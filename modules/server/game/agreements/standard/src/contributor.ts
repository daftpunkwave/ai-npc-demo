/**
 * 注册协议模块的规则贡献：提出/应答命令、到期与违约 job、三个事件消费者与聚合所有权。
 * 依赖协议命令/job/消费者处理器与 module-sdk 的贡献类型；不实现规则、不读写存储。
 * 禁止在这里改写协议状态、改变命令类型或绕过处理器直接调度 job。
 */
import { gameModuleIds, type GameModulePorts, type GameRuleContributor } from "@world-prism/module-sdk";
import { onInformationShared, onPolicyChanged, onTaskCompleted } from "./agreement-consumers";
import { propose, respond } from "./agreement-commands";
import { breach, expire } from "./agreement-jobs";
import { asPorts, type AgreementContext } from "./agreement-shared";
import { agreementsOwnedAggregates } from "./definition";

/** 协议模块的规则贡献。 */
export function createAgreementsContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.agreements,
    ownsAggregates: agreementsOwnedAggregates,
    commands: [
      { type: "agreement.propose", handler: (context, payload) => propose(context as AgreementContext, payload) },
      { type: "agreement.respond", handler: (context, payload) => respond(context as AgreementContext, payload) },
    ],
    clockSteps: [
      {
        // 章节终点由协议模块触发：它持有协议计数，而世界模块不应反向依赖协议模块。
        // 计数以惰性函数传入，世界模块确认到达评估时机后才遍历协议状态。
        stepId: "agreements.chapter-evaluation",
        when: (tick) => tick > 0,
        handler: (context, tick) => {
          const ports = asPorts(context);
          return ports["game.world"].evaluateChapter(() => ports["game.agreements"].countsAsOf(tick));
        },
      },
    ],
    jobs: [
      {
        kind: "agreement.expire",
        handler: (context, job) => {
          expire(context as AgreementContext, (job.payload as { readonly agreementId: string }).agreementId);
        },
      },
      {
        kind: "agreement.breach",
        handler: (context, job) => {
          const payload = job.payload as { readonly agreementId: string; readonly termIndex: number };
          breach(context as AgreementContext, payload.agreementId, payload.termIndex);
        },
      },
    ],
    consumers: [
      {
        consumerId: "agreement-task-completed",
        eventTypes: ["TaskCompleted"],
        handler: (context, event) => {
          onTaskCompleted(context as AgreementContext, event);
        },
      },
      {
        consumerId: "agreement-information-shared",
        eventTypes: ["InformationShared"],
        handler: (context, event) => {
          onInformationShared(context as AgreementContext, event);
        },
      },
      {
        consumerId: "agreement-policy-changed",
        eventTypes: ["PolicyChanged"],
        handler: (context, event) => {
          onPolicyChanged(context as AgreementContext, event);
        },
      },
    ],
  };
}
