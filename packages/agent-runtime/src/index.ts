/**
 * 唯一的 Agent turn 管线、调度协调、工具网关与受控对白提交，以及 turn 证据与 Agent 状态的类型化只读查询。
 * 依赖 contracts、kernel 与注入的端口，不直接持有具体认知模块实现。
 * 禁止复制第二套 loop，或让模块绕过证据、预算与 fencing 边界。
 */
export const packageName = "@world-prism/agent-runtime";

export { agentDeploymentQuota, activateAgentRoster, activateAgentRosterInTransaction } from "./activation";
export type { ActivationResult, ActivateAgentRosterInput, RosterActivationInput, RosterActivationOutcome } from "./activation";
export { createCampaignStartActivationHook } from "./campaign-activation";
export type {
  CampaignStartActivationContext,
  CampaignStartActivationOptions,
} from "./campaign-activation";
export { AgentRuntime } from "./runtime";
export type { AgentRuntimeOptions, AgentWorldRead } from "./runtime";
export type { TurnExecutionOptions } from "./turn-worker";
export { TurnLeases, TurnStopped } from "./turn-lease";
export type { ClaimedTurn } from "./turn-lease";
export {
  cancelActiveTurnsSql,
  currentMemoryRecordsSql,
  latestDayPassedSql,
  pendingTriggersSql,
  recoverExpiredTurnsSql,
  visibleMemoryRecordsSql,
} from "./agent-hot-path-sql";
export type { ReadTurnWorld, TurnWorldRead } from "./turn-input";
export { readTurnObservations } from "./turn-observations";
export type { TurnObservationQuery } from "./turn-observations";
export {
  countTurnToolCalls,
  listStartedModelAttemptTimes,
  listTurnModelAttempts,
  listTurnModelUsages,
  listTurnRuns,
  listTurnToolCalls,
  listTurnTriggerKinds,
  readSchedulerQueue,
  readTurnRun,
} from "./turn-evidence-queries";
export {
  listAgentRuntimeStates,
  listMemoryRecordVersions,
  listObservationPage,
  listPendingMaintenance,
  readMemoryWatermark,
  readPerceptionRevision,
} from "./agent-state-queries";
export type { AgentRuntimeState } from "./agent-state-queries";
export { enqueueDebugTrigger, findDebugTriggerAgent, isAgentActive } from "./debug-triggers";
export { MemoryHost } from "./memory-host";
export type { MemoryHostOptions } from "./memory-host";
export type { MemoryRecordUseRequest } from "./memory-publication";
export { memoryIdentityForAgent } from "./memory-identity";

export { StoredAgentArtifactStore } from "@world-prism/module-sdk";
export type { AgentArtifactKind, AgentArtifactRecord, AgentArtifactStore, PutAgentArtifactInput } from "@world-prism/module-sdk";
export { ToolGateway } from "./tool-gateway";
export type {
  MessageExecutionInput,
  MessageExecutionResult,
  QueryExecutionInput,
  ToolCallExecutionInput,
  ToolCallOutcome,
  ToolCatalogPort,
  ToolGatewayOptions,
  ToolGatewayTurn,
} from "./tool-gateway";
export { allowedDynamicValues, dynamicFieldName, narrowToolsForTurn } from "./tool-narrowing";
export type { NarrowedToolOmission, ToolNarrowingValues, ToolRequestProjection } from "./tool-narrowing";
export { assertToolCallResultPairing, pairedToolMessages } from "./tool-pairing";
export type { PairedToolOutcome } from "./tool-pairing";
export { isDisclosable, filterDisclosableFacts } from "./disclosure";
export type { DisclosureContext, SpeechFact } from "./disclosure";
export { validateSpeechOutput, validationAsJson } from "./speech-guards";
export type {
  SpeechCheck,
  SpeechGenerationOutput,
  SpeechGuardInput,
  SpeechReceiptState,
  SpeechSecret,
  SpeechValidation,
} from "./speech-guards";
export { renderSafeSpeech } from "./speech-template";
export type { SafeSpeechInput } from "./speech-template";
export { buildSpeechCommitEnvelope, DialogueFlow, SpeechApprovalIndex } from "./dialogue-flow";
export type {
  DialogueFlowOptions,
  SpeechApprovalInput,
  SpeechApprovalResult,
  SpeechCommitResult,
  SpeechGenerationRequest,
  SpeechGenerator,
  SpeechHistoryLine,
  SpeechPreparation,
} from "./dialogue-flow";
export { estimateSystemAndUserTokens, estimateTokens } from "@world-prism/contracts";
export { decisionSystem, decisionSubmitTool, modelContextBudget } from "./model-turn-materials";
export { AgentContextPipeline } from "./context-pipeline";
export type { ContextPipelineOptions, PreparedContext } from "./context-pipeline";
