/**
 * 核心职责：在冻结 revision 上实现观察流与反思看法的 M2 记忆策略。
 * 交互契约：只依赖观察、revision、注入 ID 与宿主作用域的模型句柄。
 * 约束与禁忌：禁止关系/承诺账本、直接存储访问或跨 Agent 读取。
 */
import {
  jsonValueSchema,
  type AgentMemoryQuery,
  type AgentObservation,
  type IdPrefix,
  type MemoryBundle,
  type MemoryChangePlan,
  type MaintenanceTask,
} from "@ai-npc/contracts";
import type {
  MemoryPort,
  MemoryRecordView,
  RevisionView,
  ScopedModelPort,
} from "@ai-npc/module-sdk";
import { z } from "zod";
import type { StreamReflectionConfig } from "./definition";
import { retrieveStreamMemory } from "./stream-reflection-retrieval";
import { compareStrings, dataOf, eventFromObservation, mergeReleasePolicies, numberValue } from "./ledger-model";
import { activeStreamRecords, capStream, importanceOf, namesKnown, partialPlan, reflectionSourceRecords, reinforceStreamRow, streamObservationRow } from "./stream-reflection-rules";

type Ids = (prefix: IdPrefix) => string;

const reflectionOutputSchema = z
  .object({
    reflections: z
      .array(
        z
          .object({
            statement: z.string().min(1).max(60),
            evidenceIds: z.array(z.string().min(1)).min(2).max(6),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

const reflectionOutput = {
  kind: "json" as const,
  schemaName: "reflection",
  schema: jsonValueSchema.parse(z.toJSONSchema(reflectionOutputSchema)),
};

const reflectionSystem = [
  "你在帮“{{name}}”整理记忆，从近期经历中得出新的看法。",
  "规则：只依据【近期记忆】里的条目；每条看法至少引用 2 条作为依据的记忆 ID；不要编造条目里没有的人、物或数量。",
  "输出 JSON：{\"reflections\":[{\"statement\":\"不超过 60 字\",\"evidenceIds\":[\"mem-...\"],\"confidence\":0.0}]}，最多 3 条；没有新看法时输出空数组。",
].join("\n");

export class StreamReflectionMemoryPort implements MemoryPort {
  constructor(
    private readonly config: StreamReflectionConfig,
    private readonly ids: Ids,
  ) {}

  prepareIngest(
    input: Parameters<MemoryPort["prepareIngest"]>[0],
    view: RevisionView,
  ): MemoryChangePlan {
    requireSameScope(input.scope, view);
    const inserts = input.observations.map((observation) => streamObservationRow(observation, view, this.ids));
    return capStream(
      {
        baseRevision: input.baseRevision,
        observationSeqThrough: maxObservationSeq(input.observations),
        inserts,
        retires: [],
        derivedThroughSeq: null,
        derivedThroughTick: null,
        changeKind: "ingest",
      },
      view,
      this.config,
    );
  }

  retrieve(query: AgentMemoryQuery, view: RevisionView): MemoryBundle {
    requireSameScope(query.scope, view);
    if (query.revision !== view.revision) return emptyBundle("not-ready", query.revision);
    return retrieveStreamMemory(query, view, this.config);
  }

  planMaintenance(
    input: Parameters<MemoryPort["planMaintenance"]>[0],
    view?: RevisionView,
  ): MaintenanceTask | null {
    if (view === undefined) throw new Error("planMaintenance requires a frozen revision view");
    requireSameScope(input.scope, view);
    if (input.trigger !== "importance") return null;
    const lastReflectionSeq = Math.max(
      0,
      ...view.records
        .filter((record) => record.kind === "belief" && record.status === "active")
        .map((record) => numberValue(dataOf(record)["reflectionThroughSeq"]) ?? 0),
    );
    const pending = activeStreamRecords(view.records)
      .filter((record) => (numberValue(dataOf(record)["observationSeq"]) ?? 0) > lastReflectionSeq);
    const importanceSum = pending.reduce((sum, record) => sum + importanceOf(record), 0);
    if (importanceSum < this.config.reflection.importanceSumThreshold) return null;
    return {
      moduleId: "agent.memory.stream-reflection",
      trigger: "importance",
      dueTick: input.worldTick + 1,
      baseRevision: input.revision,
      observationSeqThrough: input.observationSeqThrough,
      day: null,
      needsModel: true,
      modelPriority: importanceSum,
    };
  }

  async runMaintenance(
    task: Parameters<MemoryPort["runMaintenance"]>[0],
    view: RevisionView,
    model: ScopedModelPort | null,
  ): Promise<MemoryChangePlan> {
    const recent = reflectionSourceRecords(view.records, task, this.config.reflection.recentWindow);
    if (model === null) {
      return partialPlan(task, "memory-maintenance-model-unavailable");
    }
    const identity = view.identity;
    const system = reflectionSystem
      .replace("{{name}}", identity.name ?? identity.factionId)
      .replace("{{role}}", identity.role ?? "未知职责")
      .replace("{{values}}", identity.values.join("、"));
    const user = [
      `【你是谁】${identity.name ?? identity.factionId}，${identity.role ?? "未知职责"}；价值取向：${identity.values.join("、")}`,
      "【近期记忆】",
      ...recent.map((record) =>
        `- [${record.memoryId}] ${record.content.summaryZh}（重要度 ${importanceOf(record)}/10·第 ${Math.floor(record.validFromTick / 24) + 1} 天）`,
      ),
    ].join("\n");
    let parsed: z.infer<typeof reflectionOutputSchema>;
    try {
      const response = await model.call({
        purpose: "memory-maintenance",
        workRef: `reflection:${task.dueTick}:${task.observationSeqThrough}`,
        system,
        messages: [{ role: "user", content: user }],
        tools: [],
        output: reflectionOutput,
        reserveOutputTokens: 800,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        fence: () => true,
      });
      const value = response.response.json;
      if (value === null) throw new Error("reflection response is missing JSON");
      parsed = reflectionOutputSchema.parse(value);
    } catch (error) {
      return partialPlan(task, error instanceof Error ? error.message : String(error));
    }

    const discarded: Array<{ source: string; reason: string }> = [];
    const inserts: MemoryChangePlan["inserts"] = [];
    const seenStatements = new Set<string>();
    for (const [index, reflection] of parsed.reflections.slice(0, this.config.reflection.maxPerRun).entries()) {
      const evidence = reflection.evidenceIds.map((id) =>
        recent.find((record) => record.memoryId === id) ??
        view.records.find((record) => record.memoryId === id),
      ).filter((record): record is MemoryRecordView => record !== undefined && record.status === "active");
      if (evidence.length < this.config.reflection.minEvidence) {
        discarded.push({ source: `reflection-${index}`, reason: "evidence-not-visible" });
        continue;
      }
      const evidenceIds = new Set(evidence.map((record) => record.memoryId));
      if (evidenceIds.size < this.config.reflection.minEvidence) {
        discarded.push({ source: `reflection-${index}`, reason: "insufficient-distinct-evidence" });
        continue;
      }
      if (seenStatements.has(reflection.statement)) {
        discarded.push({ source: `reflection-${index}`, reason: "duplicate-statement" });
        continue;
      }
      if (!namesKnown(reflection.statement, identity.knownPrincipalNames ?? {})) {
        discarded.push({ source: `reflection-${index}`, reason: "unknown-principal" });
        continue;
      }
      seenStatements.add(reflection.statement);
      const sourceObservationIds = [...new Set(evidence.flatMap((record) => record.sourceObservationIds))].sort(compareStrings);
      inserts.push({
        memoryId: this.ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"],
        kind: "belief",
        tier: "long",
        status: "active",
        epistemic: "inference",
        releasePolicyId: mergeReleasePolicies(evidence.map((record) => record.releasePolicyId)),
        validFromTick: task.dueTick,
        validUntilTick: null,
        strength: reflection.confidence,
        salience: reflection.confidence,
        recallCount: 0,
        lastReinforcedTick: task.dueTick,
        tags: ["belief", "reflection"],
        sourceObservationIds,
        content: {
          summaryZh: reflection.statement,
          counterpartIds: [...new Set(evidence.flatMap((record) => record.content.counterpartIds))].sort(compareStrings),
          data: {
            reflection: true,
            importance: Math.round(reflection.confidence * 10),
            confidence: reflection.confidence,
            evidenceIds: [...evidenceIds],
            reflectionThroughSeq: task.observationSeqThrough,
          },
        },
      });
    }
    const plan = capStream({
      baseRevision: task.baseRevision,
      observationSeqThrough: task.observationSeqThrough,
      inserts,
      retires: [],
      derivedThroughSeq: task.observationSeqThrough,
      derivedThroughTick: task.dueTick,
      changeKind: "maintenance",
      maintenanceResult: {
        status: "completed",
        failureReason: null,
        discarded,
      },
    }, view, this.config);
    return plan;
  }

  recordUse(
    input: Parameters<MemoryPort["recordUse"]>[0],
    view: RevisionView,
  ): MemoryChangePlan {
    requireSameScope(input.scope, view);
    const cited = new Set(input.citedMemoryIds);
    const inserts: MemoryChangePlan["inserts"] = view.records
      .filter((record) => record.status === "active" && cited.has(record.memoryId))
      .map((record) => reinforceStreamRow(record as MemoryRecordView, input.worldTick));
    const observations = new Map(input.inputObservations.map((observation) => [observation.observationId, observation]));
    for (const observation of input.inputObservations) {
      for (const eventId of observation.sourceEventIds) observations.set(eventId, observation);
    }
    for (const entry of input.noteworthy) {
      const sources = entry.sourceRefs.map((ref) => observations.get(ref)).filter(
        (source): source is AgentObservation => source !== undefined,
      );
      if (sources.length !== entry.sourceRefs.length) continue;
      if (view.records.some((record) =>
        dataOf(record)["noteworthyTurnId"] === input.turnId &&
        dataOf(record)["noteworthySummary"] === entry.summary,
      )) continue;
      inserts.push({
        memoryId: this.ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"],
        kind: "episodic",
        tier: "short",
        status: "active",
        epistemic: entry.kind === "request" ? "inference" : "reported-claim",
        releasePolicyId: mergeReleasePolicies(sources.map((source) => source.releasePolicyId)),
        validFromTick: input.worldTick,
        validUntilTick: null,
        strength: 0.5,
        salience: 0.5,
        recallCount: 0,
        lastReinforcedTick: input.worldTick,
        tags: ["dialogue"],
        sourceObservationIds: [...new Set(sources.map((source) => source.observationId))].sort(compareStrings),
        sourceTurnId: input.turnId,
        content: {
          summaryZh: entry.summary,
          counterpartIds: [...new Set([entry.aboutId, ...sources.flatMap((source) =>
            eventFromObservation(source, view.scope.agentId).counterpartIds,
          )])].filter((id) => id !== view.scope.agentId).sort(compareStrings),
          data: {
            stream: true,
            importance: 5,
            observationSeq: 0,
            noteworthyTurnId: input.turnId,
            noteworthySummary: entry.summary,
          },
        },
      });
    }
    return capStream({
      baseRevision: input.baseRevision,
      observationSeqThrough: maxObservationSeq(input.inputObservations),
      inserts,
      retires: [],
      derivedThroughSeq: null,
      derivedThroughTick: null,
      changeKind: "use",
    }, view, this.config);
  }

  proposeWakeups(): ReturnType<MemoryPort["proposeWakeups"]> {
    return [];
  }
}

function maxObservationSeq(observations: readonly AgentObservation[]): number {
  return observations.reduce((highest, observation) => Math.max(highest, observation.observationSeq), 0);
}

function requireSameScope(
  left: { readonly worldId: string; readonly branchId: string; readonly agentId: string },
  view: RevisionView,
): void {
  if (left.worldId !== view.scope.worldId ||
      left.branchId !== view.scope.branchId ||
      left.agentId !== view.scope.agentId) {
    throw new Error("memory scope does not match the frozen revision");
  }
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

function estimateTokens(text: string): number {
  return Array.from(text).length;
}

export function createStreamReflectionPort(config: StreamReflectionConfig, ids: Ids): StreamReflectionMemoryPort {
  return new StreamReflectionMemoryPort(config, ids);
}