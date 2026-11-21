/**
 * 核心职责：持久化 Agent 原始结果、模型视图与已批准对白 artifact。
 * 交互契约：通过 storage 的 artifacts 表保存规范 JSON，并用注入的 host 生成 ID 与 hash。
 * 约束与禁忌：不得覆盖既有 artifact、读取跨 scope 内容或把文件 I/O 放进调用方事务。
 */
import {
  canonicalJson,
  type HostServices,
  type Json,
  type StoragePort,
  type StorageRow,
} from "@ai-npc/contracts";

export type AgentArtifactKind = "tool-raw" | "tool-view" | "speech";

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

function assertDefinedJson(value: unknown, path: string): void {
  if (value === undefined) throw new TypeError(`artifact ${path} is undefined`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDefinedJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) assertDefinedJson(item, `${path}.${key}`);
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

function decodeBody(row: StorageRow): string {
  const body = row["body"];
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (typeof body === "string") {
    return body;
  }
  throw new Error("artifact body is missing or unsupported");
}

/** Storage-backed immutable artifact store shared by tool and speech stages. */
export class StoredAgentArtifactStore implements AgentArtifactStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
  ) {}

  async put(input: PutAgentArtifactInput): Promise<AgentArtifactRecord> {
    assertDefinedJson(input.value, "value");
    const bodyText = canonicalJson(input.value);
    const body = new TextEncoder().encode(bodyText);
    const contentHash = await this.host.hash(input.value);
    const artifactId = input.artifactId ?? this.host.ids("art");
    const createdAt = this.host.nowIso();
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
        storage: "inline",
        body,
        file_path: null,
        redaction: "raw",
        redacted_from: null,
        created_at: createdAt,
      });
    });
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
    if (kind !== "tool-raw" && kind !== "tool-view" && kind !== "speech") {
      throw new Error(`artifact ${artifactId} has unsupported kind ${kind}`);
    }
    const bodyText = decodeBody(row);
    const bodyBytes = new TextEncoder().encode(bodyText);
    const declaredSize = requireNumber(row, "byte_size");
    if (bodyBytes.byteLength !== declaredSize) {
      throw new Error(`artifact ${artifactId} byte size mismatch`);
    }
    return {
      artifactId,
      runId: row["run_id"] === null ? null : requireString(row, "run_id"),
      kind,
      contentHash: requireString(row, "content_hash"),
      byteSize: declaredSize,
      createdAt: requireString(row, "created_at"),
      value: JSON.parse(bodyText) as Json,
    };
  }
}