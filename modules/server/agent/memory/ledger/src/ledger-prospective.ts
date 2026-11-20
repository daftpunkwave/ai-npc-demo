/**
 * 从已授权的任务与协议观察生成、关闭主观承诺记录。
 * Builds and closes prospective memory rows without changing formal contracts.
 * Must not invent a deadline that is absent from this or an earlier observation.
 */
import type { MemoryChangePlan } from "@ai-npc/contracts";
import type {
  MemoryRecordView,
  RevisionView,
} from "@ai-npc/module-sdk";
import type { LedgerConfig } from "./definition";
import {
  type LedgerBuild,
  type LedgerEvent,
  type LedgerRow,
  type ProspectiveState,
  dataOf,
  numberValue,
  objectValue,
} from "./ledger-model";

type Ids = (prefix: string) => string;

export function buildProspective(
  events: readonly LedgerEvent[],
  view: RevisionView,
  config: LedgerConfig,
  ids: Ids,
): LedgerBuild {
  const inserts: LedgerRow[] = [];
  const retires = new Map<string, MemoryChangePlan["retires"][number]["status"]>();
  const knownSources = new Set(view.records.flatMap((record) => record.sourceObservationIds));
  const activePromises = view.records.filter((record) =>
    record.kind === "prospective" &&
    record.status === "active" &&
    dataOf(record)["state"] === "open",
  );
  for (const event of events) {
    if (knownSources.has(event.observation.observationId)) continue;
    if (event.eventType === "AgreementActivated") {
      const agreementId = event.facts["agreementId"];
      const terms = Array.isArray(event.facts["terms"]) ? event.facts["terms"] : [];
      terms.forEach((value, termIndex) => {
        const term = objectValue(value);
        const obligorId = term["obligorId"];
        if (typeof obligorId !== "string") return;
        const dueTick = numberValue(term["byTick"]) ?? numberValue(term["untilTick"]);
        const row = prospectiveRow(event, {
          sourceKind: "agreement",
          agreementId: typeof agreementId === "string" ? agreementId : undefined,
          termIndex,
          obligorId,
          dueTick,
          state: "open",
        }, config, ids);
        inserts.push(row);
        activePromises.push(viewRecord(row));
      });
    }
    if (event.eventType === "TaskInvitationAnswered" && event.facts["response"] === "accept") {
      const taskId = event.facts["taskId"];
      const departTick = findTaskDepartTick(taskId, event.observation.knownAtTick, view, events);
      if (typeof taskId === "string" && departTick !== null) {
        const row = prospectiveRow(event, {
          sourceKind: "task",
          taskId,
          obligorId: view.scope.agentId,
          dueTick: departTick,
          state: "open",
        }, config, ids);
        inserts.push(row);
        activePromises.push(viewRecord(row));
      }
    }
    if (event.eventType === "AgreementTermFulfilled" || event.eventType === "AgreementBreached") {
      closeAgreementPromise(activePromises, event, retires);
    }
    if (event.eventType === "AgreementFulfilled") {
      const agreementId = event.facts["agreementId"];
      for (const record of activePromises) {
        if (dataOf(record)["agreementId"] === agreementId) retires.set(record.memoryId, "superseded");
      }
    }
    if (event.eventType === "TaskCompleted" || event.eventType === "TaskCancelled" || event.eventType === "TaskFailed") {
      const taskId = event.facts["taskId"];
      for (const record of activePromises) {
        if (dataOf(record)["taskId"] === taskId) retires.set(record.memoryId, "superseded");
      }
    }
  }
  const pendingIds = new Set(inserts.map((row) => row.memoryId));
  for (const memoryId of pendingIds) {
    if (!retires.has(memoryId)) continue;
    const row = inserts.find((candidate) => candidate.memoryId === memoryId);
    if (row !== undefined) row.status = "superseded";
    retires.delete(memoryId);
  }
  return { inserts, retires: [...retires].map(([memoryId, status]) => ({ memoryId, status })) };
}

function viewRecord(row: LedgerRow): MemoryRecordView {
  return {
    ...row,
    rowVersion: 0,
    tags: [...row.tags],
    sourceObservationIds: [...row.sourceObservationIds],
    content: {
      ...row.content,
      counterpartIds: [...row.content.counterpartIds],
    },
  };
}

function prospectiveRow(
  event: LedgerEvent,
  state: ProspectiveState,
  config: LedgerConfig,
  ids: Ids,
): LedgerRow {
  const salience = config.salienceThresholds.long;
  return {
    memoryId: ids("mem") as LedgerRow["memoryId"],
    kind: "prospective",
    tier: "long",
    status: "active",
    epistemic: event.observation.epistemic === "witnessed" ? "verified-event" : "reported-claim",
    releasePolicyId: event.observation.releasePolicyId,
    validFromTick: event.observation.knownAtTick,
    validUntilTick: null,
    strength: salience,
    salience,
    recallCount: 0,
    lastReinforcedTick: event.observation.knownAtTick,
    tags: [...event.tags],
    sourceObservationIds: [event.observation.observationId],
    content: {
      summaryZh: event.summaryZh,
      counterpartIds: [...event.counterpartIds],
      data: { ...state },
    },
  };
}

function findTaskDepartTick(
  taskId: unknown,
  beforeTick: number,
  view: RevisionView,
  events: readonly LedgerEvent[],
): number | null {
  if (typeof taskId !== "string") return null;
  const fromEvents = events.filter((event) =>
    event.facts["taskId"] === taskId &&
    event.observation.knownAtTick <= beforeTick,
  );
  for (const event of [...fromEvents].reverse()) {
    const direct = numberValue(event.facts["departTick"]);
    if (direct !== null) return direct;
  }
  const fromRecords = view.records.filter((record) => dataOf(record)["taskId"] === taskId);
  for (const record of [...fromRecords].reverse()) {
    const direct = numberValue(dataOf(record)["departTick"]);
    if (direct !== null) return direct;
  }
  return null;
}

function closeAgreementPromise(
  records: readonly MemoryRecordView[],
  event: LedgerEvent,
  retires: Map<string, MemoryChangePlan["retires"][number]["status"]>,
): void {
  const agreementId = event.facts["agreementId"];
  const termIndex = numberValue(event.facts["termIndex"]);
  for (const record of records) {
    const data = dataOf(record);
    if (data["agreementId"] === agreementId && data["termIndex"] === termIndex) {
      retires.set(record.memoryId, "superseded");
    }
  }
}
