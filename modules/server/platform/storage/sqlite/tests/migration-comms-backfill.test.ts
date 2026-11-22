/**
 * 验证通信聚合索引化迁移：用 0009 为止的迁移建旧库，种入嵌 lines 的会话、无投递索引的消息
 * 与按授权 ID 主键的知识授权，应用全部迁移后断言行被改写为新键形态且内容不丢失。
 * 依赖迁移加载器、真实 SQLite 与 fake host；迁移是幂等版本号驱动的一次性脚本。
 * 禁止在新库上手工构造旧形态数据，或让种子数据依赖本仓库内容包。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../src/sqlite/connection";
import { applyMigrations, loadMigrations, MIGRATIONS_DIRECTORY } from "../src/sqlite/migrations";
import { resolveCatalog } from "../src/sqlite/schema";
import { SqliteTransaction } from "../src/sqlite/transaction";
import { createFakeHost, createTempDataDir } from "./support";

const BRANCH = "brn-legacy";

/** 旧形态会话聚合：内嵌两条对白，参与者两名。 */
const LEGACY_CONVERSATION = {
  conversationId: "conv-legacy-1",
  lastSeq: 2,
  lines: [
    {
      seq: 0,
      dialogueId: "dlg-legacy-1",
      speakerId: "player-1",
      text: "物资清单在哪里？",
      channel: "face-to-face",
      worldTick: 1,
      deliveries: [{ principalId: "player-1", deliverAtTick: 0 }, { principalId: "npc-wenyuan", deliverAtTick: 0 }],
    },
    {
      seq: 1,
      dialogueId: "dlg-legacy-2",
      speakerId: "npc-wenyuan",
      text: "在灰港仓库。",
      channel: "relay",
      worldTick: 2,
      deliveries: [{ principalId: "player-1", deliverAtTick: 2 }, { principalId: "npc-wenyuan", deliverAtTick: 2 }],
    },
  ],
  participants: ["player-1", "npc-wenyuan"],
};

/** 旧形态消息聚合：两名投递对象，无投递索引行。 */
const LEGACY_MESSAGE = {
  messageId: "msg-legacy-1",
  fromId: "npc-wenyuan",
  to: ["player-1"],
  channel: "message",
  text: "清单已经核对。",
  intentKind: "scripted",
  deliveries: [{ principalId: "player-1", deliverAtTick: 4 }, { principalId: "npc-wenyuan", deliverAtTick: 3 }],
  committedAtTick: 3,
  conversationId: null,
};

/** 旧形态知识授权：主键是授权 ID 而非主体编码键。 */
const LEGACY_GRANT = {
  grantId: "kg-legacy-1",
  principalId: "player-1",
  itemId: "ev-legacy-1",
  via: "share",
  grantedAtTick: 5,
};

interface AggregateRow {
  readonly aggregate_id: string;
  readonly version: number;
  readonly state: unknown;
}

/** 读取某聚合类型的全部行并解析状态 JSON；行按聚合 ID 升序。 */
function aggregateRows(database: ReturnType<typeof openDatabase>, aggregateType: string): readonly AggregateRow[] {
  const rows = database
    .prepare(
      "SELECT aggregate_id, version, state_json FROM aggregate_state WHERE branch_id = ? AND aggregate_type = ? ORDER BY aggregate_id",
    )
    .all(BRANCH, aggregateType) as unknown as readonly {
    aggregate_id: string;
    version: number;
    state_json: string;
  }[];
  return rows.map((row) => ({
    aggregate_id: row.aggregate_id,
    version: Number(row.version),
    state: JSON.parse(row.state_json),
  }));
}

describe("通信聚合索引化迁移", () => {
  it("把旧形态会话、消息与授权改写为索引化键并保留内容", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "legacy.db");
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: ReturnType<typeof openDatabase> | null = null;
    try {
      const migrations = await loadMigrations(host.hash, MIGRATIONS_DIRECTORY);
      for (const migration of migrations) {
        if (migration.version <= 9) {
          writeFileSync(join(migrationsDirectory, basename(migration.filePath)), migration.sql, "utf8");
        }
      }
      legacy = openDatabase(databasePath);
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      legacy
        .prepare("INSERT INTO worlds (world_id, pack_id, content_version, created_at) VALUES (?, ?, ?, ?)")
        .run("wld-legacy", "legacy-pack", "v1", "2026-01-01T00:00:00.000Z");
      legacy
        .prepare("INSERT INTO branches (branch_id, world_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(BRANCH, "wld-legacy", "online", "active", "2026-01-01T00:00:00.000Z");
      const putAggregate = legacy.prepare(
        "INSERT INTO aggregate_state (branch_id, aggregate_type, aggregate_id, version, state_json) VALUES (?, ?, ?, ?, ?)",
      );
      putAggregate.run(BRANCH, "conversation", LEGACY_CONVERSATION.conversationId, 3, JSON.stringify(LEGACY_CONVERSATION));
      putAggregate.run(BRANCH, "message", LEGACY_MESSAGE.messageId, 2, JSON.stringify(LEGACY_MESSAGE));
      putAggregate.run(BRANCH, "knowledge-grant", LEGACY_GRANT.grantId, 1, JSON.stringify(LEGACY_GRANT));
      closeDatabase(legacy);
      legacy = null;

      upgraded = openDatabase(databasePath);
      await applyMigrations(upgraded, host.nowIso(), host.logger, host.hash, MIGRATIONS_DIRECTORY);

      // 会话聚合只剩参与者与 lastSeq；对白按补零序号成为行聚合，状态即原行内容。
      const conversations = aggregateRows(upgraded, "conversation");
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({ aggregate_id: "conv-legacy-1", version: 3 });
      expect(conversations[0]?.state).toEqual({
        conversationId: "conv-legacy-1",
        lastSeq: 2,
        participants: ["player-1", "npc-wenyuan"],
      });

      const lines = aggregateRows(upgraded, "conversation-line");
      expect(lines.map((row) => row.aggregate_id)).toEqual(["conv-legacy-1:0000000000", "conv-legacy-1:0000000001"]);
      expect(lines[0]?.state).toEqual(LEGACY_CONVERSATION.lines[0]);
      expect(lines[1]?.state).toEqual(LEGACY_CONVERSATION.lines[1]);

      const memberships = aggregateRows(upgraded, "conversation-membership");
      expect(memberships.map((row) => row.aggregate_id)).toEqual([
        "npc-wenyuan:conv-legacy-1",
        "player-1:conv-legacy-1",
      ]);
      expect(memberships.map((row) => row.state)).toEqual([{}, {}]);

      // 投递索引键 = 主体:送达 tick:提交 tick:消息 ID，状态保留消息 ID 与送达 tick。
      const deliveries = aggregateRows(upgraded, "message-delivery");
      expect(deliveries.map((row) => row.aggregate_id)).toEqual([
        "npc-wenyuan:0000000003:0000000003:msg-legacy-1",
        "player-1:0000000004:0000000003:msg-legacy-1",
      ]);
      expect(deliveries.map((row) => row.state)).toEqual([
        { messageId: "msg-legacy-1", deliverAtTick: 3 },
        { messageId: "msg-legacy-1", deliverAtTick: 4 },
      ]);

      // 消息聚合本体保持不变。
      const messages = aggregateRows(upgraded, "message");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.state).toEqual(LEGACY_MESSAGE);

      // 知识授权改写为主体:条目:途径主键，授权 ID 保留在状态中。
      const grants = aggregateRows(upgraded, "knowledge-grant");
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ aggregate_id: "player-1:ev-legacy-1:share", version: 1 });
      expect(grants[0]?.state).toEqual(LEGACY_GRANT);

      // 升级后的行满足通信端口的索引查询契约：主体前缀、会话前缀、送达上界与降序分页
      // 都能定位迁移后的行（与通信模块 WorldTx.list 的读取方式一致）。
      const storageTx = new SqliteTransaction(upgraded, resolveCatalog(upgraded));
      const aggregates = storageTx.branch(BRANCH).table("aggregate_state");
      expect(
        aggregates
          .list({ aggregate_type: "conversation-membership" }, { prefix: { column: "aggregate_id", value: "player-1:" } })
          .map((row) => String(row["aggregate_id"])),
      ).toEqual(["player-1:conv-legacy-1"]);
      expect(
        aggregates
          .list(
            { aggregate_type: "conversation-line" },
            { prefix: { column: "aggregate_id", value: "conv-legacy-1:" }, orderBy: [{ column: "aggregate_id", direction: "desc" }], limit: 1 },
          )
          .map((row) => (row["state_json"] as unknown as { readonly seq: number }).seq),
      ).toEqual([1]);
      expect(
        aggregates
          .list(
            { aggregate_type: "message-delivery" },
            {
              prefix: { column: "aggregate_id", value: "player-1:" },
              before: { column: "aggregate_id", value: "player-1:0000000004~" },
              orderBy: [{ column: "aggregate_id", direction: "desc" }],
              limit: 5,
            },
          )
          .map((row) => String(row["aggregate_id"])),
      ).toEqual(["player-1:0000000004:0000000003:msg-legacy-1"]);
      expect(
        aggregates
          .list(
            { aggregate_type: "knowledge-grant" },
            { prefix: { column: "aggregate_id", value: "player-1:ev-legacy-1:" }, limit: 1 },
          ).length,
      ).toBe(1);

      closeDatabase(upgraded);
      upgraded = null;
    } finally {
      if (legacy !== null) {
        closeDatabase(legacy);
      }
      if (upgraded !== null) {
        closeDatabase(upgraded);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
