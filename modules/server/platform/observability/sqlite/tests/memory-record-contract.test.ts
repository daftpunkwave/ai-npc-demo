/**
 * 验证记忆记录对外契约与存储行版本、记录视图三方的字段与语义一致。
 * 依赖契约 schema 与观测模块的行解码函数；不启动真实 SQLite 或宿主。
 * 禁止让 revision 变成视图水位、也不允许契约保留存储里没有落列的字段。
 */
import { describe, expect, it } from "vitest";
import { memoryRecordSchema } from "@ai-npc/contracts";
import { decodeMemoryRecord } from "../src/research-codec";

const scope = { worldId: "wld-000000000001", branchId: "br-000000000001", agentId: "npc-guard" };

/** 一行 memory_records：同一 memoryId 的第 4 次改写。 */
function memoryRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    memory_id: "mem-000000000001",
    row_version: 4,
    kind: "episodic",
    status: "active",
    epistemic: "verified-event",
    release_policy_id: "policy-public",
    valid_from_tick: 2,
    valid_until_tick: null,
    source_observation_ids_json: ["obs-000000000001"],
    content_json: { summaryZh: "任务完成", counterpartIds: [], data: {} },
    ...overrides,
  };
}

describe("记忆记录解码", () => {
  it("revision 取行的 row_version，而不是查询的视图 revision", () => {
    const record = decodeMemoryRecord(memoryRow(), scope);
    expect(record.revision).toBe(4);
    // 换一个视图水位不会改变同一条记录的 revision。
    expect(decodeMemoryRecord(memoryRow({ row_version: 4 }), scope).revision).toBe(4);
    expect(decodeMemoryRecord(memoryRow({ row_version: 9 }), scope).revision).toBe(9);
  });

  it("解出的记录能通过契约校验，且不带存储里没有的内容引用字段", () => {
    const record = decodeMemoryRecord(memoryRow(), scope);
    expect(memoryRecordSchema.parse(record)).toEqual(record);
    expect(Object.hasOwn(record, "contentRefs")).toBe(false);
    expect(memoryRecordSchema.safeParse({ ...record, contentRefs: [] }).success).toBe(false);
  });

  it("row_version 从 1 起算：0 不是合法行版本", () => {
    expect(memoryRecordSchema.safeParse(decodeMemoryRecord(memoryRow({ row_version: 1 }), scope)).success).toBe(true);
    expect(() => decodeMemoryRecord(memoryRow({ row_version: 0 }), scope)).toThrow(/revision/);
  });
});
