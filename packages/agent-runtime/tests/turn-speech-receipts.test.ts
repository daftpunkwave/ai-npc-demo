/**
 * 验证本轮派遣产生的任务可用于对白，并按事件受众保护回执。
 * 依赖合法的命令回执、事件载荷和只读存储视图。
 * 禁止把工具归档里的自由文本或私有预留作为对白素材。
 */
import { describe, expect, it } from "vitest";
import type { CommandReceipt, StoragePort, StorageTransaction } from "@world-prism/contracts";
import type { AgentArtifactRecord } from "@world-prism/module-sdk";
import type { SpeechApprovalInput } from "../src/dialogue-flow";
import type { ToolCallOutcome } from "../src/tool-gateway-types";
import { disclosedTurnReceipts } from "../src/turn-speech-receipts";

const taskId = "task-000000000001";
const commandId = "cmd-000000000001";
const dispatchEventId = "evt-000000000002";
const reserveEventId = "evt-000000000001";
const speaker = "human-independent";
const invitee = "species-fauna";
const receipt: CommandReceipt = {
  receiptId: "rcp-000000000001", commandId, commandStatus: "accepted", reasonCode: null,
  safeMessage: null, operationId: null, acceptedEventIds: [reserveEventId, dispatchEventId],
  resultingVersions: {}, result: { taskId, departTick: 4 }, worldTick: 2,
};
const requestArtifact: AgentArtifactRecord = {
  artifactId: "art-000000000001", runId: "run-000000000001", kind: "tool-raw",
  byteSize: 0, contentHash: "fixture", createdAt: "2026-01-01T00:00:00.000Z",
  value: { input: { taskType: "scout" }, command: { commandId } },
};
const outcome: ToolCallOutcome = {
  providerCallId: "fixture-1-1", toolCallId: "tc-000000000001", toolId: "asset.dispatch", modelText: "{}", isError: false,
  rawArtifact: requestArtifact, viewArtifact: { ...requestArtifact, kind: "tool-view" },
  result: {
    executionStatus: "ok", commandStatus: "accepted", taskStatus: null, reasonCode: null,
    receiptId: receipt.receiptId, operationId: null, resultRef: "art-000000000002",
    detail: "内部库存预留明细", data: { taskId },
  },
};

function speech(recipient: string): SpeechApprovalInput {
  const session = { worldId: "wld-000000000001", branchId: "br-000000000001", agentId: speaker };
  const turnId = "turn-000000000001";
  return {
    session, runId: "run-000000000001", agentId: speaker, turnId, facts: [], history: [], receipts: [], secrets: [],
    auth: { ...session, principalId: speaker, kind: "agent", roles: ["agent"], actingAsAgentId: speaker, controllerEpoch: 1, turnId, turnLeaseEpoch: 1 },
    intent: { kind: "report-result", audience: [recipient], tone: "neutral", reasonCode: "none", subjectRef: taskId, factRefs: [] },
    principalFactions: new Map([[speaker, speaker]]), heldEvidenceIds: new Map(), heldSecretIds: new Map(),
    principalNames: new Map(), speechStyle: "", subjectLine: "", maxChars: 80,
    channel: "message", conversationId: null, replyToId: null,
  };
}

const storage = {
  transact<T>(read: (tx: StorageTransaction) => T): T {
    return read({
      branch() {
        return {
          table(table: string) {
            if (table === "command_receipts") {
              return { get: (key: { principal_id: string; command_id: string }) =>
                key.principal_id === speaker && key.command_id === commandId ? { receipt_json: receipt } : null };
            }
            if (table !== "domain_events") throw new Error(`Unexpected table ${table}`);
            return {
              list: ({ event_id }: { event_id: string }) => event_id === reserveEventId
                ? [{ type: "ResourcesReserved", audience_json: [{ kind: "faction", factionId: speaker }], payload_json: { taskId } }]
                : [{
                  type: "TaskDispatched", audience_json: [{ kind: "principals", ids: [speaker, invitee] }],
                  payload_json: { taskId, teamId: "team-rubble", taskType: "scout", dispatcherId: speaker,
                    invitees: [invitee], departTick: 4, params: { nodeId: "pass" } },
                }],
            };
          },
        };
      },
    } as unknown as StorageTransaction);
  },
} as StoragePort;

describe("本轮对白回执的授权投影", () => {
  it("从可披露的派遣事件取得状态和新任务 ID", () => {
    const result = disclosedTurnReceipts(storage, speech(invitee), [outcome]);
    expect(result).toEqual({
      facts: [{ ref: taskId, releasePolicyId: `parties:${invitee}`, summaryZh: "已安排，预计 tick 4 出发。" }],
      receipts: [{ receiptId: receipt.receiptId, commandStatus: "accepted", taskStatus: "pending", detail: "已安排，预计 tick 4 出发。" }],
      subjectLine: "已安排，预计 tick 4 出发。",
    });
  });

  it("对任务受众外的人隐藏任务状态和内部明细", () => {
    expect(disclosedTurnReceipts(storage, speech("player-1"), [outcome]))
      .toEqual({ facts: [], receipts: [], subjectLine: "" });
  });
});
