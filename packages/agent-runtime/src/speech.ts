/**
 * 把已裁决的 dialogueIntent 渲染为安全模板对白。
 * 依赖内容包模板、可披露事实摘要和回执状态；不调用模型。
 * 禁止加入 decisionNote、秘密正文或未完成任务的完成声明。
 */
import type { ContentPack } from "@ai-npc/experiment";
import type { DecisionSubmission, DialogueIntent, Json, ToolExecutionResult } from "@ai-npc/contracts";

export interface SafeSpeechInput {
  readonly content: ContentPack;
  readonly decision: DecisionSubmission;
  readonly facts: readonly string[];
  readonly receipts: readonly ToolExecutionResult[];
  readonly subject: string | null;
}

function reasonText(content: ContentPack, intent: DialogueIntent): string {
  return content.prompts.speechReasons[intent.reasonCode] ?? "";
}

function factsText(content: ContentPack, facts: readonly string[]): string {
  const selected = facts.map((fact) => fact.trim()).filter((fact) => fact.length > 0).slice(0, 2);
  if (selected.length === 0) return content.prompts.speechNoFacts;
  return selected.map((fact) => fact.length > 40 ? `${fact.slice(0, 39)}…` : fact).join("；");
}

function receiptsText(receipts: readonly ToolExecutionResult[]): string {
  const latest = receipts.at(-1);
  if (latest === undefined) return "";
  if (latest.commandStatus === "rejected") return `没有办成，${latest.detail}`;
  if (latest.taskStatus === "pending" || latest.taskStatus === "running") return latest.detail;
  return latest.detail;
}

export function renderSafeSpeech(input: SafeSpeechInput): string {
  const intent = input.decision.dialogueIntent;
  if (intent.kind === "none") return "";
  const template = input.content.prompts.speechTemplates[intent.kind];
  const values: Readonly<Record<string, string>> = {
    facts: factsText(input.content, input.facts),
    reason: reasonText(input.content, intent),
    receipt: receiptsText(input.receipts),
    subject: input.subject ?? "我们说好的事",
  };
  const rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key: string) => values[key] ?? "");
  return rendered.length === 0 ? "我知道了。" : rendered;
}

/** 关键状态词检查；失败时由调用方改用安全模板。 */
export function validateSpeechText(input: {
  readonly text: string;
  readonly maxChars: number;
  readonly citations: readonly string[];
  readonly allowedRefs: readonly string[];
  readonly leakTerms: readonly string[];
  readonly hasPendingTask: boolean;
  readonly hasRejectedCommand: boolean;
  readonly content: ContentPack;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if ([...input.text].length > input.maxChars) return { ok: false, reason: "too-long" };
  if (input.citations.some((ref) => !input.allowedRefs.includes(ref))) {
    return { ok: false, reason: "unknown-citation" };
  }
  if (input.leakTerms.some((term) => term.length > 0 && input.text.includes(term))) {
    return { ok: false, reason: "secret-leak" };
  }
  if (
    input.hasPendingTask &&
    input.content.locale.lexicons.completionClaims.some((term) => input.text.includes(term))
  ) {
    return { ok: false, reason: "premature-completion" };
  }
  if (
    input.hasRejectedCommand &&
    input.content.locale.lexicons.progressClaims.some((term) => input.text.includes(term))
  ) {
    return { ok: false, reason: "rejected-progress-claim" };
  }
  return { ok: true };
}
