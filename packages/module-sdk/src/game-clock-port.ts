/**
 * 核心职责：定义时钟模块的游戏端口与时钟读数类型。
 * 交互契约：依赖公共契约的存储事务；端口在调用方事务内读写时钟行。
 * 约束与禁忌：时钟控制不属于规则事务内的写入路径；禁止在这里提交或回滚调用方事务。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type { StorageTransaction } from "@world-prism/contracts";

/** 时钟读数；runVersion 用作控制接口的乐观版本。 */
export interface ClockState {
  readonly worldTick: number;
  readonly mode: "running" | "pausing" | "paused" | "resuming" | "stepping";
  readonly secondsPerTick: number;
  readonly runVersion: number;
  readonly stepTargetTick: number | null;
}

/** 时钟控制端口；面向宿主 API，不属于规则事务内的写入路径。 */
export interface GameClockPort {
  read(branchId: string): ClockState;
  /**
   * 在调用方已打开的事务内读取时钟；宿主投影与规则事务用同一快照，避免嵌套事务。
   * 端口只读该事务，不提交、不回滚，也不缓存结果；分支没有时钟行时抛 not-found。
   */
  readInTransaction(tx: StorageTransaction, branchId: string): ClockState;
  /**
   * 在调用方事务内为一个新分支写入初始时钟行（0 tick、暂停、版本 0），
   * 秒数取自 provider 自己的有效配置；已有时钟行时拒绝覆盖。
   */
  initializeInTransaction(tx: StorageTransaction, branchId: string): ClockState;
  start(branchId: string, expectedRunVersion?: number): { readonly ok: true; readonly clock: ClockState } | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };
  pause(branchId: string, expectedRunVersion?: number): { readonly ok: true; readonly clock: ClockState } | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };
  step(
    branchId: string,
    ticks: number,
    expectedRunVersion?: number,
  ): { readonly ok: true; readonly clock: ClockState } | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };
  finishStep(branchId: string): ClockState;
  setTick(branchId: string, tick: number): ClockState;
}
