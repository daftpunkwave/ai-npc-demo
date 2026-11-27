/**
 * 核心职责：处理实验执行器为脚本 `setup` 提交的 `knowledge.seed`，按通信模块既有的知识授权语义把证据授予指定主体。
 * 交互契约：依赖已认证的 `system:world` 主体、网关已裁决的发行者与实验分支限制、世界端口的 campaign 查询，
 * 以及通信端口的 `grantKnowledge`（按主体、条目与途径去重）；授权事件只面向受授主体。
 * 约束与禁忌：只在开局后、时钟推进前受理；不写对白与投递、不调度 job；拒绝时整体回滚，不留部分授权。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { Json } from "@world-prism/contracts";
import { commandPayloadOf } from "@world-prism/contracts";
import {
  requireGameContent,
  type GameModulePorts,
  type HandlerContext,
  type HandlerResult,
} from "@world-prism/module-sdk";
import { knownPrincipalKind } from "./probe";

type SeedContext = HandlerContext<GameModulePorts, unknown>;

/** 系统世界身份：唯一允许预置知识的主体。 */
const seedIssuerId = "system:world";

/**
 * `knowledge.seed` 处理器。
 *
 * 预置知识是实验的初始条件，必须对每个变体在同一时点生效：开局之前没有 campaign 可供授权，
 * 时钟推进后 Agent 可能已经感知并据此行动，再补授权就会让各变体的起点不一致，因此两种时点都拒绝。
 * 同一授权重复提交不会产生第二条 `KnowledgeGranted`：`grantKnowledge` 以 (主体, 条目, 途径) 去重，
 * 执行器换命令 ID 重提或重放时世界状态不变。
 */
export function knowledgeSeed(context: SeedContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("knowledge.seed", payload);
  if (context.auth.principalId !== seedIssuerId) {
    return { kind: "rejected", reasonCode: "no-authority", safeMessage: "只有系统世界身份可以预置知识" };
  }
  const ports = context.modules;
  if (ports["game.world"].campaign() === null) {
    return { kind: "rejected", reasonCode: "not-ready", safeMessage: "开局之前不能预置知识" };
  }
  if (context.tx.worldTick !== 0) {
    return { kind: "rejected", reasonCode: "world-tick-not-zero", safeMessage: "世界时钟已推进，不能再预置知识" };
  }
  const content = requireGameContent(context.content);
  if (!content.evidence.has(input.evidenceId)) {
    return { kind: "rejected", reasonCode: "invalid-params", safeMessage: "预置的证据不存在" };
  }
  if (input.principalId !== content.playerPrincipalId && knownPrincipalKind(context, input.principalId) === null) {
    return { kind: "rejected", reasonCode: "unknown-target", safeMessage: "预置知识的接收主体不存在" };
  }
  const { grantId } = ports["game.comms"].grantKnowledge({
    principalId: input.principalId,
    itemId: input.evidenceId,
    via: "setup",
  });
  return { kind: "accepted", result: { grantId, principalId: input.principalId, evidenceId: input.evidenceId } };
}
