/**
 * 核心职责：把一次 run 的输入与产出打包为可下载的导出 artifact，供事后复核与归档。
 * 交互契约：依赖存储读取 manifest、事件、turn 与 artifact 索引，经 artifact 存储落盘；
 * `redaction` 决定是否剔除正文与凭据引用，`raw` 仅限研究员且仍不含密钥解析值。
 * 约束与禁忌：不修改 run 与事件、不推进时钟；导出失败时不写入半个 artifact。
 */
import {
  DomainError,
  type HostServices,
  type Json,
  type StoragePort,
} from "@ai-npc/contracts";

/** 导出请求：run 标识与脱敏级别。 */
export interface ExportRunInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  /** artifact 存储；由 module-sdk 提供，写入后返回可读取的 artifact 标识。 */
  readonly artifacts: {
    put(input: {
      readonly runId: string | null;
      readonly kind: "export";
      readonly value: Json;
    }): Promise<{ readonly artifactId: string }>;
  };
  /** 导出主体；用于审计与权限归属。 */
  readonly principalId: string;
}

/** 导出包结构：清单、事件、turn 与 artifact 索引。 */
interface ExportBundle {
  readonly runId: string;
  readonly redaction: "redacted" | "raw";
  readonly manifest: Json;
  readonly manifestHash: string;
  readonly events: readonly Json[];
  readonly turns: readonly Json[];
  readonly artifacts: readonly Json[];
}

/** 读取 JSON 列；字符串按 JSON 解析，解析失败时返回 null 而不是抛出。 */
function jsonCell(row: Readonly<Record<string, unknown>>, column: string): Json | null {
  const value = row[column];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Json;
    } catch {
      return null;
    }
  }
  return value === undefined ? null : (value as Json);
}

/**
 * 脱敏：剔除凭据引用与密钥名，保留结构与计数。
 * 即使 `raw` 也不输出凭据解析值——导出包会离开服务端，密钥不进任何导出产物。
 *
 * 顶层字符串无法判断语义：它可能是一段对白正文，也可能是 ID、时间戳等无敏感内容。
 * 因此只在明确位于正文类字段时才由调用方清空；这里对裸字符串原样返回，
 * 由 `redactRows` 负责先按列语义解码，避免把整段正文当普通字符串带出。
 */
function redactJson(value: Json, redaction: "redacted" | "raw"): Json {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redaction));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    // 凭据引用统一替换为占位符：字段是否存在本身有价值，具体值不能外流。
    if (key === "credentialRef" || key === "apiKey" || key === "authorization") {
      result[key] = "[redacted]";
      continue;
    }
    // raw 保留正文；redacted 把正文类字段清空，只留字段名与计数。
    if (redaction === "redacted" && (key === "body" || key === "answer" || key === "text" || key === "content")) {
      result[key] = null;
      continue;
    }
    result[key] = redactJson(item, redaction);
  }
  return result;
}

/**
 * 把行内 JSON 列解码后再脱敏。
 *
 * 行来自存储层，JSON 列可能以字符串或已解析对象返回。若把字符串直接交给 `redactJson`，
 * 它只是个字符串、不会被逐字段处理，`redacted` 就会保留完整正文，`raw` 也可能带出凭据。
 * 因此按列的语义先尝试解析：解析成功的按对象脱敏，解析失败的按普通字符串脱敏（整段清空）。
 */
function redactRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  redaction: "redacted" | "raw",
): readonly Json[] {
  return rows.map((row) => {
    const decoded: Record<string, Json> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string") {
        decoded[key] = redactJson((value ?? null) as Json, redaction);
        continue;
      }
      // 只对看起来是 JSON 的字符串做解析；普通文本按正文类字段处理。
      const trimmed = value.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          decoded[key] = redactJson(JSON.parse(value) as Json, redaction);
          continue;
        } catch {
          // 解析失败说明不是合法 JSON，退回按字符串处理。
        }
      }
      // 无法解析的字符串可能是一段正文（例如对白原文）：redacted 下无法判断内容，
      // 因此整段清空；raw 下保留原文。留空比泄露安全。
      decoded[key] = redaction === "redacted" ? null : (value as Json);
    }
    return redactJson(decoded, redaction);
  });
}

/**
 * 导出 run：读取清单、事件、turn 与 artifact 索引，脱敏后写入 artifact 存储。
 * run 不存在时抛出 not-found；导出包本身不含密钥解析值。
 */
export async function exportRun(
  input: ExportRunInput,
  request: { readonly runId: string; readonly redaction: "redacted" | "raw" },
): Promise<{ readonly artifactId: string }> {
  const bundle = input.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: request.runId });
    if (run === null) return null;
    const runId = request.runId;
    // 事件与 turn 是复核 run 行为的主要证据；artifact 索引用于定位大对象。
    // domain_events 是分支级表，必须经 branch(branchId) 访问。
    const branchId = String(run["branch_id"]);
    const events = tx.branch(branchId).table("domain_events").list();
    const turns = tx.rows("turn_runs").list({ run_id: runId });
    const artifacts = tx.rows("artifacts").list({ run_id: runId });
    const manifest = jsonCell(run, "manifest_json");
    const manifestHash = typeof run["manifest_hash"] === "string" ? run["manifest_hash"] : null;
    if (manifest === null || manifestHash === null) {
      // 没有冻结清单的 run 无法自证输入，导出它只会产生无法核对的材料。
      throw new DomainError("not-ready", `run ${runId} 缺少冻结清单，无法导出`);
    }
    const exported: ExportBundle = {
      runId,
      redaction: request.redaction,
      manifest: redactJson(manifest, request.redaction),
      manifestHash,
      events: redactRows(events, request.redaction),
      turns: redactRows(turns, request.redaction),
      artifacts: redactRows(artifacts, request.redaction),
    };
    return exported;
  });
  if (bundle === null) {
    throw new DomainError("not-found", `run ${request.runId} 不存在`);
  }
  // 导出主体写入 artifact，便于事后审计「谁导出了哪一次 run」；
  // 权限范围已在路由层按角色裁决，这里是留痕而非替代鉴权。
  const record = await input.artifacts.put({
    runId: request.runId,
    kind: "export",
    value: { ...bundle, exportedBy: input.principalId } as unknown as Json,
  });
  return { artifactId: record.artifactId };
}
