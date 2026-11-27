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
} from "@world-prism/contracts";
import type { ContentPack, ResolvedAgentProfile, Roster } from "@world-prism/contracts";
import type { NewAgentTrigger, PerceptionPort, PerceptionRequest } from "@world-prism/module-sdk";
import type { AgentModuleHandle } from "./agent-module-handle";
import { renderObservation } from "./observation-renderer";
import {
  arrayValue,
  asRecord,
  jsonValue,
  numberValue,
  parseEvent,
  pendingEntry,
  stringValue,
} from "./runtime-records";

/** 感知消费者在 consumer_offsets 中的登记 ID；受控推进按它判断感知是否已追平事件前沿。 */
export const perceptionConsumerId = "agent.perception.local";

export interface EventConsumerInput {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly content: ContentPack;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly worldId: string;
  readonly branchId: string;
  readonly readWorlds: (agentIds: readonly string[]) => ReadonlyMap<string, {
    readonly nodeId: string | null;
    readonly factionId: string;
    readonly worldViewText: string;
    readonly affairsText: string;
  }>;
}

function visibleAudience(
  event: EventEnvelope,
  agentId: string,
  factionId: string,
  nodeId: string | null,
): EventEnvelope["audience"] {
  return event.audience.filter((entry) => {
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
    private readonly perception: ReadonlyMap<string, AgentModuleHandle<PerceptionPort>>,
  ) {}

  async consume(worldTick: number): Promise<void> {
    const consumerId = perceptionConsumerId;
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
      readonly triggers: readonly NewAgentTrigger[];
      readonly scannedThroughSeq: number;
    }[] = [];
    const worlds = this.input.readWorlds(this.input.roster.agents
      .filter((agent) => this.perception.has(agent.agentId))
      .map((agent) => agent.agentId));
    for (const agent of this.input.roster.agents) {
      const perception = this.perception.get(agent.agentId);
      if (perception === undefined) continue;
      const world = worlds.get(agent.agentId);
      if (world === undefined) {
        throw new Error(`批量世界读取缺少名册身份 ${agent.agentId} 的结果`);
      }
      const audience = visibleAudience(event, agent.agentId, world.factionId, world.nodeId);
      if (audience.length === 0) {
        plans.push({ agentId: agent.agentId, observations: [], triggers: [], scannedThroughSeq: event.worldSeq });
        continue;
      }
      const detailedAudience = audience.filter(({ kind }) => kind !== "node");
      const full = detailedAudience.length > 0;
      const projectedEvent: PerceptionRequest["event"] = {
        eventId: event.eventId,
        worldSeq: event.worldSeq,
        worldTick: event.worldTick,
        type: event.type,
        principalId: event.principalId,
        causationIds: event.causationIds,
        audience: (full ? detailedAudience : audience) as readonly Json[],
        payload: full ? event.payload : { nodeId: world.nodeId },
      };
      const rendered = renderObservation({
        content: this.input.content,
        event: projectedEvent,
        agentId: agent.agentId,
        full,
      });
      const result = perception.port.perceive({
        scope: { worldId: this.input.worldId, branchId: this.input.branchId, agentId: agent.agentId },
        event: projectedEvent,
        observer: {
          nodeId: world.nodeId,
          factionId: world.factionId,
          eligible: true,
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
          releasePolicyId: rendered.releasePolicyId,
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
      inbox.put({ consumer_id: consumerId, event_id: event.eventId, processed_at: this.input.host.nowIso() });
      branch.table("consumer_offsets").put({ consumer_id: consumerId, last_world_seq: event.worldSeq });
    });
  }

  /**
   * 只挑出存在到期条目的 perception_state 行再解码：
   * 空队列与尚未到期的行在 SQLite 内用 json_each 过滤，避免每个轮询周期解码全部 state_json。
   */
  flush(tick: number): void {
    this.input.storage.transact((tx) => {
      const stateTable = tx.branch(this.input.branchId).table("perception_state");
      const dueRows = tx.all(
        `SELECT agent_id, module_id, revision, scanned_through_seq, state_json
           FROM perception_state
          WHERE branch_id = ?
            AND EXISTS (
              SELECT 1 FROM json_each(perception_state.state_json, '$.pending') AS entry
               WHERE json_extract(entry.value, '$.observation.knownAtTick') <= ?
            )`,
        [this.input.branchId, tick],
      );
      for (const state of dueRows) {
        const stateJson = asRecord(jsonValue(state["state_json"]));
        const pending = arrayValue(stateJson["pending"]);
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
          agent_id: agentId,
          module_id: stringValue(state, "module_id"),
          revision: numberValue(state, "revision") + 1,
          scanned_through_seq: numberValue(state, "scanned_through_seq"),
          state_json: { ...stateJson, pending: remaining },
        });
      }
    });
  }

  private writeObservations(
    tx: import("@world-prism/contracts").StorageTransaction,
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
    tx: import("@world-prism/contracts").StorageTransaction,
    agentId: string,
    trigger: import("@world-prism/module-sdk").NewAgentTrigger | AgentTrigger,
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
