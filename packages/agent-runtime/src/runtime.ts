/**
 * 实现感知消费、trigger、调度、记忆水位、turn 主循环、工具网关与对白提交。
 * 依赖 authority、storage、内容包、模块端口、Agent profile/toolset 与宿主服务。
 * 禁止在事务内等待模型/网络、绕过 command gateway 写世界或复用另一套 turn state machine。
 */
/* eslint-disable no-unused-vars -- 回调类型参数名用于表达运行时契约。 */
import type {
  AgentObservation,
  AgentStageEffective,
  AgentTrigger,
  AgentTriggerKind,
  AuthContext,
  CommandEnvelope,
  CommandReceipt,
  CommandType,
  ContextArtifact,
  DecisionSubmission,
  EventEnvelope,
  HostServices,
  InputFrontier,
  Json,
  MemoryBundle,
  MemoryChangePlan,
  MemoryScope,
  ModelCapabilities,
  ModuleDefinition,
  Purpose,
  StoragePort,
  ToolExecutionResult,
} from "@ai-npc/contracts";
import type { Authority } from "@ai-npc/authority";
import type {
  AgentBudgetPort,
  AgentCompressionPort,
  AgentDecisionInput,
  AgentModelPoolPort,
  AgentToolsPort,
  AgentToolViewPort,
  MemoryPort,
  MemoryRecordView,
  PerceptionRequest,
  RevisionView,
  ScopedModelPort,
  SchedulingPort,
} from "@ai-npc/module-sdk";
import type {
  ContentPack,
  ResolvedAgentProfile,
  Roster,
  Toolset,
} from "@ai-npc/experiment";
import { ApprovedSpeechStore } from "./approved-speech";
import { activateAgentRoster } from "./activation";
import { AgentModuleHandle, type AgentSlotModules } from "./module-host";
import { renderObservation } from "./observation-renderer";
import { renderSafeSpeech, validateSpeechText } from "./speech";

const terminalTurnStatuses = new Set(["completed", "failed", "cancelled", "budget-exhausted"]);
const publicNoticeTypes = new Set([
  "CampaignStarted",
  "DelegationCreated",
  "KnowledgeGranted",
  "AgentsSummoned",
  "AgreementProposed",
  "AgreementResponded",
  "AgreementActivated",
  "AgreementRejected",
  "AgreementExpired",
  "AgreementSuperseded",
  "AgreementTermFulfilled",
  "AgreementFulfilled",
  "AgreementBreached",
  "PassageGranted",
  "PolicyChanged",
  "TaskDispatched",
  "ResourcesReserved",
  "ResourcesReleased",
  "TaskInvitationIssued",
  "TaskInvitationAnswered",
  "TaskInvitationExpired",
  "TaskDeparted",
  "TaskDelayed",
  "TaskCompleted",
  "TaskFailed",
  "TaskCancelled",
  "ResourcesTransferred",
  "ResourcesConsumed",
  "StockpileAdjusted",
  "CharacterMoved",
  "TeamMoved",
  "CharacterInjured",
  "CharacterRecovered",
  "TeamRecovered",
  "EvidenceDiscovered",
  "ScoutReported",
  "GroupRescued",
  "GroupWorsened",
  "MetersChanged",
  "RelayDegraded",
  "RelayDown",
  "RelayRestored",
  "OrchardCrisis",
  "OrchardDamaged",
  "MigrationCrisis",
  "SupplyShortage",
  "DayPassed",
  "ChapterStageEvaluated",
]);

function asRecord(value: unknown): Readonly<Record<string, Json>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, Json>>
    : {};
}

function stringValue(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`字段 ${key} 不是字符串`);
  return value;
}

function numberValue(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`字段 ${key} 不是非负整数`);
  }
  return value;
}

function arrayValue(value: unknown): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value: unknown): Json {
  if (typeof value === "string") {
    return JSON.parse(value) as Json;
  }
  return value as Json;
}

function observationFromRow(row: Readonly<Record<string, unknown>>, scope: MemoryScope): AgentObservation {
  return {
    observationId: stringValue(row, "observation_id") as AgentObservation["observationId"],
    scope,
    observationSeq: numberValue(row, "observation_seq"),
    sourceEventIds: arrayValue(row["source_event_ids_json"]).filter((id): id is string => typeof id === "string") as unknown as AgentObservation["sourceEventIds"],
    sourceObservationIds: arrayValue(row["source_observation_ids_json"]).filter((id): id is string => typeof id === "string") as unknown as AgentObservation["sourceObservationIds"],
    occurredAtTick: numberValue(row, "occurred_at_tick"),
    sensedAtTick: numberValue(row, "sensed_at_tick"),
    knownAtTick: numberValue(row, "known_at_tick"),
    channel: stringValue(row, "channel"),
    epistemic: stringValue(row, "epistemic") as AgentObservation["epistemic"],
    confidence: Number(row["confidence"]),
    releasePolicyId: stringValue(row, "release_policy_id"),
    content: row["content_json"] as Json,
  };
}

function memoryRecordFromRow(row: Readonly<Record<string, unknown>>): MemoryRecordView {
  return {
    memoryId: stringValue(row, "memory_id"),
    rowVersion: numberValue(row, "row_version"),
    kind: stringValue(row, "kind") as MemoryRecordView["kind"],
    tier: stringValue(row, "tier") as MemoryRecordView["tier"],
    status: stringValue(row, "status") as MemoryRecordView["status"],
    epistemic: stringValue(row, "epistemic") as MemoryRecordView["epistemic"],
    releasePolicyId: stringValue(row, "release_policy_id"),
    validFromTick: numberValue(row, "valid_from_tick"),
    validUntilTick: row["valid_until_tick"] === null ? null : numberValue(row, "valid_until_tick"),
    strength: Number(row["strength"]),
    salience: Number(row["salience"]),
    recallCount: numberValue(row, "recall_count"),
    lastReinforcedTick: numberValue(row, "valid_from_tick"),
    tags: arrayValue(row["tags_json"]).filter((tag): tag is string => typeof tag === "string"),
    sourceObservationIds: arrayValue(row["source_observation_ids_json"]).filter((id): id is string => typeof id === "string"),
    content: row["content_json"] as MemoryRecordView["content"],
  };
}

function parseEvent(row: Readonly<Record<string, unknown>>, worldId: string, branchId: string): EventEnvelope {
  return {
    eventId: stringValue(row, "event_id") as EventEnvelope["eventId"],
    schemaVersion: numberValue(row, "schema_version"),
    worldId,
    branchId,
    worldSeq: numberValue(row, "world_seq"),
    worldTick: numberValue(row, "world_tick"),
    type: stringValue(row, "type"),
    principalId: stringValue(row, "principal_id"),
    causationIds: arrayValue(jsonValue(row["causation_ids_json"])).filter((id): id is string => typeof id === "string") as unknown as EventEnvelope["causationIds"],
    correlationId: stringValue(row, "correlation_id"),
    audience: arrayValue(jsonValue(row["audience_json"])) as EventEnvelope["audience"],
    payload: jsonValue(row["payload_json"]),
  };
}

function deliveryTick(event: EventEnvelope, agentId: string): number {
  const deliveries = arrayValue(asRecord(event.payload)["deliveries"]);
  const own = deliveries.map(asRecord).find((delivery) => delivery["principalId"] === agentId);
  return typeof own?.["deliverAtTick"] === "number"
    ? Math.max(event.worldTick, own["deliverAtTick"])
    : event.worldTick;
}

function releasePolicy(event: EventEnvelope): string {
  const principals = event.audience.flatMap((entry) => {
    const value = asRecord(entry as unknown as Json);
    return value["kind"] === "principals" && Array.isArray(value["ids"])
      ? value["ids"].filter((id): id is string => typeof id === "string")
      : [];
  }).sort();
  if (principals.length > 0) return `parties:${principals.join(",")}`;
  const faction = event.audience.map((entry) => asRecord(entry as unknown as Json)).find((entry) => entry["kind"] === "faction");
  return faction === undefined ? "public" : `faction:${String(faction["factionId"] ?? "")}`;
}

function eligible(event: EventEnvelope, agentId: string, factionId: string, nodeId: string | null): boolean {
  return event.audience.some((entry) => {
    const value = asRecord(entry as unknown as Json);
    if (value["kind"] === "public") return true;
    if (value["kind"] === "system") return false;
    if (value["kind"] === "node") return nodeId !== null && value["nodeId"] === nodeId;
    if (value["kind"] === "faction") return value["factionId"] === factionId;
    if (value["kind"] === "principals") {
      return Array.isArray(value["ids"]) && value["ids"].includes(agentId);
    }
    return false;
  });
}

function profileSelections(profile: ResolvedAgentProfile): Readonly<Record<"perception" | "memory" | "context" | "compression" | "toolView" | "decision", { readonly module: string; readonly config: Json }>> {
  return {
    perception: profile.slots.perception as { module: string; config: Json },
    memory: profile.slots.memory as { module: string; config: Json },
    context: profile.slots.context as { module: string; config: Json },
    compression: profile.slots.compression as { module: string; config: Json },
    toolView: profile.slots.toolView as { module: string; config: Json },
    decision: profile.slots.decision as { module: string; config: Json },
  };
}

export interface AgentWorldRead {
  readonly nodeId: string | null;
  readonly factionId: string;
  readonly worldViewText: string;
  readonly affairsText: string;
}

export interface AgentRuntimeOptions {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly authority: Authority;
  readonly content: ContentPack;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly toolsets: ReadonlyMap<string, Toolset>;
  readonly moduleDefinitions: ReadonlyMap<string, ModuleDefinition>;
  readonly runPorts: {
    readonly scheduling: SchedulingPort;
    readonly tools: AgentToolsPort;
    readonly modelPool: AgentModelPoolPort;
  };
  readonly approvedSpeech: ApprovedSpeechStore;
  readonly worldId: string;
  readonly branchId: string;
  readonly runId: string;
  readonly readWorld: (agentId: string) => AgentWorldRead;
  readonly onStateChange?: () => void;
}

class ScopedModelClientImpl implements ScopedModelPort {
  readonly scope: { readonly runId: string; readonly agentId: string; readonly purpose: Purpose };

  constructor(
    private readonly pool: AgentModelPoolPort,
    private readonly worldId: string,
    private readonly branchId: string,
    runId: string,
    agentId: string,
    purpose: Purpose,
  ) {
    this.scope = { runId, agentId, purpose };
  }

  call(input: Parameters<ScopedModelPort["call"]>[0]) {
    return this.pool.call({
      ...input,
      scope: { worldId: this.worldId, branchId: this.branchId, agentId: this.scope.agentId },
      purpose: this.scope.purpose,
    });
  }
}

/**
 * 单进程 Agent runtime。scheduler 与 turn 均只推进当前 branch；
 * 模型、工具和记忆提交在短事务外等待，事务内只做 CAS 与发布。
 */
export class AgentRuntime {
  private readonly consumers = new Map<string, AgentModuleHandle>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private activeTurns = new Set<string>();
  private readonly signal = new AbortController().signal;
  private readonly lastError: Error | null = null;

  constructor(private readonly options: AgentRuntimeOptions) {}

  async start(): Promise<void> {
    for (const agent of this.options.roster.agents) {
      const profile = this.options.profiles.get(agent.agentId);
      if (profile === undefined) {
        throw new Error(`名册身份 ${agent.agentId} 缺少 profile`);
      }
      const modules = await AgentModuleHandle.create({
        agentId: agent.agentId,
        host: this.options.host,
        signal: this.signal,
        worldId: this.options.worldId,
        branchId: this.options.branchId,
        selections: profileSelections(profile),
        definitions: this.options.moduleDefinitions,
        runPorts: {
          "agent.model-pool": this.options.runPorts.modelPool,
          "agent.tools": this.options.runPorts.tools,
        },
      });
      this.consumers.set(agent.agentId, modules);
      const toolset = this.options.toolsets.get(agent.toolsetRef);
      if (toolset === undefined) {
        throw new Error(`身份 ${agent.agentId} 缺少工具集 ${agent.toolsetRef}`);
      }
      this.options.runPorts.tools.bindAgentToolset({
        agentId: agent.agentId,
        toolsetId: toolset.toolsetId,
        tools: toolset.tools,
      });
      this.ensureMemoryState(agent.agentId);
    }
    this.running = true;
    await this.runCycle();
    this.schedule();
  }

  /** 立即推进一轮感知、记忆与调度；测试和受控单步复用同一循环。 */
  async pump(): Promise<void> {
    await this.runCycle();
  }

  async drain(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.activeTurns.size > 0) {
      await this.options.host.sleep(10);
    }
  }

  async dispose(): Promise<void> {
    await this.drain();
    let firstError: unknown;
    for (const handle of [...this.consumers.values()].reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.consumers.clear();
    if (firstError !== undefined) throw firstError;
  }

  private schedule(): void {
    if (!this.running || this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runCycle()
        .catch((error) => {
          this.options.host.logger.error("Agent runtime cycle failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => this.schedule());
    }, 250);
    this.timer.unref();
  }

  private async runCycle(): Promise<void> {
    if (this.stopped) return;
    const tick = this.clockTick();
    await this.consumeEvents();
    this.flushPending(tick);
    this.proposeWakeups(tick);
    await this.ingestObservations(tick);
    await this.runMaintenance(tick);
    this.scheduleTurns(tick);
    this.options.onStateChange?.();
  }

  private clockTick(): number {
    return this.options.storage.transact((tx) => {
      const row = tx.branch(this.options.branchId).table("clock").get({});
      if (row === null) throw new Error("Agent runtime 缺少时钟");
      return numberValue(row, "world_tick");
    });
  }

  private clockMode(): string {
    return this.options.storage.transact((tx) => {
      const row = tx.branch(this.options.branchId).table("clock").get({});
      return stringValue(row ?? {}, "mode");
    });
  }

  private async consumeEvents(): Promise<void> {
    const consumerId = "agent.perception.local";
    const { events, worldTick } = this.options.storage.transact((tx) => {
      const offset = tx.branch(this.options.branchId).table("consumer_offsets").get({ consumer_id: consumerId });
      const lastSeq = offset === null ? 0 : numberValue(offset, "last_world_seq");
      const clock = tx.branch(this.options.branchId).table("clock").get({});
      return {
        events: tx.all(
          "SELECT * FROM domain_events WHERE branch_id = ? AND world_seq > ? ORDER BY world_seq ASC LIMIT 200",
          [this.options.branchId, lastSeq],
        ),
        worldTick: numberValue(clock ?? {}, "world_tick"),
      };
    });
    for (const row of events) {
      const event = parseEvent(row, this.options.worldId, this.options.branchId);
      const plans: {
        readonly agentId: string;
        readonly observations: readonly AgentObservation[];
        readonly triggers: readonly import("@ai-npc/module-sdk").NewAgentTrigger[];
        readonly scannedThroughSeq: number;
      }[] = [];
      for (const agent of this.options.roster.agents) {
        const runtime = this.consumers.get(agent.agentId);
        if (runtime === undefined) continue;
        const world = this.options.readWorld(agent.agentId);
        const request: PerceptionRequest = {
          scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId: agent.agentId },
          event: {
            eventId: event.eventId,
            worldSeq: event.worldSeq,
            worldTick: event.worldTick,
            type: event.type,
            principalId: event.principalId,
            causationIds: event.causationIds,
            audience: event.audience as unknown as readonly Json[],
            payload: event.payload,
          },
          observer: {
            nodeId: world.nodeId,
            factionId: world.factionId,
            eligible: eligible(event, agent.agentId, world.factionId, world.nodeId),
            selfNodeIds: world.nodeId === null ? [] : [world.nodeId],
          },
          rendered: renderObservation({
            content: this.options.content,
            event: {
              eventId: event.eventId,
              worldSeq: event.worldSeq,
              worldTick: event.worldTick,
              type: event.type,
              principalId: event.principalId,
              causationIds: event.causationIds,
              audience: event.audience as unknown as readonly Json[],
              payload: event.payload,
            },
            agentId: agent.agentId,
            full: true,
          }),
          nowTick: worldTick,
        };
        const result = runtime.modules.perception.perceive(request);
        plans.push({
          agentId: agent.agentId,
          observations: result.observations.map((observation) => ({
            ...observation,
            observationId: this.options.host.ids("obs") as AgentObservation["observationId"],
          })),
          triggers: result.triggers,
          scannedThroughSeq: result.scannedThroughSeq,
        });
      }
      this.options.storage.transact((tx) => {
        const branch = tx.branch(this.options.branchId);
        const inbox = branch.table("consumer_inbox");
        if (inbox.get({ consumer_id: consumerId, event_id: event.eventId }) !== null) {
          branch.table("consumer_offsets").put({ consumer_id: consumerId, last_world_seq: event.worldSeq });
          return;
        }
        for (const plan of plans) {
          const stateTable = branch.table("perception_state");
          const stateRow = stateTable.get({ agent_id: plan.agentId });
          const pending = stateRow === null ? [] : arrayValue(asRecord(stateRow["state_json"])["pending"] as Json);
          const due = plan.observations.filter((observation) => observation.knownAtTick <= worldTick);
          const delayed = plan.observations.filter((observation) => observation.knownAtTick > worldTick);
          this.writeObservationsInTransaction(tx, plan.agentId, due);
          for (const trigger of plan.triggers) {
            this.writeTriggerInTransaction(tx, plan.agentId, trigger);
          }
          stateTable.put({
            agent_id: plan.agentId,
            module_id: (this.options.profiles.get(plan.agentId) as ResolvedAgentProfile).slots.perception?.module ?? "agent.perception.local",
            revision: stateRow === null ? 1 : numberValue(stateRow, "revision") + 1,
            scanned_through_seq: event.worldSeq,
            state_json: {
              ...(stateRow === null ? {} : asRecord(stateRow["state_json"])),
              pending: [...pending, ...delayed as unknown as Json[]],
              lastKnown: asRecord(stateRow?.["state_json"] as Json)["lastKnown"] ?? {},
            },
          });
        }
        inbox.put({ consumer_id: consumerId, event_id: event.eventId, processed_at: this.options.host.nowIso() });
        branch.table("consumer_offsets").put({ consumer_id: consumerId, last_world_seq: event.worldSeq });
      });
      if (event.type === "CampaignStarted") {
        this.activateRoster();
      }
    }
  }

  private writeObservationsInTransaction(
    tx: import("@ai-npc/contracts").StorageTransaction,
    agentId: string,
    observations: readonly AgentObservation[],
  ): void {
    if (observations.length === 0) return;
    const branch = tx.branch(this.options.branchId);
    const table = branch.table("observations");
    let seq = Number(table.max("observation_seq", { agent_id: agentId }) ?? 0);
    for (const observation of observations) {
      seq += 1;
      const existing = table.list(
        { agent_id: agentId, observation_id: observation.observationId },
        { limit: 1 },
      );
      if (existing.length > 0) continue;
      table.put({
        agent_id: agentId,
        observation_seq: seq,
        observation_id: observation.observationId,
        source_event_ids_json: [...observation.sourceEventIds],
        source_observation_ids_json: [...observation.sourceObservationIds],
        occurred_at_tick: observation.occurredAtTick,
        sensed_at_tick: observation.sensedAtTick,
        known_at_tick: observation.knownAtTick,
        channel: observation.channel,
        epistemic: observation.epistemic,
        confidence: observation.confidence,
        release_policy_id: observation.releasePolicyId,
        content_json: observation.content,
      });
    }
  }

  private writeTriggerInTransaction(
    tx: import("@ai-npc/contracts").StorageTransaction,
    agentId: string,
    trigger: import("@ai-npc/module-sdk").NewAgentTrigger,
  ): void {
    const table = tx.branch(this.options.branchId).table("triggers");
    if (table.list({ dedupe_key: trigger.dedupeKey }, { limit: 1 }).length > 0) return;
    table.put({
      trigger_id: this.options.host.ids("trg"),
      agent_id: agentId,
      kind: trigger.kind,
      priority: trigger.priority,
      source_ref: trigger.sourceRef,
      created_tick: trigger.createdTick,
      dedupe_key: trigger.dedupeKey,
      consumed_by_turn_id: null,
    });
  }

  private flushPending(tick: number): void {
    this.options.storage.transact((tx) => {
      const branch = tx.branch(this.options.branchId);
      const stateTable = branch.table("perception_state");
      for (const state of stateTable.list()) {
        const stateJson = asRecord(state["state_json"] as Json);
        const pending = arrayValue(stateJson["pending"] as Json)
          .map((item) => item as unknown as AgentObservation)
          .filter((observation) => observation.knownAtTick <= tick);
        if (pending.length === 0) continue;
        const agentId = stringValue(state, "agent_id");
        this.writeObservationsInTransaction(tx, agentId, pending);
        stateTable.put({
          ...state,
          revision: numberValue(state, "revision") + 1,
          state_json: {
            ...stateJson,
            pending: arrayValue(stateJson["pending"] as Json)
              .map((item) => item as unknown as AgentObservation)
              .filter((observation) => observation.knownAtTick > tick) as unknown as Json[],
          },
        });
      }
    });
  }

  private proposeWakeups(tick: number): void {
    for (const agent of this.options.roster.agents) {
      const runtime = this.consumers.get(agent.agentId);
      if (runtime === undefined) continue;
      const view = this.loadRevisionView(agent.agentId);
      const proposals = runtime.modules.memory.proposeWakeups(
        {
          scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId: agent.agentId },
          revision: view.revision,
          worldTick: tick,
        },
        view,
      );
      if (proposals.length === 0) continue;
      this.options.storage.transact((tx) => {
        for (const proposal of proposals) {
          this.writeTriggerInTransaction(tx, agent.agentId, {
            kind: "prospective",
            priority: 50,
            sourceRef: proposal.memoryId,
            createdTick: tick,
            dedupeKey: proposal.dedupeKey,
          });
        }
      });
    }
  }

  private ensureMemoryState(agentId: string): void {
    this.options.storage.transact((tx) => {
      const branch = tx.branch(this.options.branchId);
      const watermark = branch.table("memory_watermarks");
      if (watermark.get({ agent_id: agentId }) === null) {
        watermark.put({
          agent_id: agentId,
          module_id: this.options.profiles.get(agentId)?.slots.memory?.module ?? "agent.memory.none",
          revision: 0,
          observation_seq_consumed: 0,
          durable_through_seq: 0,
          derived_through_seq: 0,
          derived_through_tick: 0,
        });
      }
    });
  }

  private loadRevisionView(agentId: string): RevisionView {
    return this.options.storage.transact((tx) => {
      const branch = tx.branch(this.options.branchId);
      const watermark = branch.table("memory_watermarks").get({ agent_id: agentId });
      const revision = watermark === null ? 0 : numberValue(watermark, "revision");
      const records = branch.table("memory_records")
        .list({ agent_id: agentId })
        .filter((row) =>
          numberValue(row, "created_revision") <= revision &&
          (row["retired_revision"] === null || numberValue(row, "retired_revision") > revision),
        )
        .map(memoryRecordFromRow);
      return {
        scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId },
        revision,
        records,
      };
    });
  }

  private async ingestObservations(worldTick: number): Promise<void> {
    for (const agent of this.options.roster.agents) {
      const runtime = this.consumers.get(agent.agentId);
      if (runtime === undefined) continue;
      const input = this.options.storage.transact((tx) => {
        const branch = tx.branch(this.options.branchId);
        const watermark = branch.table("memory_watermarks").get({ agent_id: agent.agentId });
        const consumed = watermark === null ? 0 : numberValue(watermark, "observation_seq_consumed");
        const scope = { worldId: this.options.worldId, branchId: this.options.branchId, agentId: agent.agentId };
        const observations = branch.table("observations")
          .list({ agent_id: agent.agentId }, { orderBy: [{ column: "observation_seq" }] })
          .filter((row) => numberValue(row, "observation_seq") > consumed)
          .map((row) => observationFromRow(row, scope));
        return {
          baseRevision: watermark === null ? 0 : numberValue(watermark, "revision"),
          observations,
        };
      });
      if (input.observations.length === 0) continue;
      const plan = runtime.modules.memory.prepareIngest({
        scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId: agent.agentId },
        baseRevision: input.baseRevision,
        observations: input.observations,
        worldTick,
      });
      await this.applyMemoryPlan(agent.agentId, plan);
      const maintenance = runtime.modules.memory.planMaintenance({
        scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId: agent.agentId },
        revision: plan.baseRevision + 1,
        worldTick,
        observationSeqThrough: plan.observationSeqThrough,
        trigger: "importance",
      });
      if (maintenance !== null) this.queueMaintenance(agent.agentId, maintenance);
      if (input.observations.some((observation) => asRecord(observation.content)["eventType"] === "DayPassed")) {
        const daily = runtime.modules.memory.planMaintenance({
          scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId: agent.agentId },
          revision: plan.baseRevision + 1,
          worldTick,
          observationSeqThrough: plan.observationSeqThrough,
          trigger: "day-passed",
        });
        if (daily !== null) this.queueMaintenance(agent.agentId, daily);
      }
    }
  }

  private async applyMemoryPlan(agentId: string, plan: MemoryChangePlan): Promise<void> {
    const planHash = await this.options.host.hash(plan as unknown as Json);
    this.options.storage.transact((tx) => {
      const branch = tx.branch(this.options.branchId);
      const watermark = branch.table("memory_watermarks").get({ agent_id: agentId });
      if (watermark === null) throw new Error(`身份 ${agentId} 缺少 memory watermark`);
      const currentRevision = numberValue(watermark, "revision");
      if (plan.baseRevision !== currentRevision) {
        throw new Error(`memory revision 冲突：${plan.baseRevision} != ${currentRevision}`);
      }
      const nextRevision = currentRevision + 1;
      const records = branch.table("memory_records");
      for (const retire of plan.retires) {
        const current = records.list({ agent_id: agentId, memory_id: retire.memoryId }, {
          orderBy: [{ column: "row_version", direction: "desc" }],
          limit: 1,
        })[0];
        if (current !== null && current !== undefined) {
          records.put({ ...current, retired_revision: nextRevision, status: retire.status });
        }
      }
      for (const insert of plan.inserts) {
        const versions = records.list({ agent_id: agentId, memory_id: insert.memoryId }, {
          orderBy: [{ column: "row_version", direction: "desc" }],
          limit: 1,
        });
        const rowVersion = versions[0] === undefined ? 1 : numberValue(versions[0], "row_version") + 1;
        records.put({
          agent_id: agentId,
          memory_id: insert.memoryId,
          row_version: rowVersion,
          module_id: this.options.profiles.get(agentId)?.slots.memory?.module ?? "agent.memory.none",
          kind: insert.kind,
          tier: insert.tier,
          status: insert.status,
          epistemic: insert.epistemic,
          release_policy_id: insert.releasePolicyId,
          valid_from_tick: insert.validFromTick,
          valid_until_tick: insert.validUntilTick,
          created_revision: nextRevision,
          retired_revision: null,
          strength: insert.strength,
          salience: insert.salience,
          recall_count: insert.recallCount,
          tags_json: [...insert.tags],
          source_observation_ids_json: [...insert.sourceObservationIds],
          content_json: insert.content,
        });
      }
      branch.table("memory_revisions").put({
        agent_id: agentId,
        revision: nextRevision,
        base_revision: plan.baseRevision,
        observation_seq_through: plan.observationSeqThrough,
        world_seq_through: this.scannedThrough(agentId, tx),
        change_kind: plan.changeKind,
        plan_hash: planHash,
        created_at: this.options.host.nowIso(),
      });
      branch.table("memory_watermarks").put({
        ...watermark,
        revision: nextRevision,
        observation_seq_consumed: Math.max(numberValue(watermark, "observation_seq_consumed"), plan.observationSeqThrough),
        durable_through_seq: plan.observationSeqThrough,
        derived_through_seq: plan.derivedThroughSeq ?? numberValue(watermark, "derived_through_seq"),
        derived_through_tick: plan.derivedThroughTick ?? numberValue(watermark, "derived_through_tick"),
      });
    });
  }

  private scannedThrough(agentId: string, tx: import("@ai-npc/contracts").StorageTransaction): number {
    const state = tx.branch(this.options.branchId).table("perception_state").get({ agent_id: agentId });
    return state === null ? 0 : numberValue(state, "scanned_through_seq");
  }

  private queueMaintenance(agentId: string, task: import("@ai-npc/contracts").MaintenanceTask): void {
    this.options.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const existing = table.list({ branch_id: this.options.branchId, agent_id: agentId, status: "queued" })
        .find((row) => numberValue(row, "due_tick") === task.dueTick && row["trigger"] === task.trigger);
      if (existing !== undefined) return;
      table.put({
        maintenance_id: this.options.host.ids("mnt"),
        run_id: this.options.runId,
        branch_id: this.options.branchId,
        agent_id: agentId,
        module_id: task.moduleId,
        status: "queued",
        trigger: task.trigger,
        due_tick: task.dueTick,
        observation_seq_through: task.observationSeqThrough,
        task_json: task as unknown as Json,
        base_revision: task.baseRevision,
        lease_epoch: 0,
        lease_expires_at: null,
        error_json: null,
        created_at: this.options.host.nowIso(),
        ended_at: null,
      });
    });
  }

  private async runMaintenance(worldTick: number): Promise<void> {
    const taskRow = this.options.storage.transact((tx) =>
      tx.rows("maintenance_runs").list({ branch_id: this.options.branchId, status: "queued" }, {
        orderBy: [{ column: "due_tick" }, { column: "created_at" }],
        limit: 1,
      })[0],
    );
    if (taskRow === undefined || numberValue(taskRow, "due_tick") > worldTick) return;
    const agentId = stringValue(taskRow, "agent_id");
    const runtime = this.consumers.get(agentId);
    if (runtime === undefined) return;
    const task = taskRow["task_json"] as import("@ai-npc/contracts").MaintenanceTask;
    const view = this.loadRevisionView(agentId);
    const plan = await runtime.modules.memory.runMaintenance(
      task,
      view,
      task.needsModel
        ? new ScopedModelClientImpl(
            this.options.runPorts.modelPool,
            this.options.worldId,
            this.options.branchId,
            this.options.runId,
            agentId,
            "memory-maintenance",
          )
        : null,
    );
    await this.applyMemoryPlan(agentId, { ...plan, baseRevision: view.revision });
    this.options.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const row = table.get({ maintenance_id: stringValue(taskRow, "maintenance_id") });
      if (row !== null) {
        table.put({ ...row, status: "completed", ended_at: this.options.host.nowIso() });
      }
    });
  }

  private scheduleTurns(tick: number): void {
    if (this.activeTurns.size > 0 && this.activeTurns.size >= 4) return;
    const mode = this.clockMode();
    const paused = mode === "paused";
    const snapshot = this.options.storage.transact((tx) => {
      const branch = tx.branch(this.options.branchId);
      const activations = branch.table("agent_activations").list();
      const leases = branch.table("controller_leases").list();
      const triggers = branch.table("triggers").list()
        .filter((row) => row["consumed_by_turn_id"] === null);
      const running = tx.rows("turn_runs").list({ branch_id: this.options.branchId })
        .filter((row) => !terminalTurnStatuses.has(stringValue(row, "status")));
      const turns = tx.rows("turn_runs").list({ branch_id: this.options.branchId });
      return { activations, leases, triggers, running, turns };
    });
    const agents = this.options.roster.agents.map((agent) => {
      const activation = snapshot.activations.find((row) => row["agent_id"] === agent.agentId);
      const lease = snapshot.leases.find((row) => row["agent_id"] === agent.agentId);
      return {
        agentId: agent.agentId,
        active: activation?.["status"] === "active",
        controllerKind: lease?.["controller_kind"] === "human" ? "human" as const : "agent" as const,
        strategic: agent.kind === "strategic",
      };
    });
    const triggers: AgentTrigger[] = snapshot.triggers.map((row) => ({
      triggerId: stringValue(row, "trigger_id") as AgentTrigger["triggerId"],
      agentId: stringValue(row, "agent_id"),
      kind: stringValue(row, "kind") as AgentTriggerKind,
      priority: numberValue(row, "priority"),
      sourceRef: stringValue(row, "source_ref"),
      createdTick: numberValue(row, "created_tick"),
      dedupeKey: stringValue(row, "dedupe_key"),
      consumedByTurnId: row["consumed_by_turn_id"] === null
        ? null
        : stringValue(row, "consumed_by_turn_id") as AgentTrigger["consumedByTurnId"],
    }));
    const runningTurnAgentIds = snapshot.running.map((row) => stringValue(row, "agent_id"));
    const lastTurnTickByAgent: Record<string, number> = {};
    for (const row of snapshot.turns) {
      const agentId = stringValue(row, "agent_id");
      const created = row["created_at"];
      if (typeof created === "string") lastTurnTickByAgent[agentId] = Math.max(lastTurnTickByAgent[agentId] ?? 0, 0);
    }
    const plans = this.options.runPorts.scheduling.plan({
      branchId: this.options.branchId,
      worldTick: tick,
      paused,
      agents,
      triggers,
      runningTurnAgentIds,
      lastTurnTickByAgent,
    });
    for (const plan of plans) {
      if (runningTurnAgentIds.includes(plan.agentId)) continue;
      const turnId = this.options.host.ids("turn") as import("@ai-npc/contracts").AgentTurnRecord["turnId"];
      const profile = this.options.profiles.get(plan.agentId);
      const lease = snapshot.leases.find((row) => row["agent_id"] === plan.agentId);
      if (profile === undefined || lease === undefined) continue;
      const index = this.options.storage.transact((tx) =>
        tx.rows("turn_runs").list({ branch_id: this.options.branchId, agent_id: plan.agentId }).length + 1,
      );
      this.options.storage.transact((tx) => {
        tx.rows("turn_runs").put({
          turn_id: turnId,
          run_id: this.options.runId,
          branch_id: this.options.branchId,
          agent_id: plan.agentId,
          agent_turn_index: index,
          status: "queued",
          trigger_ids_json: [...plan.triggerIds],
          input_frontier_json: null,
          memory_revision: null,
          profile_hash: "pending",
          controller_epoch: numberValue(lease, "controller_epoch"),
          turn_lease_epoch: 0,
          lease_expires_at: null,
          terminal_reason: null,
          effective_json: [],
          created_at: this.options.host.nowIso(),
          started_at: null,
          ended_at: null,
        });
        const triggersTable = tx.branch(this.options.branchId).table("triggers");
        for (const triggerId of plan.triggerIds) {
          const row = triggersTable.get({ trigger_id: triggerId });
          if (row !== null) triggersTable.put({ ...row, consumed_by_turn_id: turnId });
        }
      });
      this.activeTurns.add(turnId);
      void this.executeTurn(turnId)
        .catch(async (error) => {
          await this.finishTurn(turnId, "failed", error instanceof Error ? error.message : String(error), []);
        })
        .finally(() => {
          this.activeTurns.delete(turnId);
        });
    }
  }

  private activateRoster(): void {
    activateAgentRoster({
      storage: this.options.storage,
      branchId: this.options.branchId,
      agentIds: this.options.roster.agents.map((agent) => agent.agentId),
      nowIso: this.options.host.nowIso(),
    });
  }

  private async executeTurn(turnId: string): Promise<void> {
    const row = this.options.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: turnId }));
    if (row === null) throw new Error(`turn ${turnId} 不存在`);
    const agentId = stringValue(row, "agent_id");
    const runtime = this.consumers.get(agentId);
    const profile = this.options.profiles.get(agentId);
    if (runtime === undefined || profile === undefined) throw new Error(`turn ${turnId} 缺少 Agent 模块`);
    const triggerIds = arrayValue(row["trigger_ids_json"]).filter((id): id is string => typeof id === "string");
    const triggers = this.options.storage.transact((tx) =>
      triggerIds.flatMap((id) => {
        const value = tx.branch(this.options.branchId).table("triggers").get({ trigger_id: id });
        return value === null ? [] : [{
          triggerId: stringValue(value, "trigger_id") as AgentTrigger["triggerId"],
          agentId,
          kind: stringValue(value, "kind") as AgentTriggerKind,
          priority: numberValue(value, "priority"),
          sourceRef: stringValue(value, "source_ref"),
          createdTick: numberValue(value, "created_tick"),
          dedupeKey: stringValue(value, "dedupe_key"),
          consumedByTurnId: turnId as AgentTrigger["consumedByTurnId"],
        } satisfies AgentTrigger];
      }),
    );
    const controllerEpoch = numberValue(row, "controller_epoch");
    const turnLeaseEpoch = numberValue(row, "turn_lease_epoch") + 1;
    const deadlineMs = this.options.host.monotonicMs() + profile.budgets.maxTurnMs;
    const leaseExpiresAt = new Date(
      Date.parse(this.options.host.nowIso()) + profile.budgets.maxTurnMs,
    ).toISOString();
    this.options.storage.transact((tx) => {
      tx.rows("turn_runs").put({
        ...row,
        status: "preparing",
        turn_lease_epoch: turnLeaseEpoch,
        lease_expires_at: leaseExpiresAt,
        started_at: this.options.host.nowIso(),
      });
    });
    const tick = this.clockTick();
    const view = this.loadRevisionView(agentId);
    const watermark = this.options.storage.transact((tx) =>
      tx.branch(this.options.branchId).table("memory_watermarks").get({ agent_id: agentId }),
    );
    const observationSeq = watermark === null ? 0 : numberValue(watermark, "observation_seq_consumed");
    const perception = this.options.storage.transact((tx) =>
      tx.branch(this.options.branchId).table("perception_state").get({ agent_id: agentId }),
    );
    const frontier: InputFrontier = {
      worldSeq: perception === null ? 0 : numberValue(perception, "scanned_through_seq"),
      worldTick: tick,
      observationSeq,
      perceptionRevision: perception === null ? 0 : numberValue(perception, "revision"),
      memoryRevision: view.revision,
      conversationCursor: null,
      knowledgeGrantRevision: 0,
    };
    const observations = this.loadObservations(agentId, observationSeq);
    const conversationId = observations
      .map((observation) => asRecord(observation.content)["refs"])
      .map(asRecord)
      ["find"]?.((refs) => typeof refs["conversationId"] === "string")?.["conversationId"];
    const memoryQuery = {
      scope: { worldId: this.options.worldId, branchId: this.options.branchId, agentId },
      revision: view.revision,
      frontier,
      counterpartIds: [...new Set(observations.flatMap((observation) => {
        const claim = asRecord(asRecord(observation.content)["claim"]);
        return typeof claim["sourceId"] === "string" ? [claim["sourceId"]] : [];
      }))],
      queryTags: [],
      queryText: observations.map((observation) => String(asRecord(observation.content)["summaryZh"] ?? "")).join("；"),
      nodeId: this.options.readWorld(agentId).nodeId,
      purpose: "decision" as const,
      audience: triggers.some((trigger) => trigger.kind === "player-dialogue") ? ["player-1"] : [],
      maxItems: 6,
      maxTokens: 1000,
    };
    const memory = runtime.modules.memory.retrieve(memoryQuery, view);
    const world = this.options.readWorld(agentId);
    const identity = this.identity(agentId);
    const inputText = observations.map((observation) =>
      `- [${observation.observationId}] ${String(asRecord(observation.content)["summaryZh"] ?? "")}`,
    ).join("\n");
    const historyText = typeof conversationId === "string"
      ? this.historyText(conversationId, profile.slots.context?.config)
      : "";
    const modelCapabilities = this.modelCapabilities(agentId);
    const decisionInput: AgentDecisionInput = {
      session: memoryQuery.scope,
      runId: this.options.runId,
      turnId,
      attemptId: this.options.host.ids("att") as import("@ai-npc/module-sdk").AgentDecisionInput["attemptId"],
      frontier,
      profileHash: "runtime-profile",
      templateVersion: this.options.content.prompts.templateVersion,
      agentTurnIndex: numberValue(row, "agent_turn_index"),
      triggers,
      observations,
      memory,
      identity: identity.persona,
      worldViewText: world.worldViewText,
      affairsText: world.affairsText,
      historyText,
      inputText,
      system: identity.system,
      loreSummary: this.options.content.lore.summary,
      modelWindowTokens: modelCapabilities.contextWindowTokens,
      contextBudget: {
        maxInputTokens: 8000,
        safetyTokens: 300,
        toolLoopReserveTokens: 1600,
        segmentBudgets: { world: 800, task: 500, memory: 1000, history: 800, "decision-output": 1500, "speech-output": 400 },
        historyTurns: typeof asRecord(profile.slots.context?.config)["historyTurns"] === "number"
          ? asRecord(profile.slots.context?.config)["historyTurns"] as number
          : 8,
        lendUnusedBudget: false,
      },
      model: new ScopedModelClientImpl(
        this.options.runPorts.modelPool,
        this.options.worldId,
        this.options.branchId,
        this.options.runId,
        agentId,
        "decision",
      ),
      context: runtime.modules.context,
      compression: runtime.modules.compression,
      tools: this.options.runPorts.tools,
      toolView: runtime.modules.toolView,
      executeTool: async (input) => this.executeTool({
        ...input,
        agentId,
        turnId,
        controllerEpoch,
        turnLeaseEpoch,
      }),
      maxDecisionRounds: profile.budgets.maxDecisionRounds,
      maxToolCallsPerRound: profile.budgets.maxToolCallsPerRound,
      maxToolCallsPerTurn: profile.budgets.maxToolCallsPerTurn,
      maxModelCallsPerTurn: profile.budgets.maxModelCallsPerTurn,
      deadlineMs,
    };
    this.options.storage.transact((tx) => {
      const latest = tx.rows("turn_runs").get({ turn_id: turnId });
      if (latest !== null) {
        tx.rows("turn_runs").put({
          ...latest,
          status: "deciding",
          input_frontier_json: frontier,
          memory_revision: view.revision,
          profile_hash: "runtime-profile",
        });
      }
    });
    const result = await runtime.modules.decision.decide(decisionInput);
    if (result.status !== "ok" || result.decision === null) {
      await this.finishTurn(turnId, result.status === "budget-exhausted" ? "budget-exhausted" : "failed", result.reason ?? result.status, result.stages);
      return;
    }
    let speechText: string | null = null;
    let speechValidation: Json = {};
    let speechFallback = true;
    if (result.decision.dialogueIntent.kind !== "none") {
      const generated = runtime.modules.decision.speak === undefined
        ? null
        : await runtime.modules.decision.speak({
            ...decisionInput,
            decision: result.decision,
            decisionArtifacts: result.contextArtifacts,
            receiptsText: result.toolResults.map((tool) => `${tool.executionStatus}:${tool.detail}`).join("\n"),
          });
      const allowedRefs = [
        ...result.contextArtifacts.flatMap((artifact) => artifact.segments.flatMap((segment) => segment.sourceRefs)),
        ...result.toolResults.map((tool) => tool.resultRef),
        ...memory.items.map((item) => item.memoryId),
        ...observations.map((observation) => observation.observationId),
      ];
      const fallback = renderSafeSpeech({
        content: this.options.content,
        decision: result.decision,
        facts: memory.items.map((item) => item.summaryZh).concat(observations.map((observation) => String(asRecord(observation.content)["summaryZh"] ?? ""))),
        receipts: result.toolResults,
        subject: result.decision.dialogueIntent.subjectRef,
      });
      const candidate = generated?.text ?? fallback;
      const validation = validateSpeechText({
        text: candidate,
        maxChars: profile.speech.maxChars,
        citations: generated?.citedRefs ?? [],
        allowedRefs,
        leakTerms: this.leakTerms(agentId, result.decision.dialogueIntent.audience),
        hasPendingTask: result.toolResults.some((tool) => tool.taskStatus === "pending" || tool.taskStatus === "running"),
        hasRejectedCommand: result.toolResults.some((tool) => tool.commandStatus === "rejected"),
        content: this.options.content,
      });
      speechText = validation.ok ? candidate : fallback;
      speechFallback = !validation.ok || generated?.fallback !== false;
      speechValidation = validation.ok ? generated?.validation ?? { template: false } : { fallbackReason: validation.reason };
    }
    if (speechText !== null && result.decision.dialogueIntent.audience.length > 0) {
      const artifactId = this.options.host.ids("art") as import("@ai-npc/contracts").SpeechArtifact["artifactId"];
      this.persistSpeechArtifact({
        artifactId,
        agentId,
        turnId,
        audience: result.decision.dialogueIntent.audience,
        intent: result.decision.dialogueIntent,
        text: speechText,
        fallback: speechFallback,
        validation: speechValidation,
      });
      const conversation = this.options.storage.transact((tx) =>
        typeof conversationId === "string"
          ? tx.branch(this.options.branchId).table("conversation_lines").list({ conversation_id: conversationId }, {
              orderBy: [{ column: "seq", direction: "desc" }],
              limit: 1,
            })[0]
          : undefined,
      );
      const receipt = this.options.authority.commands.execute(
        this.agentAuth(agentId, controllerEpoch, turnLeaseEpoch, turnId),
        {
          commandId: this.options.host.ids("cmd") as CommandEnvelope["commandId"],
          type: "speech.commit",
          schemaVersion: 1,
          payload: {
            channel: "dialogue",
            conversationId: typeof conversationId === "string" ? conversationId : null,
            audience: result.decision.dialogueIntent.audience,
            approvedSpeechArtifactRef: artifactId,
            intentKind: result.decision.dialogueIntent.kind,
            replyToId:
              conversation !== undefined && typeof conversation["dialogue_id"] === "string"
                ? conversation["dialogue_id"]
                : null,
          },
        },
      );
      if (receipt.commandStatus !== "accepted") {
        this.options.approvedSpeech.delete(artifactId);
      }
    }
    const usePlan = runtime.modules.memory.recordUse(
      {
        scope: memoryQuery.scope,
        baseRevision: view.revision,
        turnId,
        citedMemoryIds: result.decision.citedMemoryIds,
        noteworthy: result.decision.noteworthy,
        inputObservations: observations,
        worldTick: tick,
      },
      view,
    );
    await this.applyMemoryPlan(agentId, usePlan);
    await this.finishTurn(turnId, "completed", null, result.stages);
  }

  private identity(agentId: string): {
    readonly system: string;
    readonly persona: AgentDecisionInput["identity"];
  } {
    const character = this.options.content.index.characters.get(agentId);
    const faction = character === undefined
      ? this.options.content.index.factions.get(agentId)
      : this.options.content.index.factions.get(character.factionId);
    const name = character?.name ?? faction?.leaderName ?? faction?.name ?? agentId;
    const kind = character === undefined ? "strategic" : "character";
    const role = character?.role ?? faction?.persona.role ?? "派系代表";
    const values = character?.values ?? faction?.persona.values ?? [];
    const speechStyle = character?.speechStyle ?? faction?.persona.speechStyle ?? "";
    const bottomLines = character?.bottomLines ?? faction?.persona.bottomLines ?? [];
    const goals = character?.goals ?? faction?.persona.goals ?? [];
    const factionName = faction?.name ?? "无派系";
    const system = this.options.content.prompts.decision.system
      .replaceAll("{{kindLabel}}", this.options.content.prompts.labels.kinds[kind])
      .replaceAll("{{name}}", name)
      .replaceAll("{{agentId}}", agentId)
      .replaceAll("{{maxToolCallsPerRound}}", "3")
      .replaceAll("{{loreSummary}}", this.options.content.lore.summary)
      .replaceAll("{{factionName}}", factionName)
      .replaceAll("{{role}}", role)
      .replaceAll("{{values}}", values.join("、"))
      .replaceAll("{{speechStyle}}", speechStyle)
      .replaceAll("{{bottomLines}}", bottomLines.join("、"))
      .replaceAll("{{goals}}", goals.join("、"))
      .replaceAll("{{initialRelations}}", "");
    return {
      system,
      persona: {
        name,
        kind,
        factionName,
        role,
        values,
        skills: character?.skills ?? [],
        speechStyle,
        bottomLines,
        goals,
      },
    };
  }

  private loadObservations(agentId: string, throughSeq: number): AgentObservation[] {
    return this.options.storage.transact((tx) =>
      tx.branch(this.options.branchId).table("observations")
        .list({ agent_id: agentId }, { orderBy: [{ column: "observation_seq" }] })
        .filter((row) => numberValue(row, "observation_seq") <= throughSeq)
        .map((row) => observationFromRow(
          row,
          { worldId: this.options.worldId, branchId: this.options.branchId, agentId },
        )),
    );
  }

  private historyText(conversationId: string, contextConfig: Json | undefined): string {
    const historyTurns = typeof asRecord(contextConfig)["historyTurns"] === "number"
      ? asRecord(contextConfig)["historyTurns"] as number
      : 8;
    return this.options.storage.transact((tx) =>
      [...tx.branch(this.options.branchId).table("conversation_lines")
        .list({ conversation_id: conversationId }, {
          orderBy: [{ column: "seq", direction: "desc" }],
          limit: historyTurns,
        })]
        .reverse()
        .map((row) => `- ${this.options.content.index.characters.get(stringValue(row, "speaker_id"))?.name ?? stringValue(row, "speaker_id")}：${stringValue(row, "text")}`)
        .join("\n"),
    );
  }

  private modelCapabilities(agentId: string): ModelCapabilities {
    return {
      toolCalling: true,
      strictTools: true,
      structuredOutput: "json_schema",
      assistantReplay: "verbatim",
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
      embedding: false,
      embeddingDimensions: null,
    };
  }

  private leakTerms(agentId: string, audience: readonly string[]): readonly string[] {
    const heldByAgent = [...this.options.content.index.secrets.values()]
      .filter((secret) => secret.heldBy.includes(agentId));
    return heldByAgent
      .filter((secret) => audience.some((audienceId) => !secret.heldBy.includes(audienceId)))
      .flatMap((secret) => secret.leakTerms);
  }

  private persistSpeechArtifact(input: {
    readonly artifactId: string;
    readonly agentId: string;
    readonly turnId: string;
    readonly audience: readonly string[];
    readonly intent: import("@ai-npc/contracts").DialogueIntent;
    readonly text: string;
    readonly fallback: boolean;
    readonly validation: Json;
  }): void {
    this.options.approvedSpeech.put(input.artifactId, {
      text: input.text,
      agentId: input.agentId,
      turnId: input.turnId,
      branchId: this.options.branchId,
      audience: input.audience,
      channel: "dialogue",
      approved: true,
    });
    this.options.storage.transact((tx) => {
      tx.rows("artifacts").put({
        artifact_id: input.artifactId,
        run_id: this.options.runId,
        kind: "speech",
        content_hash: input.artifactId,
        mime: "application/json",
        byte_size: input.text.length,
        storage: "inline",
        body: JSON.stringify({
          text: input.text,
          audience: input.audience,
          intent: input.intent,
          fallback: input.fallback,
          validation: input.validation,
        }),
        file_path: null,
        redaction: "raw",
        redacted_from: null,
        created_at: this.options.host.nowIso(),
      });
    });
  }

  private agentAuth(
    agentId: string,
    controllerEpoch: number,
    turnLeaseEpoch: number,
    turnId: string,
  ): AuthContext {
    return {
      principalId: agentId,
      kind: "agent",
      roles: ["agent"],
      worldId: this.options.worldId,
      branchId: this.options.branchId,
      actingAsAgentId: null,
      controllerEpoch,
      turnLeaseEpoch,
      turnId,
    };
  }

  private async executeTool(input: {
    readonly toolId: string;
    readonly arguments: Json;
    readonly providerCallId: string;
    readonly attemptId: string;
    readonly round: number;
    readonly agentId: string;
    readonly turnId: string;
    readonly controllerEpoch: number;
    readonly turnLeaseEpoch: number;
  }): Promise<{ readonly result: ToolExecutionResult; readonly modelText: string }> {
    const definition = this.options.runPorts.tools.definition(input.toolId, "1");
    if (definition === null) {
      const result: ToolExecutionResult = {
        executionStatus: "error",
        commandStatus: null,
        taskStatus: null,
        reasonCode: "no-authority",
        receiptId: null,
        operationId: null,
        resultRef: this.options.host.ids("art"),
        detail: "未授权工具",
        data: {},
      };
      return { result, modelText: JSON.stringify(result) };
    }
    if (definition.effect === "query") {
      const world = this.options.readWorld(input.agentId);
      const result: ToolExecutionResult = {
        executionStatus: "ok",
        commandStatus: null,
        taskStatus: null,
        reasonCode: null,
        receiptId: null,
        operationId: null,
        resultRef: this.options.host.ids("art"),
        detail: input.toolId === "world.inspect" ? world.worldViewText : "查询结果",
        data: asRecord(input.arguments),
      };
      return { result, modelText: JSON.stringify(result) };
    }
    const resolved = this.options.runPorts.tools.resolveCommand(input);
    if ("error" in resolved) {
      const result: ToolExecutionResult = {
        executionStatus: "error",
        commandStatus: null,
        taskStatus: null,
        reasonCode: "invalid-params",
        receiptId: null,
        operationId: null,
        resultRef: this.options.host.ids("art"),
        detail: resolved.error,
        data: {},
      };
      return { result, modelText: JSON.stringify(result) };
    }
    const operationId = this.options.host.ids("op");
    const commandId = this.options.host.ids("cmd") as CommandEnvelope["commandId"];
    const payloadHash = await this.options.host.hash(resolved.payload);
    const existing = this.options.storage.transact((tx) => {
      const call = tx.rows("tool_calls").list({
        provider_call_id: input.providerCallId,
        attempt_id: input.attemptId,
        agent_id: input.agentId,
      }, { limit: 1 })[0];
      return call ?? null;
    });
    let receipt: CommandReceipt;
    if (existing !== null && typeof existing["operation_id"] === "string") {
      const receiptRow = this.options.storage.transact((tx) =>
        tx.branch(this.options.branchId).table("command_receipts").get({
          principal_id: input.agentId,
          command_id: String(existing["command_id"]),
        }),
      );
      receipt = receiptRow?.["receipt_json"] as CommandReceipt;
    } else {
      this.options.storage.transact((tx) => {
        tx.rows("tool_calls").put({
          tool_call_id: this.options.host.ids("tc"),
          run_id: this.options.runId,
          turn_id: input.turnId,
          attempt_id: input.attemptId,
          agent_id: input.agentId,
          provider_call_id: input.providerCallId,
          tool_id: input.toolId,
          tool_version: "1",
          binding_id: `${input.agentId}:${input.toolId}`,
          status: "admitted",
          args_hash: payloadHash,
          operation_id: operationId,
          command_id: commandId,
          execution_status: null,
          raw_artifact_id: null,
          view_artifact_id: null,
          created_at: this.options.host.nowIso(),
          settled_at: null,
        });
      });
      this.options.storage.transact((tx) => {
        tx.branch(this.options.branchId).table("operations").put({
          agent_id: input.agentId,
          operation_id: operationId,
          command_id: commandId,
          payload_hash: payloadHash,
          created_at: this.options.host.nowIso(),
        });
      });
      receipt = this.options.authority.commands.execute(
        this.agentAuth(input.agentId, input.controllerEpoch, input.turnLeaseEpoch, input.turnId),
        {
          commandId,
          type: resolved.commandType as CommandType,
          schemaVersion: 1,
          payload: resolved.payload,
        },
      );
    }
    const result: ToolExecutionResult = {
      executionStatus: "ok",
      commandStatus: receipt.commandStatus,
      taskStatus:
        receipt.commandStatus === "accepted" && typeof receipt.result === "object" && receipt.result !== null && !Array.isArray(receipt.result)
          ? "pending"
          : null,
      reasonCode: receipt.reasonCode,
      receiptId: receipt.receiptId,
      operationId,
      resultRef: this.options.host.ids("art"),
      detail: receipt.commandStatus === "accepted" ? "命令已受理，尚未完成。" : receipt.safeMessage ?? "命令被拒绝。",
      data: receipt.result ?? {},
    };
    this.options.storage.transact((tx) => {
      const table = tx.rows("tool_calls");
      const row = table.list({ operation_id: operationId }, { limit: 1 })[0];
      if (row !== undefined) {
        table.put({ ...row, status: "settled", execution_status: result.executionStatus, settled_at: this.options.host.nowIso() });
      }
    });
    return { result, modelText: JSON.stringify(result) };
  }

  private async finishTurn(
    turnId: string,
    status: "completed" | "failed" | "cancelled" | "budget-exhausted",
    reason: string | null,
    stages: readonly AgentStageEffective[],
  ): Promise<void> {
    this.options.storage.transact((tx) => {
      const table = tx.rows("turn_runs");
      const row = table.get({ turn_id: turnId });
      if (row === null) return;
      table.put({
        ...row,
        status,
        terminal_reason: reason,
        effective_json: [...stages],
        ended_at: this.options.host.nowIso(),
      });
      if (status === "cancelled") {
        const triggers = tx.branch(this.options.branchId).table("triggers");
        for (const triggerId of [...arrayValue(row["trigger_ids_json"]).filter((id): id is string => typeof id === "string")]) {
          const trigger = triggers.get({ trigger_id: triggerId });
          if (trigger !== null) triggers.put({ ...trigger, consumed_by_turn_id: null });
        }
      }
    });
  }
}
