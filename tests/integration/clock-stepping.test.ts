/**
 * 验证受控单步的完整生命周期：进入 stepping、宿主逐 tick 推进、部分完成、推进失败后的恢复、
 * 章节终点截断与重启后的续步收尾。
 * 依赖真实 SQLite 游戏环境、受控时钟端口与 authority 执行器；不等待真实定时器。
 * 禁止把 stepping 当作 running 直接推进，也禁止绕过 stepTargetTick 的有界推进。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceSteppingTick,
  catchUpWorldTick,
  type AdvanceSteppingInput,
  type SteppingTickResult,
} from "@world-prism/app-server";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

/** 暂停在线 campaign 并进入单步模式，返回进入后的时钟状态。 */
function beginStep(value: GameHarness, ticks: number): ReturnType<GameHarness["clock"]["read"]> {
  expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
  value.clock.pause(value.branchId);
  return requireStep(value, ticks);
}

/** 发起单步并解包成功结果；被拒绝时直接失败用例。 */
function requireStep(value: GameHarness, ticks: number): ReturnType<GameHarness["clock"]["read"]> {
  const outcome = value.clock.step(value.branchId, ticks);
  if (!outcome.ok) {
    throw new Error(`进入单步被拒绝：${outcome.reasonCode}`);
  }
  return outcome.clock;
}

/** 用当前时钟快照推进一个单步 tick。 */
function stepOnce(value: GameHarness, current?: ReturnType<GameHarness["clock"]["read"]>): SteppingTickResult {
  const input: AdvanceSteppingInput = {
    storage: value.storage,
    clock: value.clock,
    authority: value.authority,
    branchId: value.branchId,
    current: current ?? value.clock.read(value.branchId),
  };
  return advanceSteppingTick(input);
}

describe("受控单步推进", () => {
  it("进入单步后逐 tick 推进，到达目标自动收尾回 paused", async () => {
    const value = await createTrackedGameHarness(active);
    const entered = beginStep(value, 3);
    expect(entered).toMatchObject({ worldTick: 0, mode: "stepping", stepTargetTick: 3 });

    // 前两次推进保持 stepping；每日结算、剧情卡 job 与消费者照常执行。
    const first = stepOnce(value, entered);
    expect(first).toMatchObject({ worldTick: 1, finished: false });
    expect(value.clock.read(value.branchId)).toMatchObject({ mode: "stepping", stepTargetTick: 3 });
    const second = stepOnce(value);
    expect(second).toMatchObject({ worldTick: 2, finished: false });

    // 到达目标：本次推进后立即收尾，时钟回 paused 且目标清空。
    const third = stepOnce(value);
    expect(third).toMatchObject({ worldTick: 3, finished: true });
    expect(value.clock.read(value.branchId)).toMatchObject({ mode: "paused", stepTargetTick: null });

    // 收尾后再调用推进是幂等空操作：时钟已离开 stepping，不产生新 tick 或事件。
    const before = value.clock.read(value.branchId);
    const idle = stepOnce(value);
    expect(idle).toMatchObject({ worldTick: before.worldTick, finished: true, executedJobs: 0 });
    expect(value.clock.read(value.branchId)).toMatchObject({ mode: before.mode, runVersion: before.runVersion });
    // 重复收尾同样幂等：不改变模式与版本。
    expect(value.clock.finishStep(value.branchId)).toMatchObject({ mode: before.mode, runVersion: before.runVersion });
  });

  it("单步推进失败时错误传播、时钟停在 stepping，暂停退出后补完仍能继续", async () => {
    const value = await createTrackedGameHarness(active);
    const entered = beginStep(value, 2);
    const failing = vi.spyOn(value.authority.jobs, "runDue").mockImplementationOnce(() => {
      throw new Error("注入单步 job 失败");
    });

    expect(() => stepOnce(value, entered)).toThrow("注入单步 job 失败");
    failing.mockRestore();
    // 时钟写入已提交但本步未完成：停在 stepping，目标保持不变。
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 1, mode: "stepping", stepTargetTick: 2 });

    // 暂停是有效退出路径：停在 stepping 也可以直接回到 paused。
    expect(value.clock.pause(value.branchId)).toMatchObject({ ok: true });
    expect(value.clock.read(value.branchId)).toMatchObject({ mode: "paused", stepTargetTick: null });

    // 重新进入单步并补完：中断点之后按既有推进语义继续。
    const reentered = requireStep(value, 1);
    expect(reentered).toMatchObject({ mode: "stepping", stepTargetTick: 2 });
    expect(stepOnce(value, reentered)).toMatchObject({ worldTick: 2, finished: true });
    expect(value.clock.read(value.branchId)).toMatchObject({ mode: "paused", stepTargetTick: null });
  });

  it("单步跨过章节终点：评估后暂停截断本步并拒绝继续推进", async () => {
    const value = await createTrackedGameHarness(active);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    // 直接把时钟推进到章节终点前一个 tick，再从 paused 单步跨过终点。
    value.clock.pause(value.branchId);
    const row = value.storage.transact((tx) => {
      const table = tx.branch(value.branchId).table("clock");
      const current = table.get({});
      if (current === null) {
        throw new Error("分支缺少 clock");
      }
      const updated = { ...current, world_tick: 167, updated_at: value.host.nowIso() };
      table.put(updated);
      return updated;
    });
    expect(row["world_tick"]).toBe(167);
    const entered = requireStep(value, 24);
    expect(entered).toMatchObject({ mode: "stepping", stepTargetTick: 191 });

    stepOnce(value, entered);
    // 章节评估在 t168 登记停止点并暂停时钟：本步被截断，stepTargetTick 一并清空。
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 168, mode: "paused", stepTargetTick: null });
    expect(
      value.storage.transact((tx) => tx.branch(value.branchId).table("clock_stop_requests").list()),
    ).toEqual([expect.objectContaining({ request_id: "chapter-evaluated", requested_at_tick: 168 })]);

    // 终点之后宿主控制入口拒绝单步（lifecycle.control 查停止点）；即便绕过控制进入 stepping，
    // 下一次推进也会被持久停止点立即截断回 paused，不会卡在无法退出的单步模式。
    const afterEnd = requireStep(value, 1);
    expect(afterEnd).toMatchObject({ mode: "stepping", stepTargetTick: 169 });
    const truncated = advanceSteppingTick({
      storage: value.storage,
      clock: value.clock,
      authority: value.authority,
      branchId: value.branchId,
      current: afterEnd,
    });
    expect(truncated).toMatchObject({ worldTick: 168, finished: true });
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 168, mode: "paused", stepTargetTick: null });
  });

  it("崩溃窗口残留的 stepping 行：补完当前 tick 后按持久化目标续步到完成", async () => {
    const value = await createTrackedGameHarness(active);
    const entered = beginStep(value, 3);
    stepOnce(value, entered);
    // 进入失败注入的崩溃窗口：第二个 tick 的阶段失败，时钟已写入但步骤未完成。
    const failing = vi.spyOn(value.authority.jobs, "runDue").mockImplementationOnce(() => {
      throw new Error("注入重启前失败");
    });
    expect(() => stepOnce(value)).toThrow("注入重启前失败");
    failing.mockRestore();
    // 生产宿主重启会把非暂停时钟归位为 paused；这里覆盖同一不变量的驱动层语义：
    // 只要残留的 stepping 行还在，补完与续步必须能按持久化目标安全收尾，不会卡死。
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 2, mode: "stepping", stepTargetTick: 3 });

    // 恢复路径：先按生命周期 start 的语义补完当前 tick（不推进、不重复结算），
    // 再由 worker 依据持久化的 stepTargetTick 继续推进并收尾。
    const eventsBeforeCatchUp = value.storage.transact(
      (tx) => tx.all("SELECT world_seq FROM domain_events WHERE branch_id = ?", [value.branchId]).length,
    );
    catchUpWorldTick({
      storage: value.storage,
      clock: value.clock,
      authority: value.authority,
      branchId: value.branchId,
    });
    expect(value.clock.read(value.branchId)).toMatchObject({ worldTick: 2, mode: "stepping", stepTargetTick: 3 });
    // 补完补跑 tick 2 失败的阶段，但重复补完不新增事件。
    const eventsAfterCatchUp = value.storage.transact(
      (tx) => tx.all("SELECT world_seq FROM domain_events WHERE branch_id = ?", [value.branchId]).length,
    );
    expect(eventsAfterCatchUp).toBeGreaterThanOrEqual(eventsBeforeCatchUp);
    catchUpWorldTick({
      storage: value.storage,
      clock: value.clock,
      authority: value.authority,
      branchId: value.branchId,
    });
    expect(
      value.storage.transact((tx) => tx.all("SELECT world_seq FROM domain_events WHERE branch_id = ?", [value.branchId]).length),
    ).toBe(eventsAfterCatchUp);

    const resumed = stepOnce(value);
    expect(resumed).toMatchObject({ worldTick: 3, finished: true });
    expect(value.clock.read(value.branchId)).toMatchObject({ mode: "paused", stepTargetTick: null });
  });
});
