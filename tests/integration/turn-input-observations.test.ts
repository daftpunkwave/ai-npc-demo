/**
 * 验证 turn 就绪取观察在真实 SQLite 上的语义：主区间、触发源补充集与记忆水位上界。
 * 依赖真实存储适配器、记忆测试夹具与插入的观察行。
 * 禁止启动 turn worker、模型或网络资源，也不直接改写记忆水位。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryScope } from "@world-prism/contracts";
import { readTurnObservations } from "@world-prism/agent-runtime";
import { memoryLedgerModuleDefinition } from "@world-prism/mod-agent-memory-ledger";
import {
  createMemoryHarness,
  insertObservation,
  memoryAgentId,
  memoryBranchId,
  memoryWorldId,
  type MemoryHarness,
} from "./memory-support";

const harnesses: MemoryHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

const scope: MemoryScope = {
  worldId: memoryWorldId,
  branchId: memoryBranchId,
  agentId: memoryAgentId,
};

async function harnessWithObservations(): Promise<MemoryHarness> {
  const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
  harnesses.push(harness);
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    insertObservation(harness, {
      sequence,
      tick: sequence,
      eventType: "MetersChanged",
      summary: `观察 ${sequence}`,
    });
  }
  return harness;
}

function read(harness: MemoryHarness, previousSeq: number, throughSeq: number, sourceRefs: readonly string[]) {
  return harness.storage.transact((tx) => readTurnObservations(tx, {
    branchId: memoryBranchId,
    agentId: memoryAgentId,
    scope,
    previousSeq,
    throughSeq,
    sourceRefs,
  }));
}

describe("turn observation read over SQLite", () => {
  it("returns only the range after the consumed watermark", async () => {
    const harness = await harnessWithObservations();

    const observations = read(harness, 2, 4, []);

    expect(observations.map((observation) => observation.observationSeq)).toEqual([3, 4]);
    expect(observations.map((observation) => observation.observationId)).toEqual([
      "obs-000000000003",
      "obs-000000000004",
    ]);
  });

  it("adds an out-of-range observation whose source event triggered the turn", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    harnesses.push(harness);
    insertObservation(harness, {
      sequence: 1,
      tick: 1,
      eventType: "DialogueSubmitted",
      summary: "玩家发言",
      sourceEventIds: ["evt-000000000901"],
    });
    for (let sequence = 2; sequence <= 5; sequence += 1) {
      insertObservation(harness, { sequence, tick: sequence, eventType: "MetersChanged", summary: `观察 ${sequence}` });
    }

    const observations = read(harness, 2, 4, ["evt-000000000901"]);

    expect(observations.map((observation) => observation.observationSeq)).toEqual([1, 3, 4]);
    expect(observations[0]?.sourceEventIds).toEqual(["evt-000000000901"]);
  });

  it("keeps the memory watermark upper bound ahead of the trigger source match", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    harnesses.push(harness);
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      insertObservation(harness, { sequence, tick: sequence, eventType: "MetersChanged", summary: `观察 ${sequence}` });
    }
    insertObservation(harness, {
      sequence: 5,
      tick: 5,
      eventType: "DialogueSubmitted",
      summary: "尚未进入记忆水位的发言",
      sourceEventIds: ["evt-000000000902"],
    });

    const observations = read(harness, 2, 4, ["evt-000000000902"]);

    expect(observations.map((observation) => observation.observationSeq)).toEqual([3, 4]);
  });
});
