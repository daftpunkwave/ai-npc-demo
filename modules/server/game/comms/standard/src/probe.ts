/**
 * 核心职责：处理实验运行器在沙盒分支提交的 `probe.ask`，写入 `ProbeAsked` 事件供感知与决策消费。
 * 交互契约：依赖已认证的 `system:world` 主体、沙盒分支上的暂停豁免，以及内容索引中的主体登记；
 * 事件受众是被提问的 Agent，其他主体不得经此获取提问内容。
 * 约束与禁忌：不产生对白、不写对白批准索引、不推进逻辑时间；拒绝时整体回滚，不留部分状态。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { Json } from "@world-prism/contracts";
import { commandPayloadOf } from "@world-prism/contracts";
import {
  principalsAudience,
  requireGameContent,
  type GameModulePorts,
  type HandlerContext,
  type HandlerResult,
} from "@world-prism/module-sdk";

type ProbeContext = HandlerContext<GameModulePorts, unknown>;

/** 系统世界身份：唯一允许发行 `probe.ask` 的主体。 */
const probeIssuerId = "system:world";

/**
 * 已提交探针的登记聚合类型。它属于通信模块的写作用域，
 * 以 `probeId` 为主键，用于让同一探针在重复提交时保持幂等。
 */
export const probeRequestAggregate = "probe-request";

/**
 * 校验主体在内容索引中的登记类型。
 * 探针只面向已登记的角色或派系主体；未知 ID 直接拒绝，避免在沙盒里留下无法唤起的观察。
 */
export function knownPrincipalKind(context: ProbeContext, principalId: string): "character" | "faction" | null {
  const content = requireGameContent(context.content);
  if (content.characters.has(principalId)) {
    return "character";
  }
  return content.factions.has(principalId) ? "faction" : null;
}

/**
 * `probe.ask` 处理器：把运行器的提问转成面向被问 Agent 的观察事件。
 * 分支种类与主体资格已由命令网关裁决（发行者矩阵、分支种类限制与沙盒暂停豁免），
 * 这里只做内容侧校验、幂等检查与事件提交。
 *
 * 同一 `probeId` 只写一条事件：命令幂等以 `commandId` 为准，运行器重试或换命令 ID 重提
 * 都会再次进入处理器；若不去重，同一问题会在沙盒里产生多条观察与多个 trigger。
 */
export function probeAsk(context: ProbeContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("probe.ask", payload);
  if (context.auth.principalId !== probeIssuerId) {
    return { kind: "rejected", reasonCode: "no-authority", safeMessage: "只有系统世界身份可以发起探针" };
  }
  if (knownPrincipalKind(context, input.agentId) === null) {
    return { kind: "rejected", reasonCode: "unknown-target", safeMessage: "被提问主体不存在" };
  }
  const content = requireGameContent(context.content);
  if (input.askedBy !== content.playerPrincipalId && knownPrincipalKind(context, input.askedBy) === null) {
    return { kind: "rejected", reasonCode: "unknown-target", safeMessage: "提问者不存在" };
  }
  // 探针登记以 probeId 聚合去重：命令幂等只按 commandId，重试或换命令 ID 会再次进入处理器，
  // 若不去重，同一问题会重复产生观察与 trigger，沙盒里就会出现重复作答与重复计分。
  const registered = context.tx.get<Json>(probeRequestAggregate, input.probeId);
  if (registered !== null) {
    return { kind: "accepted", result: { probeId: input.probeId, agentId: input.agentId, duplicate: true } };
  }
  context.tx.put(probeRequestAggregate, input.probeId, {
    probeId: input.probeId,
    agentId: input.agentId,
    askedBy: input.askedBy,
    committedAtTick: context.tx.worldTick,
  });
  context.tx.emit(
    "ProbeAsked",
    { probeId: input.probeId, agentId: input.agentId, askedBy: input.askedBy, question: input.question },
    principalsAudience([input.agentId]),
  );
  return { kind: "accepted", result: { probeId: input.probeId, agentId: input.agentId } };
}
