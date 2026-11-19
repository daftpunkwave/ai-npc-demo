/**
 * 汇总服务端宿主公开入口；传输应用由 transport provider 提供。
 * 不启动服务、不打开存储。
 */
export { createServerApp } from "./host/module-catalog";
export { loadAssembly, resolveServerAssembly, resolveServerModules } from "./host/assembly";
export type { ResolvedServerAssembly } from "./host/assembly";
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
  createGameContributorsFromAssembly,
  createGamePortsFromAssembly,
  createModuleBinderFromAssembly,
  createSaveService,
} from "./host/module-catalog";
export type { AuthorityPort, ServerApp, ServerAppOptions, ServerIdentity } from "./host/module-catalog";
export { buildPlayerProjection } from "./projection";
export { advanceWorldTick, catchUpWorldTick } from "./tick";
export type {
  AdvanceWorldTickInput,
  TickAuthority,
  WorldTickContext,
  WorldTickResult,
} from "./tick";
export { startHost } from "./host";
export type { HostOptions, RunningHost } from "./host";
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
export { serverModuleDefinitions } from "./host/module-catalog";
