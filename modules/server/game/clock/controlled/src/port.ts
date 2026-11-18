/**
 * 实现受控时钟的读取与运行/暂停/单步状态转移，所有写入落在 clock 表。
 * 依赖存储端口与时钟配置；runVersion 在每次模式变化时递增。
 * 禁止在 running 之外自行推进 tick、重复打开事务或绕过乐观版本校验。
 */
import { DomainError, type StoragePort } from "@ai-npc/contracts";
import type { ClockState, GameClockPort } from "@ai-npc/module-sdk";
import { requireClockNumber, requireClockString, type ClockConfig } from "./state";

type ControlResult =
  | { readonly ok: true; readonly clock: ClockState }
  | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };

/** 从存储行解析时钟；缺失或非法时直接报错。 */
function parseClock(row: Readonly<Record<string, unknown>> | null, branchId: string): ClockState {
  if (row === null) {
    throw new DomainError("not-found", `分支 ${branchId} 没有时钟行`, { details: { branchId } });
  }
  const mode = requireClockString(row, "mode");
  if (mode !== "running" && mode !== "pausing" && mode !== "paused" && mode !== "resuming" && mode !== "stepping") {
    throw new DomainError("invalid-state", `分支 ${branchId} 的时钟模式不合法`, { details: { mode } });
  }
  const stepTarget = row["step_target_tick"];
  return {
    worldTick: requireClockNumber(row, "world_tick"),
    mode,
    secondsPerTick: requireClockNumber(row, "seconds_per_tick"),
    runVersion: requireClockNumber(row, "run_version"),
    stepTargetTick:
      stepTarget === null || stepTarget === undefined
        ? null
        : requireClockNumber(row, "step_target_tick"),
  };
}

/** 受控时钟端口；每个控制方法一个短事务。 */
class ControlledClockPort implements GameClockPort {
  private readonly storage: StoragePort;
  private readonly config: ClockConfig;
  private readonly nowIso: () => string;

  constructor(storage: StoragePort, config: ClockConfig, nowIso: () => string) {
    this.storage = storage;
    this.config = config;
    this.nowIso = nowIso;
  }

  private readRow(branchId: string): { readonly row: Readonly<Record<string, unknown>>; readonly clock: ClockState } {
    return this.storage.transact((tx) => {
      const row = tx.branch(branchId).table("clock").get({});
      return { row: row ?? {}, clock: parseClock(row, branchId) };
    });
  }

  private write(
    branchId: string,
    update: (clock: ClockState, row: Readonly<Record<string, unknown>>) => ClockState,
  ): ClockState {
    return this.storage.transact((tx) => {
      const table = tx.branch(branchId).table("clock");
      const row = table.get({});
      const current = parseClock(row, branchId);
      const next = update(current, row ?? {});
      table.put({
        world_tick: next.worldTick,
        mode: next.mode,
        seconds_per_tick: next.secondsPerTick,
        run_version: next.runVersion,
        step_target_tick: next.stepTargetTick,
        updated_at: this.nowIso(),
      });
      return next;
    });
  }

  read(branchId: string): ClockState {
    return this.readRow(branchId).clock;
  }

  start(branchId: string, expectedRunVersion?: number): ControlResult {
    const current = this.read(branchId);
    if (expectedRunVersion !== undefined && expectedRunVersion !== current.runVersion) {
      return { ok: false, reasonCode: "version-conflict" };
    }
    if (current.mode === "running") {
      return { ok: true, clock: current };
    }
    if (current.mode !== "paused" && current.mode !== "resuming" && current.mode !== "stepping") {
      return { ok: false, reasonCode: "invalid-params" };
    }
    const clock = this.write(branchId, (value) => ({
      ...value,
      mode: "running",
      runVersion: value.runVersion + 1,
      stepTargetTick: null,
    }));
    return { ok: true, clock };
  }

  pause(branchId: string, expectedRunVersion?: number): ControlResult {
    const current = this.read(branchId);
    if (expectedRunVersion !== undefined && expectedRunVersion !== current.runVersion) {
      return { ok: false, reasonCode: "version-conflict" };
    }
    if (current.mode === "paused") {
      return { ok: true, clock: current };
    }
    if (current.mode !== "running" && current.mode !== "stepping") {
      return { ok: false, reasonCode: "invalid-params" };
    }
    const clock = this.write(branchId, (value) => ({
      ...value,
      mode: "paused",
      runVersion: value.runVersion + 1,
      stepTargetTick: null,
    }));
    return { ok: true, clock };
  }

  step(branchId: string, ticks: number, expectedRunVersion?: number): ControlResult {
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > this.config.maxStepTicks) {
      return { ok: false, reasonCode: "invalid-params" };
    }
    const current = this.read(branchId);
    if (expectedRunVersion !== undefined && expectedRunVersion !== current.runVersion) {
      return { ok: false, reasonCode: "version-conflict" };
    }
    if (current.mode !== "paused") {
      return { ok: false, reasonCode: "invalid-params" };
    }
    const clock = this.write(branchId, (value) => ({
      ...value,
      mode: "stepping",
      runVersion: value.runVersion + 1,
      stepTargetTick: value.worldTick + ticks,
    }));
    return { ok: true, clock };
  }

  finishStep(branchId: string): ClockState {
    const current = this.read(branchId);
    if (current.mode !== "stepping") {
      return current;
    }
    return this.write(branchId, (value) => ({
      ...value,
      mode: "paused",
      runVersion: value.runVersion + 1,
      stepTargetTick: null,
    }));
  }

  setTick(branchId: string, tick: number): ClockState {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new DomainError("validation", "时钟 tick 必须是非负安全整数", { details: { tick } });
    }
    return this.write(branchId, (value) => {
      if (tick < value.worldTick) {
        throw new DomainError("invalid-state", "时钟不能回退", {
          details: { branchId, current: value.worldTick, requested: tick },
        });
      }
      if (value.mode !== "running" && value.mode !== "stepping") {
        throw new DomainError("invalid-state", "暂停状态下不能推进 tick", {
          details: { branchId, mode: value.mode },
        });
      }
      return { ...value, worldTick: tick };
    });
  }
}

/** 构造受控时钟端口；配置已在模块创建时填充默认值。 */
export function createClockPort(
  storage: StoragePort,
  config: ClockConfig,
  nowIso: () => string,
): GameClockPort {
  return new ControlledClockPort(storage, config, nowIso);
}
