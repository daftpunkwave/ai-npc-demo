/**
 * 核心职责：定义工具网关的 turn、执行、artifact 与错误结果本地类型及纯数据辅助。
 * 交互契约：只依赖 contracts、module-sdk 与 artifact 记录，不访问存储或执行工具。
 * 约束与禁忌：不得信任模型 scope，也不得在辅助函数中生成 ID 或调用命令。
 */
import {
  type AuthContext,
  type CommandEnvelope,
  type CommandReceipt,
  type Json,
  type MemoryScope,
  type StorageCell,
  type ToolBinding,
  type ToolExecutionResult,
} from "@ai-npc/contracts";
import type { AgentToolsPort } from "@ai-npc/module-sdk";
import type { AgentArtifactRecord } from "@ai-npc/module-sdk";
import type { ToolNarrowingValues } from "./tool-narrowing";

export interface ToolCatalogPort extends AgentToolsPort {
  bindingFor?(agentId: string, toolId: string, version: string): ToolBinding | null;
  validateArguments?(toolId: string, args: Json): { readonly ok: true } | { readonly ok: false; readonly error: string };
}

export interface ToolGatewayTurn {
  readonly session: MemoryScope;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly round: number;
  readonly phase: "decision" | "speech";
  readonly audience: readonly string[];
  readonly auth: AuthContext;
  readonly narrowing: ToolNarrowingValues;
}

export interface QueryExecutionInput {
  readonly toolId: string;
  readonly arguments: Json;
  readonly turn: ToolGatewayTurn;
}

export interface MessageExecutionInput {
  readonly arguments: Json;
  readonly turn: ToolGatewayTurn;
  readonly operationId: string;
  readonly commandId: string;
  readonly providerCallId: string;
}

export interface MessageExecutionResult {
  readonly receipt: CommandReceipt;
  readonly output: Json;
}

export interface ToolCallExecutionInput extends ToolGatewayTurn {
  readonly providerCallId: string;
  readonly wireName: string;
  readonly arguments: Json | null;
  readonly argumentsRaw: string;
  readonly operationId?: string;
}

export interface ToolCallOutcome {
  readonly providerCallId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly result: ToolExecutionResult;
  readonly modelText: string;
  readonly isError: boolean;
  readonly rawArtifact: AgentArtifactRecord;
  readonly viewArtifact: AgentArtifactRecord;
}

export interface ToolCallIdentity {
  readonly toolCallId: string;
  readonly commandId: string | null;
}

export interface RawToolArtifactValue {
  readonly kind: "tool-call-raw";
  readonly toolCallId: string;
  readonly providerCallId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: Json;
  readonly argumentsRaw: string;
  readonly scope: MemoryScope;
  readonly phase: "decision" | "speech";
  readonly audience: readonly string[];
  readonly binding: Json;
  readonly command: Json | null;
  readonly output: Json;
  readonly result: ToolExecutionResult;
  readonly argsHash: string;
}

export interface ViewToolArtifactValue {
  readonly kind: "tool-call-view";
  readonly rawArtifactId: string;
  readonly rawContentHash: string;
  readonly text: string;
  readonly omittedFields: readonly string[];
  readonly tokenEstimate: number;
}

export function isJsonRecord(value: unknown): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function storageString(row: Readonly<Record<string, StorageCell>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`tool row field ${key} is not a string`);
  return value;
}

export function storageNullableString(row: Readonly<Record<string, StorageCell>>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`tool row field ${key} is not a nullable string`);
  return value;
}

export function dropNullFields(value: Json): Json {
  if (Array.isArray(value)) return value.map(dropNullFields);
  if (!isJsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, dropNullFields(item)]),
  );
}

export function taskStatusFrom(receipt: CommandReceipt): ToolExecutionResult["taskStatus"] {
  if (!isJsonRecord(receipt.result)) return null;
  const status = receipt.result["taskStatus"];
  return status === "pending" || status === "running" || status === "completed" ||
    status === "failed" || status === "cancelled" ? status : null;
}

export function resultWithoutRef(input: {
  readonly executionStatus: ToolExecutionResult["executionStatus"];
  readonly commandStatus: ToolExecutionResult["commandStatus"];
  readonly taskStatus: ToolExecutionResult["taskStatus"];
  readonly reasonCode: string | null;
  readonly receiptId: string | null;
  readonly operationId: string | null;
  readonly detail: string;
  readonly data: Json;
}): ToolExecutionResult {
  return { ...input, resultRef: "pending-artifact" };
}

export function isToolCallIdentity(value: unknown): value is ToolCallIdentity {
  return typeof value === "object" && value !== null &&
    "toolCallId" in value && typeof value.toolCallId === "string" &&
    "commandId" in value && (typeof value.commandId === "string" || value.commandId === null);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
