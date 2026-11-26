/**
 * 按实例计划拓扑顺序创建并启动模块实例，失败时逆序释放已创建实例，并提供幂等的 drain/dispose。
 * 依赖公共契约的 HostServices、ModuleInstance 与 DomainError，以及本包解析出的实例计划；
 * 实例所需 host 服务与作用域由调用方提供，存储、模型与网络资源不由内核创建；
 * 调用方可以传入已启动的 provider 供依赖装配复用，本次句柄只释放自己创建的实例。
 * 禁止吞掉 create/start 的原始错误、在回滚中覆盖原始错误，或跳过对已启动实例的逆序释放。
 */
import {
  DomainError,
  type HostServices,
  type Json,
  type ModuleCreateInput,
  type ModuleInstance,
  type ModuleScope,
} from "@world-prism/contracts";
import type { PlannedModule, ResolvedRealmPlan } from "./resolve-assembly";

/** 启动实例所需的外部输入：宿主服务、状态作用域与协作式取消信号。 */
export interface StartInstancesOptions {
  readonly host: HostServices;
  readonly scope: ModuleScope;
  readonly signal?: AbortSignal;
  /**
   * 已由调用方启动的提供者：按 moduleId 参与本计划的 port 装配，但不归本次句柄释放。
   * 用于宿主先启动部署级 provider、再按在线 run 的装配启动其余模块。
   */
  readonly running?: readonly RunningInstance[];
}

/** 已创建并启动的模块实例及其对外 port。 */
export interface RunningInstance {
  readonly moduleId: string;
  readonly version: string;
  readonly instance: ModuleInstance;
  readonly port: unknown;
}

/** 运行中的实例集合；drain 与 dispose 都幂等，并各自按创建的逆序执行。 */
export interface StartedInstances {
  readonly instances: readonly RunningInstance[];
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  drain(deadlineMs: number): Promise<void>;
  dispose(): Promise<void>;
}

function buildPorts(
  planned: PlannedModule,
  created: ReadonlyMap<string, RunningInstance>,
): Readonly<Record<string, unknown>> {
  const ports: Record<string, unknown> = {};
  for (const requirement of planned.requires) {
    const providers: RunningInstance[] = [];
    for (const providerRef of requirement.providers) {
      const running = created.get(providerRef.moduleId);
      if (running === undefined) {
        throw new DomainError("assembly-incompatible", `实例计划顺序非法：${providerRef.moduleId} 尚未创建`, {
          details: { moduleId: planned.moduleId, providerModuleId: providerRef.moduleId },
        });
      }
      if (running.port === undefined) {
        throw new DomainError("plugin-failed", `模块 ${running.moduleId} 未暴露能力 ${requirement.capability} 的 port`, {
          details: {
            moduleId: running.moduleId,
            consumerModuleId: planned.moduleId,
            capability: requirement.capability,
          },
        });
      }
      providers.push(running);
    }
    if (requirement.cardinality === "many") {
      ports[requirement.capability] = providers.map((provider) => provider.port);
      continue;
    }
    const provider = providers[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (provider !== undefined) {
      ports[requirement.capability] = provider.port;
    }
  }
  return ports;
}

async function rollback(created: readonly RunningInstance[], host: HostServices): Promise<void> {
  // eslint-disable-next-line security-node/detect-unhandled-async-errors -- 每个 await 都在 try/catch 内处理，规则只检查函数体顶层语句。
  for (let index = created.length - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- 数组下标来自本文件循环。
    const running = created[index];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (running === undefined) {
      continue;
    }
    try {
      await running.instance.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logData: Json = { moduleId: running.moduleId, message };
      try {
        host.logger.error("模块实例回滚清理失败", logData);
      } catch {
        // 回滚日志失败不能覆盖导致启动失败的原始错误。
      }
    }
  }
}

async function closeInReverse(
  instances: readonly RunningInstance[],
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  close: (running: RunningInstance) => Promise<void>,
): Promise<void> {
  let failed = false;
  let firstError: unknown;
  for (let index = instances.length - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- 数组下标来自本文件循环。
    const running = instances[index];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (running === undefined) {
      continue;
    }
    try {
      await close(running);
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  // eslint-disable-next-line security-node/detect-unhandled-async-errors -- 每个 await 都在 try/catch 内处理，规则只检查函数体顶层语句。
  if (failed) {
    throw firstError;
  }
}

/**
 * 按计划顺序先创建全部实例、再依次启动；任一 create/start 失败时逆序 dispose 已创建实例并重抛原错误。
 * 成功后返回空闲句柄，drain 与 dispose 各自只执行一次，重复调用复用同一结果。
 */
export async function startInstances(
  plan: ResolvedRealmPlan,
  options: StartInstancesOptions,
): Promise<StartedInstances> {
  const signal = options.signal ?? new AbortController().signal;
  const running: RunningInstance[] = [];
  const byModuleId = new Map<string, RunningInstance>();
  for (const prior of options.running ?? []) {
    byModuleId.set(prior.moduleId, prior);
  }
  try {
    for (const planned of plan.modules) {
      const input: ModuleCreateInput = {
        moduleId: planned.moduleId,
        realm: plan.realm,
        config: planned.config,
        scope: options.scope,
        ports: buildPorts(planned, byModuleId),
        host: options.host,
        signal,
      };
      const instance = await planned.definition.create(input);
      const handle: RunningInstance = {
        moduleId: planned.moduleId,
        version: planned.version,
        instance,
        port: instance.port,
      };
      running.push(handle);
      byModuleId.set(planned.moduleId, handle);
    }
    for (const handle of running) {
      await handle.instance.start(signal);
    }
  } catch (error) {
    await rollback(running, options.host);
    throw error;
  }

  const instances: readonly RunningInstance[] = Object.freeze([...running]);
  let drainPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    instances,
    drain(deadlineMs: number): Promise<void> {
      if (drainPromise === undefined) {
        drainPromise = closeInReverse(instances, (runningInstance) => runningInstance.instance.drain(deadlineMs));
      }
      return drainPromise;
    },
    dispose(): Promise<void> {
      if (disposePromise === undefined) {
        disposePromise = closeInReverse(instances, (runningInstance) => runningInstance.instance.dispose());
      }
      return disposePromise;
    },
  });
}
