/**
 * 运营编排：暂停、继续、一致快照、恢复与重新开局的统一入口。
 * 依赖调用方注入的时钟/存档/分支回调；不直接写存储。
 * 禁止跳过暂停保存快照，或把恢复/重开实现成覆盖旧分支。
 */
import type { ClockView, ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { operationsConfigSchema } from "./definition";

export interface SnapshotView {
  readonly snapshotId: string;
  readonly worldTick: number;
}

/** 不一致返回的首次结果：恢复成功时带上宿主在同一提交后读到的时钟。 */
export interface RestoreOutcome {
  readonly branchId: string;
  readonly clock?: ClockView;
}

/** 需要幂等记录的运营操作上下文；operationId 由请求体提供，principalId 来自认证会话。 */
export interface OperationRequest {
  readonly operationId: string;
  readonly principalId: string;
}

export interface SnapshotInput {
  readonly label: string;
  readonly createdBy: string;
}

export interface RestoreInput {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
}

function clockHook(): { readonly mode: string; readonly runVersion: number } {
  return { mode: "paused", runVersion: 0 };
}

function pauseHook(expectedRunVersion: number): ClockView {
  throw new Error(`pause hook 未注入: ${expectedRunVersion}`);
}

function resumeHook(expectedRunVersion: number): ClockView {
  throw new Error(`resume hook 未注入: ${expectedRunVersion}`);
}

function snapshotHook(input: SnapshotInput): SnapshotView {
  throw new Error(`snapshot hook 未注入: ${input.label}:${input.createdBy}`);
}

function restoreHook(input: RestoreInput): RestoreOutcome {
  throw new Error(`restore hook 未注入: ${input.snapshotId}:${input.createdBy}`);
}

function resetHook(): { readonly branchId: string; readonly clock: ClockView } {
  throw new Error("reset hook 未注入");
}

/**
 * 幂等执行入口：宿主按认证主体、operationId 与请求内容哈希识别重试，并把首次结果与业务写入
 * 在同一事务内持久化。未提供时，运营服务退回原有的非幂等回调。
 */
export interface IdempotentOperationsDriver {
  pause(operation: OperationRequest, expectedRunVersion: number): ClockView;
  resume(operation: OperationRequest, expectedRunVersion: number): ClockView;
  snapshot(operation: OperationRequest, input: SnapshotInput): SnapshotView;
  restore(operation: OperationRequest, input: RestoreInput): RestoreOutcome;
  reset(operation: OperationRequest): { readonly branchId: string; readonly clock: ClockView };
}

export interface OperationsDriver {
  readonly clock: typeof clockHook;
  readonly pause: typeof pauseHook;
  readonly resume: typeof resumeHook;
  readonly snapshot: typeof snapshotHook;
  readonly restore: typeof restoreHook;
  readonly reset: typeof resetHook;
  /** 可选的幂等执行入口；提供后运营服务按 operationId 转发。 */
  readonly idempotent?: IdempotentOperationsDriver;
}

/** 统一运营流程；快照前强制暂停，恢复/重开保留旧分支。 */
export class OperationsService {
  private readonly driver: OperationsDriver;

  constructor(driver: OperationsDriver) {
    this.driver = driver;
  }

  pause(expectedRunVersion: number, operation?: OperationRequest): ClockView {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.pause(operation, expectedRunVersion);
    }
    return this.driver.pause(expectedRunVersion);
  }

  resume(expectedRunVersion: number, operation?: OperationRequest): ClockView {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.resume(operation, expectedRunVersion);
    }
    return this.driver.resume(expectedRunVersion);
  }

  snapshot(label: string, createdBy: string, operation?: OperationRequest): SnapshotView {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.snapshot(operation, { label, createdBy });
    }
    const clock = this.driver.clock();
    if (clock.mode === "running") {
      this.driver.pause(clock.runVersion);
    }
    return this.driver.snapshot({ label, createdBy });
  }

  restore(snapshotId: string, createdBy: string, runId?: string, operation?: OperationRequest): RestoreOutcome {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.restore(operation, {
        snapshotId,
        createdBy,
        ...(runId === undefined ? {} : { runId }),
      });
    }
    return this.driver.restore({ snapshotId, createdBy, ...(runId === undefined ? {} : { runId }) });
  }

  reset(operation?: OperationRequest): { readonly branchId: string; readonly clock: ClockView } {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.reset(operation);
    }
    return this.driver.reset();
  }
}

/** 创建无状态运营模块；端口暴露服务工厂。 */
export function createOperationsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  operationsConfigSchema.parse(input.config);
  return createStatelessModule(input, {
    create: (driver: OperationsDriver): OperationsService => new OperationsService(driver),
  });
}
