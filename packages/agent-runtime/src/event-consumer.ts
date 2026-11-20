/**
 * 消费已提交世界事件，生成观察与 trigger，并持久化延迟投递。
 * 依赖真实存储、感知端口、内容渲染与 HostServices；不执行 turn。
 * 禁止越过 ACL 生成观察，或让延迟观察与 trigger 分两次发布。
 */
import type {
  AgentObservation,
  AgentTrigger,
  EventEnvelope,
  HostServices,
  Json,
  StoragePort,
} from "@ai-npc/contracts";
import type { ContentPack, ResolvedAgentProfile, Roster } from "@ai-npc/experiment";
import { activateAgentRosterInTransaction } from "./activation";
import { renderObservation } from "./observation-renderer";
import type { PerceptionModuleHandle } from "./perception-host";
import {
  arrayValue,
  asRecord,
  numberValue,
  parseEvent,
  pendingEntry,
  stringValue,
  triggerFromRow,
} from "./runtime-records";

export interface EventConsumerInput {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly content: ContentPack;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly worldId: string;
  readonly branchId: string;
  readonly readWorld: (agentId: string) => {
    readonly nodeId: string | null;
    readonly factionId: string;
    readonly worldViewText: string;
    readonly affairsText: string;
  };
}

function eligible(
  event: EventEnvelope,
  agentId: string,
  factionId: string,
  nodeId: string | null,
): boolean {
  return event.audience.some((entry) => {
    const value = asRecord(entry);
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

export class PerceptionEventConsumer {
  constructor(
    private readonly input: EventConsumerInput,
    private readonly perception: ReadonlyMap<string, PerceptionModuleHandle>,
  ) {}

  async consume(worldTick: number): Promise<void> {
    const consumerId = "agent.perception.local";
    const events = this.input.storage.transact((tx) => {
      const offset = tx.branch(this.input.branchId).table("consumer_offsets").get({ consumer_id: consumerId });
      return tx.all(
        "SELECT * FROM domain_events WHERE branch_id = ? AND world_seq > ? ORDER BY world_seq ASC LIMIT 200",
        [this.input.branchId, offset === null ? 0 : numberValue(offset, "last_world_seq")],
      );
    });
    for (const row of events) {
      const event = parseEvent(row, this.input.worldId, this.input.branchId);
      const plans = this.perceive(event, worldTick);
      this.commitEvent(event, plans, consumerId);
    }
  }

  private perceive(event: EventEnvelope, worldTick: number) {
    const plans: {
      readonly agentId: string;
      readonly observations: readonly AgentObservation[];
      readonly triggers: readonly import("@ai-npc/module-sdk").NewAgentTrigger[];
      readonly scannedThroughSeq: number;
    }[] = [];
    for (const agent of this.input.roster.agents) {
      const perception = this.perception.get(agent.agentId);
      if (perception === undefined) continue;
      const world = this.input.readWorld(agent.agentId);
      const rendered = renderObservation({
        content: this.input.content,
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
      });
      const result = perception.port.perceive({
        scope: { worldId: this.input.worldId, branchId: this.input.branchId, agentId: agent.agentId },
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
        rendered,
        nowTick: worldTick,
      });
      plans.push({
        agentId: agent.agentId,
        observations: result.observations.map((observation) => ({
          ...observation,
          observationId: this.input.host.ids("obs") as AgentObservation["observationId"],
        })),
        triggers: result.triggers,
        scannedThroughSeq: result.scannedThroughSeq,
      });
    }
    return plans;
  }

  private commitEvent(
    event: EventEnvelope,
    plans: ReturnType<PerceptionEventConsumer["perceive"]>,
    consumerId: string,
  ): void {
    this.input.storage.transact((tx) => {
      const branch = tx.branch(this.input.branchId);
      const inbox = branch.table("consumer_inbox");
      if (inbox.get({ consumer_id: consumerId, event_id: event.eventId }) !== null) {
        branch.table("consumer_offsets").put({ consumer_id: consumerId, last_world_seq: event.worldSeq });
        return;
      }
      for (const plan of plans) {
        const stateTable = branch.table("perception_state");
        const stateRow = stateTable.get({ agent_id: plan.agentId });
        const previous = stateRow === null ? {} : asRecord(stateRow["state_json"]);
        const pending = arrayValue(previous["pending"]);
        const due = plan.observations.filter((observation) => observation.knownAtTick <= event.worldTick);
        const delayed = plan.observations.filter((observation) => observation.knownAtTick > event.worldTick);
        this.writeObservations(tx, plan.agentId, due);
        for (const trigger of plan.triggers) {
          if (delayed.length === 0) this.writeTrigger(tx, plan.agentId, trigger);
        }
        const delayedEntries = delayed.map((observation) => pendingEntry(
          observation,
          plan.triggers.map((trigger) => ({
            ...trigger,
            triggerId: this.input.host.ids("trg") as AgentTrigger["triggerId"],
            agentId: plan.agentId,
            consumedByTurnId: null,
          })),
        ));
        stateTable.put({
          agent_id: plan.agentId,
          module_id: this.input.profiles.get(plan.agentId)?.slots.perception?.module ?? "agent.perception.local",
          revision: stateRow === null ? 1 : numberValue(stateRow, "revision") + 1,
          scanned_through_seq: plan.scannedThroughSeq,
          state_json: {
            ...previous,
            pending: [...pending, ...delayedEntries],
            lastKnown: asRecord(previous["lastKnown"]),
          },
        });
      }
      if (event.type === "CampaignStarted") {
        activateAgentRosterInTransaction({
          tx,
          branchId: this.input.branchId,
          agentIds: this.input.roster.agents.map((agent) => agent.agentId),
          nowIso: this.input.host.nowIso(),
        });
      }
      inbox.put({ consumer_id: consumerId, event_id: event.eventId, processed_at: this.input.host.nowIso() });
      branch.table("consumer_offsets").put({ consumer_id: consumerId, last_world_seq: event.worldSeq });
    });
  }

  flush(tick: number): void {
    this.input.storage.transact((tx) => {
      const stateTable = tx.branch(this.input.branchId).table("perception_state");
      for (const state of stateTable.list()) {
        const stateJson = asRecord(state["state_json"]);
        const pending = arrayValue(stateJson["pending"]);
        if (pending.length === 0) continue;
        const due: { observation: AgentObservation; triggers: readonly AgentTrigger[] }[] = [];
        const remaining: Json[] = [];
        for (const item of pending) {
          const entry = asRecord(item);
          const observation = entry["observation"] as unknown as AgentObservation;
          if (observation.knownAtTick <= tick) {
            due.push({
              observation,
              triggers: arrayValue(entry["triggers"]) as unknown as readonly AgentTrigger[],
            });
          } else {
            remaining.push(item);
          }
        }
        if (due.length === 0) continue;
        const agentId = stringValue(state, "agent_id");
        this.writeObservations(tx, agentId, due.map((entry) => entry.observation));
        for (const entry of due) {
          for (const trigger of entry.triggers) this.writeTrigger(tx, agentId, trigger);
        }
        stateTable.put({
          ...state,
          revision: numberValue(state, "revision") + 1,
          state_json: { ...stateJson, pending: remaining },
        });
      }
    });
  }

  private writeObservations(
    tx: import("@ai-npc/contracts").StorageTransaction,
    agentId: string,
    observations: readonly AgentObservation[],
  ): void {
    const table = tx.branch(this.input.branchId).table("observations");
    let seq = Number(table.max("observation_seq", { agent_id: agentId }) ?? 0);
    for (const observation of observations) {
      if (table.list({ agent_id: agentId, observation_id: observation.observationId }, { limit: 1 }).length > 0) {
        continue;
      }
      seq += 1;
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

  private writeTrigger(
    tx: import("@ai-npc/contracts").StorageTransaction,
    agentId: string,
    trigger: import("@ai-npc/module-sdk").NewAgentTrigger | AgentTrigger,
  ): void {
    const table = tx.branch(this.input.branchId).table("triggers");
    if (table.list({ dedupe_key: trigger.dedupeKey }, { limit: 1 }).length > 0) return;
    table.put({
      trigger_id: "triggerId" in trigger ? trigger.triggerId : this.input.host.ids("trg"),
      agent_id: agentId,
      kind: trigger.kind,
      priority: trigger.priority,
      source_ref: trigger.sourceRef,
      created_tick: trigger.createdTick,
      dedupe_key: trigger.dedupeKey,
      consumed_by_turn_id: null,
    });
  }
}
