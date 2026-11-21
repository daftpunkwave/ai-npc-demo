/**
 * 汇总 authority 的公开入口：命令网关、规则注册、job/时钟/消费者执行器与组装门面。
 * 依赖各固定机制实现与公共类型；调用方只经此入口装配，不导入内部事务细节。
 * 禁止在此启动运行时、创建存储连接或隐藏处理器注册失败。
 */
export const packageName = "@ai-npc/authority";

export { Authority } from "./authority";
export type { AuthorityOptions } from "./authority";
export { CommandGateway, commandPayloadHash } from "./command-gateway";
export { createScopedWorldTxFactory } from "./module-binding";
export type { ModuleBindingInput, ModuleScopeInput } from "./module-binding";
export { ClockStepRunner } from "./clock-steps";
export type { ClockStepRunResult, ClockStepRunnerOptions } from "./clock-steps";
export { EventConsumerRunner } from "./consumer-runner";
export type { ConsumerRunOptions, ConsumerRunResult, EventConsumerRunnerOptions } from "./consumer-runner";
export { JobRunner } from "./job-runner";
export type { JobRunnerOptions } from "./job-runner";
export { RuleRegistry } from "./rule-registry";
export {
  MAX_RULE_ATTEMPTS,
  RuleExecutionError,
  clearRuleFailure,
  listRuleFailures,
  readRuleFailure,
  recordRuleAttempt,
  writeRuleFailure,
  workerFailureIdentity,
} from "./rule-failures";
export type {
  RuleFailureIdentity,
  RuleFailurePhase,
  RuleFailureRecord,
  RuleFailureWrite,
} from "./rule-failures";
export { createSystemAuth, systemPrincipalId } from "./system-auth";
export { TransactionWorldTx } from "./world-tx";
export type { WorldTxOptions } from "./world-tx";
export { commandIssuerKinds, isCommandIssuerAllowed } from "./issuer-policy";
export { effectivePrincipalKind } from "./types";
export type {
  AfterCommandHook,
  ClockStepRegistration,
  CommandGatewayOptions,
  CommandHandler,
  ContributorScope,
  DueJob,
  EventConsumerRegistration,
  HostAfterCommandHook,
  HostAfterCommandInput,
  JobHandler,
  RegisteredAfterCommand,
  RegisteredCommand,
  RegisteredHostAfterCommand,
  RegisteredJob,
  RuleContributor,
  RuleRuntime,
  StoredAfterCommandHook,
  StoredClockStep,
  StoredCommandHandler,
  StoredEventConsumer,
  StoredHostAfterCommandHook,
  StoredJobHandler,
} from "./types";
