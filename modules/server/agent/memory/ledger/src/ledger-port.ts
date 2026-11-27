/**
 * 在冻结 revision 视图上实现结构化账本 MemoryPort。
 * 只依赖确定性账本规则与宿主注入的 ID 服务。
 * 禁止读取存储、调用模型，或信任未校验的自报引用。
 */
import type {
  AgentMemoryQuery,
  AgentObservation,
  IdPrefix,
  MemoryBundle,
  MemoryChangePlan,
} from "@world-prism/contracts";
import type {
  MemoryPort,
  MemoryRecordView,
  RevisionView,
} from "@world-prism/module-sdk";
import type { LedgerConfig } from "./definition";
import {
  type LedgerBuild,
  applyUsage,
  buildIngestion,
  capacityRetirements,
} from "./ledger-rules";
import { buildMaintenance } from "./ledger-maintenance";
import { RecallSelection, type ScoredRecord } from "./ledger-recall";
import {
  type LedgerRow,
  clamp01,
  compareStrings,
  currentStrength,
  dataOf,
  eventFromObservation,
  mergeReleasePolicies,
  numberValue,
  objectValue,
  relationSummary,
  requireSameScope,
} from "./ledger-model";

type Ids = (prefix: IdPrefix) => string;

export class LedgerMemoryPort implements MemoryPort {
  constructor(
    private readonly config: LedgerConfig,
    private readonly ids: Ids,
  ) {}

  prepareIngest(
    input: Parameters<MemoryPort["prepareIngest"]>[0],
    view: RevisionView,
  ): MemoryChangePlan {
    requireSameScope(input.scope, view);
    view = withoutPublicRecords(view);
    const capped = capacityRetirements(
      buildIngestion(input.observations, view, this.config, this.ids),
      view,
      this.config,
      input.worldTick,
    );
    return this.plan(input.baseRevision, input.observations, "ingest", capped);
  }

  retrieve(query: AgentMemoryQuery, view: RevisionView): MemoryBundle {
    requireSameScope(query.scope, view);
    view = withoutPublicRecords(view);
    if (query.revision !== view.revision) {
      return emptyBundle("not-ready", query.revision);
    }
    const { recall } = this.config;
    const scored = this.scoredCandidates(query, view);
    const concernsCounterpart = (record: MemoryRecordView): boolean =>
      record.content.counterpartIds.some((id) => query.counterpartIds.includes(id));
    const selection = new RecallSelection({
      maxItems: query.maxItems,
      maxTokens: query.maxTokens,
      droppedLimit: recall.candidateLimit,
    });
    // 必带项先于按分数入选：先是与对方相关的承诺，再是与对方相关的长期记忆（按显著度排序）。
    if (this.config.prospectiveInput === "enabled") {
      selection.pickMandatory(
        scored.filter(({ record }) => record.kind === "prospective" && concernsCounterpart(record)),
        Math.min(recall.mustIncludeProspective, query.maxItems),
      );
    }
    selection.pickMandatory(
      scored
        .filter(({ record }) => record.tier === "long" && concernsCounterpart(record))
        .sort((left, right) =>
          right.record.salience - left.record.salience ||
          right.record.validFromTick - left.record.validFromTick ||
          left.record.memoryId.localeCompare(right.record.memoryId),
        ),
      recall.mustIncludeAboutCounterpart,
    );
    selection.fillFrom(scored.slice(0, recall.candidateLimit), Math.min(recall.topK, query.maxItems));
    selection.markUnpickedAsRank(scored);
    const items = selection.pickedRecords().map(({ record, score, mustInclude }) => ({
      memoryId: record.memoryId,
      kind: record.kind,
      epistemic: record.epistemic,
      summaryZh: record.content.summaryZh,
      validFromTick: record.validFromTick,
      score,
      mustInclude,
      releasePolicyId: record.releasePolicyId,
      sourceObservationIds: [...record.sourceObservationIds],
    }));
    return {
      status: "ok",
      revision: view.revision,
      coreBlock: null,
      relationSummary: this.config.relationInput === "enabled" ? relationSummary(query, view) : [],
      items,
      candidates: scored.length,
      dropped: selection.dropped(),
    };
  }

  /** 可检索的记录按分数、生效时间与记忆 ID 排序；关系行与未生效的记录不参与，承诺按配置决定。 */
  private scoredCandidates(query: AgentMemoryQuery, view: RevisionView): readonly ScoredRecord[] {
    return view.records
      .filter((record) =>
        record.status === "active" &&
        record.kind !== "relation" &&
        (this.config.prospectiveInput === "enabled" || record.kind !== "prospective") &&
        record.validFromTick <= query.frontier.worldTick,
      )
      .map((record) => ({ record, score: this.score(record, query) }))
      .sort((left, right) =>
        right.score - left.score ||
        right.record.validFromTick - left.record.validFromTick ||
        left.record.memoryId.localeCompare(right.record.memoryId),
      );
  }

  planMaintenance(input: Parameters<MemoryPort["planMaintenance"]>[0], _view?: RevisionView) {
    if (input.trigger !== "day-passed") return null;
    return {
      moduleId: "agent.memory.ledger",
      trigger: input.trigger,
      dueTick: input.worldTick,
      baseRevision: input.revision,
      observationSeqThrough: input.observationSeqThrough,
      day: Math.floor(input.worldTick / 24) + 1,
      needsModel: false,
    };
  }

  async runMaintenance(
    task: Parameters<MemoryPort["runMaintenance"]>[0],
    view: RevisionView,
  ): Promise<MemoryChangePlan> {
    view = withoutPublicRecords(view);
    const build = buildMaintenance(task, view, this.config, this.ids);
    return {
      baseRevision: task.baseRevision,
      observationSeqThrough: task.observationSeqThrough,
      inserts: build.inserts,
      retires: build.retires,
      derivedThroughSeq: task.observationSeqThrough,
      derivedThroughTick: task.dueTick,
      changeKind: "maintenance",
    };
  }

  recordUse(
    input: Parameters<MemoryPort["recordUse"]>[0],
    view: RevisionView,
  ): MemoryChangePlan {
    requireSameScope(input.scope, view);
    view = withoutPublicRecords(view);
    const usage = applyUsage(input, view);
    const noteworthy = this.noteworthyRows(input, view);
    const combined = capacityRetirements(
      {
        inserts: [...usage.inserts, ...noteworthy],
        retires: usage.retires,
      },
      view,
      this.config,
      input.worldTick,
    );
    return {
      baseRevision: input.baseRevision,
      observationSeqThrough: input.inputObservations.reduce(
        (highest, observation) => Math.max(highest, observation.observationSeq),
        0,
      ),
      inserts: combined.inserts,
      retires: combined.retires,
      derivedThroughSeq: null,
      derivedThroughTick: null,
      changeKind: "use",
    };
  }

  proposeWakeups(
    input: Parameters<MemoryPort["proposeWakeups"]>[0],
    view: RevisionView,
  ): ReturnType<MemoryPort["proposeWakeups"]> {
    requireSameScope(input.scope, view);
    view = withoutPublicRecords(view);
    if (this.config.wakeups === "disabled") return [];
    return view.records
      .filter((record) =>
        record.status === "active" &&
        record.kind === "prospective" &&
        dataOf(record)["state"] === "open",
      )
      .flatMap((record) => {
        const data = dataOf(record);
        const dueTick = numberValue(data["dueTick"]);
        const obligorId = data["obligorId"];
        if (dueTick === null || typeof obligorId !== "string") return [];
        const reason = obligorId === view.scope.agentId ? "self-due" as const : "other-due" as const;
        const atTick = reason === "self-due" ? Math.max(0, dueTick - 6) : dueTick;
        if (atTick > input.worldTick) return [];
        return [{
          atTick,
          dedupeKey: `${record.memoryId}:${reason}:${atTick}`,
          reason,
          memoryId: record.memoryId,
          counterpartId: record.content.counterpartIds.find((id) => id !== view.scope.agentId) ?? null,
        }];
      });
  }

  private plan(
    baseRevision: number,
    observations: readonly AgentObservation[],
    changeKind: "ingest" | "use" | "maintenance" | "import",
    build: LedgerBuild,
  ): MemoryChangePlan {
    return {
      baseRevision,
      observationSeqThrough: observations.reduce(
        (highest, observation) => Math.max(highest, observation.observationSeq),
        0,
      ),
      inserts: build.inserts,
      retires: build.retires,
      derivedThroughSeq: null,
      derivedThroughTick: null,
      changeKind,
    };
  }

  private score(record: MemoryRecordView, query: AgentMemoryQuery): number {
    const strength = currentStrength(record, this.config, query.frontier.worldTick);
    const union = new Set([...record.tags, ...query.queryTags]);
    const intersection = record.tags.filter((tag) => query.queryTags.includes(tag)).length;
    const relevance = clamp01(
      (union.size === 0 ? 0 : intersection / union.size) +
      (record.content.counterpartIds.some((id) => query.counterpartIds.includes(id)) ? 0.5 : 0),
    );
    const recency = Math.exp(-(query.frontier.worldTick - record.validFromTick) / 240);
    return (
      strength * this.config.recall.weights.strength +
      record.salience * this.config.recall.weights.salience +
      relevance * this.config.recall.weights.relevance +
      recency * this.config.recall.weights.recency
    );
  }

  private noteworthyRows(
    input: Parameters<MemoryPort["recordUse"]>[0],
    view: RevisionView,
  ): readonly LedgerRow[] {
    const observations = new Map<string, AgentObservation>();
    for (const observation of input.inputObservations) {
      observations.set(observation.observationId, observation);
      for (const eventId of observation.sourceEventIds) observations.set(eventId, observation);
    }
    return input.noteworthy.flatMap((entry) => {
      const sources = entry.sourceRefs.map((ref) => observations.get(ref)).filter(
        (observation): observation is AgentObservation => observation !== undefined,
      );
      if (sources.length !== entry.sourceRefs.length) return [];
      if (entry.kind === "promise-by-other" && !sources.some((source) =>
        speakerIds(source).includes(entry.aboutId),
      )) {
        return [];
      }
      if (view.records.some((record) =>
        dataOf(record)["noteworthyTurnId"] === input.turnId &&
        dataOf(record)["noteworthySummary"] === entry.summary,
      )) {
        return [];
      }
      return [this.noteworthyRow(entry, sources, input, view)];
    });
  }

  private noteworthyRow(
    entry: Parameters<MemoryPort["recordUse"]>[0]["noteworthy"][number],
    sources: readonly AgentObservation[],
    input: Parameters<MemoryPort["recordUse"]>[0],
    view: RevisionView,
  ): LedgerRow {
    if (sources.length === 0) throw new Error("validated noteworthy entry has no source");
    const isPromise = entry.kind === "promise-by-other" || entry.kind === "promise-by-me";
    const obligorId = entry.kind === "promise-by-other" ? entry.aboutId : view.scope.agentId;
    const kind = isPromise ? "prospective" : "episodic";
    const salience = entry.kind === "request" ? 0.3 : 0.5;
    const data: Record<string, import("@world-prism/contracts").Json> = {
      dueTick: entry.dueTick,
      // 持久化后供本模块跨 turn 去重；宿主的来源校验只读插入行的 sourceTurnId。
      noteworthyTurnId: input.turnId,
      noteworthySummary: entry.summary,
    };
    if (isPromise) {
      data["sourceKind"] = "informal";
      data["obligorId"] = obligorId;
      data["state"] = "open";
    }
    return {
      memoryId: this.ids("mem") as LedgerRow["memoryId"],
      kind,
      tier: isPromise ? "long" : kind === "episodic" && salience >= this.config.salienceThresholds.long ? "long" : "short",
      status: "active",
      epistemic: entry.kind === "request" ? "inference" : "reported-claim",
      releasePolicyId: mergeReleasePolicies(sources.map((source) => source.releasePolicyId)),
      validFromTick: input.worldTick,
      validUntilTick: null,
      strength: salience,
      salience,
      recallCount: 0,
      lastReinforcedTick: input.worldTick,
      tags: isPromise ? ["agreement", "prospective"] : ["dialogue"],
      sourceObservationIds: [...new Set(sources.map((source) => source.observationId))].sort(compareStrings),
      sourceTurnId: input.turnId,
      content: {
        summaryZh: entry.summary,
        counterpartIds: [...new Set([entry.aboutId, ...sources.flatMap((source) =>
          eventFromObservation(source, view.scope.agentId).counterpartIds,
        )])].filter((id) => id !== view.scope.agentId).sort(compareStrings),
        data,
      },
    };
  }
}

export function createLedgerPort(config: LedgerConfig, ids: Ids): LedgerMemoryPort {
  return new LedgerMemoryPort(config, ids);
}

function emptyBundle(status: MemoryBundle["status"], revision: number): MemoryBundle {
  return {
    status,
    revision,
    coreBlock: null,
    relationSummary: [],
    items: [],
    candidates: 0,
    dropped: [],
  };
}

/**
 * 去重键：同一批来源观察的排序拼接。
 * 由检索流程在记录首次参与必选或候选选择时调用并缓存，避免同一条记录两处重复排序拼接。
 */
function speakerIds(observation: AgentObservation): readonly string[] {
  const content = objectRecord(observation);
  const facts = objectValue(content["facts"]);
  const claim = content["claim"];
  const claimRecord = typeof claim === "object" && claim !== null && !Array.isArray(claim)
    ? claim as Readonly<Record<string, unknown>>
    : {};
  const ids = new Set<string>();
  for (const key of ["speakerId", "fromId", "senderId", "sourceId"]) {
    const value = facts[key] ?? claimRecord[key] ?? content[key];
    if (typeof value === "string") ids.add(value);
  }
  return [...ids];
}

function objectRecord(observation: AgentObservation): Readonly<Record<string, unknown>> {
  return typeof observation.content === "object" && observation.content !== null && !Array.isArray(observation.content)
    ? observation.content as Readonly<Record<string, unknown>>
    : {};
}

function withoutPublicRecords(view: RevisionView): RevisionView {
  return { ...view, records: view.records.filter((record) => record.kind !== "public") };
}
