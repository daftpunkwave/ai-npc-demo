/**
 * 核心职责：用内容包安全模板生成通过披露与状态约束的兜底对白。
 * 交互契约：只接收已过滤事实、intent、理由与 receipt 状态。
 * 约束与禁忌：不得拼接未披露秘密、自由文本理由或未来完成承诺。
 */
import type { DialogueIntent, Json } from "@ai-npc/contracts";
import type { ContentPack } from "@ai-npc/experiment";
import type { SpeechFact } from "./disclosure";
import type { SpeechReceiptState } from "./speech-guards";

export interface SafeSpeechInput {
  readonly intent: DialogueIntent;
  readonly facts: readonly SpeechFact[];
  readonly receipts: readonly SpeechReceiptState[];
  readonly subject: string;
  readonly maxChars: number;
  readonly prompts: ContentPack["prompts"];
}

function limitText(text: string, maxChars: number): string {
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function factsText(input: SafeSpeechInput): string {
  const values = input.facts.slice(0, 2).map((fact) => limitText(fact.summaryZh, 40));
  return values.length === 0 ? "" : values.join("；");
}

function receiptText(receipts: readonly SpeechReceiptState[], prompts: ContentPack["prompts"]): string {
  if (receipts.some((receipt) => receipt.commandStatus === "rejected")) return "这项请求被拒绝了。";
  if (receipts.some((receipt) => receipt.taskStatus === "pending" || receipt.taskStatus === "running")) {
    return "已经安排，仍在进行。";
  }
  if (receipts.some((receipt) => receipt.taskStatus === "completed")) return "这件事已经有结果了。";
  if (receipts.some((receipt) => receipt.taskStatus === "failed")) return "这件事没有成功。";
  if (receipts.length > 0) return "结果还在确认。";
  return prompts.speechNoFacts;
}

function replaceToken(template: string, token: string, value: string): string {
  return template.replaceAll(`{${token}}`, value);
}

export function renderSafeSpeech(input: SafeSpeechInput): string {
  const kind = input.intent.kind;
  if (kind === "none") throw new Error("cannot render speech for intent none");
  const facts = factsText(input);
  const reason = input.prompts.speechReasons[input.intent.reasonCode] ?? "";
  const template = input.prompts.speechTemplates[kind];
  let text = template;
  text = replaceToken(text, "facts", facts);
  text = replaceToken(text, "reason", reason);
  text = replaceToken(text, "receipt", receiptText(input.receipts, input.prompts));
  text = replaceToken(text, "subject", input.subject.length === 0 ? "我们说好的事" : input.subject);
  if (facts.length === 0 && (kind === "answer" || kind === "inform" || kind === "warn")) {
    text = input.prompts.speechNoFacts;
  }
  text = text.replace(/[，：:\s]+$/u, "").trim();
  if (text.length === 0) text = input.prompts.speechNoFacts;
  return limitText(text, input.maxChars);
}
