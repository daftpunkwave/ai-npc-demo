/**
 * 验证记忆行编解码保留任意 JSON 内容并单独恢复强化时间。
 * 依赖 encodeMemoryRow 与 parseRecord 的纯函数行为及内联 JSON 夹具。
 * 禁止读取数据库或调用记忆模块。
 */
import { describe, expect, it } from "vitest";
import type { Json, MemoryChangePlan } from "@world-prism/contracts";
import { decodeObservationRow, encodeMemoryRow, parseObservation, parseRecord } from "../src/memory-row-codec";

const inserts: readonly {
  readonly label: string;
  readonly data: Json;
}[] = [
  { label: "object", data: { nested: true } },
  { label: "array", data: ["a", 2, null] },
  { label: "string", data: "text" },
  { label: "number", data: 42 },
  { label: "null", data: null },
];

describe("memory row codec", () => {
  for (const { label, data } of inserts) {
    it(`preserves ${label} content data`, () => {
      const insert: MemoryChangePlan["inserts"][number] = {
        memoryId: "mem-000000000001",
        kind: "episodic",
        tier: "long",
        status: "active",
        epistemic: "verified-event",
        releasePolicyId: "public",
        validFromTick: 1,
        validUntilTick: null,
        strength: 0.8,
        salience: 0.8,
        recallCount: 2,
        lastReinforcedTick: 7,
        tags: ["test"],
        sourceObservationIds: ["obs-000000000001"],
        content: {
          summaryZh: "测试",
          counterpartIds: ["player-1"],
          data,
        },
      };
      const row = encodeMemoryRow({
        agentId: "human-independent",
        moduleId: "agent.memory.test",
        revision: 3,
        rowVersion: 1,
        insert,
      });
      const record = parseRecord(row);
      expect(record.content.data).toEqual(data);
      expect(record.lastReinforcedTick).toBe(7);
      expect(record.recallCount).toBe(2);
    });
  }
});

describe("observation raw row decode", () => {
  const scope = {
    worldId: "wld-000000000001",
    branchId: "br-000000000001",
    agentId: "human-independent",
  };

  const rawRow = {
    observation_id: "obs-000000000007",
    observation_seq: 7,
    source_event_ids_json: '["evt-000000000007"]',
    source_observation_ids_json: "[]",
    occurred_at_tick: 3,
    sensed_at_tick: 4,
    known_at_tick: 5,
    channel: "party",
    epistemic: "witnessed",
    confidence: 0.75,
    release_policy_id: "parties:human-independent,player-1",
    content_json: '{"eventType":"MetersChanged","summaryZh":"测试"}',
  } as const;

  it("decodes JSON text columns into values before parsing", () => {
    const observation = parseObservation(decodeObservationRow(rawRow), scope);
    expect(observation).toMatchObject({
      observationId: "obs-000000000007",
      observationSeq: 7,
      sourceEventIds: ["evt-000000000007"],
      sourceObservationIds: [],
      occurredAtTick: 3,
      sensedAtTick: 4,
      knownAtTick: 5,
      channel: "party",
      epistemic: "witnessed",
      confidence: 0.75,
      content: { eventType: "MetersChanged", summaryZh: "测试" },
    });
  });

  it("rejects a non-JSON text column instead of passing raw text through", () => {
    expect(() => decodeObservationRow({ ...rawRow, content_json: "not-json" }))
      .toThrow("content_json is not valid JSON");
  });

  it("rejects a numeric column that is not a number", () => {
    expect(() => decodeObservationRow({ ...rawRow, confidence: "0.75" }))
      .toThrow("confidence is not a number");
  });
});
