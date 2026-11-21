/**
 * 核心职责：持久化工具调用、operation 关联、原始结果与模型视图 artifact，并支持幂等恢复。
 * 交互契约：依赖 storage、HostServices、artifact store 与 tool-view 端口，只处理已经校验的调用上下文。
 * 约束与禁忌：不得执行命令、改变结果状态或跨主体复用 unsettled/unknown 结果。
 */
import type {
  HostServices,
  Json,
  StorageCell,
  StoragePort,
  ToolBinding,
  ToolDefinition,
  ToolExecutionResult,
} from "@ai-npc/contracts";
import type { AgentToolViewPort } from "@ai-npc/module-sdk";
import type { AgentArtifactRecord, AgentArtifactStore } from "./artifact-store";
import {
  isToolCallIdentity,
  storageNullableString,
  storageString,
  type RawToolArtifactValue,
  type ToolCallExecutionInput,
  type ToolCallIdentity,
  type ToolCallOutcome,
  type ToolGatewayTurn,
  type ViewToolArtifactValue,
} from "./tool-gateway-types";

export interface ToolOutcomeStoreOptions {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly artifacts: AgentArtifactStore;
  readonly toolView: AgentToolViewPort;
}

export interface PersistToolOutcomeInput {
  readonly input: ToolCallExecutionInput;
  readonly binding: ToolBinding;
  readonly definition: ToolDefinition;
  readonly argsHash: string;
  readonly args: Json;
  readonly command: Json | null;
  readonly output: Json;
  readonly partialResult: ToolExecutionResult;
  readonly toolCall: ToolCallIdentity;
}

export class ToolOutcomeStore {
  constructor(private readonly options: ToolOutcomeStoreOptions) {}

  findCall(input: ToolCallExecutionInput): Readonly<Record<string, StorageCell>> | null {
    const rows = this.options.storage.transact((tx) => tx.rows("tool_calls").list({
      run_id: input.runId,
      turn_id: input.turnId,
      attempt_id: input.attemptId,
      provider_call_id: input.providerCallId,
    }, { orderBy: [{ column: "created_at", direction: "asc" }] }));
    return rows[0] ?? null;
  }

  findSettledOperation(
    turn: ToolGatewayTurn,
    operationId: string,
  ): Readonly<Record<string, StorageCell>> | null {
    const rows = this.options.storage.transact((tx) => tx.rows("tool_calls").list({
      run_id: turn.runId,
      agent_id: turn.agentId,
      operation_id: operationId,
    }));
    return rows.find((row) =>
      row["status"] === "settled" &&
      row["execution_status"] === "ok" &&
      row["raw_artifact_id"] !== null &&
      row["view_artifact_id"] !== null
    ) ?? null;
  }

  ensureToolCall(
    input: ToolCallExecutionInput,
    binding: ToolBinding,
    argsHash: string,
    operationId: string | null,
    commandId: string | null,
    existing: Readonly<Record<string, StorageCell>> | null,
  ): ToolCallIdentity {
    const toolCallId = existing === null ? this.options.host.ids("tc") : storageString(existing, "tool_call_id");
    this.options.storage.transact((tx) => {
      tx.rows("tool_calls").put({
        tool_call_id: toolCallId,
        run_id: input.runId,
        turn_id: input.turnId,
        attempt_id: input.attemptId,
        agent_id: input.agentId,
        provider_call_id: input.providerCallId,
        tool_id: binding.toolId,
        tool_version: binding.version,
        binding_id: binding.bindingId,
        status: "admitted",
        args_hash: argsHash,
        operation_id: operationId,
        command_id: commandId,
        execution_status: null,
        raw_artifact_id: null,
        view_artifact_id: null,
        created_at: existing === null ? this.options.host.nowIso() : storageString(existing, "created_at"),
        settled_at: null,
      });
    });
    return { toolCallId, commandId };
  }

  async persistOutcome(input: PersistToolOutcomeInput): Promise<ToolCallOutcome> {
    const rawArtifactId = this.options.host.ids("art");
    const result: ToolExecutionResult = { ...input.partialResult, resultRef: rawArtifactId };
    const rawValue: RawToolArtifactValue = {
      kind: "tool-call-raw",
      toolCallId: input.toolCall.toolCallId,
      providerCallId: input.input.providerCallId,
      toolId: input.binding.toolId,
      toolVersion: input.binding.version,
      input: input.args,
      argumentsRaw: input.input.argumentsRaw,
      scope: input.input.session,
      phase: input.input.phase,
      audience: [...input.input.audience],
      binding: {
        bindingId: input.binding.bindingId,
        permissionProfile: input.binding.permissionProfile,
        viewConstraints: input.binding.viewConstraints,
      },
      command: input.command,
      output: input.output,
      result,
      argsHash: input.argsHash,
    };
    const rawArtifact = await this.options.artifacts.put({
      artifactId: rawArtifactId,
      runId: input.input.runId,
      kind: "tool-raw",
      value: rawValue as unknown as Json,
    });
    const view = this.options.toolView.render({
      phase: input.input.phase,
      audience: input.input.audience,
      result,
      viewFields: input.definition.viewFields,
      maxListItems: input.binding.viewConstraints.maxListItems,
      maxTokens: input.binding.viewConstraints.maxTokens,
    });
    const viewValue: ViewToolArtifactValue = {
      kind: "tool-call-view",
      rawArtifactId: rawArtifact.artifactId,
      rawContentHash: rawArtifact.contentHash,
      text: view.text,
      omittedFields: view.omittedFields,
      tokenEstimate: view.tokenEstimate,
    };
    const viewArtifact = await this.options.artifacts.put({
      runId: input.input.runId,
      kind: "tool-view",
      value: viewValue as unknown as Json,
    });
    this.attachArtifactsToCall(
      input.toolCall.toolCallId,
      rawArtifact,
      viewArtifact,
      result,
      result.operationId,
      input.toolCall.commandId,
    );
    return {
      providerCallId: input.input.providerCallId,
      toolCallId: input.toolCall.toolCallId,
      toolId: input.binding.toolId,
      result,
      modelText: view.text,
      isError: result.executionStatus !== "ok",
      rawArtifact,
      viewArtifact,
    };
  }

  async loadSettled(row: Readonly<Record<string, StorageCell>>): Promise<ToolCallOutcome> {
    const rawArtifactId = storageString(row, "raw_artifact_id");
    const viewArtifactId = storageString(row, "view_artifact_id");
    const raw = this.options.artifacts.get(rawArtifactId);
    const view = this.options.artifacts.get(viewArtifactId);
    if (raw === null || view === null) throw new Error("settled tool call references a missing artifact");
    const rawValue = raw.value as unknown as RawToolArtifactValue;
    const viewValue = view.value as unknown as ViewToolArtifactValue;
    if (rawValue.kind !== "tool-call-raw" || viewValue.kind !== "tool-call-view") {
      throw new Error("tool artifact kind does not match the call record");
    }
    if (viewValue.rawArtifactId !== raw.artifactId || viewValue.rawContentHash !== raw.contentHash) {
      throw new Error("tool view does not reference the paired raw artifact");
    }
    return {
      providerCallId: storageString(row, "provider_call_id"),
      toolCallId: storageString(row, "tool_call_id"),
      toolId: storageString(row, "tool_id"),
      result: rawValue.result,
      modelText: viewValue.text,
      isError: rawValue.result.executionStatus !== "ok",
      rawArtifact: raw,
      viewArtifact: view,
    };
  }

  identityFromExisting(
    existing: Readonly<Record<string, StorageCell>> | ToolCallIdentity | null,
  ): ToolCallIdentity | null {
    if (isToolCallIdentity(existing)) return existing;
    if (existing === null) return null;
    return {
      toolCallId: storageString(existing, "tool_call_id"),
      commandId: storageNullableString(existing, "command_id"),
    };
  }

  attachArtifactsToCall(
    toolCallId: string,
    rawArtifact: AgentArtifactRecord,
    viewArtifact: AgentArtifactRecord,
    result: ToolExecutionResult,
    operationId: string | null,
    commandId: string | null,
  ): void {
    this.options.storage.transact((tx) => {
      const table = tx.rows("tool_calls");
      const current = table.get({ tool_call_id: toolCallId });
      if (current === null) throw new Error(`tool call ${toolCallId} disappeared`);
      table.put({
        ...current,
        status: "settled",
        operation_id: operationId,
        command_id: commandId,
        execution_status: result.executionStatus,
        raw_artifact_id: rawArtifact.artifactId,
        view_artifact_id: viewArtifact.artifactId,
        settled_at: this.options.host.nowIso(),
      });
    });
  }
}
