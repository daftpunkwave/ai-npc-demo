/**
 * 命令回执的构造、持久化与读取：把执行结果转成契约回执并写入分支内 command_receipts。
 * 依赖公共契约回执 schema 与宿主 ID/时间服务；不判断命令是否可执行、不改动聚合状态。
 * 禁止在保存点之外写入回执、复用调用方的回执内容或吞掉存储中的非法回执。
 */
import {
  DomainError,
  commandReceiptSchema,
  type AuthContext,
  type CommandEnvelope,
  type CommandReceipt,
  type Json,
  type ReasonCode,
  type ScopedBranchStorage,
} from "@world-prism/contracts";
import type { HostServices } from "@world-prism/contracts";
import { issuesOf } from "./command-validation";

/** 回执的全部业务字段；payloadHash 与写入时间由写入方补齐。 */
export interface ReceiptInput {
  readonly auth: AuthContext;
  readonly envelope: CommandEnvelope;
  readonly commandStatus: "accepted" | "rejected";
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  readonly reasonCode: ReasonCode | null;
  readonly safeMessage: string | null;
  readonly acceptedEventIds: readonly string[];
  /** 发起该命令的副作用操作；不经 operation 执行（如玩家直接提交）时为 null。 */
  readonly operationId: string | null;
  readonly resultingVersions: Readonly<Record<string, number>>;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  readonly result: Json | null;
  readonly worldTick: number;
}

/** 只读宿主服务；回执只需要 ID 生成与时间。 */
export type ReceiptHost = Pick<HostServices, "ids" | "nowIso">;

/** 按执行结果构造并校验回执；非法结构在写入前失败。 */
export function buildReceipt(host: ReceiptHost, input: ReceiptInput): CommandReceipt {
  const receipt = {
    receiptId: host.ids("rcp"),
    commandId: input.envelope.commandId,
    commandStatus: input.commandStatus,
    reasonCode: input.reasonCode,
    safeMessage: input.safeMessage,
    acceptedEventIds: [...input.acceptedEventIds],
    operationId: input.operationId,
    resultingVersions: input.resultingVersions,
    result: input.result,
    worldTick: input.worldTick,
  };
  const parsed = commandReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "构造的命令回执不合法", {
      details: { issues: issuesOf(parsed.error) },
    });
  }
  return parsed.data;
}

/** 构造回执并写入分支存储；调用方保证处于命令的保存点事务内。 */
export function writeReceipt(
  host: ReceiptHost,
  branchStorage: ScopedBranchStorage,
  input: ReceiptInput,
  payloadHash: string,
): CommandReceipt {
  const receipt = buildReceipt(host, input);
  branchStorage.table("command_receipts").put({
    principal_id: input.auth.principalId,
    command_id: input.envelope.commandId,
    command_type: input.envelope.type,
    payload_hash: payloadHash,
    receipt_json: receipt,
    created_at: host.nowIso(),
  });
  return receipt;
}

/** 读取既有回执并按契约校验；存储内容不合法说明数据被破坏。 */
export function readReceipt(row: Readonly<Record<string, unknown>>): CommandReceipt {
  const parsed = commandReceiptSchema.safeParse(row["receipt_json"]);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "存储中的命令回执不符合契约", {
      details: { issues: issuesOf(parsed.error) },
    });
  }
  return parsed.data;
}
