/**
 * 运营编排：暂停、继续、受控单步、一致快照、恢复、重新开局与在线名册休眠/唤醒的统一入口。
 * 依赖调用方注入的时钟/存档/分支/名册回调；不直接写存储。
 * 禁止跳过暂停保存快照，或把恢复/重开实现成覆盖旧分支。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口方法参数名用于表达运营调用契约。 */
import {
  DomainError,
  type ClockView,
  type ModuleCreateInput,
  type ModuleInstance,
  type OnlineRosterOperationResponse,
  type OnlineRosterView,
  type RestoreDryRunResponse,
} from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { operationsConfigSchema } from "./definition";

export interface SnapshotView {
  readonly snapshotId: string;
  readonly worldTick: number;
}

/** 不一致返回的首次结果：恢复成功时带上宿主在同一提交后读到的时钟。 */
export interface RestoreOutcome {
  readonly branchId: string;
  readonly clock?: ClockView;
  /** 本次调用是否真正切换了在线分支；幂等重放返回首次结果时为 false。 */
  readonly applied?: boolean;
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

/**
 * 幂等执行入口：宿主按认证主体、operationId 与请求内容哈希识别重试，并把首次结果与业务写入
 * 在同一事务内持久化。未提供时，运营服务退回原有的非幂等回调。
 */
export interface IdempotentOperationsDriver {
  pause(operation: OperationRequest, expectedRunVersion: number): ClockView;
  resume(operation: OperationRequest, expectedRunVersion: number): ClockView;
  step(operation: OperationRequest, expectedRunVersion: number, ticks: number): ClockView;
  snapshot(operation: OperationRequest, input: SnapshotInput): SnapshotView;
  restore(operation: OperationRequest, input: RestoreInput): RestoreOutcome;
  reset(operation: OperationRequest): {
    readonly branchId: string;
    readonly clock: ClockView;
    readonly applied?: boolean;
  };
}

/**
 * 在线名册的休眠与唤醒：休眠先受控暂停在线时钟并释放部署级名额，唤醒在同一事务内预留名额并激活名册。
 * 两者都只经幂等入口执行，宿主按 operationId 记录首次结果。
 */
export interface OnlineRosterDriver {
  readonly state: () => OnlineRosterView;
  readonly hibernate: (operation: OperationRequest) => OnlineRosterOperationResponse;
  readonly wake: (operation: OperationRequest) => OnlineRosterOperationResponse;
}

/** 宿主注入的时钟/存档/分支回调；运营服务不直接读写存储。 */
export interface OperationsDriver {
  readonly clock: () => { readonly mode: string; readonly runVersion: number };
  readonly pause: (expectedRunVersion: number) => ClockView;
  readonly resume: (expectedRunVersion: number) => ClockView;
  /** 受控单步推进：从 paused 进入 stepping，由宿主逐 tick 推进后回到 paused。 */
  readonly step: (expectedRunVersion: number, ticks: number) => ClockView;
  readonly snapshot: (input: SnapshotInput) => SnapshotView;
  readonly restore: (input: RestoreInput) => RestoreOutcome;
  readonly validateRestore?: (snapshotId: string) => RestoreDryRunResponse;
  /** 重开在线世界；createdBy 是发起重开的认证主体，写入重开前快照的创建者。 */
  readonly reset: (createdBy: string) => { readonly branchId: string; readonly clock: ClockView };
  /** 可选的幂等执行入口；提供后运营服务按 operationId 转发。 */
  readonly idempotent?: IdempotentOperationsDriver;
  /** 可选的在线名册休眠与唤醒；未提供时对应操作按 not-ready 拒绝。 */
  readonly roster?: OnlineRosterDriver;
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

  step(expectedRunVersion: number, ticks: number, operation?: OperationRequest): ClockView {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.step(operation, expectedRunVersion, ticks);
    }
    return this.driver.step(expectedRunVersion, ticks);
  }

  snapshot(label: string, createdBy: string, operation?: OperationRequest): SnapshotView {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.snapshot(operation, { label, createdBy });
    }
    const clock = this.driver.clock();
    // 非幂等回退与幂等路径同语义：运行或单步中都先受控暂停，不在 stepping 中间冻结存档。
    if (clock.mode === "running" || clock.mode === "stepping") {
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

  validateRestore(snapshotId: string): RestoreDryRunResponse {
    if (this.driver.validateRestore === undefined) {
      throw new Error("运营驱动未提供恢复预检");
    }
    return this.driver.validateRestore(snapshotId);
  }

  reset(createdBy: string, operation?: OperationRequest): {
    readonly branchId: string;
    readonly clock: ClockView;
    readonly applied?: boolean;
  } {
    if (operation !== undefined && this.driver.idempotent !== undefined) {
      return this.driver.idempotent.reset(operation);
    }
    return this.driver.reset(createdBy);
  }

  rosterState(): OnlineRosterView {
    return this.roster().state();
  }

  /** 休眠在线名册：运行或单步中先受控暂停，再释放名册占用的部署级名额。 */
  hibernateRoster(operation: OperationRequest): OnlineRosterOperationResponse {
    return this.roster().hibernate(operation);
  }

  /** 唤醒在线名册：在同一事务内预留名额并激活，名额不足时整体拒绝；时钟保持暂停。 */
  wakeRoster(operation: OperationRequest): OnlineRosterOperationResponse {
    return this.roster().wake(operation);
  }

  private roster(): OnlineRosterDriver {
    if (this.driver.roster === undefined) {
      throw new DomainError("not-ready", "运营驱动未提供在线名册休眠与唤醒");
    }
    return this.driver.roster;
  }
}

/** 创建无状态运营模块；端口暴露服务工厂。 */
export function createOperationsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  operationsConfigSchema.parse(input.config);
  return createStatelessModule(input, {
    create: (driver: OperationsDriver): OperationsService => new OperationsService(driver),
  });
}
