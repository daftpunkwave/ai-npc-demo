/**
 * 核心职责：用宿主会话读取的真实查询形状对真实 SQLite 断言查询计划，确认按对白取提交序号命中 0019 的表达式索引。
 * 交互契约：依赖存储模块启动真实 SQLite、迁移建出的 domain_events_dialogue 索引与宿主在 reads 中使用的同一段查询。
 * 约束与禁忌：禁止另写一份字面量 SQL 副本代替生产查询——表达式与索引定义必须逐字一致才可能命中，
 *   副本的查询计划说明不了生产行为；也不得在查询退化成扫描全部 DialogueSubmitted 时仍判为通过。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dialogueWorldSeqSql } from "@ai-npc/app-server";
import type { StoragePort, StorageTransaction } from "@ai-npc/contracts";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { createFakeHost } from "./authority-support";

const baseIso = "2026-01-01T00:00:00.000Z";
const branchId = "br-000000000001";

const resources: { readonly dispose: () => Promise<void>; readonly dataDir: string }[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.dispose();
    rmSync(resource.dataDir, { recursive: true, force: true });
  }
});

async function openStorage(): Promise<StoragePort> {
  const dataDir = mkdtempSync(join(tmpdir(), "dialogue-index-"));
  const host = createFakeHost();
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  resources.push({ dispose: () => instance.dispose(), dataDir });
  return instance.port as StoragePort;
}

function planOf(storage: StoragePort, sql: string, params: readonly unknown[]): string {
  return storage
    .transact((tx: StorageTransaction) => tx.all(`EXPLAIN QUERY PLAN ${sql}`, params as never))
    .map((row) => String(row["detail"]))
    .join("\n");
}

/** 写入一条领域事件；payload 只带对白查询关心的字段，其余列取固定值。 */
function putEvent(
  tx: StorageTransaction,
  seq: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  tx.run(
    `INSERT INTO domain_events (branch_id, world_seq, event_id, world_tick, type, schema_version,
                                principal_id, causation_ids_json, correlation_id, audience_json,
                                payload_json, committed_at)
     VALUES (?, ?, ?, ?, ?, 1, 'human-independent', '[]', 'corr-000000000001', '[]', ?, ?)`,
    [branchId, seq, `evt-00000000000${String(seq)}`, seq, type, JSON.stringify(payload), baseIso],
  );
}

describe("对白提交事件的查询计划", () => {
  it("按对白 ID 取最大 world_seq 命中 domain_events_dialogue 表达式索引", async () => {
    const storage = await openStorage();
    const plan = planOf(storage, dialogueWorldSeqSql(2), [branchId, "dlg-000000000001", "dlg-000000000002"]);

    expect(plan).toContain("domain_events_dialogue");
    // 命中表达式索引后，dialogueId 的比对与 MAX(world_seq) 都在索引内完成，不需要临时 B 树分组。
    expect(plan).not.toContain("SCAN domain_events");
    expect(plan).not.toContain("USE TEMP B-TREE");
  });

  it("载荷不是合法 JSON 时仍能写入，且不会让索引求值失败", async () => {
    const storage = await openStorage();
    // 表达式索引对每一行求值；没有 json_valid 守卫时这条写入会因为索引求值抛错。
    storage.transact((tx) => {
      putEvent(tx, 1, "DialogueSubmitted", { dialogueId: "dlg-000000000001" });
      tx.run("UPDATE domain_events SET payload_json = ? WHERE branch_id = ? AND world_seq = 1", [
        "{incomplete",
        branchId,
      ]);
      putEvent(tx, 2, "DialogueSubmitted", { dialogueId: "dlg-000000000002" });
    });
    const rows = storage.transact((tx) => tx.all(dialogueWorldSeqSql(1), [branchId, "dlg-000000000002"]));
    expect(rows.map((row) => [String(row["dialogue_id"]), Number(row["world_seq"])])).toEqual([
      ["dlg-000000000002", 2],
    ]);
  });

  it("同一分支的对白事件与其他事件并存时只返回命中对白的最新序号", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      // 混入其他类型事件与无关对白，模拟事件表随会话增长后的形状。
      putEvent(tx, 1, "CampaignStarted", { campaignId: "cmp-000000000001" });
      putEvent(tx, 2, "DialogueSubmitted", { dialogueId: "dlg-000000000001", conversationId: "cnv-000000000001" });
      putEvent(tx, 3, "DialogueSubmitted", { dialogueId: "dlg-000000000009", conversationId: "cnv-000000000009" });
      putEvent(tx, 4, "MessageSent", { dialogueId: "dlg-000000000001" });
      putEvent(tx, 5, "DialogueSubmitted", { dialogueId: "dlg-000000000001", conversationId: "cnv-000000000001" });
    });

    const rows = storage.transact((tx) =>
      tx.all(dialogueWorldSeqSql(2), [branchId, "dlg-000000000001", "dlg-000000000009"]),
    );
    expect(
      rows
        .map((row) => [String(row["dialogue_id"]), Number(row["world_seq"])])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ).toEqual([
      ["dlg-000000000001", 5],
      ["dlg-000000000009", 3],
    ]);
  });
});
