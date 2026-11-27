/**
 * 核心职责：汇总服务端宿主公开入口。
 * 交互契约：只导出宿主、配置与类型；传输应用由 transport provider 提供。
 * 约束与禁忌：不启动服务、不打开存储、不监听端口。
 */
export { createServerApp, resolveGameModuleBindings } from "./host/module-catalog";
export { defaultModelLayoutRefFor, deploymentDefaults } from "./deployment-defaults";
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
export { buildRunManifest, readFrozenManifest, rosterAgentKindsOf } from "./host/manifest";
export { createObservabilitySources } from "./host/observability-sources";
export type { ObservabilitySourcesInput } from "./host/observability-sources";
export {
  assertMigrationScopeIsCapabilityClosure,
  migrateOnlineRun,
  migrationSummary,
  OnlineRunMigrationRequiredError,
  restoreOnlineAliasToSourceBranch,
} from "./host/run-migration";
export type { MigrateOnlineRunInput, MigratedOnlineRun } from "./host/run-migration";
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
export { advanceSteppingTick, advanceWorldTick, catchUpWorldTick } from "./tick";
export { createLifecycle } from "./host/lifecycle";
export type { HostLifecycle, LifecycleInput } from "./host/lifecycle";
export type {
  AdvanceSteppingInput,
  AdvanceWorldTickInput,
  SteppingClockPort,
  SteppingTickResult,
  TickAuthority,
  TickClockPort,
  WorldTickContext,
  WorldTickResult,
} from "./tick";
export { disposeInReverse, disposeWithin, drainBeforeClose, settleWithin, startHost } from "./host";
export type { DrainFailure, DrainStep, DisposalStep, HostOptions, RunningHost } from "./host";
export { startServer } from "./startup";
export type { StartServerOptions, StartupHost } from "./startup";
export { createShutdownHandler, shutdownServer } from "./shutdown";
export type { ShutdownInput } from "./shutdown";
export { createProcessFaultHandlers, faultExitCode, installProcessFaultHandlers } from "./process-faults";
export type { ProcessFaultHandlersInput, ProcessFaultReport } from "./process-faults";
export { OperationJournal, operationRequestHash } from "./host/operation-journal";
export type { OperationKey, OperationKind, OperationOutcome } from "./host/operation-journal";
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
