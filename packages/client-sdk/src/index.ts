/**
 * 汇总浏览器模块作者辅助：宿主 context、slot 组件、port 查找 hook 与纯展示偏好端口。
 * 依赖本包 context、slot、preferences 的导出与契约类型；不执行服务端规则或直接访问后端。
 * 禁止在此创建 Node 资源、伪造未注册 port 或绕过授权投影读取世界状态。
 */
export const packageName = "@world-prism/client-sdk";

export {
  ModuleHostProvider,
  useModuleHost,
  usePort,
  usePortSubscription,
  usePreferencePort,
} from "./context";
export type {
  ContributionErrorReporter,
  ModuleHostProviderProps,
  ModuleHostValue,
} from "./context";

export { ContributionBoundary, Slot } from "./slot";
export type { ContributionBoundaryProps, ContributionBoundaryState, SlotProps } from "./slot";

export { selectSlotContributions } from "./slots";
export type { SlotContribution } from "./slots";

export { isPreferenceKey, preferenceKeys } from "./preferences";
export type { PreferenceKey, PreferencePort, PreferenceValues } from "./preferences";

export { memoryPreferencePort, startBrowserModules } from "./runtime";
export type {
  BrowserModuleRuntimeInput,
  BrowserViewPort,
  StartedBrowserModules,
} from "./runtime";

export {
  defineBrowserModule,
  defineBrowserModuleDefinition,
} from "./define-browser-module";
export type { BrowserModuleDefinitionInput } from "./define-browser-module";
