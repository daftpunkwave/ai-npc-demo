/**
 * 核心职责：把平铺模型参数转换为严格领域命令 payload。
 * 交互契约：先删除用于占位的 null，再按工具类型完成最终 schema 校验。
 * 约束与禁忌：不得调用命令网关、生成 ID 或信任模型提供的 scope。
 */
import {
  agreementProposePayloadSchema,
  agreementRespondPayloadSchema,
  informationSharePayloadSchema,
  policySetPayloadSchema,
  taskCancelPayloadSchema,
  taskDispatchPayloadSchema,
  taskRespondPayloadSchema,
  termSchema,
  type Json,
} from "@world-prism/contracts";
import type { AgentToolsPort } from "@world-prism/module-sdk";
import { gameToolInputSchemas, type GameToolId } from "./schemas";

type ResolveResult = ReturnType<AgentToolsPort["resolveCommand"]>;

function isRecord(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dropNullFields(value: Json): Json {
  if (Array.isArray(value)) return value.map(dropNullFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, dropNullFields(item)]),
  );
}

function parseCommand<T>(
  commandType: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
  payload: Json,
): { readonly commandType: string; readonly payload: T } | { readonly error: string } {
  const parsed = schema.safeParse(payload);
  return parsed.success ? { commandType, payload: parsed.data } : { error: parsed.error.message };
}

function normalizeTerm(value: Json): Json {
  const normalized = dropNullFields(value);
  if (isRecord(normalized) && normalized["kind"] === "delegate" && normalized["stockpileId"] === undefined) {
    return { ...normalized, stockpileId: null };
  }
  return normalized;
}

function dispatchPayload(value: Json): { readonly payload: Json } | { readonly error: string } {
  const parsed = gameToolInputSchemas["asset.dispatch"].safeParse(value);
  if (!parsed.success) return { error: parsed.error.message };
  const input = parsed.data;
  const required = (field: string, item: Json | null): Json => {
    if (item === null) throw new Error(`${field} is required for ${input.taskType}`);
    return item;
  };
  try {
    let params: Json;
    switch (input.taskType) {
      case "transport":
        params = {
          fromStockpileId: required("fromStockpileId", input.fromStockpileId),
          toStockpileId: required("toStockpileId", input.toStockpileId),
          cargo: required("cargo", input.cargo),
        };
        break;
      case "escort":
        params = {
          roadId: required("roadId", input.roadId),
          ...(input.durationTicks === null ? {} : { durationTicks: input.durationTicks }),
        };
        break;
      case "rescue":
        params = {
          groupId: required("groupId", input.groupId),
          toNodeId: required("toNodeId", input.toNodeId),
          medicalStockpileId: required("medicalStockpileId", input.medicalStockpileId),
        };
        break;
      case "repair":
        params = {
          target: "relay",
          energyStockpileId: required("energyStockpileId", input.energyStockpileId),
          supplyStockpileId: input.supplyStockpileId,
        };
        break;
      case "scout":
        params = { nodeId: required("nodeId", input.nodeId) };
        break;
    }
    const payload = {
      taskType: input.taskType,
      teamId: input.teamId,
      invitees: input.invitees,
      ...(input.departAfterTicks === null ? {} : { departAfterTicks: input.departAfterTicks }),
      params,
    };
    const validated = taskDispatchPayloadSchema.safeParse(payload);
    return validated.success ? { payload: validated.data } : { error: validated.error.message };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveGameToolCommand(toolId: GameToolId, args: Json): ResolveResult {
  const inputSchema = gameToolInputSchemas[toolId];
  const input = inputSchema.safeParse(args);
  if (!input.success) return { error: input.error.message };
  const clean = dropNullFields(args);
  switch (toolId) {
    case "message.send":
      return { error: "message.send is handled by the dialogue flow" };
    case "information.share":
      return parseCommand("information.share", informationSharePayloadSchema, clean) as ResolveResult;
    case "agreement.propose": {
      const value = clean as unknown as { readonly terms: readonly Json[] };
      const payload = {
        ...(clean as { readonly [key: string]: Json }),
        terms: value.terms.map(normalizeTerm),
      };
      return parseCommand("agreement.propose", agreementProposePayloadSchema, payload) as ResolveResult;
    }
    case "agreement.respond": {
      if (!isRecord(clean) || clean["counterTerms"] === undefined) {
        return parseCommand("agreement.respond", agreementRespondPayloadSchema, clean) as ResolveResult;
      }
      const counterTerms = clean["counterTerms"];
      if (!Array.isArray(counterTerms)) return { error: "counterTerms must be an array" };
      return parseCommand("agreement.respond", agreementRespondPayloadSchema, {
        ...clean,
        counterTerms: counterTerms.map(normalizeTerm),
      }) as ResolveResult;
    }
    case "asset.dispatch": {
      const dispatched = dispatchPayload(args);
      return "error" in dispatched
        ? dispatched
        : parseCommand("task.dispatch", taskDispatchPayloadSchema, dispatched.payload) as ResolveResult;
    }
    case "task.respond":
      return parseCommand("task.respond", taskRespondPayloadSchema, clean) as ResolveResult;
    case "task.cancel":
      return parseCommand("task.cancel", taskCancelPayloadSchema, clean) as ResolveResult;
    case "policy.set":
      return parseCommand("policy.set", policySetPayloadSchema, clean) as ResolveResult;
  }
  return { error: "unsupported command tool" };
}

export { termSchema };