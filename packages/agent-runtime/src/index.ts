/**
 * 唯一的 Agent turn 管线、调度协调、工具网关与受控对白提交。
 * 依赖 contracts、kernel 与注入的端口，不直接持有具体认知模块实现。
 * 禁止复制第二套 loop，或让模块绕过证据、预算与 fencing 边界。
 */
export const packageName = "@ai-npc/agent-runtime";

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
export type { ReadTurnWorld, TurnWorldRead } from "./turn-input";
export { MemoryHost } from "./memory-host";
export type { MemoryHostOptions } from "./memory-host";
export type { MemoryRecordUseRequest } from "./memory-publication";
export { memoryIdentityForAgent } from "./memory-identity";

export { StoredAgentArtifactStore } from "@ai-npc/module-sdk";
export type { AgentArtifactKind, AgentArtifactRecord, AgentArtifactStore, PutAgentArtifactInput } from "@ai-npc/module-sdk";
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
export { estimateSystemAndUserTokens, estimateTokens } from "@ai-npc/contracts";
export { decisionSystem, decisionSubmitTool, modelContextBudget } from "./model-turn-materials";
export { AgentContextPipeline } from "./context-pipeline";
export type { ContextPipelineOptions, PreparedContext } from "./context-pipeline";
