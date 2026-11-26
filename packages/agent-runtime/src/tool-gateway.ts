/**
 * 核心职责：以一次认证 turn 为边界执行工具、强制 binding 收窄、幂等命令与 artifact 视图。
 * 交互契约：依赖 storage、HostServices、AgentToolsPort、AgentToolViewPort 及注入的 query/command executor。
 * 约束与禁忌：不得信任模型 scope、绕过 authority、复用其他主体的结果或让调用缺少配对结果。
 */
import {
  DomainError,
  canonicalJson,
  commandReceiptSchema,
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
  type ToolResultReasonCode,
} from "@ai-npc/contracts";
import type { AgentToolViewPort } from "@ai-npc/module-sdk";
import { StoredAgentArtifactStore, type AgentArtifactStore } from "@ai-npc/module-sdk";
import { ToolOutcomeStore } from "./tool-outcome-store";
import { executeCommandTool, executeQueryTool, type ToolExecutionDeps } from "./tool-execution";
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
  isToolCallIdentity,
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

/**
 * 参数无法规范化序列化时写入 tool_calls.args_hash 的稳定标记。
 * 取值带前缀，不会与真实哈希碰撞；同一 provider call 的重复超预算调用因此判定为同一参数，
 * 而不是被当成「重试改了参数」的幂等冲突。
 */
const OVER_BUDGET_ARGS_HASH = "invalid-json-budget";

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
    const argsHash = await this.argsHashOf(args);
    const existing = this.store.findCall(input);
    if (argsHash === null) {
      // 参数超出 JSON 输入预算：模型输出不是事实，按参数非法结算，不让整个 turn 崩溃。
      // 幂等检查仍然先跑：同一 provider call 重试时，沿用既有结算结果而不是重复结算，
      // 既有成功结算也不会被这条与它无关的参数错误覆盖。
      if (existing !== null && existing["status"] === "settled") {
        // 超预算时无法算出参数摘要，但工具身份仍可校验：同一 provider call 换了工具再重试，
        // 必须报幂等冲突，不能把旧的成功结果当成本次调用的结果返回给模型。
        const settledToolId = this.toolIdForWireName(input.wireName);
        if (settledToolId !== existing["tool_id"]) {
          return this.settleError(
            input,
            null,
            OVER_BUDGET_ARGS_HASH,
            "idempotency-conflict",
            "Tool call retry changed its tool.",
            existing,
          );
        }
        return await this.store.loadSettled(existing);
      }
      return this.settleError(
        input,
        null,
        OVER_BUDGET_ARGS_HASH,
        "invalid-params",
        "Tool arguments exceed the JSON depth, node or type budget.",
        existing,
      );
    }
    if (existing !== null && existing["status"] === "settled") {
      const toolId = this.toolIdForWireName(input.wireName);
      if (toolId === existing["tool_id"] && argsHash === existing["args_hash"]) {
        return await this.store.loadSettled(existing);
      }
      return this.settleError(input, null, argsHash, "idempotency-conflict", "Tool call retry changed its tool or arguments.");
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
    if (toolId === "message.send" && typeof args === "object" && args !== null && !Array.isArray(args)) {
      const recipients = args["to"];
      if (Array.isArray(recipients)) {
        // 定向消息的授权上下文是派发前置条件：缺失时无法证明收件人在授权受众内，一律拒绝。
        // 公开广播按独立的绑定权限判断，不依赖该集合。
        const allowed = input.narrowing.messagePrincipalIds;
        const unauthorized = recipients.includes("public")
          ? recipients.length !== 1 || binding.permissionProfile !== "message-principals-or-public"
          : allowed === undefined || recipients.some((value) => typeof value !== "string" || !allowed.has(value));
        if (unauthorized) {
          return this.settleError(input, binding, argsHash, "no-authority", "Recipient is outside the authorized message audience.");
        }
      }
    }

    if (this.callBudgetExhausted(input, toolId, binding, existing)) {
      return this.settleError(input, binding, argsHash, "budget-exhausted", "Tool call budget is exhausted for this turn.", existing);
    }

    if (definition.effect === "query") {
      return executeQueryTool(this.execution(), input, binding, definition, argsHash, args, existing);
    }
    return executeCommandTool(this.execution(), input, binding, definition, argsHash, args, existing);
  }

  /** 组装工具效果执行所需的依赖；结算与幂等仍复用本网关的同一套实现。 */
  private execution(): ToolExecutionDeps {
    return {
      storage: this.options.storage,
      host: this.options.host,
      tools: this.options.tools,
      toolView: this.options.toolView,
      store: this.store,
      executeQuery: this.options.executeQuery,
      executeCommand: this.options.executeCommand,
      executeMessage: this.options.executeMessage,
      settleError: (input, binding, argsHash, reasonCode, detail, existing, operationId, executionStatus) =>
        this.settleError(input, binding, argsHash, reasonCode, detail, existing, operationId, executionStatus),
    };
  }

  /**
   * 计算工具参数的幂等哈希；参数无法规范化序列化（超出预算或含非 JSON 值）时返回 null。
   * 预算失败不是运行期异常而是拒绝理由：模型输出不充当事实，
   * 超预算参数按 invalid-params 结算，避免 canonicalJson 的 TypeError 打断整个 turn。
   * 只把 TypeError 当作「参数不可序列化」；host.hash 的其他异常照常向上抛，
   * 避免把真实故障误判成参数非法。
   */
  private async argsHashOf(args: Json): Promise<string | null> {
    let canonical: string;
    try {
      canonical = canonicalJson(args);
    } catch (error) {
      if (error instanceof TypeError) {
        return null;
      }
      throw error;
    }
    return this.options.host.hash(canonical);
  }

  private async settleError(
    input: ToolCallExecutionInput,
    binding: ToolBinding | null,
    argsHash: string,
    reasonCode: ToolResultReasonCode,
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
    // 既有已结算调用不被后续错误覆盖：幂等语义要求同一 provider call 的首次结算结果保持权威。
    if (!isToolCallIdentity(existing) && existing !== null && existing["status"] === "settled") {
      return await this.store.loadSettled(existing);
    }
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
      // data 只放可枚举的短标记：超出预算的参数本身不可序列化，不能进入结算结果。
      data: { error: reasonCode },
    });
    return await this.store.persistOutcome({
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
    if (field === null) return null;
    if (allowedValues === undefined) return "Dynamic authorization is missing for this tool.";
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
    // 配额只需要「本 turn 该工具已调用几次」，交给 SQL 走 COUNT；list 会把每条历史调用整行解码，
    // 成本随会话累计的调用数增长，而这里只需要一个计数。
    const priorCalls = this.options.storage.transact((tx) => tx.rows("tool_calls").count({
      run_id: input.runId,
      turn_id: input.turnId,
      tool_id: toolId,
    }));
    // 同一 provider call 的既有结果不占用额外名额：它本身就是这次调用的重放目标。
    return (currentId === null ? priorCalls : priorCalls - 1) >= binding.maxCallsPerTurn;
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
