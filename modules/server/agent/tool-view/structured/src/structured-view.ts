/**
 * 核心职责：把完整工具结果压缩为保留状态 envelope 的模型可见 JSON。
 * 交互契约：只从已授权结果中筛字段、截列表和文本，并返回实际 token 估值。
 * 约束与禁忌：不得执行工具、改写 receipt、重新授权或读取 resultRef。
 */
import { estimateTokens, type Json, type ToolExecutionResult } from "@world-prism/contracts";
import type { AgentToolViewPort } from "@world-prism/module-sdk";
import type { StructuredToolViewConfig } from "./definition";

type RenderInput = Parameters<AgentToolViewPort["render"]>[0];

function isRecord(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): string {
  const characters = Array.from(value);
  return characters.length <= maxChars ? value : `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

interface SanitizedValue {
  readonly value: Json;
  readonly omittedCount: number;
  readonly hasList: boolean;
  readonly listLength: number;
}

function sanitizeValue(
  value: Json,
  maxListItems: number,
  maxTextChars: number,
  depth = 0,
): SanitizedValue {
  if (depth > 8) return { value: null, omittedCount: 0, hasList: false, listLength: 0 };
  if (typeof value === "string") {
    return { value: truncateText(value, maxTextChars), omittedCount: 0, hasList: false, listLength: 0 };
  }
  if (Array.isArray(value)) {
    const selected = value.slice(0, maxListItems).map((item) =>
      sanitizeValue(item, maxListItems, maxTextChars, depth + 1).value
    );
    return {
      value: selected,
      omittedCount: Math.max(0, value.length - selected.length),
      hasList: true,
      listLength: selected.length,
    };
  }
  if (isRecord(value)) {
    let omittedCount = 0;
    const entries = Object.entries(value).map(([key, item]) => {
      const sanitized = sanitizeValue(item, maxListItems, maxTextChars, depth + 1);
      omittedCount += sanitized.omittedCount;
      return [key, sanitized.value] as const;
    });
    return { value: Object.fromEntries(entries), omittedCount, hasList: false, listLength: 0 };
  }
  return { value, omittedCount: 0, hasList: false, listLength: 0 };
}

function envelopeOf(result: ToolExecutionResult): { readonly [key: string]: Json } {
  return {
    executionStatus: result.executionStatus,
    commandStatus: result.commandStatus,
    taskStatus: result.taskStatus,
    reasonCode: result.reasonCode,
    receiptId: result.receiptId,
    operationId: result.operationId,
    resultRef: result.resultRef,
  };
}

function tokenEstimateOf(value: Json): number {
  return estimateTokens(JSON.stringify(value));
}

export function renderStructuredView(
  input: RenderInput,
  config: StructuredToolViewConfig,
): ReturnType<AgentToolViewPort["render"]> {
  const maxListItems = Math.max(1, Math.min(input.maxListItems, config.maxListItems));
  const envelope = envelopeOf(input.result);
  const data = isRecord(input.result.data) ? input.result.data : {};
  const viewFields = new Set(input.viewFields);
  const selected: { [key: string]: Json } = {};
  let omittedCount = 0;
  const omittedFields = Object.keys(data).filter((key) => !viewFields.has(key));
  for (const key of viewFields) {
    const value = data[key];
    if (value === undefined) continue;
    const sanitized = sanitizeValue(value, maxListItems, config.maxTextChars);
    selected[key] = sanitized.value;
    omittedCount += sanitized.omittedCount;
  }
  if (config.includeEvidenceRefs && data["evidenceRefs"] !== undefined && selected["evidenceRefs"] === undefined) {
    const sanitized = sanitizeValue(data["evidenceRefs"], maxListItems, config.maxTextChars);
    selected["evidenceRefs"] = sanitized.value;
    omittedCount += sanitized.omittedCount;
  }
  const baseDetails: { [key: string]: Json } = {
    ...envelope,
    omittedFields,
  };
  if (input.result.executionStatus !== "ok" || viewFields.has("detail")) {
    baseDetails["detail"] = truncateText(input.result.detail, config.maxTextChars);
  }
  let dataForOutput: { [key: string]: Json } = { ...selected };
  let currentOmittedCount = omittedCount;
  let output: Json = {
    ...baseDetails,
    data: dataForOutput,
    omittedCount: currentOmittedCount,
  };
  while (tokenEstimateOf(output) > input.maxTokens) {
    const listKey = Object.keys(dataForOutput).find((key) => Array.isArray(dataForOutput[key]));
    if (listKey === undefined) break;
    const values = dataForOutput[listKey];
    if (!Array.isArray(values) || values.length === 0) break;
    dataForOutput = { ...dataForOutput, [listKey]: values.slice(0, -1) };
    currentOmittedCount += 1;
    output = {
      ...baseDetails,
      data: dataForOutput,
      omittedCount: currentOmittedCount,
    };
  }
  if (tokenEstimateOf(output) > input.maxTokens) {
    currentOmittedCount += Object.values(dataForOutput).reduce<number>((total, value) =>
      total + (Array.isArray(value) ? value.length : 0), 0);
    output = {
      ...envelope,
      omittedFields: [...new Set([...omittedFields, ...Object.keys(selected)])],
      omittedCount: currentOmittedCount,
    };
  }  const text = JSON.stringify(output);
  return {
    text,
    omittedFields,
    tokenEstimate: estimateTokens(text),
  };
}