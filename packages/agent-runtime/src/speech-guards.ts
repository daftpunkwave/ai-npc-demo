/**
 * 核心职责：对 speech 输出执行 schema、引用、泄密和状态声明四项校验。
 * 交互契约：输入已过滤的可披露引用、受限秘密与当前 turn receipt 状态。
 * 约束与禁忌：不得用关键词检查宣称语义完全安全，也不得修改候选正文。
 */
import type { Json } from "@ai-npc/contracts";

export interface SpeechGenerationOutput {
  readonly utterance: string;
  readonly citedRefs: readonly string[];
}

export interface SpeechSecret {
  readonly secretId: string;
  readonly leakTerms: readonly string[];
}

export interface SpeechReceiptState {
  readonly receiptId: string;
  readonly commandStatus: "accepted" | "rejected" | null;
  readonly taskStatus: "pending" | "running" | "completed" | "failed" | "cancelled" | null;
  readonly detail: string;
}

export interface SpeechGuardInput {
  readonly output: unknown;
  readonly maxChars: number;
  readonly allowedRefs: readonly string[];
  readonly restrictedSecrets: readonly SpeechSecret[];
  readonly receipts: readonly SpeechReceiptState[];
  readonly completionClaims: readonly string[];
  readonly progressClaims: readonly string[];
}

export interface SpeechCheck {
  readonly name: "schema" | "cited-refs" | "leak-terms" | "status-claims";
  readonly passed: boolean;
  readonly reason: string | null;
}

export interface SpeechValidation {
  readonly ok: boolean;
  readonly checks: readonly SpeechCheck[];
}

function isOutput(value: unknown): value is SpeechGenerationOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly utterance?: unknown; readonly citedRefs?: unknown };
  return typeof candidate.utterance === "string" &&
    Array.isArray(candidate.citedRefs) &&
    candidate.citedRefs.every((item) => typeof item === "string") &&
    candidate.citedRefs.length <= 6;
}

export function validateSpeechOutput(input: SpeechGuardInput): SpeechValidation {
  const output = isOutput(input.output) ? input.output : null;
  const schemaPassed = output !== null &&
    output.utterance.length > 0 &&
    Array.from(output.utterance).length <= 160 &&
    Array.from(output.utterance).length <= input.maxChars;
  const allowed = new Set(input.allowedRefs);
  const refsPassed = output !== null && output.citedRefs.every((ref) => allowed.has(ref));
  const utterance = output?.utterance ?? "";
  const leaked = input.restrictedSecrets
    .flatMap((secret) => secret.leakTerms)
    .find((term) => term.length > 0 && utterance.includes(term));
  const leakPassed = leaked === undefined;
  const hasPending = input.receipts.some((receipt) =>
    receipt.taskStatus === "pending" || receipt.taskStatus === "running");
  const hasRejected = input.receipts.some((receipt) => receipt.commandStatus === "rejected");
  const completionClaim = hasPending
    ? input.completionClaims.find((term) => utterance.includes(term))
    : undefined;
  const progressClaim = hasRejected
    ? input.progressClaims.find((term) => utterance.includes(term))
    : undefined;
  const statusPassed = completionClaim === undefined && progressClaim === undefined;
  const checks: SpeechCheck[] = [
    { name: "schema", passed: schemaPassed, reason: schemaPassed ? null : "speech output schema or length is invalid" },
    { name: "cited-refs", passed: refsPassed, reason: refsPassed ? null : "citedRefs contains an undisclosable or unknown reference" },
    { name: "leak-terms", passed: leakPassed, reason: leakPassed ? null : "restricted leak term detected" },
    {
      name: "status-claims",
      passed: statusPassed,
      reason: statusPassed ? null : "completion or progress claim conflicts with receipt status",
    },
  ];
  return { ok: checks.every((check) => check.passed), checks };
}

export function validationAsJson(validation: SpeechValidation): Json {
  return validation as unknown as Json;
}