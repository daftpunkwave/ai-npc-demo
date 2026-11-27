/**
 * realm 无关的宿主机制：模块描述符校验、实例注册表、装配与能力图解析、配置与 profile 合并、摘要计算、生命周期与 slot 排序。
 * 只依赖公共契约与通用运行机制，不承担具体游戏、Agent 或 UI 策略。
 * 禁止 import modules、apps、游戏内容、供应商 SDK、Node/DOM 专有 API 或具体浏览器实现。
 */
export const packageName = "@world-prism/kernel";

export { validateModuleDefinition } from "./descriptor-validation";
export { REALM_NAMESPACES } from "./descriptor-constraints";

export { createModuleRegistry } from "./registry";
export type { CatalogSnapshot, ModuleRegistry } from "./registry";

export { resolveModuleConfig } from "./resolve-config";

export { orderSlotContributions } from "./slots";

export {
  profileDocumentSchema,
  profileKindSchema,
  profileSlotSchema,
  resolveProfile,
} from "./resolve-profile";
export type {
  ProfileDocument,
  ProfileKind,
  ProfileSlot,
  ResolveProfileInput,
  ResolvedProfile,
} from "./resolve-profile";

export { isInstanceScopeCompatible } from "./capability-requirements";
export type { PortProviderRef, ResolvedRequirement } from "./capability-requirements";

export { resolveRealmPlan } from "./resolve-assembly";
export type { PlannedModule, ResolvedRealmPlan, ResolveRealmInput } from "./resolve-assembly";

export { computeAssemblyHash, computeCatalogHash, computeConfigHash } from "./manifest";
export type { CanonicalHasher, ComputeAssemblyHashInput } from "./manifest";

export { startInstances } from "./lifecycle";
export type { RunningInstance, StartInstancesOptions, StartedInstances } from "./lifecycle";
