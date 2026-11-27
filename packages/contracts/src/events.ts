/**
 * 汇总领域事件类型到 payload schema 的登记表，并按事件目录顺序导出类型。
 * 依赖各领域事件 payload 文件；事件信封、schemaVersion 与受众由宿主负责。
 * 禁止在此执行事件处理或订阅；未知事件类型必须由调用方显式拒绝。
 */
import { z } from "zod";
import {
  agentsSummonedPayloadSchema,
  agreementActivatedPayloadSchema,
  agreementBreachedPayloadSchema,
  agreementClosedPayloadSchema,
  agreementFulfilledPayloadSchema,
  agreementProposedPayloadSchema,
  agreementRespondedPayloadSchema,
  agreementTermFulfilledPayloadSchema,
  delegationCreatedPayloadSchema,
  dialogueSubmittedPayloadSchema,
  informationSharedPayloadSchema,
  knowledgeGrantedPayloadSchema,
  messageSentPayloadSchema,
  probeAskedPayloadSchema,
  rumorSpreadPayloadSchema,
  scenarioCardEventPayloadSchema,
  worldFactRecordedPayloadSchema,
} from "./events-social";
import {
  campaignStartedPayloadSchema,
  chapterStageEvaluatedPayloadSchema,
  characterInjuryPayloadSchema,
  characterMovedPayloadSchema,
  dayPassedPayloadSchema,
  evidenceDiscoveredPayloadSchema,
  groupRescuedPayloadSchema,
  groupWorsenedPayloadSchema,
  meterThresholdPayloadSchema,
  metersChangedPayloadSchema,
  passageGrantedPayloadSchema,
  policyChangedPayloadSchema,
  scoutReportedPayloadSchema,
  teamMovedPayloadSchema,
  teamRecoveredPayloadSchema,
} from "./events-world";
import {
  resourcesConsumedPayloadSchema,
  resourcesReservedPayloadSchema,
  resourcesTransferredPayloadSchema,
  stockpileAdjustedPayloadSchema,
  taskCancelledPayloadSchema,
  taskCompletedPayloadSchema,
  taskDelayedPayloadSchema,
  taskDepartedPayloadSchema,
  taskDispatchedPayloadSchema,
  taskFailedPayloadSchema,
  taskInvitationIssuedPayloadSchema,
  taskInvitationOutcomePayloadSchema,
} from "./events-actions";

export * from "./events-world";
export * from "./events-social";
export * from "./events-actions";

/** 领域事件 payload 登记表；键为事件 type，顺序与领域事件目录一致。 */
export const domainEventPayloadSchemas = {
  CampaignStarted: campaignStartedPayloadSchema,
  DelegationCreated: delegationCreatedPayloadSchema,
  KnowledgeGranted: knowledgeGrantedPayloadSchema,
  MessageSent: messageSentPayloadSchema,
  DialogueSubmitted: dialogueSubmittedPayloadSchema,
  InformationShared: informationSharedPayloadSchema,
  RumorSpread: rumorSpreadPayloadSchema,
  WorldFactRecorded: worldFactRecordedPayloadSchema,
  AgentsSummoned: agentsSummonedPayloadSchema,
  ProbeAsked: probeAskedPayloadSchema,
  AgreementProposed: agreementProposedPayloadSchema,
  AgreementResponded: agreementRespondedPayloadSchema,
  AgreementActivated: agreementActivatedPayloadSchema,
  AgreementRejected: agreementClosedPayloadSchema,
  AgreementExpired: agreementClosedPayloadSchema,
  AgreementSuperseded: agreementClosedPayloadSchema,
  AgreementTermFulfilled: agreementTermFulfilledPayloadSchema,
  AgreementFulfilled: agreementFulfilledPayloadSchema,
  AgreementBreached: agreementBreachedPayloadSchema,
  PassageGranted: passageGrantedPayloadSchema,
  PolicyChanged: policyChangedPayloadSchema,
  TaskDispatched: taskDispatchedPayloadSchema,
  ResourcesReserved: resourcesReservedPayloadSchema,
  ResourcesReleased: resourcesReservedPayloadSchema,
  TaskInvitationIssued: taskInvitationIssuedPayloadSchema,
  TaskInvitationAnswered: taskInvitationOutcomePayloadSchema,
  TaskInvitationExpired: taskInvitationOutcomePayloadSchema,
  TaskDeparted: taskDepartedPayloadSchema,
  TaskDelayed: taskDelayedPayloadSchema,
  TaskCompleted: taskCompletedPayloadSchema,
  TaskFailed: taskFailedPayloadSchema,
  TaskCancelled: taskCancelledPayloadSchema,
  ResourcesTransferred: resourcesTransferredPayloadSchema,
  ResourcesConsumed: resourcesConsumedPayloadSchema,
  StockpileAdjusted: stockpileAdjustedPayloadSchema,
  CharacterMoved: characterMovedPayloadSchema,
  TeamMoved: teamMovedPayloadSchema,
  CharacterInjured: characterInjuryPayloadSchema,
  CharacterRecovered: characterInjuryPayloadSchema,
  TeamRecovered: teamRecoveredPayloadSchema,
  EvidenceDiscovered: evidenceDiscoveredPayloadSchema,
  ScoutReported: scoutReportedPayloadSchema,
  GroupRescued: groupRescuedPayloadSchema,
  GroupWorsened: groupWorsenedPayloadSchema,
  MetersChanged: metersChangedPayloadSchema,
  RelayDegraded: meterThresholdPayloadSchema,
  RelayDown: meterThresholdPayloadSchema,
  RelayRestored: meterThresholdPayloadSchema,
  OrchardCrisis: meterThresholdPayloadSchema,
  OrchardDamaged: meterThresholdPayloadSchema,
  MigrationCrisis: meterThresholdPayloadSchema,
  SupplyShortage: meterThresholdPayloadSchema,
  DayPassed: dayPassedPayloadSchema,
  ScenarioCardTriggered: scenarioCardEventPayloadSchema,
  ScenarioCardPublished: scenarioCardEventPayloadSchema,
  ScenarioCardWithdrawn: scenarioCardEventPayloadSchema,
  ScenarioCompensationApplied: scenarioCardEventPayloadSchema,
  ScenarioOverrideApplied: scenarioCardEventPayloadSchema,
  ChapterStageEvaluated: chapterStageEvaluatedPayloadSchema,
} as const;

export type DomainEventPayloadSchemas = typeof domainEventPayloadSchemas;

export type DomainEventType = keyof DomainEventPayloadSchemas;

/** 按事件类型取契约载荷类型；读取方据此在类型层面绑定载荷字段名。 */
export type DomainEventPayload<Type extends DomainEventType> = z.infer<DomainEventPayloadSchemas[Type]>;

/**
 * 领域事件 payload schema 的最小类型。
 * 公共目录中的事件直接使用 zod schema；扩展事件由模块显式登记同形状的 schema。
 */
export type EventPayloadSchema = z.ZodType;

/** 领域事件类型全集，直接由登记表键派生，避免目录与 schema 脱节。 */
export const domainEventTypes = Object.keys(domainEventPayloadSchemas) as readonly DomainEventType[];

export const domainEventTypeSchema = z.enum(
  domainEventTypes as unknown as [DomainEventType, ...DomainEventType[]],
);

/** 按事件类型取 payload schema；未登记的类型返回 undefined，由调用方拒绝。 */
export function getDomainEventPayloadSchema(type: string): z.ZodType | undefined {
  if (!Object.hasOwn(domainEventPayloadSchemas, type)) {
    return undefined;
  }
  return domainEventPayloadSchemas[type as DomainEventType];
}
