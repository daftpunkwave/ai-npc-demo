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

interface SnapshotInput {
  readonly label: string;
  readonly createdBy: string;
}

interface RestoreInput {
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

function restoreHook(input: RestoreInput): { readonly branchId: string } {
  throw new Error(`restore hook 未注入: ${input.snapshotId}:${input.createdBy}`);
}

function resetHook(): { readonly branchId: string; readonly clock: ClockView } {
  throw new Error("reset hook 未注入");
}

export interface OperationsDriver {
  readonly clock: typeof clockHook;
  readonly pause: typeof pauseHook;
  readonly resume: typeof resumeHook;
  readonly snapshot: typeof snapshotHook;
  readonly restore: typeof restoreHook;
  readonly reset: typeof resetHook;
}

/** 统一运营流程；快照前强制暂停，恢复/重开保留旧分支。 */
export class OperationsService {
  private readonly driver: OperationsDriver;

  constructor(driver: OperationsDriver) {
    this.driver = driver;
  }

  pause(expectedRunVersion: number): ClockView {
    return this.driver.pause(expectedRunVersion);
  }

  resume(expectedRunVersion: number): ClockView {
    return this.driver.resume(expectedRunVersion);
  }

  snapshot(label: string, createdBy: string): SnapshotView {
    const clock = this.driver.clock();
    if (clock.mode === "running") {
      this.driver.pause(clock.runVersion);
    }
    return this.driver.snapshot({ label, createdBy });
  }

  restore(snapshotId: string, createdBy: string, runId?: string): { readonly branchId: string } {
    return this.driver.restore({ snapshotId, createdBy, ...(runId === undefined ? {} : { runId }) });
  }

  reset(): { readonly branchId: string; readonly clock: ClockView } {
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
