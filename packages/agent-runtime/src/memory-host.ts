/**
 * 协调记忆模块生命周期、摄入、检索、整理与唤醒 trigger。
 * Coordinates memory module lifecycles, ingestion, retrieval, maintenance, and wake-up triggers.
 * Depends on injected storage, profiles, registered modules, and immutable revision views.
 * Must not call models inside actor transactions or allow modules to publish rows directly.
 */
import type {
  AgentMemoryQuery,
  AgentObservation,
  HostServices,
  Json,
  MemoryBundle,
  MemoryChangePlan,
  MemoryScope,
  ModuleDefinition,
  StoragePort,
} from "@ai-npc/contracts";
import type {
  MemoryAgentIdentity,
  MemoryPort,
  RevisionView,
} from "@ai-npc/module-sdk";
import type { ResolvedAgentProfile, Roster } from "@ai-npc/experiment";
import { MemoryMaintenanceQueue } from "./memory-maintenance-queue";
import { MemoryModuleHandle } from "./memory-module-handle";
import {
  publishMaintenance,
  publishUse,
  type MemoryRecordUseRequest,
} from "./memory-publication";
import { MemoryStore, type MemoryWatermark } from "./memory-store";

export interface MemoryHostOptions {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly moduleDefinitions: ReadonlyMap<string, ModuleDefinition>;
  readonly identities: ReadonlyMap<string, MemoryAgentIdentity>;
  readonly worldId: string;
  readonly branchId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly maintenanceLeaseMs?: number;
  readonly maintenanceConcurrency?: number;
}

export class MemoryHost {
  private readonly modules = new Map<string, MemoryModuleHandle>();
  private readonly actorTails = new Map<string, Promise<void>>();
  private readonly store: MemoryStore;
  private readonly maintenance: MemoryMaintenanceQueue;
  private started = false;

  constructor(private readonly options: MemoryHostOptions) {
    this.store = new MemoryStore(
      options.storage,
      options.host,
      options.worldId,
      options.branchId,
      options.runId,
    );
    this.maintenance = new MemoryMaintenanceQueue(
      options.storage,
      options.host,
      options.runId,
      options.branchId,
      options.maintenanceLeaseMs ?? 120_000,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    try {
      for (const agent of this.options.roster.agents) {
        const selection = this.options.profiles.get(agent.agentId)?.slots.memory;
        if (selection === undefined) {
          throw new Error(`agent ${agent.agentId} has no memory profile slot`);
        }
        const definition = this.options.moduleDefinitions.get(selection.module);
        if (definition === undefined) {
          throw new Error(`memory module ${selection.module} is not registered`);
        }
        const handle = await MemoryModuleHandle.create({
          agentId: agent.agentId,
          moduleId: selection.module,
          config: selection.config,
          definition,
          worldId: this.options.worldId,
          branchId: this.options.branchId,
          host: this.options.host,
          signal: this.options.signal,
        });
        this.modules.set(agent.agentId, handle);
        await this.store.initializeAgent(agent.agentId, selection.module);
      }
      this.maintenance.recoverInterrupted();
      for (const agent of this.options.roster.agents) {
        this.requeueMissingDayPassed(agent.agentId);
      }
      this.started = true;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async ingestAll(worldTick: number): Promise<void> {
    await Promise.all(this.options.roster.agents.map(async (agent) => {
      if (!this.store.agentControl(agent.agentId).active) return;
      await this.ingestAgent(agent.agentId, worldTick);
    }));
  }

  async runDueMaintenance(worldTick: number): Promise<void> {
    const claimed = this.maintenance.due(
      this.options.maintenanceConcurrency ?? 2,
      worldTick,
    );
    await Promise.all(claimed.map(async (claim) => {
      const agentId = String(claim.row["agent_id"]);
      try {
        await publishMaintenance(agentId, claim, this.publication(agentId));
      } catch (error) {
        this.options.host.logger.error("Memory maintenance failed", {
          agentId,
          maintenanceId: claim.maintenanceId,
          message: error instanceof Error ? error.message : String(error),
        });
        this.maintenance.fail(claim.maintenanceId, claim.leaseEpoch, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  proposeDueWakeups(worldTick: number): void {
    for (const agent of this.options.roster.agents) {
      const control = this.store.agentControl(agent.agentId);
      if (!control.active || !control.agentControlled) continue;
      const handle = this.module(agent.agentId);
      const watermark = this.requireWatermark(agent.agentId);
      const view = this.view(agent.agentId, watermark.revision);
      const proposals = handle.port.proposeWakeups({
        scope: this.scope(agent.agentId),
        revision: watermark.revision,
        worldTick,
      }, view);
      this.writeTriggers(agent.agentId, proposals, worldTick);
    }
  }

  retrieve(agentId: string, query: AgentMemoryQuery): MemoryBundle {
    const view = this.store.readRevisionView(
      agentId,
      this.identity(agentId),
      query.revision,
    );
    return this.module(agentId).port.retrieve(query, view);
  }

  recordUse(agentId: string, input: MemoryRecordUseRequest): Promise<number> {
    return publishUse(agentId, input, this.publication(agentId));
  }

  watermark(agentId: string): MemoryWatermark {
    return this.requireWatermark(agentId);
  }

  async dispose(): Promise<void> {
    this.started = false;
    let firstError: unknown;
    for (const handle of [...this.modules.values()].reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.modules.clear();
    if (firstError !== undefined) throw firstError;
  }

  private async ingestAgent(agentId: string, worldTick: number): Promise<void> {
    await this.enqueueActor(agentId, async () => {
      const watermark = this.requireWatermark(agentId);
      const observations = this.store.readObservations(agentId, watermark.observationSeqConsumed);
      if (observations.length === 0) return;
      for (const observation of observations) {
        assertScope(observation.scope, this.scope(agentId));
      }
      const expectedSeq = watermark.observationSeqConsumed + 1;
      for (const [index, observation] of observations.entries()) {
        if (observation.observationSeq !== expectedSeq + index) {
          throw new Error(
            `agent ${agentId} observation watermark has a gap: expected ${expectedSeq + index}, got ${observation.observationSeq}`,
          );
        }
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = this.requireWatermark(agentId);
        const view = this.store.readRevisionView(agentId, this.identity(agentId), current.revision);
        const plan = this.module(agentId).port.prepareIngest({
          scope: this.scope(agentId),
          baseRevision: current.revision,
          observations,
          worldTick,
        }, view);
        validatePlan(plan, current.revision, observations);
        const planHash = await this.options.host.hash(plan as unknown as Json);
        const latest = this.requireWatermark(agentId);
        if (latest.revision !== current.revision) continue;
        this.store.commitPlan(agentId, this.module(agentId).moduleId, plan, {
          planHash,
          worldSeqThrough: this.store.scannedWorldSeq(),
        });
        this.queueMaintenanceAfterIngest(agentId, observations, worldTick);
        return;
      }
      throw new Error(`agent ${agentId} ingest could not bind a stable revision`);
    });
  }

  private queueMaintenanceAfterIngest(
    agentId: string,
    observations: readonly AgentObservation[],
    worldTick: number,
  ): void {
    const handle = this.module(agentId);
    const watermark = this.requireWatermark(agentId);
    const dayTicks = [...new Set(observations
      .filter((observation) => observationObject(observation)["eventType"] === "DayPassed")
      .map((observation) => observation.knownAtTick))];
    for (const dayTick of dayTicks) {
      const task = handle.port.planMaintenance({
        scope: this.scope(agentId),
        revision: watermark.revision,
        worldTick: dayTick,
        observationSeqThrough: watermark.observationSeqConsumed,
        trigger: "day-passed",
      });
      if (task !== null) this.maintenance.enqueue(agentId, task);
    }
    const importance = handle.port.planMaintenance({
      scope: this.scope(agentId),
      revision: watermark.revision,
      worldTick,
      observationSeqThrough: watermark.observationSeqConsumed,
      trigger: "importance",
    });
    if (importance !== null) this.maintenance.enqueue(agentId, importance);
  }

  private requeueMissingDayPassed(agentId: string): void {
    if (!this.store.agentControl(agentId).active) return;
    const latest = this.store.latestDayPassedTick(agentId);
    if (latest === null) return;
    const watermark = this.requireWatermark(agentId);
    if (watermark.derivedThroughTick >= latest) return;
    if (this.maintenance.hasTask(agentId, "day-passed", latest)) return;
    const task = this.module(agentId).port.planMaintenance({
      scope: this.scope(agentId),
      revision: watermark.revision,
      worldTick: latest,
      observationSeqThrough: watermark.observationSeqConsumed,
      trigger: "day-passed",
    });
    if (task !== null) this.maintenance.enqueue(agentId, task);
  }

  private writeTriggers(
    agentId: string,
    proposals: ReturnType<MemoryPort["proposeWakeups"]>,
    worldTick: number,
  ): void {
    if (proposals.length === 0) return;
    this.options.storage.transact((tx) => {
      const triggers = tx.branch(this.options.branchId).table("triggers");
      for (const proposal of proposals) {
        if (proposal.atTick > worldTick) continue;
        if (triggers.list({ dedupe_key: proposal.dedupeKey }, { limit: 1 }).length > 0) continue;
        triggers.put({
          trigger_id: this.options.host.ids("trg"),
          agent_id: agentId,
          kind: "prospective",
          priority: 50,
          source_ref: proposal.memoryId,
          created_tick: worldTick,
          dedupe_key: proposal.dedupeKey,
          consumed_by_turn_id: null,
        });
      }
    });
  }

  private enqueueActor<T>(agentId: string, operation: () => T | Promise<T>): Promise<T> {
    const prior = this.actorTails.get(agentId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(() => operation());
    const tail = result.then(() => undefined, () => undefined);
    this.actorTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.actorTails.get(agentId) === tail) this.actorTails.delete(agentId);
    });
    return result;
  }

  private publication(agentId: string) {
    return {
      store: this.store,
      maintenance: this.maintenance,
      host: this.options.host,
      moduleId: this.module(agentId).moduleId,
      port: this.module(agentId).port,
      scope: this.scope(agentId),
      identity: this.identity(agentId),
      enqueueActor: this.enqueueActor.bind(this),
    };
  }

  private view(agentId: string, revision: number): RevisionView {
    return this.store.readRevisionView(agentId, this.identity(agentId), revision);
  }

  private identity(agentId: string): MemoryAgentIdentity {
    const identity = this.options.identities.get(agentId);
    if (identity === undefined) throw new Error(`agent ${agentId} memory identity is not configured`);
    return identity;
  }

  private module(agentId: string): MemoryModuleHandle {
    const handle = this.modules.get(agentId);
    if (handle === undefined) throw new Error(`agent ${agentId} memory module is not started`);
    return handle;
  }

  private requireWatermark(agentId: string): MemoryWatermark {
    const watermark = this.store.readWatermark(agentId);
    if (watermark === null) throw new Error(`agent ${agentId} memory is not initialized`);
    return watermark;
  }

  private scope(agentId: string): MemoryScope {
    return { worldId: this.options.worldId, branchId: this.options.branchId, agentId };
  }
}

function validatePlan(
  plan: MemoryChangePlan,
  baseRevision: number,
  observations: readonly AgentObservation[],
): void {
  if (plan.baseRevision !== baseRevision) {
    throw new Error(`memory ingest plan base ${plan.baseRevision} does not match ${baseRevision}`);
  }
  const expectedThrough = Math.max(...observations.map((observation) => observation.observationSeq));
  if (plan.observationSeqThrough !== expectedThrough) {
    throw new Error(`memory ingest plan must advance through observation ${expectedThrough}`);
  }
  const insertIds = plan.inserts.map((row) => row.memoryId);
  if (new Set(insertIds).size !== insertIds.length) {
    throw new Error("memory ingest plan contains duplicate inserted memory IDs");
  }
}

function assertScope(left: MemoryScope, right: MemoryScope): void {
  if (
    left.worldId !== right.worldId ||
    left.branchId !== right.branchId ||
    left.agentId !== right.agentId
  ) {
    throw new Error("memory observation scope does not match the agent host");
  }
}

function observationObject(observation: AgentObservation): Readonly<Record<string, unknown>> {
  return typeof observation.content === "object" &&
    observation.content !== null &&
    !Array.isArray(observation.content)
    ? observation.content as Readonly<Record<string, unknown>>
    : {};
}
