/**
 * 核心职责：把工具调用按效果分派——query 执行、命令执行与对白消息投递——并结算幂等结果。
 * 交互契约：由工具网关注入 storage、HostServices、工具目录、视图端口与 query/command/message 执行器；
 * 结算结果统一写回 ToolOutcomeStore，本模块不判断调用是否已认证（由网关入口完成）。
 * 约束与禁忌：不信任模型上报的工具身份、不在幂等冲突时复用他人的结果、也不吞掉执行异常。
 */
import {
  DomainError,
  commandReceiptSchema,
  type CommandEnvelope,
  type CommandReceipt,
  type HostServices,
  type Json,
  type StorageCell,
  type StoragePort,
  type ToolBinding,
  type ToolDefinition,
  type ToolResultReasonCode,
} from "@ai-npc/contracts";
import type { AgentToolViewPort } from "@ai-npc/module-sdk";
import type { ToolOutcomeStore } from "./tool-outcome-store";
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
} from "./tool-gateway-types";

/** 工具效果执行需要的注入依赖；与网关共享同一份存储与工具目录。 */
export interface ToolExecutionDeps {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly tools: ToolCatalogPort;
  readonly toolView: AgentToolViewPort;
  readonly store: ToolOutcomeStore;
  readonly executeQuery?: (input: QueryExecutionInput) => Json | Promise<Json>;
  readonly executeCommand: (auth: ToolCallExecutionInput["auth"], envelope: CommandEnvelope) =>
    CommandReceipt | Promise<CommandReceipt>;
  readonly executeMessage?: (input: MessageExecutionInput) =>
    MessageExecutionResult | Promise<MessageExecutionResult>;
  /** 结算失败；由网关提供，保证错误结算与正常结算走同一路径。 */
  // eslint-disable-next-line no-unused-vars -- 回调类型参数名用于表达调用契约。
  readonly settleError: (
    input: ToolCallExecutionInput,
    binding: ToolBinding | null,
    argsHash: string,
    reasonCode: ToolResultReasonCode,
    detail: string,
    existing: Readonly<Record<string, StorageCell>> | ToolCallIdentity | null,
    operationId?: string | null,
    executionStatus?: "error" | "unknown",
  ) => Promise<ToolCallOutcome>;
}

/** query 效果：调用注入的查询执行器并把输出结算为工具结果。 */
export async function executeQueryTool(
  deps: ToolExecutionDeps,
  input: ToolCallExecutionInput,
  binding: ToolBinding,
  definition: ToolDefinition,
  argsHash: string,
  args: Json,
  existing: Readonly<Record<string, StorageCell>> | null,
): Promise<ToolCallOutcome> {
  const current = deps.store.ensureToolCall(input, binding, argsHash, null, null, existing);
  if (deps.executeQuery === undefined) {
    return deps.settleError(input, binding, argsHash, "execution-failed", "Query executor is not configured.", current);
  }
  try {
    const output = await deps.executeQuery({
      toolId: binding.toolId,
      // 查询执行器只接受显式参数：值为 null 的可选字段代表「调用方没给」，
      // 上层据此区分缺省与显式 null，因此必须在调用前剔除。
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
    return await deps.store.persistOutcome({
      input, binding, definition, argsHash, args, command: null, output, partialResult: result, toolCall: current,
    });
  } catch (error) {
    return deps.settleError(input, binding, argsHash, "execution-unknown", errorMessage(error), current, null, "unknown");
  }
}

/** command 效果：解析命令、按 operationId 幂等复用并落 receipt；对白消息走独立执行器。 */
export async function executeCommandTool(
  deps: ToolExecutionDeps,
  input: ToolCallExecutionInput,
  binding: ToolBinding,
  definition: ToolDefinition,
  argsHash: string,
  args: Json,
  existing: Readonly<Record<string, StorageCell>> | null,
): Promise<ToolCallOutcome> {
  const command = deps.tools.resolveCommand({ toolId: binding.toolId, arguments: args });
  const resolvedCommand = "error" in command ? null : command;
  if (resolvedCommand === null && binding.toolId !== "message.send") {
    const error = "error" in command ? command.error : "Command resolution failed.";
    return deps.settleError(input, binding, argsHash, "invalid-params", error, existing);
  }
  const operationId = input.operationId ??
    (existing === null ? null : existing["operation_id"] as string | null) ??
    deps.host.ids("op");
  const operation = deps.storage.transact((tx) =>
    tx.branch(input.session.branchId).table("operations").get({
      agent_id: input.agentId,
      operation_id: operationId,
    }),
  );
  if (operation !== null && operation["payload_hash"] !== argsHash) {
    return deps.settleError(input, binding, argsHash, "idempotency-conflict", "operationId was reused with different arguments.", existing, operationId);
  }
  const reusable = deps.store.findSettledOperation(input, operationId);
  if (reusable !== null) {
    const commandId = reusable["command_id"] as string | null;
    const current = deps.store.ensureToolCall(input, binding, argsHash, operationId, commandId, existing);
    const loaded = await deps.store.loadSettled(reusable);
    deps.store.attachArtifactsToCall(current.toolCallId, loaded.rawArtifact, loaded.viewArtifact, loaded.result, operationId, commandId);
    return { ...loaded, providerCallId: input.providerCallId, toolCallId: current.toolCallId, toolId: binding.toolId };
  }

  const commandId = operation === null ? deps.host.ids("cmd") : operation["command_id"] as string;
  const current = deps.store.ensureToolCall(input, binding, argsHash, operationId, commandId, existing);
  if (operation === null) {
    deps.storage.transact((tx) => {
      tx.branch(input.session.branchId).table("operations").put({
        agent_id: input.agentId,
        operation_id: operationId,
        command_id: commandId,
        payload_hash: argsHash,
        created_at: deps.host.nowIso(),
      });
    });
  }
  try {
    if (binding.toolId === "message.send") {
      return await executeMessageTool(deps, {
        input, binding, definition, argsHash, args, current, operationId, commandId,
      });
    }
    if (resolvedCommand === null) {
      return deps.settleError(input, binding, argsHash, "invalid-params", "Command resolution failed.", current);
    }
    const envelope: CommandEnvelope = {
      commandId,
      type: resolvedCommand.commandType,
      schemaVersion: 1,
      payload: resolvedCommand.payload,
    };
    const receipt = await deps.executeCommand(input.auth, envelope);
    return await persistReceipt(deps, {
      input, binding, definition, argsHash, args, envelope, receipt, current, operationId,
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === "idempotency-conflict") {
      return deps.settleError(input, binding, argsHash, "idempotency-conflict", error.safeMessage, current, operationId);
    }
    return deps.settleError(input, binding, argsHash, "execution-unknown", errorMessage(error), current, operationId, "unknown");
  }
}

/** 已认领的工具调用：命令分支把解析出的身份一并以本对象传递，避免逐个透传参数。 */
interface ClaimedCall {
  readonly input: ToolCallExecutionInput;
  readonly binding: ToolBinding;
  readonly definition: ToolDefinition;
  readonly argsHash: string;
  readonly args: Json;
  readonly current: ToolCallIdentity;
  readonly operationId: string;
  readonly commandId: string;
}

/** 对白消息效果：复用已提交的 receipt，未提交时调用注入的消息执行器。 */
async function executeMessageTool(
  deps: ToolExecutionDeps,
  call: ClaimedCall,
): Promise<ToolCallOutcome> {
  const { input, binding, definition, argsHash, args, current, operationId, commandId } = call;
  if (deps.executeMessage === undefined) {
    return deps.settleError(input, binding, argsHash, "execution-failed", "Message dialogue executor is not configured.", current, operationId);
  }
  const prior = deps.storage.transact((tx) => tx.branch(input.session.branchId)
    .table("command_receipts").get({ principal_id: input.agentId, command_id: commandId }));
  const message = prior === null
    ? await deps.executeMessage({ arguments: args, turn: input, operationId, commandId, providerCallId: input.providerCallId })
    : (() => {
        const receipt = commandReceiptSchema.parse(prior["receipt_json"]);
        return { receipt, output: receipt.result ?? {} };
      })();
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
  return await deps.store.persistOutcome({
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

/** 把命令回执结算为工具结果；operationId 以回执自带的为准。 */
async function persistReceipt(
  deps: ToolExecutionDeps,
  resultInput: {
    readonly input: ToolCallExecutionInput;
    readonly binding: ToolBinding;
    readonly definition: ToolDefinition;
    readonly argsHash: string;
    readonly args: Json;
    readonly envelope: CommandEnvelope;
    readonly receipt: CommandReceipt;
    readonly current: ToolCallIdentity;
    readonly operationId: string;
  },
): Promise<ToolCallOutcome> {
  const { input, binding, definition, argsHash, args, envelope, receipt, current, operationId } = resultInput;
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
  return await deps.store.persistOutcome({
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
