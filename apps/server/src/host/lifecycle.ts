/**
 * 宿主生命周期：时钟控制（含受控单步）、运营生命周期审计、断线自动暂停、在线 tick worker 与关闭释放。
 * 依赖时钟 provider、authority 的 tick 推进、存储事务、传输应用通知与组合根提供的释放回调。
 * 禁止在 worker 失败后继续推进时钟、跳过断线宽限或在关闭时跳过资源释放。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import { DomainError, type Json, type StoragePort } from "@world-prism/contracts";
import {
  clearRuleFailure,
  readBranch,
  readRuleFailure,
  workerFailureIdentity,
  writeRuleFailure,
  type Authority,
} from "@world-prism/authority";
import { insertLifecycleAuditEvent, type ClockState } from "@world-prism/module-sdk";
import type { HostServices } from "@world-prism/contracts";
import { advanceSteppingTick, advanceWorldTick, catchUpWorldTick } from "../tick";
import { clockView } from "./clock-view";
import type { LiveRunState } from "./live-state";
import type { ServerApp, ServerRuntime } from "./module-catalog";

export interface LifecycleInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly runtime: ServerRuntime;
  readonly authority: Authority;
  readonly active: LiveRunState;
  /** 时钟 provider 的有效配置：全部玩家断线后自动暂停的阈值。 */
  readonly autoPauseAfterDisconnectMs: number;
  readonly agentHealth?: () => boolean;
  /** 当前在线分支是否已开始 campaign；未开局时不能继续时钟，避免非零 tick 开局。 */
  readonly campaignStarted: () => boolean;
  /**
   * 关闭时排空并释放存储、模块与传输；传输实例在 attachApp 后可用。
   * 实现方必须先排空再释放（见 `drainBeforeClose`），因此这里不再分两级调用。
   */
  readonly closeResources: (app: ServerApp | null) => Promise<void>; // eslint-disable-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把 ServerApp 判为 any。
}

/** 宿主生命周期接口；组装完成后由组合根 attachApp 并 start。 */
export interface HostLifecycle {
  attachApp(app: ServerApp): void;
  clockState(): ClockState;
  control(mode: "pause" | "start", expectedRunVersion: number): ReturnType<typeof clockView>;
  /** 受控单步：从 paused 进入 stepping，宿主 worker 逐 tick 推进并回到 paused。 */
  control(mode: "step", expectedRunVersion: number, ticks: number): ReturnType<typeof clockView>;
  handlePlayerConnections(connected: number): void;
  healthStatus(): "ready" | "degraded";
  start(): void;
  close(): Promise<void>;
}

/**
 * 创建生命周期管理器：worker 与自动暂停都只操作当前在线分支，
 * 失败后停止推进并让健康状态变为 degraded。
 */
export function createLifecycle(input: LifecycleInput): HostLifecycle {
  const { host, storage, runtime, authority, active, autoPauseAfterDisconnectMs, campaignStarted } = input;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把 ServerApp 判为 any。
  let app: ServerApp | null = null;
  let playerConnections = 0;
  let autoPauseTimer: ReturnType<typeof setTimeout> | null = null;
  let workerTimer: ReturnType<typeof setTimeout> | null = null;
  let workerFailed = false;
  let workerBusy = false;
  let closePromise: Promise<void> | null = null;

  const clockState = (): ClockState => runtime.clock.read(active.branchId);

  /**
   * 记录运营性生命周期事件（自动暂停等）；与领域事件分离。
   * 写入走统一审计契约；审计写入失败只记日志，不覆盖触发它的业务结果。
   */
  const recordLifecycleEvent = (type: string, subjectId: string, payload: Json): void => {
    try {
      storage.transact((tx) => {
        // 分支的 run 归属经 authority 的分支读取取得，字段缺失或类型不符时随审计失败记入日志。
        const runId = readBranch(tx, active.branchId)?.runId ?? null;
        insertLifecycleAuditEvent(tx, {
          runId, branchId: active.branchId, type, subjectId, payload, createdAt: host.nowIso(),
        });
      });
    } catch (error) {
      host.logger.error("生命周期审计写入失败", {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * 持久化 worker 失败的位置、tick 与消息；健康摘要据此在重启后仍能解释 degraded 原因。
   * 记录自身失败只写日志，不覆盖已经发生的推进错误。
   */
  const recordWorkerFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    let worldTick: number | null = null;
    try {
      storage.transact((tx) => {
        const previous = readRuleFailure(tx, active.branchId, workerFailureIdentity);
        writeRuleFailure(tx, active.branchId, workerFailureIdentity, {
          attempts: (previous?.attempts ?? 0) + 1,
          error,
          deadLettered: true,
          nowIso: host.nowIso(),
        });
      });
      worldTick = clockState().worldTick;
    } catch (recordError) {
      host.logger.error("worker 失败状态持久化失败", {
        message: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
    recordLifecycleEvent("WorkerFailed", "system:tick-worker", { message, worldTick });
  };

  /** 清理已恢复的 worker 失败记录；清理失败时保留记录并让健康状态继续报告 degraded。 */
  const clearWorkerFailure = (): boolean => {
    try {
      storage.transact((tx) => clearRuleFailure(tx, active.branchId, workerFailureIdentity));
      return true;
    } catch (error) {
      host.logger.error("worker 恢复状态清理失败", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  /** 读取持久化的 worker 失败记录；存储不可用时按 degraded 处理，不伪造 ready。 */
  const hasPersistedWorkerFailure = (): boolean => {
    try {
      return storage.transact(
        (tx) => readRuleFailure(tx, active.branchId, workerFailureIdentity)?.status === "failed",
      );
    } catch (error) {
      host.logger.error("读取 worker 失败状态失败", {
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };

  const clearAutoPauseTimer = (): void => {
    if (autoPauseTimer !== null) {
      clearTimeout(autoPauseTimer);
      autoPauseTimer = null;
    }
  };

  /**
   * 全部玩家连接断开后启动一次自动暂停计时；阈值来自时钟装配配置。
   * 计时器 unref，重连或关闭时取消；暂停后 tick 不再推进，离线时间不补算。
   */
  function scheduleAutoPause(): void {
    if (autoPauseTimer !== null || playerConnections > 0 || workerFailed) {
      return;
    }
    autoPauseTimer = setTimeout(() => {
      autoPauseTimer = null;
      if (playerConnections > 0) {
        return;
      }
      const clock = clockState();
      if (clock.mode !== "running") {
        return;
      }
      const paused = runtime.clock.pause(active.branchId, clock.runVersion);
      if (!paused.ok) {
        host.logger.warn("玩家断线超时但自动暂停未生效", {
          branchId: active.branchId,
          reason: paused.reasonCode,
        });
        return;
      }
      host.logger.warn("玩家全部断开超过阈值，已自动暂停时钟", {
        branchId: active.branchId,
        afterMs: autoPauseAfterDisconnectMs,
        worldTick: clock.worldTick,
      });
      recordLifecycleEvent("ClockAutoPaused", "system:offline-timeout", {
        reason: "players-disconnected",
        afterMs: autoPauseAfterDisconnectMs,
        worldTick: clock.worldTick,
        runVersion: paused.clock.runVersion,
      });
      app?.notifyWorldChanged();
    }, autoPauseAfterDisconnectMs);
    autoPauseTimer.unref();
  }

  /** 玩家连接数变化：重连取消计时；从在线变为全断时开始计时。 */
  function handlePlayerConnections(connected: number): void {
    const previouslyConnected = playerConnections > 0;
    playerConnections = connected;
    if (connected > 0) {
      clearAutoPauseTimer();
      return;
    }
    if (previouslyConnected) {
      scheduleAutoPause();
    }
  }

  /** 按 provider 的 tick 间隔安排下一次推进；unref 避免阻止进程退出。 */
  const schedule = (): void => {
    if (workerFailed) {
      return;
    }
    const delay = Math.max(1000, clockState().secondsPerTick * 1000);
    workerTimer = setTimeout(runWorker, delay);
    workerTimer.unref();
  };

  /** 单次推进：保持 busy 标记避免重入，失败后停止后续推进并持久化原因。 */
  function runWorker(): void {
    if (workerBusy) {
      return;
    }
    workerBusy = true;
    try {
      const clock = clockState();
      if (clock.mode === "running") {
        if (authority.clock.pendingStop(active.branchId)) {
          // 终局已登记：补做一次暂停，不把预期的章节终点当成 worker 失败。
          const paused = runtime.clock.pause(active.branchId);
          if (!paused.ok) {
            host.logger.warn("章节终点补做暂停未生效", {
              branchId: active.branchId,
              reason: paused.reasonCode,
            });
          }
          app?.notifyWorldChanged();
        } else {
          advanceWorldTick({
            storage,
            clock: runtime.clock,
            authority,
            branchId: active.branchId,
            targetTick: clock.worldTick + 1,
          });
          clearWorkerFailure();
          app?.notifyWorldChanged();
        }
      } else if (clock.mode === "stepping") {
        // 受控单步：按同一间隔推进一个 tick；到达目标或章节终点时由推进函数收尾回 paused。
        advanceSteppingTick({
          storage,
          clock: runtime.clock,
          authority,
          branchId: active.branchId,
          current: clock,
        });
        clearWorkerFailure();
        app?.notifyWorldChanged();
      }
    } catch (error) {
      workerFailed = true;
      recordWorkerFailure(error);
      host.logger.error("host worker 失败，已停止推进", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      workerBusy = false;
      if (!workerFailed) {
        schedule();
      }
    }
  }

  /**
   * 补完当前 tick 并清理持久失败状态；成功后才允许提交时钟恢复。
   * 补完失败时保留 worker 失败状态并拒绝恢复；清理失败时健康状态保持 degraded。
   */
  const recoverWorker = (expectedRunVersion: number): void => {
    // 先按与时钟控制相同的版本语义预检，避免已开始恢复后才因版本冲突失败。
    if (clockState().runVersion !== expectedRunVersion) {
      throw new DomainError("version-conflict", "时钟版本冲突");
    }
    try {
      catchUpWorldTick({ storage, clock: runtime.clock, authority, branchId: active.branchId });
    } catch (error) {
      workerFailed = true;
      recordWorkerFailure(error);
      app?.notifyWorldChanged();
      throw new DomainError("not-ready", "worker 恢复失败，当前 tick 仍有未处理的失败项", {
        cause: error,
        details: { branchId: active.branchId },
      });
    }
    if (!clearWorkerFailure()) {
      workerFailed = false;
      throw new DomainError("not-ready", "worker 失败状态清理失败，健康状态仍为 degraded", {
        details: { branchId: active.branchId },
      });
    }
    workerFailed = false;
    recordLifecycleEvent("WorkerRecovered", "system:tick-worker", {
      worldTick: clockState().worldTick,
    });
  };

  /**
   * 暂停/继续/受控单步：版本冲突与非法参数分别映射为领域错误，继续时按断线状态重新计时。
   * 恢复必须先补完当前 tick 且清理持久失败记录，成功后才提交时钟启动，失败时时钟不变；
   * 单步从 paused 进入 stepping 后交回 worker 按间隔推进，不在此处同步跑完整步。
   */
  const control = (
    mode: "pause" | "start" | "step",
    expectedRunVersion: number,
    ticks?: number,
  ): ReturnType<typeof clockView> => {
    // 未开局就推进时钟会让 campaign.start 永久落在非零 tick；必须在入口拒绝。
    if (mode !== "pause" && !campaignStarted()) {
      throw new DomainError(
        "not-ready",
        mode === "step" ? "campaign 尚未开始，不能单步推进时钟" : "campaign 尚未开始，不能继续时钟",
        { details: { branchId: active.branchId } },
      );
    }
    // 终局停止点已登记：先补完当前 tick 并清理 worker 失败状态，再确认时钟保持暂停并拒绝推进。
    if (mode !== "pause" && authority.clock.pendingStop(active.branchId)) {
      recoverWorker(expectedRunVersion);
      const paused = runtime.clock.pause(active.branchId);
      if (!paused.ok) {
        throw new DomainError("invalid-state", "章节终点暂停时钟失败", {
          details: { branchId: active.branchId, reasonCode: paused.reasonCode },
        });
      }
      app?.notifyWorldChanged();
      throw new DomainError(
        "invalid-state",
        mode === "step" ? "章节已结束，不能单步推进时钟" : "章节已结束，不能恢复时钟",
        { details: { branchId: active.branchId } },
      );
    }
    const needsWorkerRecovery =
      mode !== "pause" && (workerFailed || hasPersistedWorkerFailure());
    if (needsWorkerRecovery) {
      recoverWorker(expectedRunVersion);
      // 恢复成功即重建推进调度：即便随后的时钟控制被拒绝（如 stepping 中重复单步），
      // worker 也已重新驱动，不会留下无驱动方的 running/stepping 残留。
      schedule();
      app?.notifyWorldChanged();
    }
    const result = mode === "pause"
      ? runtime.clock.pause(active.branchId, expectedRunVersion)
      : mode === "step"
        ? runtime.clock.step(active.branchId, ticks ?? 0, expectedRunVersion)
        : runtime.clock.start(active.branchId, expectedRunVersion);
    if (!result.ok) {
      throw result.reasonCode === "version-conflict"
        ? new DomainError("version-conflict", "时钟版本冲突")
        : new DomainError("invalid-state", "时钟控制参数非法");
    }
    // 没有玩家连接时恢复时钟，同样要进入断线自动暂停计时；单步是 operator 发起的有界推进，不参与。
    if (mode === "start" && playerConnections === 0) {
      scheduleAutoPause();
    }
    return clockView(result.clock);
  };

  return {
    attachApp(next: ServerApp): void {
      app = next;
    },
    clockState,
    control,
    handlePlayerConnections,
    healthStatus: () => (workerFailed || hasPersistedWorkerFailure() || input.agentHealth?.() === false ? "degraded" : "ready"),
    start(): void {
      try {
        // 重启或恢复后先补完当前 tick，再开始按间隔推进。
        catchUpWorldTick({ storage, clock: runtime.clock, authority, branchId: active.branchId });
        clearWorkerFailure();
      } catch (error) {
        workerFailed = true;
        recordWorkerFailure(error);
        host.logger.error("host 启动补完当前 tick 失败，已停止推进", {
          message: error instanceof Error ? error.message : String(error),
          branchId: active.branchId,
        });
      }
      schedule();
    },
    close: async (): Promise<void> => {
      if (closePromise !== null) {
        return closePromise;
      }
      closePromise = (async () => {
        workerFailed = true;
        if (workerTimer !== null) {
          clearTimeout(workerTimer);
          workerTimer = null;
        }
        clearAutoPauseTimer();
        // 关闭按传输、模块、存储的逆序释放；任一步抛错仍继续，最后汇总错误。
        await input.closeResources(app);
      })();
      return closePromise;
    },
  };
}
