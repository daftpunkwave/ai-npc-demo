/**
 * 核心职责：把一次 run 的输入与产出打包为可下载的导出 artifact，供事后复核与归档。
 * 交互契约：依赖存储读取 manifest、turn、artifact 索引、探针结果与实验汇总，经 authority 的事件查询读取事件，经 artifact 存储落盘；
 * `redaction` 决定是否剔除正文与凭据引用，`raw` 仅限研究员且仍不含密钥解析值。
 * 约束与禁忌：不修改 run 与事件、不推进时钟；导出失败时不写入半个 artifact。
 */
import { listBranchEventRows } from "@world-prism/authority";
import {
  DomainError,
  isSensitiveKey,
  type HostServices,
  type Json,
  type StoragePort,
} from "@world-prism/contracts";

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
  /** 当前宿主的世界标识；导出范围限定在该世界内。 */
  readonly worldId: string;
}

/** 导出包结构：清单、事件、turn、artifact 索引，以及实验执行器写入的探针结果与指标汇总。 */
interface ExportBundle {
  readonly runId: string;
  readonly redaction: "redacted" | "raw";
  readonly manifest: Json;
  readonly manifestHash: string;
  readonly events: readonly Json[];
  readonly turns: readonly Json[];
  readonly artifacts: readonly Json[];
  readonly probeResults: readonly Json[];
  readonly experimentResults: readonly Json[];
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
    // 凭据引用与密钥类键统一替换为占位符：字段是否存在本身有价值，具体值不能外流。
    // 复用契约层的敏感键判定，覆盖大小写变体与 token/secret/password/api_key 等命名。
    if (isSensitiveKey(key)) {
      result[key] = "[redacted]";
      continue;
    }
    // raw 保留正文；redacted 把正文类字段清空，只留字段名与计数。
    // decisionNote 是决策阶段的自由文本理由，可能复述该 Agent 持有的秘密，与对白正文同等处理。
    if (redaction === "redacted" &&
      (key === "body" || key === "answer" || key === "text" || key === "content" || key === "decisionNote")) {
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
 * 因此按列的语义处理：`redacted` 下正文类列先整列清空，再对其余列里看起来是 JSON 的字符串解析后按对象脱敏；
 * 标识、类型、时间戳等标量列保持原值——否则导出包会失去可追溯性。
 * 正文列必须在解析之前判定：一段恰好写成 JSON 的回答（如 `{"plan":"..."}`）解析后只按键名脱敏，
 * 不属于正文键名的字段会原样带出。
 */
function redactRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  redaction: "redacted" | "raw",
): readonly Json[] {
  const textColumns = new Set(["answer_text", "body", "content", "question", "note", "summary", "message", "text"]);
  return rows.map((row) => {
    const decoded: Record<string, Json> = {};
    for (const [key, value] of Object.entries(row)) {
      if (redaction === "redacted" && textColumns.has(key)) {
        decoded[key] = null;
        continue;
      }
      if (typeof value !== "string") {
        decoded[key] = redactJson((value ?? null) as Json, redaction);
        continue;
      }
      // 只对看起来是 JSON 的字符串做解析；普通文本按列语义处理。
      const trimmed = value.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          decoded[key] = redactJson(JSON.parse(value) as Json, redaction);
          continue;
        } catch {
          // 解析失败说明不是合法 JSON，退回按字符串处理。
        }
      }
      // ID、类型、时间戳等标量与 raw 下的正文原样保留。
      decoded[key] = value as Json;
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
    // 跨 world 的 run 按不存在处理，避免经导出接口取到作用域外数据。
    if (run === null || String(run["world_id"]) !== input.worldId) return null;
    const runId = request.runId;
    // 事件与 turn 是复核 run 行为的主要证据；artifact 索引用于定位大对象。
    // 事件存储归 authority，按 run 绑定的分支经其查询读取。
    const branchId = String(run["branch_id"]);
    const events = listBranchEventRows(tx, branchId);
    const turns = tx.rows("turn_runs").list({ run_id: runId });
    const artifacts = tx.rows("artifacts").list({ run_id: runId });
    // 探针回答与汇总指标是实验的结论数据：回答正文按同一脱敏口径处理（answer_text 属于正文列）。
    const probeResults = tx.rows("probe_results").list({ run_id: runId }, { orderBy: [{ column: "created_at" }] });
    const experimentResults = tx.rows("experiment_results").list({ run_id: runId }, { orderBy: [{ column: "metric" }] });
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
      // 只导出 artifact 的元数据索引（标识、类型、摘要、大小），不导出 body 正文本体：
      // artifact 可能是二进制模型响应或工具原始输出，随导出包外流的风险高于其复核价值。
      artifacts: artifacts.map((row) => {
        // 逐列取标量：artifact 行含 body 二进制，整行展开会把正文带进导出包。
        const index: Record<string, Json> = {};
        for (const column of ["artifact_id", "kind", "content_hash", "byte_size", "created_at"]) {
          const value = row[column];
          if (typeof value === "string" || typeof value === "number" || value === null) {
            index[column] = value;
          }
        }
        return index;
      }),
      probeResults: redactRows(probeResults, request.redaction),
      experimentResults: redactRows(experimentResults, request.redaction),
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
