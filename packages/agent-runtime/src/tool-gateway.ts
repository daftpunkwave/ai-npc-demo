/**
 * 核心职责：以一次认证 turn 为边界执行工具、强制 binding 收窄、幂等命令与 artifact 视图。
 * 交互契约：依赖 storage、HostServices、AgentToolsPort、AgentToolViewPort 及注入的 query/command executor。
 * 约束与禁忌：不得信任模型 scope、绕过 authority、复用其他主体的结果或让调用缺少配对结果。
 */
import {
  canonicalJson,
  type AuthContext,
  type CommandEnvelope,
  type CommandReceipt,
  type HostServices,
  type Json,
  type NormalizedMessage,
  type NormalizedToolCall,
  type StoragePort,
  type ToolBinding,
  type ToolDefinition,
  type ToolExecutionResult,
} from "@ai-npc/contracts";
import type { AgentToolViewPort } from "@ai-npc/module-sdk";
import { StoredAgentArtifactStore, type AgentArtifactStore } from "./artifact-store";
import { ToolOutcomeStore } from "./tool-outcome-store";
import {
  allowedDynamicValues,
  dynamicFieldName,
  narrowToolsForTurn,
  type ToolNarrowingValues,
  type ToolRequestProjection,
} from "./tool-narrowing";
import {
  dropNullFields,
  errorMessage,
  resultWithoutRef,
  taskStatusFrom,
  type MessageExecutionInput,
  type MessageExecutionResult,
  type QueryExecutionInput,
  type ToolCallExecutionInput,
  type ToolCallIdentity,
  type ToolCallOutcome,
  type ToolCatalogPort,
  type ToolGatewayTurn,
} from "./tool-gateway-types";

export type {
  MessageExecutionInput,
  MessageExecutionResult,
  QueryExecutionInput,
  ToolCallExecutionInput,
  ToolCallOutcome,
  ToolCatalogPort,
  ToolGatewayTurn,
} from "./tool-gateway-types";

export interface ToolGatewayOptions {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly tools: ToolCatalogPort;
  readonly toolView: AgentToolViewPort;
  readonly artifacts?: AgentArtifactStore;
  readonly executeQuery?: (input: QueryExecutionInput) => Json | Promise<Json>;
  readonly executeCommand: (auth: AuthContext, envelope: CommandEnvelope) => CommandReceipt | Promise<CommandReceipt>;
  readonly executeMessage?: (input: MessageExecutionInput) => MessageExecutionResult | Promise<MessageExecutionResult>;
}

export class ToolGateway {
  private readonly store: ToolOutcomeStore;

  constructor(private readonly options: ToolGatewayOptions) {
    const artifacts = options.artifacts ?? new StoredAgentArtifactStore(options.storage, options.host);
    this.store = new ToolOutcomeStore({
      storage: options.storage,
      host: options.host,
      artifacts,
      toolView: options.toolView,
    });
  }

  projectTools(turn: ToolGatewayTurn): ToolRequestProjection {
    return narrowToolsForTurn(this.options.tools, turn.agentId, turn.narrowing);
  }

  async executeCalls(
    turn: ToolGatewayTurn,
    calls: readonly NormalizedToolCall[],
  ): Promise<readonly ToolCallOutcome[]> {
    const outcomes: ToolCallOutcome[] = [];
    for (const call of calls) {
      outcomes.push(await this.executeCall({
        ...turn,
        providerCallId: call.id,
        wireName: call.name,
        arguments: call.arguments,
        argumentsRaw: call.argumentsRaw,
      }));
    }
    return outcomes;
  }

  resultMessages(outcomes: readonly ToolCallOutcome[]): readonly NormalizedMessage[] {
    return outcomes.map((outcome) => ({
      role: "tool",
      toolCallId: outcome.providerCallId,
      content: outcome.modelText,
      isError: outcome.isError,
    }));
  }

  async executeCall(input: ToolCallExecutionInput): Promise<ToolCallOutcome> {
    this.assertAuthenticatedTurn(input);
    const args = input.arguments ?? {};
    const argsHash = await this.options.host.hash(canonicalJson(args));
    const existing = this.store.findCall(input);
    if (existing !== null && existing["status"] === "settled") {
      const toolId = this.toolIdForWireName(input.wireName);
      if (toolId === existing["tool_id"] && argsHash === existing["args_hash"]) {
        return this.store.loadSettled(existing);
      }
      return this.settleError(input, null, argsHash, "idempotency-conflict", "Tool call retry changed its tool or arguments.", existing);
    }

    const toolId = this.toolIdForWireName(input.wireName);
    if (toolId === null) return this.settleError(input, null, argsHash, "invalid-params", "Unknown model tool name.");
    const projection = this.projectTools(input);
    const binding = projection.bindings.find((item) => item.toolId === toolId);
    if (binding === undefined) {
      return this.settleError(input, null, argsHash, "no-authority", "Tool is unavailable or its dynamic enum is empty.");
    }
    const definition = this.options.tools.definition(toolId, binding.version);
    if (definition === null) return this.settleError(input, binding, argsHash, "invalid-params", "Tool definition is missing.");
    if (input.arguments === null) return this.settleError(input, binding, argsHash, "invalid-params", "Tool arguments are not valid JSON.");
    const dynamicError = this.validateDynamicArguments(toolId, args, input.narrowing);
    if (dynamicError !== null) return this.settleError(input, binding, argsHash, "no-authority", dynamicError);
    const validation = this.options.tools.validateArguments?.(toolId, args) ?? { ok: true as const };
    if (!validation.ok) return this.settleError(input, binding, argsHash, "invalid-params", validation.error);

    if (this.callBudgetExhausted(input, toolId, binding, existing)) {
      return this.settleError(input, binding, argsHash, "budget-exhausted", "Tool call budget is exhausted for this turn.", existing);
    }

    if (definition.effect === "query") {
      return this.executeQueryTool(input, binding, definition, argsHash, args, existing);
    }
    return this.executeCommandTool(input, binding, definition, argsHash, args, existing);
  }

  private async executeQueryTool(
    input: ToolCallExecutionInput,
    binding: ToolBinding,
    definition: ToolDefinition,
    argsHash: string,
    args: Json,
    existing: Readonly<Record<string, import("@ai-npc/contracts").StorageCell>> | null,
  ): Promise<ToolCallOutcome> {
    const current = this.store.ensureToolCall(input, binding, argsHash, null, null, existing);
    if (this.options.executeQuery === undefined) {
      return this.settleError(input, binding, argsHash, "execution-failed", "Query executor is not configured.", current);
    }
    try {
      const output = await this.options.executeQuery({
        toolId: binding.toolId,
        arguments: dropNullFields(args),
        turn: input,
      });
      const result = resultWithoutRef({
        executionStatus: "ok",
        commandStatus: null,
        taskStatus: null,
        reasonCode: null,
        receiptId: null,
        operationId: null,
        detail: "Query completed.",
        data: output,
      });
      return this.store.persistOutcome({ input, binding, definition, argsHash, args, command: null, output, partialResult: result, toolCall: current });
    } catch (error) {
      return this.settleError(input, binding, argsHash, "execution-unknown", errorMessage(error), current, null, "unknown");
    }
  }

  private async executeCommandTool(
    input: ToolCallExecutionInput,
    binding: ToolBinding,
    definition: ToolDefinition,
    argsHash: string,
    args: Json,
    existing: Readonly<Record<string, import("@ai-npc/contracts").StorageCell>> | null,
  ): Promise<ToolCallOutcome> {
    const command = this.options.tools.resolveCommand({ toolId: binding.toolId, arguments: args });
    const resolvedCommand = "error" in command ? null : command;
    if (resolvedCommand === null && binding.toolId !== "message.send") {
      const error = "error" in command ? command.error : "Command resolution failed.";
      return this.settleError(input, binding, argsHash, "invalid-params", error, existing);
    }
    const operationId = input.operationId ??
      (existing === null ? null : existing["operation_id"] as string | null) ??
      this.options.host.ids("op");
    const operation = this.options.storage.transact((tx) =>
      tx.branch(input.session.branchId).table("operations").get({
        agent_id: input.agentId,
        operation_id: operationId,
      }),
    );
    if (operation !== null && operation["payload_hash"] !== argsHash) {
      return this.settleError(input, binding, argsHash, "idempotency-conflict", "operationId was reused with different arguments.", existing, operationId);
    }
    const reusable = this.store.findSettledOperation(input, operationId);
    if (reusable !== null) {
      const commandId = reusable["command_id"] as string | null;
      const current = this.store.ensureToolCall(input, binding, argsHash, operationId, commandId, existing);
      const loaded = this.store.loadSettled(reusable);
      this.store.attachArtifactsToCall(current.toolCallId, loaded.rawArtifact, loaded.viewArtifact, loaded.result, operationId, commandId);
      return { ...loaded, providerCallId: input.providerCallId, toolCallId: current.toolCallId, toolId: binding.toolId };
    }

    const commandId = operation === null ? this.options.host.ids("cmd") : operation["command_id"] as string;
    const current = this.store.ensureToolCall(input, binding, argsHash, operationId, commandId, existing);
    if (operation === null) {
      this.options.storage.transact((tx) => {
        tx.branch(input.session.branchId).table("operations").put({
          agent_id: input.agentId,
          operation_id: operationId,
          command_id: commandId,
          payload_hash: argsHash,
          created_at: this.options.host.nowIso(),
        });
      });
    }
    try {
      if (binding.toolId === "message.send") {
        return this.executeMessageTool(input, binding, definition, argsHash, args, current, operationId, commandId);
      }
      if (resolvedCommand === null) {
        return this.settleError(input, binding, argsHash, "invalid-params", "Command resolution failed.", current);
      }
      const envelope: CommandEnvelope = {
        commandId,
        type: resolvedCommand.commandType,
        schemaVersion: 1,
        payload: resolvedCommand.payload,
      };
      const receipt = await this.options.executeCommand(input.auth, envelope);
      return this.persistReceipt(input, binding, definition, argsHash, args, envelope, receipt, current, operationId);
    } catch (error) {
      return this.settleError(input, binding, argsHash, "execution-unknown", errorMessage(error), current, operationId, "unknown");
    }
  }

  private async executeMessageTool(
    input: ToolCallExecutionInput,
    binding: ToolBinding,
    definition: ToolDefinition,
    argsHash: string,
    args: Json,
    current: ToolCallIdentity,
    operationId: string,
    commandId: string,
  ): Promise<ToolCallOutcome> {
    if (this.options.executeMessage === undefined) {
      return this.settleError(input, binding, argsHash, "execution-failed", "Message dialogue executor is not configured.", current, operationId);
    }
    const message = await this.options.executeMessage({
      arguments: dropNullFields(args),
      turn: input,
      operationId,
      commandId,
      providerCallId: input.providerCallId,
    });
    const result = resultWithoutRef({
      executionStatus: "ok",
      commandStatus: message.receipt.commandStatus,
      taskStatus: taskStatusFrom(message.receipt),
      reasonCode: message.receipt.reasonCode,
      receiptId: message.receipt.receiptId,
      operationId,
      detail: message.receipt.safeMessage ?? (message.receipt.commandStatus === "accepted" ? "Message accepted." : "Message rejected."),
      data: message.output,
    });
    return this.store.persistOutcome({
      input,
      binding,
      definition,
      argsHash,
      args,
      command: { type: "speech.commit", operationId, commandId },
      output: message.output,
      partialResult: result,
      toolCall: current,
    });
  }

  private persistReceipt(
    input: ToolCallExecutionInput,
    binding: ToolBinding,
    definition: ToolDefinition,
    argsHash: string,
    args: Json,
    envelope: CommandEnvelope,
    receipt: CommandReceipt,
    current: ToolCallIdentity,
    operationId: string,
  ): Promise<ToolCallOutcome> {
    const result = resultWithoutRef({
      executionStatus: "ok",
      commandStatus: receipt.commandStatus,
      taskStatus: taskStatusFrom(receipt),
      reasonCode: receipt.reasonCode,
      receiptId: receipt.receiptId,
      operationId: receipt.operationId ?? operationId,
      detail: receipt.safeMessage ?? (receipt.commandStatus === "accepted" ? "Command accepted." : "Command rejected."),
      data: receipt.result ?? {},
    });
    return this.store.persistOutcome({
      input,
      binding,
      definition,
      argsHash,
      args,
      command: envelope as unknown as Json,
      output: receipt.result ?? {},
      partialResult: result,
      toolCall: current,
    });
  }

  private async settleError(
    input: ToolCallExecutionInput,
    binding: ToolBinding | null,
    argsHash: string,
    reasonCode: string,
    detail: string,
    existing: Readonly<Record<string, import("@ai-npc/contracts").StorageCell>> | ToolCallIdentity | null = null,
    operationId: string | null = null,
    executionStatus: "error" | "unknown" = "error",
  ): Promise<ToolCallOutcome> {
    const fallbackToolId = this.toolIdForWireName(input.wireName) ?? input.wireName;
    const effectiveBinding = binding ?? {
      bindingId: `unbound:${input.agentId}`,
      agentId: input.agentId,
      toolId: fallbackToolId,
      version: "1",
      permissionProfile: "none",
      maxCallsPerTurn: 0,
      viewConstraints: { maxListItems: 1, maxTokens: 150 },
    } satisfies ToolBinding;
    const definition = binding === null
      ? {
        toolId: fallbackToolId,
        version: "1",
        description: "",
        effect: "query" as const,
        commandType: null,
        inputSchema: {},
        outputSchema: {},
        viewFields: [],
        permissionProfile: "none",
      } satisfies ToolDefinition
      : this.options.tools.definition(binding.toolId, binding.version);
    if (definition === null) throw new Error("tool definition disappeared during error settlement");
    const current = this.store.identityFromExisting(existing) ??
      this.store.ensureToolCall(input, effectiveBinding, argsHash, operationId, null, null);
    const result = resultWithoutRef({
      executionStatus,
      commandStatus: null,
      taskStatus: null,
      reasonCode,
      receiptId: null,
      operationId,
      detail,
      data: { error: reasonCode },
    });
    return this.store.persistOutcome({
      input,
      binding: effectiveBinding,
      definition,
      argsHash,
      args: input.arguments ?? {},
      command: null,
      output: { error: reasonCode },
      partialResult: result,
      toolCall: current,
    });
  }

  private validateDynamicArguments(
    toolId: string,
    args: Json,
    narrowing: ToolNarrowingValues,
  ): string | null {
    const field = dynamicFieldName(toolId);
    const allowedValues = allowedDynamicValues(toolId, narrowing);
    if (field === null || allowedValues === undefined) return null;
    const rawValue = typeof args === "object" && args !== null && !Array.isArray(args) ? args[field] : undefined;
    return typeof rawValue === "string" && allowedValues.includes(rawValue)
      ? null
      : "Tool parameter is outside the current binding.";
  }

  private callBudgetExhausted(
    input: ToolCallExecutionInput,
    toolId: string,
    binding: ToolBinding,
    existing: Readonly<Record<string, import("@ai-npc/contracts").StorageCell>> | null,
  ): boolean {
    const currentId = existing === null ? null : existing["tool_call_id"];
    const priorCalls = this.options.storage.transact((tx) => tx.rows("tool_calls").list({
      run_id: input.runId,
      turn_id: input.turnId,
      tool_id: toolId,
    })).filter((row) => row["tool_call_id"] !== currentId);
    return priorCalls.length >= binding.maxCallsPerTurn;
  }

  private assertAuthenticatedTurn(input: ToolGatewayTurn): void {
    if (input.auth.branchId !== input.session.branchId || input.auth.worldId !== input.session.worldId) {
      throw new Error("tool turn auth scope does not match session scope");
    }
    if ((input.auth.actingAsAgentId ?? input.auth.principalId) !== input.agentId) {
      throw new Error("tool turn auth subject does not match agentId");
    }
    if (input.auth.turnId !== null && input.auth.turnId !== input.turnId) {
      throw new Error("tool turn auth turnId does not match the active turn");
    }
  }

  private toolIdForWireName(wireName: string): string | null {
    for (const definition of this.options.tools.definitions()) {
      if (definition.toolId.replaceAll(".", "_") === wireName) return definition.toolId;
    }
    return null;
  }
}