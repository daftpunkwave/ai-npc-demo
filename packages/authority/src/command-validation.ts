/**
 * 命令网关的校验辅助：schema 问题收集、处理器结果收窄、命令类型解析、暂停豁免与聚合版本比对。
 * 依赖公共契约命令 schema 与分支存储视图；不写回执、不执行处理器。
 * 禁止在这里修改世界状态、吞掉 schema 错误或放宽版本比对规则。
 */
import {
  DomainError,
  commandTypeSchema,
  jsonValueSchema,
  type CommandEnvelope,
  type CommandType,
  type Json,
  type ScopedBranchStorage,
} from "@ai-npc/contracts";
import type { AuthContext } from "@ai-npc/contracts";
import type { BranchRecord } from "./branch-state";
import { requireStorageNumber } from "./storage-values";

/** 把 schema 问题压成可放进错误详情的路径与说明。 */
export function issuesOf(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

/** 收窄处理器返回值：undefined 视为无结果，其余必须是合法 JSON。 */
export function requireJsonResult(value: unknown): Json | null {
  if (value === undefined) {
    return null;
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "命令处理器返回的 result 不是合法 JSON", {
      details: { issues: issuesOf(parsed.error) },
    });
  }
  return parsed.data;
}

/** 解析命令类型；未登记的类型返回 null，由调用方写拒绝回执。 */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- 静态分析缺少 workspace 类型解析时把导入的 CommandType 视为 any，这里是有意的可空返回。
export function parseCommandType(type: string): CommandType | null {
  const parsed = commandTypeSchema.safeParse(type);
  return parsed.success ? parsed.data : null;
}

/** 暂停豁免：开局命令，以及系统世界探针在 sandbox 分支上的询问。 */
export function isPauseExempt(type: CommandType, auth: AuthContext, branch: BranchRecord): boolean {
  if (type === "campaign.start") {
    return true;
  }
  return (
    type === "probe.ask" &&
    auth.kind === "system" &&
    auth.principalId === "system:world" &&
    branch.kind === "sandbox" &&
    branch.status === "active"
  );
}

/** 校验 expectedVersions 中每个 "<聚合类型>:<聚合 ID>" 的当前版本；缺失按 0 处理。 */
export function checkExpectedVersions(branchStorage: ScopedBranchStorage, envelope: CommandEnvelope): boolean {
  for (const [key, expected] of Object.entries(envelope.expectedVersions ?? {})) {
    const separator = key.indexOf(":");
    if (separator <= 0 || separator === key.length - 1) {
      return false;
    }
    const aggregateType = key.slice(0, separator);
    const aggregateId = key.slice(separator + 1);
    const row = branchStorage.table("aggregate_state").get({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
    });
    const actual = row === null ? 0 : requireStorageNumber(row, "aggregate_state", "version");
    if (actual !== expected) {
      return false;
    }
  }
  return true;
}
