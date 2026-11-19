/**
 * 实现受控时钟的读取与运行/暂停/单步状态转移，所有写入落在 clock 表。
 * 依赖存储端口与时钟配置；runVersion 在每次模式变化时递增。
 * 禁止在 running 之外自行推进 tick、重复打开事务或绕过乐观版本校验。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 方法签名中的参数名只用于表达调用契约。 */
import { DomainError, type StoragePort, type StorageTransaction } from "@ai-npc/contracts";
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

  private readRow(branchId: string): ClockState {
    return this.storage.transact((tx) => this.readInTransaction(tx, branchId));
  }

  readInTransaction(tx: StorageTransaction, branchId: string): ClockState {
    return parseClock(tx.branch(branchId).table("clock").get({}), branchId);
  }

  initializeInTransaction(tx: StorageTransaction, branchId: string): ClockState {
    const table = tx.branch(branchId).table("clock");
    if (table.get({}) !== null) {
      throw new DomainError("invalid-state", `分支 ${branchId} 已有时钟行，拒绝覆盖`, {
        details: { branchId },
      });
    }
    return this.commit(table, {
      worldTick: 0,
      mode: "paused",
      secondsPerTick: this.config.secondsPerTick,
      runVersion: 0,
      stepTargetTick: null,
    });
  }

  private commit(table: { put(row: Record<string, unknown>): void }, next: ClockState): ClockState {
    table.put({
      world_tick: next.worldTick,
      mode: next.mode,
      seconds_per_tick: next.secondsPerTick,
      run_version: next.runVersion,
      step_target_tick: next.stepTargetTick,
      updated_at: this.nowIso(),
    });
    return next;
  }

  private control(
    branchId: string,
    expectedRunVersion: number | undefined,
    action: (current: ClockState) => ControlResult,
  ): ControlResult {
    return this.storage.transact((tx) => {
      const table = tx.branch(branchId).table("clock");
      const current = parseClock(table.get({}), branchId);
      if (expectedRunVersion !== undefined && expectedRunVersion !== current.runVersion) {
        return { ok: false, reasonCode: "version-conflict" };
      }
      const outcome = action(current);
      if (!outcome.ok) {
        return outcome;
      }
      return { ok: true, clock: this.commit(table, outcome.clock) };
    });
  }

  read(branchId: string): ClockState {
    return this.readRow(branchId);
  }

  start(branchId: string, expectedRunVersion?: number): ControlResult {
    return this.control(branchId, expectedRunVersion, (current) => {
      if (current.mode === "running") {
        return { ok: true, clock: current };
      }
      if (current.mode !== "paused" && current.mode !== "resuming" && current.mode !== "stepping") {
        return { ok: false, reasonCode: "invalid-params" };
      }
      return {
        ok: true,
        clock: { ...current, mode: "running", runVersion: current.runVersion + 1, stepTargetTick: null },
      };
    });
  }

  pause(branchId: string, expectedRunVersion?: number): ControlResult {
    return this.control(branchId, expectedRunVersion, (current) => {
      if (current.mode === "paused") {
        return { ok: true, clock: current };
      }
      if (current.mode !== "running" && current.mode !== "stepping") {
        return { ok: false, reasonCode: "invalid-params" };
      }
      return {
        ok: true,
        clock: { ...current, mode: "paused", runVersion: current.runVersion + 1, stepTargetTick: null },
      };
    });
  }

  step(branchId: string, ticks: number, expectedRunVersion?: number): ControlResult {
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > this.config.maxStepTicks) {
      return { ok: false, reasonCode: "invalid-params" };
    }
    return this.control(branchId, expectedRunVersion, (current) => {
      if (current.mode !== "paused") {
        return { ok: false, reasonCode: "invalid-params" };
      }
      return {
        ok: true,
        clock: {
          ...current,
          mode: "stepping",
          runVersion: current.runVersion + 1,
          stepTargetTick: current.worldTick + ticks,
        },
      };
    });
  }

  finishStep(branchId: string): ClockState {
    const outcome = this.control(branchId, undefined, (current) => {
      if (current.mode !== "stepping") {
        return { ok: true, clock: current };
      }
      return {
        ok: true,
        clock: { ...current, mode: "paused", runVersion: current.runVersion + 1, stepTargetTick: null },
      };
    });
    return outcome.ok ? outcome.clock : this.read(branchId);
  }

  setTick(branchId: string, tick: number): ClockState {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new DomainError("validation", "时钟 tick 必须是非负安全整数", { details: { tick } });
    }
    const outcome = this.control(branchId, undefined, (current) => {
      if (tick < current.worldTick) {
        throw new DomainError("invalid-state", "时钟不能回退", {
          details: { branchId, current: current.worldTick, requested: tick },
        });
      }
      if (current.mode !== "running" && current.mode !== "stepping") {
        throw new DomainError("invalid-state", "暂停状态下不能推进 tick", {
          details: { branchId, mode: current.mode },
        });
      }
      return { ok: true, clock: { ...current, worldTick: tick } };
    });
    if (!outcome.ok) {
      throw new DomainError("invalid-state", "时钟推进被拒绝", { details: { branchId, tick } });
    }
    return outcome.clock;
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
