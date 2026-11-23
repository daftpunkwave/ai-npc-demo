/**
 * 核心职责：在 M1 账本规则上增加看法、核心块、公共编年史与每日模型整理。
 * 交互契约：复用同包账本实现，模型只能返回受校验的认知变更。
 * 约束与禁忌：模型失败不得伪造水位推进；禁止直接存储、跨 Agent 或世界写入。
 */
import type {
  WakeupProposal,
  AgentMemoryQuery,
  AgentObservation,
  IdPrefix,
  MemoryBundle,
  MemoryChangePlan,
  MaintenanceTask,
} from "@ai-npc/contracts";
import type {
  MemoryPort,
  RevisionView,
  ScopedModelPort,
} from "@ai-npc/module-sdk";
import { createLedgerPort } from "./ledger-port";
import { applyUsage, capacityRetirements } from "./ledger-usage";
import { ledgerConfigFromHybrid, type LayeredHybridConfig } from "./layered-hybrid-config";
import type { LedgerConfig } from "./definition";
import { applyDailyReview } from "./layered-hybrid-changes";
import {
  dailyReviewOutputContract,
  dailyReviewOutputSchema,
  dailyReviewPrompt,
  type DailyReviewOutput,
} from "./layered-hybrid-model";
import {
  baseSalience,
  compareStrings,
  dataOf,
  eventFromObservation,
  numberValue,
  relationSummary,
  requireSameScope,
} from "./ledger-model";

type Ids = (prefix: IdPrefix) => string;
type Rng = (...parts: string[]) => (() => number);

export class LayeredHybridMemoryPort implements MemoryPort {
  private readonly ledger: MemoryPort;
  private readonly ledgerConfig: LedgerConfig;

  constructor(
    private readonly config: LayeredHybridConfig,
    private readonly ids: Ids,
    private readonly rng: Rng | null,
  ) {
    this.ledgerConfig = ledgerConfigFromHybrid(config);
    this.ledger = createLedgerPort(this.ledgerConfig, ids);
  }

  prepareIngest(
    input: Parameters<MemoryPort["prepareIngest"]>[0],
    view: RevisionView,
  ): MemoryChangePlan {
    requireSameScope(input.scope, view);
    const base = this.ledger.prepareIngest(input, this.ruleView(view));
    const publicRows = input.observations.flatMap((observation) => this.publicRow(observation, view));
    return { ...base, inserts: [...base.inserts, ...publicRows] };
  }

  retrieve(query: AgentMemoryQuery, view: RevisionView): MemoryBundle {
    requireSameScope(query.scope, view);
    const base = this.ledger.retrieve(query, { ...view, records: view.records.filter((record) => record.kind !== "public") });
    if (base.status !== "ok") return base;
    const publicItems = this.config.chronicle.enabled
      ? view.records
        .filter((record) =>
          record.status === "active" &&
          record.kind === "public" &&
          record.validFromTick <= query.frontier.worldTick,
        )
        .sort((left, right) =>
          right.salience - left.salience ||
          right.validFromTick - left.validFromTick ||
          left.memoryId.localeCompare(right.memoryId),
        )
        .slice(0, this.config.chronicle.maxPerRecall)
        .map((record) => ({
          memoryId: record.memoryId,
          kind: record.kind,
          epistemic: record.epistemic,
          summaryZh: record.content.summaryZh,
          validFromTick: record.validFromTick,
          score: record.salience,
          mustInclude: false,
          releasePolicyId: record.releasePolicyId,
          sourceObservationIds: [...record.sourceObservationIds],
        }))
      : [];
    const seen = new Set(base.items.map((item) => item.memoryId));
    const ranked = [
      ...base.items.map((item) => ({
        ...item,
        score: item.score + this.jitter(query, item.memoryId),
      })).sort((left, right) =>
        right.score - left.score ||
        right.validFromTick - left.validFromTick ||
        left.memoryId.localeCompare(right.memoryId),
      ),
      ...publicItems.filter((item) => !seen.has(item.memoryId)),
    ];
    const items: MemoryBundle["items"] = [];
    const dropped = [...base.dropped];
    let tokens = 0;
    for (const item of ranked) {
      const cost = Array.from(item.summaryZh).length;
      if (tokens + cost > query.maxTokens) {
        dropped.push({ memoryId: item.memoryId, reason: "budget" });
      } else if (items.length < Math.min(query.maxItems, this.config.recall.topK + this.config.chronicle.maxPerRecall)) {
        items.push(item);
        tokens += cost;
      } else {
        dropped.push({ memoryId: item.memoryId, reason: "rank" });
      }
    }
    return {
      ...base,
      coreBlock: this.coreBlock(query, view),
      items,
      dropped,
      candidates: base.candidates + publicItems.length,
    };
  }
  planMaintenance(
    input: Parameters<MemoryPort["planMaintenance"]>[0],
    view?: RevisionView,
  ): MaintenanceTask | null {
    if (view === undefined) throw new Error("planMaintenance requires a frozen revision view");
    requireSameScope(input.scope, view);
    const base = this.ledger.planMaintenance(input, view);
    if (base === null) return null;
    const changeScore = this.changeScore(view, input.worldTick);
    return {
      ...base,
      moduleId: "agent.memory.layered-hybrid",
      needsModel: this.config.llmMaintenance.enabled && changeScore > 0,
      modelPriority: changeScore,
      modelQuota: this.config.llmMaintenance.maxAgentsPerDay,
    };
  }

  async runMaintenance(
    task: Parameters<MemoryPort["runMaintenance"]>[0],
    view: RevisionView,
    model: ScopedModelPort | null,
  ): Promise<MemoryChangePlan> {
    const rulePlan: MemoryChangePlan = task.rulesApplied === true ? {
      baseRevision: task.baseRevision, observationSeqThrough: task.observationSeqThrough,
      inserts: [], retires: [], changeKind: "maintenance",
      derivedThroughSeq: task.observationSeqThrough, derivedThroughTick: task.dueTick,
    } : await this.ledger.runMaintenance({ ...task, moduleId: "agent.memory.ledger", needsModel: false }, this.ruleView(view), null);
    if (task.trigger !== "day-passed" || !task.needsModel || !this.config.llmMaintenance.enabled) {
      return withResult(rulePlan, { status: "completed", failureReason: null, discarded: [] });
    }
    if (model === null) return partial(rulePlan, "memory-maintenance-model-unavailable");
    const today = view.records
      .filter((record) =>
        record.status === "active" &&
        record.validFromTick >= Math.max(0, task.dueTick - 23) &&
        record.validFromTick <= task.dueTick &&
        record.kind !== "relation",
      )
      .sort((left, right) =>
        right.salience - left.salience ||
        right.validFromTick - left.validFromTick ||
        left.memoryId.localeCompare(right.memoryId),
      )
      .slice(0, 20);
    const beliefs = view.records
      .filter((record) => record.status === "active" && record.kind === "belief")
      .sort((left, right) => right.validFromTick - left.validFromTick || left.memoryId.localeCompare(right.memoryId))
      .slice(0, 20);
    const relations = relationSummary({
      scope: view.scope,
      revision: view.revision,
      frontier: {
        worldSeq: 0,
        worldTick: task.dueTick,
        observationSeq: task.observationSeqThrough,
        memoryRevision: task.baseRevision,
        perceptionRevision: 0,
        knowledgeGrantRevision: 0,
        conversationCursor: null,
      },
      counterpartIds: [...new Set(today.flatMap((record) => record.content.counterpartIds))],
      queryTags: [],
      queryText: "",
      nodeId: null,
      purpose: "decision",
      audience: [view.scope.agentId],
      maxItems: 20,
      maxTokens: 1000,
    }, view);
    const prompt = dailyReviewPrompt({ identity: view.identity, today, beliefs, relations });
    let response: DailyReviewOutput;
    try {
      const result = await model.call({
        purpose: "memory-maintenance",
        workRef: `daily-review:${task.dueTick}:${task.observationSeqThrough}`,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        tools: [],
        output: dailyReviewOutputContract,
        reserveOutputTokens: 800,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        fence: () => true,
      });
      if (result.response.json === null) throw new Error("daily-review response is missing JSON");
      response = dailyReviewOutputSchema.parse(result.response.json);
    } catch (error) {
      return partial(rulePlan, error instanceof Error ? error.message : String(error));
    }
    const extras = applyDailyReview({ response, task, view, today, beliefs, ids: this.ids, config: this.config });
    // 规则段已裁剪过短期层；模型段直接追加意向记录，合并后必须再按 capacity.short 统一裁剪。
    const capped = capacityRetirements(
      {
        inserts: [...rulePlan.inserts, ...extras.inserts],
        retires: dedupeRetires([...rulePlan.retires, ...extras.retires]),
      },
      view,
      this.ledgerConfig,
      task.dueTick,
      ["short"],
    );
    return {
      ...rulePlan,
      inserts: capped.inserts,
      retires: capped.retires,
      maintenanceResult: {
        status: "completed",
        failureReason: null,
        discarded: [...extras.discarded],
      },
    };
  }

  recordUse(
    input: Parameters<MemoryPort["recordUse"]>[0],
    view: RevisionView,
  ): MemoryChangePlan {
    const rules = this.ledger.recordUse(input, this.ruleView(view));
    const special = applyUsage(input, { ...view, records: view.records.filter((record) => record.kind === "belief" || record.kind === "core") });
    return { ...rules, inserts: [...rules.inserts, ...special.inserts], retires: [...rules.retires, ...special.retires] };
  }

  proposeWakeups(
    input: Parameters<MemoryPort["proposeWakeups"]>[0],
    view: RevisionView,
  ): ReturnType<MemoryPort["proposeWakeups"]> {
    requireSameScope(input.scope, view);
    if (this.config.wakeups !== "enabled") return [];
    const intents: WakeupProposal[] = view.records
      .filter((record) =>
        record.status === "active" &&
        record.kind === "episodic" &&
        dataOf(record)["intent"] === true,
      )
      .flatMap((record) => {
        const dueTick = numberValue(dataOf(record)["dueTick"]);
        const targetId = dataOf(record)["targetId"];
        if (dueTick === null || typeof targetId !== "string" || dueTick > input.worldTick) return [];
        return [{
          atTick: dueTick,
          dedupeKey: `${record.memoryId}:intent:${dueTick}`,
          reason: "intent" as const,
          memoryId: record.memoryId,
          counterpartId: targetId,
        }];
      });
    return [...this.ledger.proposeWakeups(input, view), ...intents];
  }
  private publicRow(observation: AgentObservation, view: RevisionView): MemoryChangePlan["inserts"] {
    if (observation.releasePolicyId !== "public") return [];
    const event = eventFromObservation(observation, view.scope.agentId);
    const salience = baseSalience(event);
    if (salience < 0.5) return [];
    const key = [...new Set(observation.sourceEventIds)].sort(compareStrings).join(",") || observation.observationId;
    if (view.records.some((record) =>
      record.kind === "public" && dataOf(record)["sourceEventKey"] === key,
    )) return [];
    return [{
      memoryId: this.ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"],
      kind: "public",
      tier: "long",
      status: "active",
      epistemic: observation.epistemic === "witnessed" ? "verified-event" : "reported-claim",
      releasePolicyId: "public",
      branchPublic: true,
      validFromTick: observation.knownAtTick,
      validUntilTick: null,
      strength: salience,
      salience,
      recallCount: 0,
      lastReinforcedTick: observation.knownAtTick,
      tags: ["public", ...event.tags],
      sourceObservationIds: [observation.observationId],
      content: {
        summaryZh: event.summaryZh,
        counterpartIds: [...event.counterpartIds],
        data: { public: true, sourceEventKey: key, eventType: event.eventType },
      },
    }];
  }

  private coreBlock(query: AgentMemoryQuery, view: RevisionView): string | null {
    const concernsRecord = view.records
      .filter((record) => record.status === "active" && record.kind === "core" && record.validFromTick <= query.frontier.worldTick)
      .sort((left, right) => right.validFromTick - left.validFromTick || left.memoryId.localeCompare(right.memoryId))[0];
    const concerns = concernsRecord === undefined
      ? this.ruleConcerns(query, view)
      : String(dataOf(concernsRecord)["currentConcerns"] ?? this.ruleConcerns(query, view));
    const staticPart = [
      `【核心记忆：${view.identity.name ?? view.scope.agentId}】`,
      `职责：${view.identity.role ?? "未知"}`,
      `价值：${view.identity.values.join("、")}`,
      `目标：${(view.identity.goals ?? []).join("、") || "无"}`,
      `当前关注：${concerns || "暂无"}`,
    ].join("\n");
    return truncate(staticPart, this.config.coreBlockMaxTokens);
  }

  private ruleConcerns(query: AgentMemoryQuery, view: RevisionView): string {
    const promises = view.records
      .filter((record) => record.status === "active" && record.kind === "prospective" && dataOf(record)["state"] === "open")
      .sort((left, right) =>
        (numberValue(dataOf(left)["dueTick"]) ?? Number.MAX_SAFE_INTEGER) -
        (numberValue(dataOf(right)["dueTick"]) ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 2)
      .map((record) => record.content.summaryZh);
    const relations = relationSummary(query, view)
      .sort((left, right) => left.trust - right.trust)
      .slice(0, 1)
      .map((relation) => `${relation.targetId} 关系紧张（trust=${relation.trust}）`);
    return [...promises, ...relations].join("；");
  }

  private ruleView(view: RevisionView): RevisionView {
    return { ...view, records: view.records.filter((record) =>
      record.kind !== "belief" && record.kind !== "core" && record.kind !== "public",
    ) };
  }

  private changeScore(view: RevisionView, worldTick: number): number {
    return view.records.filter((record) => {
      if (record.status !== "active" || record.validFromTick < worldTick - 23) return false;
      if (record.tier === "long" || record.kind === "core") return true;
      return record.kind === "relation" && Math.abs(numberValue(dataOf(record)["delta"]) ?? 0) >= 3;
    }).length;
  }
  private jitter(query: AgentMemoryQuery, memoryId: string): number {
    if (this.config.recall.jitter <= 0 || this.rng === null) return 0;
    const random = this.rng("recall-jitter", query.scope.agentId, String(query.frontier.worldTick), memoryId)();
    return random * this.config.recall.jitter;
  }
}

function withResult(plan: MemoryChangePlan, result: MemoryChangePlan["maintenanceResult"]): MemoryChangePlan {
  return { ...plan, maintenanceResult: result };
}

function partial(rulePlan: MemoryChangePlan, reason: string): MemoryChangePlan {
  return {
    ...rulePlan,
    derivedThroughSeq: null,
    derivedThroughTick: null,
    maintenanceResult: { status: "partial", failureReason: reason, discarded: [] },
  };
}

function dedupeRetires(retires: MemoryChangePlan["retires"]): MemoryChangePlan["retires"] {
  return [...new Map(retires.map((retire) => [retire.memoryId, retire])).values()];
}

function truncate(value: string, maxTokens: number): string {
  return Array.from(value).slice(0, maxTokens).join("");
}

export function createLayeredHybridPort(config: LayeredHybridConfig, ids: Ids, rng: Rng | null): LayeredHybridMemoryPort {
  return new LayeredHybridMemoryPort(config, ids, rng);
}