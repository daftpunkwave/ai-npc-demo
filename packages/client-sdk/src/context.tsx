/**
 * 提供浏览器模块宿主的 React context：已绑定 port、slot 贡献、纯展示偏好与贡献失败上报入口。
 * 依赖公共契约的能力/贡献语义、React context 与本包的偏好与 slot 类型；不创建网络、存储或服务端对象。
 * 禁止伪造未注册 port，也禁止把世界权威状态、运营权限或凭据放进 context。
 */
import { DomainError } from "@ai-npc/contracts";
import { createContext, useContext, type ReactNode } from "react";
import type { PreferencePort } from "./preferences";
import type { SlotContribution } from "./slots";

/** 单个贡献渲染失败的上报入口；宿主据此记录 trace 或显示原因，不在 SDK 内静默吞掉。 */
export type ContributionErrorReporter = (error: unknown, contribution: SlotContribution) => void;

/** 浏览器宿主向模块提供的受控上下文值。 */
export interface ModuleHostValue {
  /** 按 capability ID 绑定的 port；只含本 realm 已解析的 requires 与宿主固定端口。 */
  readonly ports: Readonly<Record<string, unknown>>;
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
 * 按 capability ID 读取宿主已绑定的 port。
 * 未注册时抛装配错误，不返回空实现、代理对象或静默降级结果。
 */
export function usePort<TPort>(capabilityId: string): TPort {
  const { ports } = useModuleHost();
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
