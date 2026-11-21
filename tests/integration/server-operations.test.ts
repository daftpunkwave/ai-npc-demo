/**
 * 验证运营操作的持久化幂等：暂停、继续、快照、恢复与重开按认证主体与 operationId 去重，
 * 首次结果跨在线别名切换和进程重启有效；同键不同内容 409，结构非法 400 且零写入；
 * 可重试失败不锁定 operationId，重试可换版本重新执行并覆盖失败记录。
 * 依赖真实宿主、SQLite 存储与 HTTP inject；不伪造幂等记录或跳过存储事务。
 * 禁止用进程内缓存替代部署级表，也不在用例间复用数据目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DomainError,
  errorResponseSchema,
  snapshotListResponseSchema,
  type Json,
  type StorageCell,
} from "@ai-npc/contracts";
import { OperationJournal, operationRequestHash, startHost, type RunningHost } from "@ai-npc/app-server";
import type { OperationKey } from "@ai-npc/app-server";

const hosts: RunningHost[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // 先等待全部宿主关闭（单个失败不跳过其余），再删除全部已登记目录，最后汇总抛出：
  // 删除目录必须晚于 SQLite 句柄释放，否则 Windows 上会与未关闭的存储竞争并抛 EBUSY。
  const failures: unknown[] = [];
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
    throw new AggregateError(failures, `运营操作测试清理未全部完成：${failures.length} 处失败`);
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-operations-test-"));
  dirs.push(dir);
  return dir;
}

/** 登录并返回会话令牌。 */
async function loginSession(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

/** 分支、run、快照与在线别名的持久化清单，用于断言重放不再写入。 */
function ledger(host: RunningHost): {
  readonly branches: readonly string[];
  readonly runs: readonly string[];
  readonly snapshots: readonly string[];
  readonly alias: string;
} {
  return host.storage.transact((tx) => ({
    branches: tx.rows("branches").list().map((row) => String(row["branch_id"])).sort(),
    runs: tx.rows("runs").list().map((row) => String(row["run_id"])).sort(),
    snapshots: tx.rows("snapshots").list().map((row) => String(row["snapshot_id"])).sort(),
    alias: String(tx.rows("world_aliases").get({ alias: "online" })?.["branch_id"]),
  }));
}

/** 读取指定分支的时钟行。 */
function clockRow(host: RunningHost, branchId: string): Readonly<Record<string, StorageCell>> {
  const row = host.storage.transact((tx) => tx.branch(branchId).table("clock").get({}));
  if (row === null) {
    throw new Error(`分支 ${branchId} 缺少时钟行`);
  }
  return row;
}

/** 发起一次带会话的 POST。 */
async function post(
  host: RunningHost,
  session: string,
  url: string,
  payload: Record<string, Json>,
) {
  return host.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${session}` },
    payload,
  });
}

describe("运营操作幂等", () => {
  it("同键同内容重放返回首次结果且只写一次，同键不同内容 409", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");

    // 两个快照用于恢复与其后的同键不同内容冲突。
    const firstSnapshot = await post(host, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000011",
      label: "幂等存档一",
    });
    expect(firstSnapshot.statusCode).toBe(200);
    const firstSnapshotBody = firstSnapshot.json() as { readonly snapshotId: string; readonly worldTick: number };
    const secondSnapshot = await post(host, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000012",
      label: "幂等存档二",
    });
    expect(secondSnapshot.statusCode).toBe(200);
    const secondSnapshotBody = secondSnapshot.json() as { readonly snapshotId: string };
    const afterSnapshots = ledger(host);
    expect(afterSnapshots.snapshots).toHaveLength(2);

    // 列表响应必须满足公开的 SnapshotView 契约，包含天数与创建者。
    const listed = await host.app.inject({
      method: "GET",
      url: "/api/v1/campaign/snapshots",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = snapshotListResponseSchema.parse(listed.json());
    const listedFirst = listedBody.snapshots.find(
      (snapshot) => snapshot.snapshotId === firstSnapshotBody.snapshotId,
    );
    expect(listedFirst).toMatchObject({
      label: "幂等存档一",
      worldTick: firstSnapshotBody.worldTick,
      day: Math.floor(firstSnapshotBody.worldTick / 24) + 1,
      createdBy: "player-1",
    });

    // 快照重放返回同一 snapshotId，不再复制冻结分支。
    const snapshotReplay = await post(host, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000011",
      label: "幂等存档一",
    });
    expect(snapshotReplay.statusCode).toBe(200);
    expect(snapshotReplay.json()).toEqual(firstSnapshotBody);
    expect(ledger(host)).toEqual(afterSnapshots);

    // 暂停与继续：重放返回首次 ClockView，run_version 不再递增。
    const initialClock = clockRow(host, host.branchId);
    const pause = await post(host, session, "/api/v1/campaign/pause", {
      operationId: "op-000000000013",
      expectedRunVersion: Number(initialClock["run_version"]),
    });
    expect(pause.statusCode).toBe(200);
    const paused = pause.json() as Json;
    const pausedClock = clockRow(host, host.branchId);
    const pauseReplay = await post(host, session, "/api/v1/campaign/pause", {
      operationId: "op-000000000013",
      expectedRunVersion: Number(initialClock["run_version"]),
    });
    expect(pauseReplay.statusCode).toBe(200);
    expect(pauseReplay.json()).toEqual(paused);
    expect(clockRow(host, host.branchId)).toEqual(pausedClock);

    const resume = await post(host, session, "/api/v1/campaign/resume", {
      operationId: "op-000000000014",
      expectedRunVersion: Number(pausedClock["run_version"]),
    });
    expect(resume.statusCode).toBe(200);
    const resumed = resume.json() as Json;
    const resumedClock = clockRow(host, host.branchId);
    const resumeReplay = await post(host, session, "/api/v1/campaign/resume", {
      operationId: "op-000000000014",
      expectedRunVersion: Number(pausedClock["run_version"]),
    });
    expect(resumeReplay.statusCode).toBe(200);
    expect(resumeReplay.json()).toEqual(resumed);
    expect(clockRow(host, host.branchId)).toEqual(resumedClock);

    // 恢复：重放返回首次后继分支与时钟，不再创建分支或 run。
    const restore = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000015",
      snapshotId: firstSnapshotBody.snapshotId,
    });
    expect(restore.statusCode).toBe(200);
    const restored = restore.json() as Json;
    const afterRestore = ledger(host);
    expect(afterRestore.alias).toBe((restored as { readonly branchId: string }).branchId);
    const restoreReplay = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000015",
      snapshotId: firstSnapshotBody.snapshotId,
    });
    expect(restoreReplay.statusCode).toBe(200);
    expect(restoreReplay.json()).toEqual(restored);
    expect(ledger(host)).toEqual(afterRestore);

    // 重开：重放返回首次新在线分支，且重开前的快照只创建一次。
    const reset = await post(host, session, "/api/v1/campaign/reset", {
      operationId: "op-000000000016",
    });
    expect(reset.statusCode).toBe(200);
    const resetBody = reset.json() as { readonly branchId: string };
    const afterReset = ledger(host);
    expect(afterReset.snapshots).toHaveLength(afterRestore.snapshots.length + 1);
    const resetReplay = await post(host, session, "/api/v1/campaign/reset", {
      operationId: "op-000000000016",
    });
    expect(resetReplay.statusCode).toBe(200);
    expect(resetReplay.json()).toEqual(resetBody);
    expect(ledger(host)).toEqual(afterReset);

    // 同键不同内容：快照换 label 与恢复换 snapshotId 都是 409 idempotency-conflict，零写入。
    const snapshotConflict = await post(host, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000011",
      label: "换一个标签",
    });
    expect(snapshotConflict.statusCode).toBe(409);
    expect(errorResponseSchema.parse(snapshotConflict.json()).error.code).toBe("idempotency-conflict");
    const restoreConflict = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000015",
      snapshotId: secondSnapshotBody.snapshotId,
    });
    expect(restoreConflict.statusCode).toBe(409);
    expect(errorResponseSchema.parse(restoreConflict.json()).error.code).toBe("idempotency-conflict");
    const pauseConflict = await post(host, session, "/api/v1/campaign/pause", {
      operationId: "op-000000000013",
      expectedRunVersion: Number(initialClock["run_version"]) + 99,
    });
    expect(pauseConflict.statusCode).toBe(409);
    expect(errorResponseSchema.parse(pauseConflict.json()).error.code).toBe("idempotency-conflict");
    expect(ledger(host)).toEqual(afterReset);

    // 结构非法：400 validation，且零写入。
    for (const request of [
      { url: "/api/v1/campaign/pause", payload: { expectedRunVersion: 0 } },
      { url: "/api/v1/campaign/snapshots", payload: { operationId: "op-000000000017", label: "" } },
      { url: "/api/v1/campaign/restore", payload: { operationId: "op-000000000018", snapshotId: firstSnapshotBody.snapshotId, extra: true } },
      { url: "/api/v1/campaign/reset", payload: {} },
    ]) {
      const response = await post(host, session, request.url, request.payload as Record<string, Json>);
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe("validation");
    }
    expect(ledger(host)).toEqual(afterReset);
  }, 30_000);

  it("恢复在别名切换后与进程重启后重试仍返回首次结果", async () => {
    const dataDir = tempDataDir();
    const first = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    let restoredBody: Json | null = null;
    let afterRestore: ReturnType<typeof ledger> | null = null;
    let snapshotBody: Json | null = null;
    let snapshotCount = 0;
    try {
      const session = await loginSession(first, "player-token");
      const snapshot = await post(first, session, "/api/v1/campaign/snapshots", {
        operationId: "op-000000000021",
        label: "重启恢复点",
      });
      expect(snapshot.statusCode).toBe(200);
      snapshotBody = snapshot.json();
      snapshotCount = ledger(first).snapshots.length;

      const restore = await post(first, session, "/api/v1/campaign/restore", {
        operationId: "op-000000000022",
        snapshotId: (snapshotBody as { readonly snapshotId: string }).snapshotId,
      });
      expect(restore.statusCode).toBe(200);
      restoredBody = restore.json();
      afterRestore = ledger(first);
      expect(first.branchId).toBe((restoredBody as { readonly branchId: string }).branchId);

      // 别名已经切换到后继分支后重试同一 operationId 与内容。
      const replay = await post(first, session, "/api/v1/campaign/restore", {
        operationId: "op-000000000022",
        snapshotId: (snapshotBody as { readonly snapshotId: string }).snapshotId,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(restoredBody);
      expect(ledger(first)).toEqual(afterRestore);
    } finally {
      await first.close();
    }

    const second = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(second);
    expect(second.branchId).toBe((restoredBody as { readonly branchId: string }).branchId);

    const session = await loginSession(second, "player-token");
    const replayAfterRestart = await post(second, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000022",
      snapshotId: (snapshotBody as { readonly snapshotId: string }).snapshotId,
    });
    expect(replayAfterRestart.statusCode).toBe(200);
    expect(replayAfterRestart.json()).toEqual(restoredBody);

    const snapshotReplay = await post(second, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000021",
      label: "重启恢复点",
    });
    expect(snapshotReplay.statusCode).toBe(200);
    expect(snapshotReplay.json()).toEqual(snapshotBody);

    expect(ledger(second)).toEqual(afterRestore);
    expect(ledger(second).snapshots).toHaveLength(snapshotCount);
  }, 30_000);

  it("重放旧的分支切换操作不会把在线入口切回已归档分支", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");

    const snapshot = await post(host, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000041",
      label: "旧分支回退点",
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotId = (snapshot.json() as { readonly snapshotId: string }).snapshotId;

    const restore = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000042",
      snapshotId,
    });
    expect(restore.statusCode).toBe(200);
    const restoredBranchId = (restore.json() as { readonly branchId: string }).branchId;

    const reset = await post(host, session, "/api/v1/campaign/reset", {
      operationId: "op-000000000043",
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { readonly branchId: string }).branchId).not.toBe(restoredBranchId);

    // 再恢复同一个快照，得到当前在线分支；旧的操作结果都已经不是在线入口。
    const currentRestore = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000044",
      snapshotId,
    });
    expect(currentRestore.statusCode).toBe(200);
    const currentBranchId = (currentRestore.json() as { readonly branchId: string }).branchId;

    // 重放“重开”和“恢复”的旧 operationId：仍返回首次结果，但不得切回已归档分支。
    const resetReplay = await post(host, session, "/api/v1/campaign/reset", {
      operationId: "op-000000000043",
    });
    expect(resetReplay.statusCode).toBe(200);
    expect((resetReplay.json() as { readonly branchId: string }).branchId).not.toBe(currentBranchId);

    const restoreReplay = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000042",
      snapshotId,
    });
    expect(restoreReplay.statusCode).toBe(200);
    expect((restoreReplay.json() as { readonly branchId: string }).branchId).toBe(restoredBranchId);

    // 在线别名、宿主内存入口与会话视图都保持在最后一次真正切换的分支。
    expect(ledger(host).alias).toBe(currentBranchId);
    expect(host.branchId).toBe(currentBranchId);
    const sessionView = await host.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(sessionView.json()).toMatchObject({ branchId: currentBranchId });

    // 后续命令仍落在当前在线分支，不会因旧重放指向已归档分支而被拒绝。
    const started = await post(host, session, "/api/v1/commands", {
      commandId: "cmd-000000000041",
      type: "campaign.start",
      schemaVersion: 1,
      payload: { factionId: "human-neutral" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ commandStatus: "accepted" });
  }, 30_000);

  it("时钟版本冲突按 DomainError 返回 409 并记录首次失败", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");
    const current = Number(clockRow(host, host.branchId)["run_version"]);

    const conflict = await post(host, session, "/api/v1/campaign/pause", {
      operationId: "op-000000000031",
      expectedRunVersion: current + 5,
    });
    expect(conflict.statusCode).toBe(409);
    const body = errorResponseSchema.parse(conflict.json());
    expect(body.error).toMatchObject({ code: "version-conflict", retryable: false });

    // 首次失败原因按 operationId 持久化，重放返回同一冲突而不是重新执行。
    const replay = await post(host, session, "/api/v1/campaign/pause", {
      operationId: "op-000000000031",
      expectedRunVersion: current + 5,
    });
    expect(replay.statusCode).toBe(409);
    expect(errorResponseSchema.parse(replay.json()).error.code).toBe("version-conflict");

    // 新 operationId 使用正确版本仍能暂停；领域拒绝保持 200 rejected receipt。
    const paused = await post(host, session, "/api/v1/campaign/pause", {
      operationId: "op-000000000032",
      expectedRunVersion: current,
    });
    expect(paused.statusCode).toBe(200);
    const rejected = await post(host, session, "/api/v1/commands", {
      commandId: "cmd-000000000031",
      type: "dialogue.say",
      schemaVersion: 1,
      payload: { targetAgentId: "npc-wenyuan", text: "暂停期间不应执行。" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ commandStatus: "rejected", reasonCode: "paused" });
  }, 30_000);
});

/** 构造暂停请求的幂等键；时钟控制的内容包含 expectedRunVersion。 */
function pauseKey(host: RunningHost, operationId: string, expectedRunVersion: number): OperationKey {
  return {
    kind: "pause",
    worldId: host.worldId,
    principalId: "player-1",
    operationId,
    requestHash: operationRequestHash("pause", { expectedRunVersion }),
  };
}

/** 读取部署级幂等记录，用于断言失败记录被重试结果替换或保留终态。 */
function idempotencyRow(
  host: RunningHost,
  operationId: string,
): Readonly<Record<string, StorageCell>> | null {
  return host.storage.transact((tx) =>
    tx.rows("operation_idempotency").get({
      world_id: host.worldId,
      principal_id: "player-1",
      operation_id: operationId,
    }),
  );
}

/** 捕获一次同步抛错，便于断错误类型与错误码。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe("运营失败记录的重试语义", () => {
  it("可重试失败视为未提交：同一 operationId 可换版本重试、更新记录并在成功后转为终态", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const journal = new OperationJournal(host.storage, () => "2026-11-21T00:00:00.000Z", () => {});
    const operationId = "op-000000000071";
    const versionZero = pauseKey(host, operationId, 0);
    journal.recordFailure(versionZero, new DomainError("invalid-state", "时钟暂停暂时失败", { retryable: true }));

    // 可重试失败不锁死同一 operationId：同版本与换版本的回放都不抛错、不返回结果。
    expect(journal.replay(versionZero, (value) => value)).toBeNull();
    const versionOne = pauseKey(host, operationId, 1);
    expect(journal.replay(versionOne, (value) => value)).toBeNull();

    // 重试再次失败更新失败记录，不保留过期错误与旧请求哈希。
    journal.recordFailure(versionOne, new DomainError("not-ready", "时钟仍不可用", { retryable: true }));
    expect(idempotencyRow(host, operationId)).toMatchObject({
      request_hash: versionOne.requestHash,
      error_code: "not-ready",
      error_safe_message: "时钟仍不可用",
    });

    // 重试成功覆盖失败记录；此后同键同内容返回成功结果。
    const clock: Json = { worldTick: 0, mode: "paused", secondsPerTick: 20, runVersion: 2, stepTargetTick: null };
    const versionTwo = pauseKey(host, operationId, 2);
    journal.recordSuccessStandalone(versionTwo, clock);
    expect(journal.replay(versionTwo, (value) => value)).toEqual(clock);
    expect(idempotencyRow(host, operationId)).toMatchObject({
      status: "succeeded",
      request_hash: versionTwo.requestHash,
    });

    // 成功结果是终态：同一 operationId 换回旧版本内容返回幂等冲突。
    const conflict = captureError(() => journal.replay(versionZero, (value) => value));
    expect(conflict).toBeInstanceOf(DomainError);
    expect((conflict as DomainError).code).toBe("idempotency-conflict");
  }, 30_000);

  it("不可重试失败保持终态：重放同一错误、换 payload 仍冲突，且失败记录不覆盖成功结果", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const journal = new OperationJournal(host.storage, () => "2026-11-21T00:00:00.000Z", () => {});
    const operationId = "op-000000000072";
    const terminal = pauseKey(host, operationId, 5);
    journal.recordFailure(terminal, new DomainError("version-conflict", "时钟版本冲突"));
    const firstFailure = captureError(() => journal.replay(terminal, (value) => value));
    expect(firstFailure).toBeInstanceOf(DomainError);
    expect((firstFailure as DomainError).code).toBe("version-conflict");
    expect((firstFailure as DomainError).safeMessage).toBe("时钟版本冲突");

    // 终态失败记录不因再次回放被替换；同键不同 payload 仍是幂等冲突。
    const changedPayload = pauseKey(host, operationId, 6);
    const conflict = captureError(() => journal.replay(changedPayload, (value) => value));
    expect(conflict).toBeInstanceOf(DomainError);
    expect((conflict as DomainError).code).toBe("idempotency-conflict");

    // 已提交成功结果不会被后续失败记录覆盖。
    const successKey = pauseKey(host, "op-000000000073", 0);
    const clock: Json = { worldTick: 0, mode: "paused", secondsPerTick: 20, runVersion: 1, stepTargetTick: null };
    journal.recordSuccessStandalone(successKey, clock);
    journal.recordFailure(successKey, new DomainError("invalid-state", "不应覆盖成功结果", { retryable: true }));
    expect(journal.replay(successKey, (value) => value)).toEqual(clock);
  }, 30_000);

  it("可重试失败后同一 operationId 用新版本重试返回成功而不是幂等冲突", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");
    const journal = new OperationJournal(host.storage, () => "2026-11-21T00:00:00.000Z", () => {});
    const operationId = "op-000000000074";

    // 首次尝试按旧版本记录可重试失败；随后时钟由另一个操作推进到 running（runVersion 1）。
    journal.recordFailure(
      pauseKey(host, operationId, 0),
      new DomainError("invalid-state", "时钟暂停暂时失败", { retryable: true }),
    );
    const resume = await post(host, session, "/api/v1/campaign/resume", {
      operationId: "op-000000000075",
      expectedRunVersion: 0,
    });
    expect(resume.statusCode).toBe(200);

    // 同一 operationId 换新版本重试：不再返回幂等冲突，而是重新执行并成功覆盖失败记录。
    const retried = await post(host, session, "/api/v1/campaign/pause", {
      operationId,
      expectedRunVersion: 1,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ mode: "paused", runVersion: 2 });
    expect(idempotencyRow(host, operationId)).toMatchObject({
      status: "succeeded",
      request_hash: pauseKey(host, operationId, 1).requestHash,
    });

    // 成功后的终态：同一 operationId 换回旧版本请求内容仍是幂等冲突。
    const stale = await post(host, session, "/api/v1/campaign/pause", {
      operationId,
      expectedRunVersion: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(errorResponseSchema.parse(stale.json()).error.code).toBe("idempotency-conflict");
  }, 30_000);
});

describe("坏快照的错误分类", () => {
  it("冻结分支状态不一致的恢复请求返回稳定 invalid-state 而不是 plugin-failed", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");
    const snapshot = await post(host, session, "/api/v1/campaign/snapshots", {
      operationId: "op-000000000081",
      label: "待破坏快照",
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotId = (snapshot.json() as { readonly snapshotId: string }).snapshotId;
    const frozenBranchId = host.storage.transact((tx) =>
      tx.rows("snapshots").get({ snapshot_id: snapshotId })?.["frozen_branch_id"],
    );
    const frozen = host.storage.transact((tx) =>
      tx.rows("branches").get({ branch_id: String(frozenBranchId) }),
    );
    if (frozen === null) {
      throw new Error(`快照 ${snapshotId} 缺少冻结分支`);
    }
    host.storage.transact((tx) => {
      tx.rows("branches").put({ ...frozen, status: "active" });
    });

    const response = await post(host, session, "/api/v1/campaign/restore", {
      operationId: "op-000000000082",
      snapshotId,
    });
    expect(response.statusCode).toBe(409);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("invalid-state");
    expect(body.error.code).not.toBe("plugin-failed");
    expect(body.error.safeMessage).toContain("冻结分支状态");
  }, 30_000);
});
