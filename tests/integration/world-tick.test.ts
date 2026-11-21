/**
 * 验证在线世界 tick 的固定执行顺序、阶段失败后的幂等补完、快照前的排空与 job 受控扫描顺序。
 * 依赖真实 SQLite 游戏环境、服务端宿主、运营快照入口与 authority 执行器。
 * 禁止跳过到期 job 直接断言结算，也禁止用内存夹具替代真实持久化。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoragePort, StorageRawRow, StorageTransaction } from "@ai-npc/contracts";
import {
  advanceWorldTick,
  catchUpWorldTick,
  startHost,
  type RunningHost,
  type WorldTickResult,
} from "@ai-npc/app-server";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  readGameAggregate,
  setGameClock,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];
const hosts: RunningHost[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // 先释放 harness 数据库句柄，再等待全部宿主关闭，最后删除目录；单步失败不跳过其余清理。
  const failures: unknown[] = [];
  try {
    await disposeTrackedGameHarnesses(active);
  } catch (error) {
    failures.push(error);
  }
  const closed = await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const result of closed) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `世界 tick 测试清理未全部完成：${failures.length} 处失败`);
  }
});

/** 为断言事件顺序保存的最小事件视图。 */
interface StoredEvent {
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly type: string;
  readonly payload: unknown;
}

/** 按 worldSeq 升序读取分支领域事件。 */
function readEvents(storage: StoragePort, branchId: string): readonly StoredEvent[] {
  return storage.transact((tx) =>
    tx
      .all(
        "SELECT world_seq, world_tick, type, payload_json FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC",
        [branchId],
      )
      .map((row) => ({
        worldSeq: Number(row["world_seq"]),
        worldTick: Number(row["world_tick"]),
        type: String(row["type"]),
        payload: typeof row["payload_json"] === "string" ? (JSON.parse(row["payload_json"]) as unknown) : null,
      })),
  );
}

/** 读取分支 job 的到期 tick 与状态，按 jobId 排序便于比较。 */
function readJobs(storage: StoragePort, branchId: string): readonly {
  readonly jobId: string;
  readonly dueTick: number;
  readonly status: string;
}[] {
  return storage.transact((tx) =>
    tx
      .branch(branchId)
      .table("jobs")
      .list({}, { orderBy: [{ column: "job_id" }] })
      .map((row) => ({
        jobId: String(row["job_id"]),
        dueTick: Number(row["due_tick"]),
        status: String(row["status"]),
      })),
  );
}

/** 读取一个分支的世界、事件与 job 原始行，用于比较快照与源分支。 */
function readBranchDigest(
  storage: StoragePort,
  branchId: string,
): {
  readonly events: readonly StorageRawRow[];
  readonly aggregates: readonly StorageRawRow[];
  readonly jobs: readonly StorageRawRow[];
} {
  return storage.transact((tx) => ({
    events: tx.all(
      "SELECT world_seq, world_tick, type, payload_json, audience_json FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC",
      [branchId],
    ),
    aggregates: tx.all(
      "SELECT aggregate_type, aggregate_id, version, state_json FROM aggregate_state WHERE branch_id = ? ORDER BY aggregate_type, aggregate_id",
      [branchId],
    ),
    jobs: tx.all(
      "SELECT job_id, kind, due_tick, status, attempts FROM jobs WHERE branch_id = ? ORDER BY job_id",
      [branchId],
    ),
  }));
}

/** 读取分支当前 tick。 */
function readTick(storage: StoragePort, branchId: string): number {
  return storage.transact((tx) => {
    const row = tx.branch(branchId).table("clock").get({});
    if (row === null) {
      throw new Error("分支缺少 clock");
    }
    return Number(row["world_tick"]);
  });
}

/** 按规则逐个推进 tick，返回每次推进的计数。 */
function advanceRange(value: GameHarness, fromTick: number, toTick: number): readonly WorldTickResult[] {
  const results: WorldTickResult[] = [];
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    results.push(
      advanceWorldTick({
        storage: value.storage,
        authority: value.authority,
        clock: value.clock,
        branchId: value.branchId,
        targetTick: tick,
      }),
    );
  }
  return results;
}

/** 找到指定 tick 上触发指定卡片的事件；缺失时明确失败。 */
function requireCardEvent(events: readonly StoredEvent[], tick: number, cardId: string): StoredEvent {
  const event = events.find(
    (candidate) =>
      candidate.worldTick === tick &&
      candidate.type === "ScenarioCardTriggered" &&
      (candidate.payload as { readonly cardId?: string }).cardId === cardId,
  );
  if (event === undefined) {
    throw new Error(`tick ${tick} 缺少卡片 ${cardId} 的触发事件`);
  }
  return event;
}

/** 找到指定 tick 的每日结算事件；缺失时明确失败。 */
function requireDayPassed(events: readonly StoredEvent[], tick: number): StoredEvent {
  const event = events.find((candidate) => candidate.worldTick === tick && candidate.type === "DayPassed");
  if (event === undefined) {
    throw new Error(`tick ${tick} 缺少每日结算事件`);
  }
  return event;
}

/** 把在线分支时钟直接设为目标 tick，模拟已有到期 job 尚未执行的现场。 */
function setHostClock(host: RunningHost, branchId: string, worldTick: number): void {
  host.storage.transact((tx) => {
    const table = tx.branch(branchId).table("clock");
    const row = table.get({});
    if (row === null) {
      throw new Error("分支缺少 clock");
    }
    table.put({
      ...row,
      world_tick: worldTick,
      mode: "paused",
      run_version: Number(row["run_version"]) + 1,
      updated_at: new Date().toISOString(),
    });
  });
}

/**
 * 包装真实存储并统计 job 表的读取次数与返回行数。
 * 只观察 JobRunner 的查询形状，其余事务与表访问原样转发，避免测试夹具改变持久化语义。
 */
function countingJobReads(
  storage: StoragePort,
  counts: { calls: number; rows: number },
): StoragePort {
  const wrapTransaction = (tx: StorageTransaction): StorageTransaction => ({
    get: (sql, params) => tx.get(sql, params),
    all: (sql, params) => tx.all(sql, params),
    run: (sql, params) => tx.run(sql, params),
    rows: (table) => tx.rows(table),
    savepoint: (name, fn) => tx.savepoint(name, fn),
    branch: (branchId) => {
      const scoped = tx.branch(branchId);
      return {
        branchId: scoped.branchId,
        table: (name) => {
          const table = scoped.table(name);
          if (name !== "jobs") {
            return table;
          }
          return {
            table: table.table,
            get: (key) => table.get(key),
            list: (filter, options) => {
              const rows = table.list(filter, options);
              counts.calls += 1;
              counts.rows += rows.length;
              return rows;
            },
            put: (row) => table.put(row),
            delete: (key) => table.delete(key),
            count: (filter) => table.count(filter),
            max: (column, filter) => table.max(column, filter),
          };
        },
      };
    },
  });
  return {
    transact: (fn) => storage.transact((tx) => fn(wrapTransaction(tx))),
    forkBranch: (tx, request) => storage.forkBranch(tx, request),
    backup: (options) => storage.backup(options),
  };
}

describe("在线 tick 顺序", () => {
  it("tick 72 的剧情卡 job 早于同一 tick 的每日结算", { timeout: 30_000 }, async () => {
    const value = await createTrackedGameHarness(active);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    advanceRange(value, 1, 72);

    const events = readEvents(value.storage, value.branchId);
    const card = requireCardEvent(events, 72, "card-supply-spoilage");
    const day = requireDayPassed(events, 72);
    expect(card.worldSeq).toBeLessThan(day.worldSeq);
    expect(events.filter((event) => event.worldTick === 72 && event.type === "DayPassed")).toHaveLength(1);
    expect(readTick(value.storage, value.branchId)).toBe(72);
  });

  it("tick 24 与 168 各结算一次，章节评估晚于每日结算且补完不重复", { timeout: 60_000 }, async () => {
    const value = await createTrackedGameHarness(active);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    advanceRange(value, 1, 24);

    let events = readEvents(value.storage, value.branchId);
    expect(events.filter((event) => event.type === "DayPassed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ChapterStageEvaluated")).toHaveLength(0);

    advanceRange(value, 25, 168);
    events = readEvents(value.storage, value.branchId);
    const days = events.filter((event) => event.type === "DayPassed");
    expect(days).toHaveLength(7);
    expect(days.filter((event) => event.worldTick === 24)).toHaveLength(1);
    expect(days.filter((event) => event.worldTick === 168)).toHaveLength(1);
    const chapters = events.filter((event) => event.type === "ChapterStageEvaluated");
    expect(chapters).toHaveLength(1);
    const day168 = requireDayPassed(events, 168);
    const chapter = chapters[0];
    if (chapter === undefined) {
      throw new Error("tick 168 缺少章节评估事件");
    }
    expect(chapter.worldSeq).toBeGreaterThan(day168.worldSeq);
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({ status: "evaluated" });
    // 章节评估提交后时钟暂停，保留 t168 存档，不再接受后续 tick 推进。
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 168, mode: "paused" });
    expect(() =>
      advanceWorldTick({
        storage: value.storage,
        authority: value.authority,
        clock: value.clock,
        branchId: value.branchId,
        targetTick: 169,
      }),
    ).toThrow(/不能推进 tick/);

    const beforeCatchUp = readEvents(value.storage, value.branchId);
    const catchUp = catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    expect(catchUp.worldTick).toBe(168);
    expect(catchUp.executedJobs).toBe(0);
    expect(readEvents(value.storage, value.branchId)).toEqual(beforeCatchUp);
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({ status: "evaluated" });
  });

  it("评估提交后暂停失败：重启补完仍停在 t168 并拒绝 t169", { timeout: 60_000 }, async () => {
    const value = await createTrackedGameHarness(active);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    advanceRange(value, 1, 167);

    // 注入“评估事务已提交、暂停时钟尚未提交”的崩溃窗口：第一次暂停调用失败。
    const failingClock = Object.create(value.clock) as typeof value.clock;
    let pauseAttempts = 0;
    failingClock.pause = (branchId, expectedRunVersion) => {
      pauseAttempts += 1;
      if (pauseAttempts === 1) {
        return { ok: false, reasonCode: "version-conflict" };
      }
      return value.clock.pause(branchId, expectedRunVersion);
    };
    expect(() =>
      advanceWorldTick({
        storage: value.storage,
        authority: value.authority,
        clock: failingClock,
        branchId: value.branchId,
        targetTick: 168,
      }),
    ).toThrow("章节终点暂停时钟失败");
    expect(readTick(value.storage, value.branchId)).toBe(168);
    expect(value.clock.read(value.branchId).mode).toBe("running");
    // “章节已到终点、需要暂停”与评估结果在同一事务提交。
    expect(
      value.storage.transact((tx) =>
        tx.branch(value.branchId).table("clock_stop_requests").list(),
      ),
    ).toEqual([expect.objectContaining({ request_id: "chapter-evaluated", requested_at_tick: 168 })]);

    // 重启或补完路径只重跑幂等步骤，再根据持久停止点补做暂停。
    const catchUp = catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    expect(catchUp.worldTick).toBe(168);
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 168, mode: "paused" });
    const events = readEvents(value.storage, value.branchId);
    expect(events.filter((event) => event.type === "ChapterStageEvaluated")).toHaveLength(1);

    // t169 推进被持久停止点拒绝，且不会写入新 tick。
    expect(() =>
      advanceWorldTick({
        storage: value.storage,
        authority: value.authority,
        clock: value.clock,
        branchId: value.branchId,
        targetTick: 169,
      }),
    ).toThrow(/不能推进 tick/);
    expect(readTick(value.storage, value.branchId)).toBe(168);

    // 重复补完不产生新事件，也不递增 runVersion。
    const runVersion = value.clock.read(value.branchId).runVersion;
    catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    expect(value.clock.read(value.branchId).runVersion).toBe(runVersion);
    expect(readEvents(value.storage, value.branchId)).toEqual(events);
  });

  it("阶段失败后补完同一 tick，不跳过结算也不重复提交", { timeout: 30_000 }, async () => {
    const value = await createTrackedGameHarness(active);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    advanceRange(value, 1, 71);

    const spy = vi.spyOn(value.authority.jobs, "runDue").mockImplementationOnce(() => {
      throw new Error("注入 job 阶段失败");
    });
    expect(() =>
      advanceWorldTick({
        storage: value.storage,
        authority: value.authority,
        clock: value.clock,
        branchId: value.branchId,
        targetTick: 72,
      }),
    ).toThrow("注入 job 阶段失败");
    spy.mockRestore();

    // 时钟写入已提交，job、时钟步骤与消费者尚未执行。
    expect(readTick(value.storage, value.branchId)).toBe(72);
    let events = readEvents(value.storage, value.branchId);
    expect(events.some((event) => event.worldTick === 72 && event.type === "DayPassed")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.worldTick === 72 &&
          event.type === "ScenarioCardTriggered" &&
          (event.payload as { readonly cardId?: string }).cardId === "card-supply-spoilage",
      ),
    ).toBe(false);

    const recovered = catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    expect(recovered.worldTick).toBe(72);
    events = readEvents(value.storage, value.branchId);
    const card = requireCardEvent(events, 72, "card-supply-spoilage");
    const day = requireDayPassed(events, 72);
    expect(card.worldSeq).toBeLessThan(day.worldSeq);
    expect(readTick(value.storage, value.branchId)).toBe(72);

    const repeated = catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    expect(repeated.executedJobs).toBe(0);
    expect(readEvents(value.storage, value.branchId)).toEqual(events);
  });

  it("单个时钟步骤失败不撤销已提交的每日结算", { timeout: 30_000 }, async () => {
    const value = await createTrackedGameHarness(active);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    let failed = false;
    value.authority.registerModule({
      moduleId: "test.clock-step-failure",
      ownsAggregates: [],
      clockSteps: [
        {
          stepId: "test.clock-step-failure.step",
          when: (tick) => tick === 24,
          handler: () => {
            if (!failed) {
              failed = true;
              throw new Error("注入时钟步骤失败");
            }
          },
        },
      ],
    });
    advanceRange(value, 1, 23);
    expect(() =>
      advanceWorldTick({
        storage: value.storage,
        authority: value.authority,
        clock: value.clock,
        branchId: value.branchId,
        targetTick: 24,
      }),
    ).toThrow("注入时钟步骤失败");

    // 每日结算在独立事务内先提交，不随后续步骤失败而回滚。
    let events = readEvents(value.storage, value.branchId);
    expect(events.filter((event) => event.worldTick === 24 && event.type === "DayPassed")).toHaveLength(1);

    const recovered = catchUpWorldTick({
      storage: value.storage,
      authority: value.authority,
      clock: value.clock,
      branchId: value.branchId,
    });
    expect(recovered.worldTick).toBe(24);
    events = readEvents(value.storage, value.branchId);
    expect(events.filter((event) => event.worldTick === 24 && event.type === "DayPassed")).toHaveLength(1);
  });
  it("到期 job 严格按 (dueTick, seq) 执行，每次推进只读取下一候选", { timeout: 30_000 }, async () => {
    const counts = { calls: 0, rows: 0 };
    const value = await createTrackedGameHarness(active, {
      storageWrapper: (storage) => countingJobReads(storage, counts),
    });
    const order: string[] = [];
    value.authority.registerModule({
      moduleId: "test.job-order",
      ownsAggregates: [],
      jobs: [
        {
          kind: "test.job-order",
          handler: (_context, job) => {
            order.push(job.jobId);
          },
        },
      ],
    });
    // 四种到期/创建顺序：due 3 最早；due 5 由 seq 决定；due 9 本次不执行。
    value.storage.transact((tx) => {
      const table = tx.branch(value.branchId).table("jobs");
      const rows = [
        { job_id: "job-late", seq: 4, due_tick: 9, idempotency_key: "test-key-4" },
        { job_id: "job-same-first", seq: 2, due_tick: 5, idempotency_key: "test-key-2" },
        { job_id: "job-early", seq: 1, due_tick: 3, idempotency_key: "test-key-1" },
        { job_id: "job-same-second", seq: 3, due_tick: 5, idempotency_key: "test-key-3" },
      ];
      for (const row of rows) {
        table.put({
          ...row,
          kind: "test.job-order",
          status: "scheduled",
          payload_json: {},
          attempts: 0,
          last_error: null,
        });
      }
    });
    setGameClock(value, { worldTick: 5, mode: "running" });
    const scheduledBefore = value.storage.transact(
      (tx) =>
        tx
          .branch(value.branchId)
          .table("jobs")
          .list({ status: "scheduled" }, { orderBy: [{ column: "due_tick" }, { column: "seq" }] }).length,
    );
    expect(scheduledBefore).toBe(4);
    // 上面的基线查询也经过计数包装；从推进前重新计数。
    counts.calls = 0;
    counts.rows = 0;

    const executed = value.authority.jobs.runDue(value.branchId, 5);
    expect(executed).toBe(3);
    expect(order).toEqual(["job-early", "job-same-first", "job-same-second"]);
    // 每次受控查询最多返回一条候选：3 条执行 + 1 条未到期候选。
    expect(counts.calls).toBe(4);
    expect(counts.rows).toBe(4);
    // 旧实现每步全量读取并排序 scheduled 行，同样推进需要读取 4+3+2+1=10 行。
    expect(counts.rows).toBeLessThan((scheduledBefore * (scheduledBefore + 1)) / 2);

    const remaining = value.storage.transact((tx) =>
      tx.branch(value.branchId).table("jobs").list({ status: "scheduled" }),
    );
    expect(remaining.map((row) => String(row["job_id"]))).toEqual(["job-late"]);
    expect(Number(remaining[0]?.["attempts"])).toBe(0);
  });
});

describe("快照排空", () => {
  it("创建快照前先排空当前 tick 的到期 job 与时钟步骤", { timeout: 30_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ai-npc-world-tick-"));
    dirs.push(dataDir);
    const host = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);

    const login = await host.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { token: "player-token" },
    });
    expect(login.statusCode).toBe(200);
    const session = (login.json() as { readonly sessionToken: string }).sessionToken;
    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: { authorization: `Bearer ${session}` },
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001"),
    });
    expect(started.statusCode).toBe(200);

    const branchId = host.branchId;
    setHostClock(host, branchId, 72);
    const before = readJobs(host.storage, branchId);
    expect(before.some((job) => job.status === "scheduled" && job.dueTick <= 72)).toBe(true);

    const response = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/snapshots",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000001", label: "tick-72" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { readonly snapshotId: string; readonly worldTick: number };
    expect(body.worldTick).toBe(72);

    const after = readJobs(host.storage, branchId);
    expect(after.some((job) => job.status === "scheduled" && job.dueTick <= 72)).toBe(false);

    const snapshotRow = host.storage.transact((tx) =>
      tx.rows("snapshots").get({ snapshot_id: body.snapshotId }),
    );
    if (snapshotRow === null) {
      throw new Error("缺少快照行");
    }
    const frozenBranchId = String(snapshotRow["frozen_branch_id"]);
    expect(readBranchDigest(host.storage, frozenBranchId)).toEqual(readBranchDigest(host.storage, branchId));

    const events = readEvents(host.storage, branchId);
    expect(requireCardEvent(events, 72, "card-supply-spoilage").worldSeq).toBeLessThan(
      requireDayPassed(events, 72).worldSeq,
    );
  });
});
