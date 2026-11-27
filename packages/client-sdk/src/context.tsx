/**
 * 提供浏览器模块宿主的 React context：已绑定 port、slot 贡献、纯展示偏好与贡献失败上报入口；
 * 模块视图在运行时建立的模块作用域内只看见该模块声明的端口。
 * 依赖公共契约的能力/贡献语义、React context 与本包的偏好与 slot 类型；不创建网络、存储或服务端对象。
 * 禁止伪造未注册 port，也禁止把世界权威状态、运营权限或凭据放进 context。
 */
import { DomainError } from "@world-prism/contracts";
import { createContext, useMemo, useSyncExternalStore, useContext, type ReactNode } from "react";
import type { PreferencePort } from "./preferences";
import type { SlotContribution } from "./slots";

/** 单个贡献渲染失败的上报入口；宿主据此记录 trace 或显示原因，不在 SDK 内静默吞掉。 */
export type ContributionErrorReporter = (error: unknown, contribution: SlotContribution) => void;

/** 浏览器宿主向模块提供的受控上下文值。 */
export interface ModuleHostValue {
  /**
   * 按 capability ID 绑定的 port。宿主根 Provider 给出本 realm 全部端口；
   * 模块视图内收窄为该模块 requires、自身 provides 与本 realm 宿主固定端口。
   */
  readonly ports: Readonly<Record<string, unknown>>;
  /** 当前渲染的模块；只在运行时为模块视图建立的作用域内存在，宿主根 Provider 不设置。 */
  readonly moduleId?: string;
  /** 本 realm 装配的全部 slot 贡献；由宿主按能力与角色过滤后提供。 */
  readonly contributions: readonly SlotContribution[];
  /** 宿主提供的纯展示偏好端口，作用域是设备或玩家。 */
  readonly preferences: PreferencePort;
  /** 可选：贡献渲染失败时的上报入口。 */
  readonly reportContributionError?: ContributionErrorReporter;
}

export interface ModuleHostProviderProps {
  readonly value: ModuleHostValue;
  readonly children?: ReactNode;
}

const ModuleHostContext = createContext<ModuleHostValue | null>(null);

/** 宿主装配根提供唯一一份模块上下文；模块不能自行创建第二份宿主或全局 store。 */
export function ModuleHostProvider({ value, children }: ModuleHostProviderProps): ReactNode {
  return <ModuleHostContext.Provider value={value}>{children}</ModuleHostContext.Provider>;
}

/** 读取宿主上下文；缺失时抛装配错误，不返回空对象冒充宿主。 */
export function useModuleHost(): ModuleHostValue {
  const value = useContext(ModuleHostContext);
  if (value === null) {
    throw new DomainError(
      "assembly-incompatible",
      "浏览器模块上下文缺失：模块视图必须在宿主 Provider 内渲染",
    );
  }
  return value;
}

/**
 * 运行时为单个模块的视图建立作用域：沿用外层宿主的贡献、偏好与上报入口，
 * 但 ports 换成该模块声明的端口，并记下模块 ID 供取用失败时定位。
 */
export function ModulePortScope({
  moduleId,
  ports,
  children,
}: {
  readonly moduleId: string;
  readonly ports: Readonly<Record<string, unknown>>;
  readonly children?: ReactNode;
}): ReactNode {
  const host = useModuleHost();
  const value = useMemo(() => ({ ...host, ports, moduleId }), [host, ports, moduleId]);
  return <ModuleHostContext.Provider value={value}>{children}</ModuleHostContext.Provider>;
}

/**
 * 按 capability ID 读取宿主已绑定的 port。
 * 模块视图取用自己未声明的能力时抛装配错误并指出模块：requires 才是模块可用端口的契约，
 * 否则替换装配后要到渲染期才发现依赖缺失。未注册时同样抛装配错误，不返回空实现、代理对象或静默降级结果。
 */
export function usePort<TPort>(capabilityId: string): TPort {
  const { ports, moduleId } = useModuleHost();
  if (moduleId !== undefined && !Object.prototype.hasOwnProperty.call(ports, capabilityId)) {
    throw new DomainError(
      "assembly-incompatible",
      `模块 ${moduleId} 未声明能力 ${capabilityId}：只能取用 requires 声明的能力、自身提供的能力与本 realm 宿主固定端口`,
      { details: { moduleId, capability: capabilityId } },
    );
  }
  const port = ports[capabilityId];
  if (port === undefined) {
    throw new DomainError("assembly-incompatible", `能力 ${capabilityId} 的 port 未注册`, {
      details: { capability: capabilityId },
    });
  }
  return port as TPort;
}

/** 读取宿主提供的纯展示偏好端口；偏好不进入运行清单，也不改变世界规则。 */
export function usePreferencePort(): PreferencePort {
  return useModuleHost().preferences;
}

/** 订阅模块提供的只读外部状态；getSnapshot 必须返回稳定引用。 */
export function usePortSubscription<T>(
  capabilityId: string,
): T {
  const port = usePort<{
    subscribe(listener: (value: T) => void): () => void;
    getSnapshot(): T;
  }>(capabilityId);
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot);
}
