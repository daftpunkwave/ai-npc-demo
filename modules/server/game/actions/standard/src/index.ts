/**
 * 汇总标准行动模块的公开入口：模块定义、端口工厂、规则贡献与状态工具。
 * 依赖定义、端口、处理器与状态文件；宿主只经组合根登记定义。
 * 禁止在这里打开存储或执行任务结算。
 */
export const packageName = "@ai-npc/mod-game-actions-standard";

export { actionsModuleDefinition } from "./definition";
export { createActionsContributor } from "./contributor";
export { createActionsPort } from "./port";
export { invitationStateSchema, readActionState, taskStateSchema } from "./state";
export type { InvitationState, TaskState } from "./state";
export { planDispatch } from "./plan";
export type { DispatchInput, DispatchPlan, PlanResult } from "./plan";
