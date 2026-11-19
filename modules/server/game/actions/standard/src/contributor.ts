/**
 * 注册行动模块的规则贡献：任务命令、任务 job、聚合所有权与模块 ID。
 * 依赖任务命令/job 处理器与 module-sdk 的贡献类型；不实现规则、不读写存储。
 * 禁止在这里改写任务状态、改变命令类型或绕过处理器直接调度 job。
 */
import { gameModuleIds, type GameModulePorts, type GameRuleContributor } from "@ai-npc/module-sdk";
import { cancel } from "./cancel";
import { dispatch } from "./dispatch";
import { respond } from "./respond";
import { complete, depart, returnToOrigin, work } from "./task-jobs";
import type { ActionContext } from "./task-shared";

/** 行动模块的规则贡献。 */
export function createActionsContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.actions,
    ownsAggregates: ["task", "task-invitation"],
    commands: [
      { type: "task.dispatch", handler: (context, payload) => dispatch(context as ActionContext, payload) },
      { type: "task.respond", handler: (context, payload) => respond(context as ActionContext, payload) },
      { type: "task.cancel", handler: (context, payload) => cancel(context as ActionContext, payload) },
    ],
    jobs: [
      {
        kind: "task.depart",
        handler: (context, job) => {
          depart(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
      {
        kind: "task.work",
        handler: (context, job) => {
          work(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
      {
        kind: "task.complete",
        handler: (context, job) => {
          complete(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
      {
        kind: "task.return",
        handler: (context, job) => {
          returnToOrigin(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
    ],
  };
}
