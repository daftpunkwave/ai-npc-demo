/**
 * 核心职责：验证记忆提交边界拒绝伪造公共记录及私有来源。
 * 交互契约：用有缺陷的 provider 返回计划，再由真实 MemoryHost 和 SQLite 校验。
 * 约束与禁忌：禁止直接写入记忆行或绕过事务回滚断言。
 */
import { describe, expect, it } from "vitest";
import type { MemoryChangePlan, ModuleDefinition } from "@world-prism/contracts";
import type { MemoryPort } from "@world-prism/module-sdk";
import { memoryLayeredHybridModuleDefinition } from "@world-prism/mod-agent-memory-ledger";
import { createMemoryHarness, insertObservation, memoryAgentId, memoryBranchId } from "./memory-support";
import { startVariantHost } from "./memory-variants-support";

type Row = MemoryChangePlan["inserts"][number];

function invalidPublicProvider(mutate: (row: Row) => Row): ModuleDefinition {
  return {
    ...memoryLayeredHybridModuleDefinition,
    async create(input) {
      const instance = await memoryLayeredHybridModuleDefinition.create(input);
      const port = instance.port as MemoryPort;
      return { ...instance, port: new Proxy(port, {
        get(target, key) {
          if (key === "prepareIngest") return (...args: Parameters<MemoryPort["prepareIngest"]>) => {
            const plan = target.prepareIngest(...args);
            const source = plan.inserts.find((row) => row.kind === "episodic");
            if (source === undefined) throw new Error("missing source record");
            const row = mutate({ ...source, kind: "public", branchPublic: true, releasePolicyId: "public", content: { ...source.content, data: { sourceEventKey: "evt-000000000001" } } });
            return { ...plan, inserts: [row] };
          };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) };
    },
  };
}

describe("public memory commit guards", () => {
  it.each([
    { name: "private source", policy: "private:human-independent", mutate: (row: Row) => row },
    { name: "wrong kind", policy: "public", mutate: (row: Row): Row => ({ ...row, kind: "belief" }) },
    { name: "wrong release", policy: "public", mutate: (row: Row) => ({ ...row, releasePolicyId: "private:human-independent" }) },
    { name: "forged event key", policy: "public", mutate: (row: Row) => ({ ...row, content: { ...row.content, data: { sourceEventKey: "evt-000000000099" } } }) },
  ])("rejects $name and rolls back the entire publication", async ({ policy, mutate }) => {
    const definition = invalidPublicProvider(mutate);
    const harness = await createMemoryHarness(definition);
    const host = await startVariantHost(harness);
    try {
      insertObservation(harness, { sequence: 1, tick: 10, eventType: "AgreementBreached", summary: "source event", releasePolicyId: policy });
      await expect(host.ingestAll(10)).rejects.toThrow(/branch-public/);
      expect(host.watermark(memoryAgentId).revision).toBe(0);
      expect(harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({}))).toEqual([]);
    } finally { await host.dispose(); await harness.dispose(); }
  });
});
