/**
 * 验证受控时钟的运行、暂停、单步与乐观版本冲突。
 * 依赖真实 SQLite 分支时钟、时钟端口与测试宿主；不启动调度 worker。
 * 禁止在测试中直接改内存时钟或绕过 runVersion。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createClockPort } from "@world-prism/mod-game-clock-controlled";
import { createGameHarness, type GameHarness } from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (harness) => harness.dispose()));
});

async function harness(): Promise<GameHarness> {
  const created = await createGameHarness();
  active.push(created);
  return created;
}

describe("受控时钟", () => {
  it("运行、暂停、单步与完成单步都递增 runVersion", async () => {
    const value = await harness();
    const clock = createClockPort(value.storage, { secondsPerTick: 10, maxStepTicks: 24, autoPauseAfterDisconnectMs: 60_000 }, value.host.nowIso);
    expect(clock.read(value.branchId)).toMatchObject({ worldTick: 0, mode: "running", runVersion: 0 });
    const paused = clock.pause(value.branchId);
    expect(paused).toMatchObject({ ok: true, clock: { mode: "paused", runVersion: 1 } });
    const started = clock.start(value.branchId);
    expect(started).toMatchObject({ ok: true, clock: { mode: "running", runVersion: 2 } });
    expect(clock.pause(value.branchId)).toMatchObject({ ok: true, clock: { mode: "paused", runVersion: 3 } });
    const stepping = clock.step(value.branchId, 6);
    expect(stepping).toMatchObject({ ok: true, clock: { mode: "stepping", stepTargetTick: 6, runVersion: 4 } });
    expect(clock.finishStep(value.branchId)).toMatchObject({ mode: "paused", stepTargetTick: null, runVersion: 5 });
  });

  it("拒绝过期版本、越界单步与暂停推进", async () => {
    const value = await harness();
    const clock = createClockPort(value.storage, { secondsPerTick: 10, maxStepTicks: 24, autoPauseAfterDisconnectMs: 60_000 }, value.host.nowIso);
    expect(clock.pause(value.branchId, 99)).toMatchObject({ ok: false, reasonCode: "version-conflict" });
    // 运行中不能进入单步：单步只从 paused 发起，避免与 worker 的自动推进竞争。
    expect(clock.step(value.branchId, 1)).toMatchObject({ ok: false, reasonCode: "invalid-params" });
    expect(clock.step(value.branchId, 25)).toMatchObject({ ok: false, reasonCode: "invalid-params" });
    clock.pause(value.branchId);
    expect(() => clock.setTick(value.branchId, 1)).toThrow();
  });
});
