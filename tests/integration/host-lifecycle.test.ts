/**
 * 验证宿主 worker 失败后的持久化、健康状态、运营恢复路径、受控单步入口与运营审计失败策略。
 * 依赖真实 SQLite 权威执行器、确定性宿主与内存时钟；每个用例使用独立数据目录。
 * 禁止用真实定时器等待推进，也禁止把内存 workerFailed 当成跨重启状态。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifecycle, type ServerRuntime } from "@ai-npc/app-server";
import { listRuleFailures } from "@ai-npc/authority";
import type { ClockState, GameClockPort } from "@ai-npc/module-sdk";
import { createAuthorityHarness, createFakeHost, type AuthorityHarness } from "./authority-support";
import { storageFailingOnLifecycleAudit } from "./lifecycle-audit-support";

const harnesses: AuthorityHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.dispose()));
});

/** 可注入的内存时钟：只实现 worker 与生命周期用到的同步控制语义；syncTick 供用例把 tick 同步到持久行。 */
function createFakeClock(
  initial: ClockState,
  syncTick?: (tick: number) => void,
): {
  readonly port: GameClockPort;
  state(): ClockState;
} {
  let clock: ClockState = { ...initial };
  const port = {
    read: () => clock,
    readInTransaction: () => clock,
    initializeInTransaction: () => clock,
    start: (_branchId: string, expectedRunVersion?: number) => {
      if (expectedRunVersion !== undefined && expectedRunVersion !== clock.runVersion) {
        return { ok: false, reasonCode: "version-conflict" } as const;
      }
      if (clock.mode !== "running") {
        clock = { ...clock, mode: "running", runVersion: clock.runVersion + 1, stepTargetTick: null };
      }
      return { ok: true, clock } as const;
    },
    pause: (_branchId: string, expectedRunVersion?: number) => {
      if (expectedRunVersion !== undefined && expectedRunVersion !== clock.runVersion) {
        return { ok: false, reasonCode: "version-conflict" } as const;
      }
      if (clock.mode !== "paused") {
        clock = { ...clock, mode: "paused", runVersion: clock.runVersion + 1, stepTargetTick: null };
      }
      return { ok: true, clock } as const;
    },
    step: (_branchId: string, ticks: number, expectedRunVersion?: number) => {
      if (expectedRunVersion !== undefined && expectedRunVersion !== clock.runVersion) {
        return { ok: false, reasonCode: "version-conflict" } as const;
      }
      if (clock.mode !== "paused") {
        return { ok: false, reasonCode: "invalid-params" } as const;
      }
      clock = {
        ...clock,
        mode: "stepping",
        runVersion: clock.runVersion + 1,
        stepTargetTick: clock.worldTick + ticks,
      };
      return { ok: true, clock } as const;
    },
    finishStep: () => {
      if (clock.mode === "stepping") {
        clock = { ...clock, mode: "paused", runVersion: clock.runVersion + 1, stepTargetTick: null };
      }
      return clock;
    },
    setTick: (_branchId: string, tick: number) => {
      clock = { ...clock, worldTick: tick };
      syncTick?.(tick);
      return clock;
    },
  } satisfies Partial<GameClockPort>;
  return { port: port as unknown as GameClockPort, state: () => clock };
}

/** 把内存时钟的 tick 同步到持久 clock 行；JobRunner 按持久 worldTick 校验 job 推进。 */
function syncClockTickTo(harness: AuthorityHarness): (tick: number) => void {
  return (tick) => {
    harness.storage.transact((tx) => {
      const table = tx.branch(harness.branchId).table("clock");
      const row = table.get({});
      if (row === null) {
        throw new Error("分支缺少 clock 行");
      }
      table.put({ ...row, world_tick: tick, updated_at: harness.host.nowIso() });
    });
  };
}

/** 创建生命周期所需的在线分支状态与最小运行时外壳。 */
function createLifecycleFor(
  harness: AuthorityHarness,
  clock: GameClockPort,
  campaignStarted: () => boolean = () => true,
): ReturnType<typeof createLifecycle> {
  const active = { branchId: harness.branchId, worldId: harness.worldId };
  const host = createFakeHost();
  return createLifecycle({
    host,
    storage: harness.storage,
    runtime: { clock } as unknown as ServerRuntime,
    authority: harness.authority,
    active,
    autoPauseAfterDisconnectMs: 60_000,
    campaignStarted,
    disposeResources: async () => {},
  });
}

/** 在分支内写入一个到期 job；处理器行为由调用方给出，到期 tick 缺省为当前 tick。 */
function seedJob(harness: AuthorityHarness, kind: string, handler: () => void, dueTick = 0): void {
  harness.authority.registerModule({
    moduleId: "test.worker-recovery",
    ownsAggregates: [],
    jobs: [{ kind, handler }],
  });
  harness.storage.transact((tx) => {
    tx.branch(harness.branchId).table("jobs").put({
      job_id: "job-worker-test",
      seq: 1,
      kind,
      due_tick: dueTick,
      status: "scheduled",
      idempotency_key: "test-worker-key",
      payload_json: {},
      attempts: 0,
      last_error: null,
    });
  });
}

describe("宿主 worker 恢复", () => {
  it("未开局时拒绝继续时钟，避免把 campaign.start 挤到非零 tick", async () => {
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    const fakeClock = createFakeClock({
      worldTick: 0,
      mode: "paused",
      secondsPerTick: 1,
      runVersion: 0,
      stepTargetTick: null,
    });
    const lifecycle = createLifecycleFor(harness, fakeClock.port, () => false);
    try {
      let caught: unknown;
      try {
        lifecycle.control("start", 0);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "not-ready" });
      expect(fakeClock.state()).toMatchObject({ mode: "paused", runVersion: 0 });
    } finally {
      await lifecycle.close();
    }
  });

  it("持续失败时保持 degraded，恢复请求返回 not-ready 且时钟不变", async () => {
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    seedJob(harness, "test.failing-job", () => {
      throw new Error("注入持续失败");
    });
    const fakeClock = createFakeClock({
      worldTick: 0,
      mode: "paused",
      secondsPerTick: 1,
      runVersion: 0,
      stepTargetTick: null,
    });
    const lifecycle = createLifecycleFor(harness, fakeClock.port);
    try {
      lifecycle.start();
      expect(lifecycle.healthStatus()).toBe("degraded");
      expect(
        listRuleFailures(harness.storage, harness.branchId).filter((record) => record.phase === "worker"),
      ).toEqual([expect.objectContaining({ status: "failed" })]);

      let caught: unknown;
      try {
        lifecycle.control("start", 0);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "not-ready" });
      expect(fakeClock.state()).toMatchObject({ mode: "paused", runVersion: 0 });
      expect(lifecycle.healthStatus()).toBe("degraded");
      expect(
        listRuleFailures(harness.storage, harness.branchId).filter((record) => record.phase === "worker"),
      ).toEqual([expect.objectContaining({ status: "failed" })]);
    } finally {
      await lifecycle.close();
    }
  });

  it("处理器恢复后 control(start) 补完 tick、清除失败记录并进入 ready", async () => {
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    let failing = true;
    seedJob(harness, "test.recovering-worker-job", () => {
      if (failing) {
        throw new Error("首次恢复失败");
      }
    });
    const fakeClock = createFakeClock({
      worldTick: 0,
      mode: "paused",
      secondsPerTick: 1,
      runVersion: 0,
      stepTargetTick: null,
    });
    const lifecycle = createLifecycleFor(harness, fakeClock.port);
    try {
      lifecycle.start();
      expect(lifecycle.healthStatus()).toBe("degraded");

      failing = false;
      lifecycle.control("start", 0);
      expect(fakeClock.state()).toMatchObject({ mode: "running", runVersion: 1 });
      expect(lifecycle.healthStatus()).toBe("ready");
      expect(listRuleFailures(harness.storage, harness.branchId)).toEqual([]);
      const job = harness.storage.transact((tx) =>
        tx.branch(harness.branchId).table("jobs").get({ job_id: "job-worker-test" }),
      );
      expect(job).toMatchObject({ status: "done" });
    } finally {
      await lifecycle.close();
    }
  });

  it("受控单步：worker 失败时先恢复，成功后进入 stepping；未开局直接拒绝", async () => {
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    let failing = true;
    seedJob(harness, "test.stepping-recovery-job", () => {
      if (failing) {
        throw new Error("单步恢复前失败");
      }
    });
    const fakeClock = createFakeClock({
      worldTick: 0,
      mode: "paused",
      secondsPerTick: 1,
      runVersion: 0,
      stepTargetTick: null,
    });
    const lifecycle = createLifecycleFor(harness, fakeClock.port);
    try {
      lifecycle.start();
      expect(lifecycle.healthStatus()).toBe("degraded");

      // worker 失败未恢复时单步同样被拒绝，时钟保持 paused。
      let caught: unknown;
      try {
        lifecycle.control("step", 0, 3);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "not-ready" });
      expect(fakeClock.state()).toMatchObject({ mode: "paused", runVersion: 0 });

      // 恢复成功后单步进入 stepping，目标与版本由时钟 provider 写入。
      failing = false;
      const stepped = lifecycle.control("step", 0, 3);
      expect(stepped).toMatchObject({ mode: "stepping", runVersion: 1 });
      expect(fakeClock.state()).toMatchObject({ mode: "stepping", runVersion: 1, stepTargetTick: 3 });
      expect(lifecycle.healthStatus()).toBe("ready");
    } finally {
      await lifecycle.close();
    }
  });

  it("单步 worker 失败后：被拒绝的直接重试仍恢复调度，worker 依目标续步到完成", async () => {
    vi.useFakeTimers();
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    let failing = true;
    // 到期 tick 为 1：启动补完不触发，worker 在单步推进 tick 1 时失败。
    seedJob(harness, "test.stepping-retry-job", () => {
      if (failing) {
        throw new Error("单步推进失败");
      }
    }, 1);
    const fakeClock = createFakeClock(
      { worldTick: 0, mode: "paused", secondsPerTick: 1, runVersion: 0, stepTargetTick: null },
      syncClockTickTo(harness),
    );
    let lifecycle: ReturnType<typeof createLifecycle> | null = null;
    try {
      lifecycle = createLifecycleFor(harness, fakeClock.port);
      lifecycle.start();
      expect(lifecycle.healthStatus()).toBe("ready");
      expect(lifecycle.control("step", 0, 3)).toMatchObject({ mode: "stepping", runVersion: 1 });

      // worker 按 tick 间隔触发：推进到 tick 1 时到期 job 失败，时钟写入已提交、worker 停止调度。
      vi.advanceTimersByTime(1000);
      expect(fakeClock.state()).toMatchObject({ worldTick: 1, mode: "stepping", stepTargetTick: 3 });
      expect(lifecycle.healthStatus()).toBe("degraded");

      // 直接重试单步：恢复成功但时钟仍在 stepping，clock.step 被拒绝并抛 invalid-state；
      // 调度在恢复时已重建，不依赖这次被拒绝的调用。
      failing = false;
      let caught: unknown;
      try {
        lifecycle.control("step", 1, 3);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "invalid-state" });
      expect(fakeClock.state()).toMatchObject({ worldTick: 1, mode: "stepping", runVersion: 1 });
      expect(lifecycle.healthStatus()).toBe("ready");

      // 调度已恢复：worker 触发后续步到目标并收尾回 paused，不留下无驱动方的 stepping。
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      expect(fakeClock.state()).toMatchObject({ worldTick: 3, mode: "paused", stepTargetTick: null });
      expect(lifecycle.healthStatus()).toBe("ready");
    } finally {
      vi.useRealTimers();
      await lifecycle?.close();
    }
  });

  it("单步 worker 失败后：暂停退出再单步，恢复成功即重建调度并推进到完成", async () => {
    vi.useFakeTimers();
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    let failing = true;
    seedJob(harness, "test.stepping-pause-step-job", () => {
      if (failing) {
        throw new Error("单步推进失败");
      }
    }, 1);
    const fakeClock = createFakeClock(
      { worldTick: 0, mode: "paused", secondsPerTick: 1, runVersion: 0, stepTargetTick: null },
      syncClockTickTo(harness),
    );
    let lifecycle: ReturnType<typeof createLifecycle> | null = null;
    try {
      lifecycle = createLifecycleFor(harness, fakeClock.port);
      lifecycle.start();
      expect(lifecycle.control("step", 0, 3)).toMatchObject({ mode: "stepping", runVersion: 1 });

      // worker 在 tick 1 失败，时钟停在 stepping 且不再调度。
      vi.advanceTimersByTime(1000);
      expect(fakeClock.state()).toMatchObject({ worldTick: 1, mode: "stepping", stepTargetTick: 3 });
      expect(lifecycle.healthStatus()).toBe("degraded");

      // 暂停退出单步（不先恢复 worker），再从 paused 重新单步：control 内部先恢复再进入 stepping。
      failing = false;
      expect(lifecycle.control("pause", 1)).toMatchObject({ mode: "paused", runVersion: 2 });
      const reentered = lifecycle.control("step", 2, 2);
      expect(reentered).toMatchObject({ mode: "stepping", runVersion: 3 });
      expect(fakeClock.state()).toMatchObject({ mode: "stepping", stepTargetTick: 3 });
      expect(lifecycle.healthStatus()).toBe("ready");

      // 恢复已重建调度：worker 推进到新目标并收尾。
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      expect(fakeClock.state()).toMatchObject({ worldTick: 3, mode: "paused", stepTargetTick: null });
      expect(lifecycle.healthStatus()).toBe("ready");
    } finally {
      vi.useRealTimers();
      await lifecycle?.close();
    }
  });

  it("受控单步在未开局与章节终点拒绝", async () => {
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    const fakeClock = createFakeClock({
      worldTick: 0,
      mode: "paused",
      secondsPerTick: 1,
      runVersion: 0,
      stepTargetTick: null,
    });
    // 未开局：单步与继续一样被拒绝，避免把开局挤到非零 tick。
    const unstarted = createLifecycleFor(harness, fakeClock.port, () => false);
    try {
      let caught: unknown;
      try {
        unstarted.control("step", 0, 1);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "not-ready" });
      expect(fakeClock.state()).toMatchObject({ mode: "paused", runVersion: 0 });
    } finally {
      await unstarted.close();
    }

    // 章节终点已登记：单步先补完恢复，再确认保持暂停并拒绝。
    const stopHarness = await createAuthorityHarness();
    harnesses.push(stopHarness);
    const stopClock = createFakeClock({
      worldTick: 168,
      mode: "paused",
      secondsPerTick: 1,
      runVersion: 2,
      stepTargetTick: null,
    });
    const withStop = createLifecycleFor(stopHarness, stopClock.port);
    try {
      stopHarness.storage.transact((tx) => {
        tx.branch(stopHarness.branchId).table("clock_stop_requests").put({
          branch_id: stopHarness.branchId,
          request_id: "chapter-evaluated",
          reason: "测试注入",
          requested_at_tick: 168,
          created_at: stopHarness.host.nowIso(),
        });
        // 同步持久时钟行：补完与 job 推进按持久 worldTick 校验，内存时钟不能与之背离。
        const table = tx.branch(stopHarness.branchId).table("clock");
        const row = table.get({});
        if (row === null) {
          throw new Error("分支缺少 clock 行");
        }
        table.put({ ...row, world_tick: 168, updated_at: stopHarness.host.nowIso() });
      });
      let caught: unknown;
      try {
        withStop.control("step", 2, 1);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "invalid-state" });
      expect(stopClock.state()).toMatchObject({ mode: "paused", runVersion: 2 });
    } finally {
      await withStop.close();
    }
  });
});

describe("宿主运营审计", () => {
  it("审计写入失败只记日志，不覆盖自动暂停的业务结果", async () => {
    vi.useFakeTimers();
    const harness = await createAuthorityHarness();
    harnesses.push(harness);
    const fakeClock = createFakeClock({
      worldTick: 0,
      mode: "running",
      secondsPerTick: 1,
      runVersion: 1,
      stepTargetTick: null,
    });
    const host = createFakeHost();
    const lifecycle = createLifecycle({
      host,
      storage: storageFailingOnLifecycleAudit(harness.storage, "注入审计写入失败"),
      runtime: { clock: fakeClock.port } as unknown as ServerRuntime,
      authority: harness.authority,
      active: { branchId: harness.branchId, worldId: harness.worldId },
      autoPauseAfterDisconnectMs: 60_000,
      campaignStarted: () => true,
      disposeResources: async () => {},
    });
    try {
      lifecycle.handlePlayerConnections(1);
      lifecycle.handlePlayerConnections(0);
      vi.advanceTimersByTime(60_000);
      // 审计失败被吞掉：时钟照常暂停，健康状态不被审计故障牵连，失败原因可从日志定位。
      expect(fakeClock.state()).toMatchObject({ mode: "paused", runVersion: 2 });
      expect(lifecycle.healthStatus()).toBe("ready");
      expect(host.logs).toContainEqual(
        expect.objectContaining({ level: "error", message: "生命周期审计写入失败" }),
      );
      expect(harness.storage.transact((tx) => tx.all("SELECT seq FROM lifecycle_events"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await lifecycle.close();
    }
  });
});
