/**
 * 验证记忆行编解码保留任意 JSON 内容并单独恢复强化时间。
 * Verifies memory row codecs preserve arbitrary JSON data and reinforcement metadata.
 * Must not read a database or invoke a memory module.
 */
import { describe, expect, it } from "vitest";
import type { Json, MemoryChangePlan } from "@ai-npc/contracts";
import { encodeMemoryRow, parseRecord } from "../src/memory-row-codec";

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
