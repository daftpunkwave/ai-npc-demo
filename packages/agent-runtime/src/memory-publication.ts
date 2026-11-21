/**
 * 在 actor 事务外生成记忆计划，并在短事务内完成 CAS 或 rebase 发布。
 * Generates use and maintenance plans outside actors and publishes them with fencing.
 * Must not call modules while an actor transaction is open.
 */
import type {
  AgentObservation,
  HostServices,
  Json,
  MaintenanceTask,
  MemoryChangePlan,
  MemoryScope,
  StorageTransaction,
} from "@ai-npc/contracts";
import type {
  MemoryAgentIdentity,
  MemoryPort,
  RevisionView,
} from "@ai-npc/module-sdk";
import type {
  ClaimedMaintenance,
  MemoryMaintenanceQueue,
} from "./memory-maintenance-queue";
import type { MemoryStore } from "./memory-store";

export interface MemoryRecordUseRequest {
  readonly baseRevision: number;
  readonly turnId: string;
  readonly retrievedMemoryIds: readonly string[];
  readonly citedMemoryIds: readonly string[];
  readonly noteworthy: Parameters<MemoryPort["recordUse"]>[0]["noteworthy"];
  readonly inputObservations: readonly AgentObservation[];
  readonly worldTick: number;
  readonly guard?: (tx: StorageTransaction) => void;
}

export interface MemoryPublicationDependencies {
  readonly store: MemoryStore;
  readonly maintenance: MemoryMaintenanceQueue;
  readonly host: HostServices;
  readonly moduleId: string;
  readonly port: MemoryPort;
  readonly scope: MemoryScope;
  readonly identity: MemoryAgentIdentity;
  readonly enqueueActor: <T>(agentId: string, operation: () => T | Promise<T>) => Promise<T>;
}

export async function publishUse(
  agentId: string,
  input: MemoryRecordUseRequest,
  dependencies: MemoryPublicationDependencies,
): Promise<number> {
  const { store, port, scope, identity, enqueueActor } = dependencies;
  let baseRevision = input.baseRevision;
  for (let generation = 0; generation <= 2; generation += 1) {
    const current = store.readWatermark(agentId);
    if (current === null) throw new Error(`agent ${agentId} memory is not initialized`);
    if (generation === 0 && baseRevision < current.revision) baseRevision = current.revision;
    for (const observation of input.inputObservations) {
      assertObservationScope(observation.scope, scope);
      if (observation.observationSeq > current.observationSeqConsumed) {
        throw new Error("memory use references an observation that has not been ingested");
      }
    }
    const view = store.readRevisionView(agentId, identity, baseRevision);
    const plan = port.recordUse({
      scope,
      baseRevision,
      turnId: input.turnId,
      citedMemoryIds: input.citedMemoryIds,
      noteworthy: input.noteworthy,
      inputObservations: input.inputObservations,
      worldTick: input.worldTick,
    }, view);
    validateUsePlan(plan, view, input);
    if (plan.derivedThroughTick !== null && plan.derivedThroughTick > input.worldTick) {
      throw new Error("memory use plan cannot derive a future tick");
    }
    const outcome = await bindAndCommitPlan(
      agentId,
      plan,
      dependencies,
      enqueueActor,
      { guard: input.guard },
    );
    if (outcome.committed) return outcome.revision;
    baseRevision = outcome.revision;
  }
  throw new Error(`memory recordUse for ${agentId} exhausted its rebase attempts`);
}

export async function publishMaintenance(
  agentId: string,
  claim: ClaimedMaintenance,
  dependencies: MemoryPublicationDependencies,
): Promise<void> {
  const { store, maintenance, port, identity, enqueueActor } = dependencies;
  let task: MaintenanceTask = {
    ...claim.task,
    observationSeqThrough: claim.observationSeqThrough,
  };
  for (let rerun = 0; rerun <= 1; rerun += 1) {
    const view = store.readRevisionView(agentId, identity, task.baseRevision);
    const plan = await port.runMaintenance(task, view, null);
    validateMaintenancePlan(plan, task);
    const outcome = await bindAndCommitPlan(
      agentId,
      plan,
      dependencies,
      enqueueActor,
      { maintenance: { maintenanceId: claim.maintenanceId, leaseEpoch: claim.leaseEpoch } },
    );
    if (outcome.committed) return;
    if (rerun === 1) throw new Error("memory maintenance remained conflicted after regeneration");
    const current = store.readWatermark(agentId);
    if (current === null) throw new Error(`agent ${agentId} memory is not initialized`);
    task = {
      ...task,
      baseRevision: current.revision,
      observationSeqThrough: current.observationSeqConsumed,
    };
    maintenance.completeTaskJson(claim.maintenanceId, claim.leaseEpoch, task);
  }
}

interface MaintenanceFence {
  readonly maintenanceId: string;
  readonly leaseEpoch: number;
}

async function bindAndCommitPlan(
  agentId: string,
  plan: MemoryChangePlan,
  dependencies: MemoryPublicationDependencies,
  enqueueActor: MemoryPublicationDependencies["enqueueActor"],
  options: {
    readonly maintenance?: MaintenanceFence;
    readonly guard?: ((tx: StorageTransaction) => void) | undefined;
  },
): Promise<{ readonly committed: boolean; readonly revision: number }> {
  const { store, host, moduleId } = dependencies;
  let candidate = plan;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = store.readWatermark(agentId);
    if (current === null) throw new Error(`agent ${agentId} memory is not initialized`);
    if (store.hasRevisionConflicts(agentId, plan.baseRevision, targetIds(plan))) {
      return { committed: false, revision: current.revision };
    }
    if (current.revision !== candidate.baseRevision) {
      candidate = { ...candidate, baseRevision: current.revision };
    }
    const planHash = await host.hash(candidate as unknown as Json);
    const outcome = await enqueueActor(agentId, () => {
      const latest = store.readWatermark(agentId);
      if (latest === null) throw new Error(`agent ${agentId} memory is not initialized`);
      if (latest.revision !== candidate.baseRevision) {
        return { committed: false as const, revision: latest.revision };
      }
      return {
        committed: true as const,
        revision: store.commitPlan(agentId, moduleId, candidate, {
          planHash,
          worldSeqThrough: store.scannedWorldSeq(),
          ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
          ...(options.guard === undefined ? {} : { guard: options.guard }),
        }),
      };
    });
    if (outcome.committed) return outcome;
  }
  const current = store.readWatermark(agentId);
  if (current === null) throw new Error(`agent ${agentId} memory is not initialized`);
  return { committed: false, revision: current.revision };
}

function validateUsePlan(
  plan: MemoryChangePlan,
  view: RevisionView,
  input: MemoryRecordUseRequest,
): void {
  const current = new Map(view.records
    .filter((record) => record.status === "active")
    .map((record) => [record.memoryId, record]));
  const cited = new Set(input.citedMemoryIds);
  const retrieved = new Set(input.retrievedMemoryIds);
  if (input.citedMemoryIds.some((memoryId) => !retrieved.has(memoryId))) {
    throw new Error("memory use cited a record that was not retrieved for this turn");
  }
  const inputObservations = new Set(input.inputObservations.map((observation) => observation.observationId));
  for (const retire of plan.retires) {
    if (!current.has(retire.memoryId)) {
      throw new Error(`memory use cannot retire unknown record ${retire.memoryId}`);
    }
    if (!cited.has(retire.memoryId) && retire.status !== "evicted") {
      throw new Error(`memory use cannot retire uncited record ${retire.memoryId}`);
    }
  }
  for (const insert of plan.inserts) {
    if (current.has(insert.memoryId)) {
      if (!cited.has(insert.memoryId)) {
        throw new Error(`memory use cannot reinforce uncited record ${insert.memoryId}`);
      }
      continue;
    }
    if (
      insert.sourceObservationIds.length === 0 ||
      !insert.sourceObservationIds.every((observationId) => inputObservations.has(observationId))
    ) {
      throw new Error("memory use inserted a record that was not derived from this turn");
    }
    if (insert.sourceTurnId !== input.turnId) {
      throw new Error("memory use inserted a record whose source turn does not match this turn");
    }
  }
}

function validateMaintenancePlan(plan: MemoryChangePlan, task: MaintenanceTask): void {
  if (plan.changeKind !== "maintenance") {
    throw new Error("memory maintenance returned a non-maintenance change plan");
  }
  if (plan.baseRevision !== task.baseRevision) {
    throw new Error("memory maintenance plan does not match the leased base revision");
  }
  if (
    plan.derivedThroughSeq === null ||
    plan.derivedThroughSeq < task.observationSeqThrough ||
    plan.derivedThroughTick === null ||
    plan.derivedThroughTick < task.dueTick
  ) {
    throw new Error("memory maintenance did not advance its derived watermark");
  }
}

function targetIds(plan: MemoryChangePlan): readonly string[] {
  return [...new Set(plan.retires.map((entry) => entry.memoryId))];
}

function assertObservationScope(left: MemoryScope, right: MemoryScope): void {
  if (
    left.worldId !== right.worldId ||
    left.branchId !== right.branchId ||
    left.agentId !== right.agentId
  ) {
    throw new Error("memory observation scope does not match the agent host");
  }
}
