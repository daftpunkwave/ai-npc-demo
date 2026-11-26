/**
 * 构造目标受众有权读取的本轮操作回执。
 * 通过工具归档的命令 ID 找回权威 receipt，并逐项校验它关联的提交事件。
 * 禁止用模型声明代替回执或向受众提供未知披露范围的操作明细。
 */
import { audienceSpecSchema, commandReceiptSchema, jsonValueSchema, taskDispatchedPayloadSchema, type StoragePort } from "@world-prism/contracts";
import type { SpeechApprovalInput } from "./dialogue-flow";
import { isDisclosable, type SpeechFact } from "./disclosure";
import { observationReleasePolicy } from "./observation-renderer";
import { asRecord } from "./runtime-records";
import { taskStatusFrom, type ToolCallOutcome } from "./tool-gateway-types";

function refersTo(value: unknown, ref: string): boolean {
  const { taskId, agreementId, invitationId, evidenceId } = asRecord(value);
  return [taskId, agreementId, invitationId, evidenceId].includes(ref);
}

export function disclosedTurnReceipts(
  storage: StoragePort, speech: SpeechApprovalInput, outcomes: readonly ToolCallOutcome[],
): Pick<SpeechApprovalInput, "receipts" | "facts" | "subjectLine"> {
  const { subjectRef } = speech.intent;
  const fallback = { receipts: [], facts: speech.facts, subjectLine: speech.subjectLine };
  if (outcomes.length === 0 || subjectRef === null || speech.intent.audience.length === 0) return fallback;
  const context = { audience: speech.intent.audience, principalFactions: speech.principalFactions, heldEvidenceIds: speech.heldEvidenceIds };
  const subject = speech.facts.find(({ ref }) => ref === subjectRef);
  const known = subject !== undefined && isDisclosable(subject.releasePolicyId, context);
  return storage.transact((tx) => {
    const branch = tx.branch(speech.session.branchId);
    const receipts: SpeechApprovalInput["receipts"][number][] = [];
    let createdSubject: SpeechFact | null = null;
    for (const { result, rawArtifact, toolId } of outcomes) {
      const raw = asRecord(rawArtifact.value);
      const commandId = asRecord(raw["command"])["commandId"];
      if (result.receiptId === null || typeof commandId !== "string") continue;
      const stored = commandReceiptSchema.safeParse(branch.table("command_receipts")
        .get({ principal_id: speech.agentId, command_id: commandId })?.["receipt_json"]);
      if (!stored.success || stored.data.receiptId !== result.receiptId) continue;
      const receipt = stored.data;
      const mentioned = refersTo(raw["input"], subjectRef) || refersTo(receipt.result, subjectRef);
      if (!mentioned) continue;
      if (receipt.commandStatus === "rejected") {
        if (known) receipts.push({ receiptId: receipt.receiptId, commandStatus: "rejected", taskStatus: null, detail: "命令被拒绝。" });
        continue;
      }
      for (const eventId of receipt.acceptedEventIds) {
        const [row] = branch.table("domain_events").list({ event_id: eventId }, { limit: 1 });
        if (row === undefined || typeof row["type"] !== "string") continue;
        const type = row["type"];
        const audience = audienceSpecSchema.array().safeParse(row["audience_json"]);
        const payload = jsonValueSchema.safeParse(row["payload_json"]);
        if (!audience.success || !payload.success || !refersTo(payload.data, subjectRef)) continue;
        const dispatched = type === "TaskDispatched" ? taskDispatchedPayloadSchema.safeParse(payload.data) : null;
        if (toolId === "asset.dispatch" && dispatched?.success !== true) continue;
        const policies = audience.data.map((entry) => observationReleasePolicy({ type, audience: [entry], payload: payload.data }));
        if (!context.audience.every((principal) =>
          policies.some((policy) => isDisclosable(policy, { ...context, audience: [principal] })))) continue;
        const state = dispatched?.success ? "pending" : taskStatusFrom(receipt);
        const detail = dispatched?.success ? `已安排，预计 tick ${dispatched.data.departTick} 出发。` : "命令已受理。";
        receipts.push({ receiptId: receipt.receiptId, commandStatus: "accepted", taskStatus: state, detail });
        if (subject === undefined && dispatched?.success) {
          createdSubject = { ref: subjectRef, releasePolicyId: `parties:${context.audience.join(",")}`, summaryZh: detail };
        }
        break;
      }
    }
    return {
      receipts, facts: createdSubject === null ? speech.facts : [...speech.facts, createdSubject],
      subjectLine: createdSubject?.summaryZh ?? speech.subjectLine,
    };
  });
}
