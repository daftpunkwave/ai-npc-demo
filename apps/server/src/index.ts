/**
 * 汇总服务端宿主公开入口；传输应用由 transport provider 提供。
 * 不启动服务、不打开存储。
 */
export { createServerApp, resolveGameModuleBindings } from "./host/module-catalog";
export type { GameModuleBindings, GameModulePublicPort } from "./host/game-port-binder";
export { checkModuleCapabilityUsage } from "./host/module-capability-usage";
export type { CapabilityUsageViolation } from "./host/module-capability-usage";
export { checkCatalog, runCatalogCheckCli } from "./host/catalog-check";
export type {
  CatalogCheckOptions,
  CatalogCheckReport,
  CatalogCliOptions,
  CatalogViolation,
} from "./host/catalog-check";
export { filterPlan, loadAssembly, resolveServerAssembly, resolveSessionAssemblies, resolveServerModules } from "./host/assembly";
export type { ResolvedServerAssembly, ResolveServerAssemblyOptions } from "./host/assembly";
export { buildRunManifest, readFrozenManifest } from "./host/manifest";
export type {
  BuiltRunManifest,
  BuildRunManifestInput,
  FrozenManifestFacts,
  RunManifest,
  RunManifestModule,
  RunManifestSelection,
} from "./host/manifest";
export { generateRunSeed, rngFor } from "./host/random";
export { canonicalHasher } from "./host-services";
export {
  clockConfigOf,
  createSaveService,
  createServerRuntime,
  plannedModuleForCapability,
  serverRequiredCapabilities,
} from "./host/module-catalog";
export type { OperationsFactory, ServerRuntime } from "./host/module-catalog";
export type {
  AuthorityPort,
  CommandReceiptReadPort,
  ConversationReadPort,
  ServerApp,
  ServerAppInjectResponse,
  ServerAppOptions,
  ServerIdentity,
} from "./host/module-catalog";
export { buildPlayerProjection } from "./projection";
export { advanceWorldTick, catchUpWorldTick } from "./tick";
export { createLifecycle } from "./host/lifecycle";
export type { HostLifecycle, LifecycleInput } from "./host/lifecycle";
export type {
  AdvanceWorldTickInput,
  TickAuthority,
  TickClockPort,
  WorldTickContext,
  WorldTickResult,
} from "./tick";
export { disposeInReverse, startHost } from "./host";
export type { DisposalStep, HostOptions, RunningHost } from "./host";
export { createTransportApp } from "./host/transport-app";
export type { TransportAppInput } from "./host/transport-app";
export {
  assertDistinctTokens,
  credentialsFileName,
  fixedClientPort,
  fixedServerHost,
  fixedServerPort,
  loadDeploymentConfig,
  loadEnvFileIfPresent,
  loginLinks,
  parseDeploymentConfig,
  persistResolvedCredentials,
  resolveCredentials,
  startupLogLines,
  tokenEnvNames,
} from "./config";
export type {
  DeploymentConfig,
  DeploymentConfigInput,
  LoginLinks,
  NamedToken,
  ResolvedCredentials,
  RoleTokens,
  StartupLogInput,
  TokenRole,
} from "./config";
export {
  allModuleDefinitions,
  browserModuleDefinitions,
  clientRequiredCapabilities,
  serverModuleDefinitions,
} from "./host/module-catalog";
