/**
 * 验证宿主 worker 失败后的持久化、健康状态与运营恢复路径。
 * 依赖真实 SQLite 权威执行器、确定性宿主与内存时钟；每个用例使用独立数据目录。
 * 禁止用真实定时器等待推进，也禁止把内存 workerFailed 当成跨重启状态。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createLifecycle, type ServerRuntime } from "@ai-npc/app-server";
import { listRuleFailures } from "@ai-npc/authority";
import type { ClockState, GameClockPort } from "@ai-npc/module-sdk";
import { createAuthorityHarness, createFakeHost, type AuthorityHarness } from "./authority-support";

const harnesses: AuthorityHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.dispose()));
});

/** 可注入的内存时钟：只实现 worker 与生命周期用到的同步控制语义。 */
function createFakeClock(initial: ClockState): {
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
    step: () => ({ ok: false, reasonCode: "invalid-params" }) as const,
    finishStep: () => clock,
    setTick: (_branchId: string, tick: number) => {
      clock = { ...clock, worldTick: tick };
      return clock;
    },
  } satisfies Partial<GameClockPort>;
  return { port: port as unknown as GameClockPort, state: () => clock };
}

/** 创建生命周期所需的在线分支状态与最小运行时外壳。 */
function createLifecycleFor(
  harness: AuthorityHarness,
  clock: GameClockPort,
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
    disposeResources: async () => {},
  });
}

/** 在分支内写入一个到期 job；处理器行为由调用方给出。 */
function seedJob(harness: AuthorityHarness, kind: string, handler: () => void): void {
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
      due_tick: 0,
      status: "scheduled",
      idempotency_key: "test-worker-key",
      payload_json: {},
      attempts: 0,
      last_error: null,
    });
  });
}

describe("宿主 worker 恢复", () => {
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
});
