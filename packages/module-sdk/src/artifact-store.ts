/**
 * 核心职责：持久化 Agent 原始结果、模型视图与已批准对白 artifact，并按存储端口的内联上限把大正文分流到文件。
 * 交互契约：通过 storage 的 artifacts 表登记规范 JSON，超过 artifactFiles.inlineMaxBytes 的正文经 artifactFiles 落盘；
 * 用注入的 host 生成 ID，并对规范正文文本求 content_hash。artifactBodyText 供其他只读方在事务外取回正文。
 * 约束与禁忌：不得覆盖既有 artifact、读取跨 scope 内容或把文件 I/O 放进任何事务。
 */
import {
  canonicalJson,
  checkJsonBudget,
  type HostServices,
  type Json,
  type StoragePort,
  type StorageRow,
} from "@world-prism/contracts";

const artifactKinds = ["tool-raw", "tool-view", "speech", "decision", "context", "model-request", "model-response", "export"] as const;

export type AgentArtifactKind = typeof artifactKinds[number];

export interface AgentArtifactRecord {
  readonly artifactId: string;
  readonly runId: string | null;
  readonly kind: AgentArtifactKind;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly value: Json;
}

export interface PutAgentArtifactInput {
  readonly artifactId?: string;
  readonly runId: string | null;
  readonly kind: AgentArtifactKind;
  readonly value: Json;
}

export interface AgentArtifactStore {
  put(input: PutAgentArtifactInput): Promise<AgentArtifactRecord>;
  get(artifactId: string): AgentArtifactRecord | null;
}

/**
 * 校验 artifact 值里没有 undefined 属性值。
 * 用显式栈迭代遍历：artifact 值可能是模型产出的深层结构，
 * 递归实现会在超深输入上抛 RangeError，而这里应当给出明确的 TypeError。
 */
function assertDefinedJson(value: unknown, path: string): void {
  const stack: { readonly value: unknown; readonly path: string }[] = [{ value, path }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.value === undefined) throw new TypeError(`artifact ${current.path} is undefined`);
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => {
        stack.push({ value: item, path: `${current.path}[${index}]` });
      });
      continue;
    }
    if (typeof current.value === "object" && current.value !== null) {
      for (const [key, item] of Object.entries(current.value)) {
        stack.push({ value: item, path: `${current.path}.${key}` });
      }
    }
  }
}

function requireString(row: StorageRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`artifact field ${key} is not a string`);
  }
  return value;
}

function requireNumber(row: StorageRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`artifact field ${key} is not a non-negative integer`);
  }
  return value;
}

/**
 * 在事务内被读取正文的 artifact 类型始终内联：turn 取消时在命令事务里用 SQL 读取对白 artifact 判断回复是否已发布，
 * 事务内不能做文件 I/O。对白正文受命令文本长度上限约束，内联不会带来大对象。
 */
const alwaysInlineKinds: ReadonlySet<AgentArtifactKind> = new Set(["speech"]);

function decodeInlineBody(row: StorageRow): string {
  const body = row["body"];
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (typeof body === "string") {
    return body;
  }
  throw new Error("artifact body is missing or unsupported");
}

/**
 * 取回 artifacts 行的正文文本：内联行直接解码，文件行经存储端口读取正文文件。
 * 必须在事务外调用：文件行会触发文件 I/O，而存储只有一条写连接。
 */
export function artifactBodyText(storage: StoragePort, row: StorageRow): string {
  if (row["storage"] !== "file") {
    return decodeInlineBody(row);
  }
  const filePath = row["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("artifact file_path is missing");
  }
  return new TextDecoder().decode(storage.artifactFiles.read(filePath));
}

/** 由存储支持的不可变 artifact 仓库，供工具与对白阶段共用。 */
export class StoredAgentArtifactStore implements AgentArtifactStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
  ) {}

  async put(input: PutAgentArtifactInput): Promise<AgentArtifactRecord> {
    // 先跑有界 JSON 校验：assertDefinedJson 与 canonicalJson 都会遍历整棵结构，
    // 循环引用会让它们的栈/帧数组无界增长，必须在遍历前用预算拒绝。
    const budget = checkJsonBudget(input.value);
    if (budget !== null) {
      throw new TypeError(`artifact 值超出 JSON 预算：${budget.message}`);
    }
    assertDefinedJson(input.value, "value");
    const bodyText = canonicalJson(input.value);
    const body = new TextEncoder().encode(bodyText);
    // 对已得到的规范文本求摘要，与 host.hash(input.value) 结果相同，但不再对同一值序列化第二次。
    const contentHash = await this.host.hashText(bodyText);
    const artifactId = input.artifactId ?? this.host.ids("art");
    const createdAt = this.host.nowIso();
    const files = this.storage.artifactFiles;
    const inline = body.byteLength <= files.inlineMaxBytes || alwaysInlineKinds.has(input.kind);
    // 正文文件在登记事务之前写入：事务内不做文件 I/O；登记失败时删除刚写入的文件，不留下无人引用的正文。
    const filePath = inline ? null : files.write(artifactId, body);
    try {
      this.storage.transact((tx) => {
        const artifacts = tx.rows("artifacts");
        if (artifacts.get({ artifact_id: artifactId }) !== null) {
          throw new Error(`artifact ${artifactId} already exists`);
        }
        artifacts.put({
          artifact_id: artifactId,
          run_id: input.runId,
          kind: input.kind,
          content_hash: contentHash,
          mime: "application/json",
          byte_size: body.byteLength,
          storage: filePath === null ? "inline" : "file",
          body: filePath === null ? body : null,
          file_path: filePath,
          redaction: "raw",
          redacted_from: null,
          created_at: createdAt,
        });
      });
    } catch (error) {
      if (filePath !== null) files.remove(filePath);
      throw error;
    }
    return {
      artifactId,
      runId: input.runId,
      kind: input.kind,
      contentHash,
      byteSize: body.byteLength,
      createdAt,
      value: input.value,
    };
  }

  get(artifactId: string): AgentArtifactRecord | null {
    const row = this.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
    if (row === null) return null;
    const kind = requireString(row, "kind");
    if (!(artifactKinds as readonly string[]).includes(kind)) {
      throw new Error(`artifact ${artifactId} has unsupported kind ${kind}`);
    }
    const bodyText = artifactBodyText(this.storage, row);
    const bodyBytes = new TextEncoder().encode(bodyText);
    const declaredSize = requireNumber(row, "byte_size");
    if (bodyBytes.byteLength !== declaredSize) {
      throw new Error(`artifact ${artifactId} byte size mismatch`);
    }
    return {
      artifactId,
      runId: row["run_id"] === null ? null : requireString(row, "run_id"),
      kind: kind as AgentArtifactKind,
      contentHash: requireString(row, "content_hash"),
      byteSize: declaredSize,
      createdAt: requireString(row, "created_at"),
      value: JSON.parse(bodyText) as Json,
    };
  }
}
