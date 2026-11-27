/**
 * 验证记忆记录对外契约与记忆行版本、记录视图三方的字段与语义一致。
 * 依赖契约 schema 与观测模块的记录转换函数；记忆行版本按数据源端口的类型化记录给出，不启动真实 SQLite 或宿主。
 * 禁止让 revision 变成视图水位、也不允许契约保留存储里没有落列的字段。
 */
import { describe, expect, it } from "vitest";
import { memoryRecordSchema } from "@world-prism/contracts";
import type { ObservedMemoryRecord } from "@world-prism/module-sdk";
import { decodeMemoryRecord } from "../src/research-codec";

const scope = { worldId: "wld-000000000001", branchId: "br-000000000001", agentId: "npc-guard" };

/** 同一 memoryId 的第 4 次改写。 */
function memoryRecord(overrides: Partial<ObservedMemoryRecord> = {}): ObservedMemoryRecord {
  return {
    memoryId: "mem-000000000001",
    rowVersion: 4,
    kind: "episodic",
    status: "active",
    epistemic: "verified-event",
    releasePolicyId: "policy-public",
    validFromTick: 2,
    validUntilTick: null,
    createdRevision: 3,
    retiredRevision: null,
    sourceObservationIds: ["obs-000000000001"],
    content: { summaryZh: "任务完成", counterpartIds: [], data: {} },
    ...overrides,
  };
}

describe("记忆记录解码", () => {
  it("revision 取行的 rowVersion，而不是查询的视图 revision", () => {
    const record = decodeMemoryRecord(memoryRecord(), scope);
    expect(record.revision).toBe(4);
    // 换一个视图水位不会改变同一条记录的 revision。
    expect(decodeMemoryRecord(memoryRecord({ rowVersion: 4, createdRevision: 1 }), scope).revision).toBe(4);
    expect(decodeMemoryRecord(memoryRecord({ rowVersion: 9 }), scope).revision).toBe(9);
  });

  it("解出的记录能通过契约校验，且不带存储里没有的内容引用字段", () => {
    const record = decodeMemoryRecord(memoryRecord(), scope);
    expect(memoryRecordSchema.parse(record)).toEqual(record);
    expect(Object.hasOwn(record, "contentRefs")).toBe(false);
    expect(memoryRecordSchema.safeParse({ ...record, contentRefs: [] }).success).toBe(false);
  });

  it("行版本从 1 起算：0 不是合法行版本", () => {
    expect(memoryRecordSchema.safeParse(decodeMemoryRecord(memoryRecord({ rowVersion: 1 }), scope)).success).toBe(true);
    expect(() => decodeMemoryRecord(memoryRecord({ rowVersion: 0 }), scope)).toThrow(/revision/);
  });
});
