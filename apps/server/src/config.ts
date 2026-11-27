/**
 * 解析部署配置与登录凭据：加载项目根 .env、校验双端固定拓扑、生成并原子持久化启动令牌。
 * 依赖 Node 进程环境、文件系统与 crypto；不启动宿主、不监听端口。
 * 禁止读取旧式 PORT/HOST/DATA_DIR，禁止接受非回环主机或约定之外的端口，禁止用非原子写入覆盖凭据文件。
 */
/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- 只按约定的环境变量名与数据目录内固定文件名读取，路径已由配置解析与目录检查限制。 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 类型与回调参数名用于表达调用契约。 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultModelLayoutRefFor, deploymentDefaults } from "./deployment-defaults";

/** 双端拓扑固定的服务端监听地址。 */
export const fixedServerHost = "127.0.0.1";
/** 双端拓扑固定的服务端端口。 */
export const fixedServerPort = 3000;
/** 双端拓扑固定的客户端端口。 */
export const fixedClientPort = 5173;
/** 控制台构建产物相对仓库根的固定位置，与 apps/console/vite.config.ts 的 outDir 指向同一目录。 */
export const consoleStaticDirRelativeToRoot = "apps/server/console-static";
/** 自动生成令牌的持久化文件名，位于数据目录下。 */
export const credentialsFileName = "dev-tokens.json";

const defaultDataDir = "./data";
const credentialsFileVersion = 1;

/** 启动令牌对应的身份；单角色令牌只发放对应控制台角色。 */
export type TokenRole = "player" | "console" | "operator" | "researcher" | "evaluator";

/** 全部启动令牌角色，按冲突预检与输出顺序排列。 */
const tokenRoles: readonly TokenRole[] = ["player", "console", "operator", "researcher", "evaluator"];

/** 缺省时自动生成并持久化的主令牌；单角色令牌只取配置值。 */
const generatedTokenRoles: readonly TokenRole[] = ["player", "console"];

/** 各令牌来源的环境变量名。 */
export const tokenEnvNames: Readonly<Record<TokenRole, string>> = {
  player: "WORLD_PRISM_PLAYER_TOKEN",
  console: "WORLD_PRISM_CONSOLE_TOKEN",
  operator: "WORLD_PRISM_OPERATOR_TOKEN",
  researcher: "WORLD_PRISM_RESEARCHER_TOKEN",
  evaluator: "WORLD_PRISM_EVALUATOR_TOKEN",
};

/** 一次部署的固定拓扑、数据目录、运行时选择与已配置令牌。 */
export interface DeploymentConfig {
  /** 项目根目录；`.env` 与相对数据目录都以它为基准。 */
  readonly projectRoot: string;
  readonly serverHost: string;
  readonly serverPort: number;
  readonly clientPort: number;
  /** 已按项目根解析为绝对路径的数据目录。 */
  readonly dataDir: string;
  /**
   * 已按项目根解析为绝对路径的控制台静态产物目录。
   * 默认取仓库内的构建输出位置，不按进程工作目录派生：部署参数只认环境变量与项目根，
   * 从仓库根以外的工作目录启动服务端时行为必须一致。
   */
  readonly consoleStaticDir: string;
  readonly assemblyRef: string;
  readonly modelLayoutRef: string;
  readonly rosterRef: string;
  /** 在线 run 能力闭包升级时的显式迁移开关；缺省关闭，拒绝启动并给出迁移指引。 */
  readonly migrateOnlineRun: boolean;
  /** 只包含非空的已配置令牌；缺省令牌在解析凭据时生成。 */
  readonly configuredTokens: Partial<Record<TokenRole, string>>;
}

/** 解析部署配置所需的原始输入。 */
export interface DeploymentConfigInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly projectRoot: string;
}

/** 令牌及其来源说明，用于重复冲突的错误信息。 */
export interface NamedToken {
  readonly label: string;
  /** 令牌值；未配置时为空。字段名用 credential 表达凭据值，语义仍是启动令牌。 */
  readonly credential: string | undefined;
}

/** 启动时刻可用的全部令牌；单角色令牌未配置时缺省。 */
export interface RoleTokens {
  readonly player: string;
  readonly console: string;
  readonly operator?: string;
  readonly researcher?: string;
  readonly evaluator?: string;
}

/** 解析结果：令牌、本次新生成的角色与凭据文件位置。 */
export interface ResolvedCredentials {
  readonly tokens: RoleTokens;
  readonly generated: readonly TokenRole[];
  readonly filePath: string;
}

/** 启动日志里展示的入口地址；绝不包含令牌。 */
export interface LoginLinks {
  readonly server: string;
  readonly player: string;
  readonly console: string;
}

/** 启动日志输入：配置、令牌与本次新生成的角色。 */
export interface StartupLogInput {
  readonly config: Pick<DeploymentConfig, "serverHost" | "serverPort" | "clientPort">;
  readonly tokens: RoleTokens;
  readonly generated: readonly TokenRole[];
}

function readText(env: DeploymentConfigInput["env"], name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  return value === "" ? undefined : value;
}

function readFixedPort(env: DeploymentConfigInput["env"], name: string, expected: number): number {
  const raw = readText(env, name);
  if (raw === undefined) {
    return expected;
  }
  if (!/^\d+$/.test(raw) || Number(raw) !== expected) {
    throw new Error(`${name} 必须是 ${expected}（双端拓扑固定，不换端口），收到 "${raw}"`);
  }
  return expected;
}

/** 解析布尔开关；只接受约定取值，其余非空值报错，避免手误后静默按关闭执行。 */
function readBooleanFlag(env: DeploymentConfigInput["env"], name: string): boolean {
  const raw = readText(env, name);
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  throw new Error(`${name} 只接受 1/true 或 0/false（不区分大小写），收到 "${raw}"`);
}

/**
 * 校验任意两个非空令牌都不同。
 * 重复时指出具体来源，避免传输层按 Map 覆盖身份后静默降级为后一个角色。
 */
export function assertDistinctTokens(entries: readonly NamedToken[]): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const credential = entry.credential?.trim() ?? "";
    if (credential.length === 0) {
      continue;
    }
    const previous = seen.get(credential);
    if (previous !== undefined) {
      throw new Error(`登录令牌重复：${previous} 与 ${entry.label} 相同；玩家、控制台与单角色令牌必须互不相同`);
    }
    seen.set(credential, entry.label);
  }
}

/** 解析部署配置；只接受固定主机、固定双端口与约定的运行时选择。 */
export function parseDeploymentConfig(input: DeploymentConfigInput): DeploymentConfig {
  const host = readText(input.env, "WORLD_PRISM_SERVER_HOST") ?? fixedServerHost;
  if (host !== fixedServerHost) {
    throw new Error(`WORLD_PRISM_SERVER_HOST 必须是 ${fixedServerHost}（只允许回环监听），收到 "${host}"`);
  }
  const serverPort = readFixedPort(input.env, "WORLD_PRISM_SERVER_PORT", fixedServerPort);
  const clientPort = readFixedPort(input.env, "WORLD_PRISM_CLIENT_PORT", fixedClientPort);
  const dataDirValue = readText(input.env, "WORLD_PRISM_DATA_DIR") ?? defaultDataDir;
  const dataDir = isAbsolute(dataDirValue) ? resolve(dataDirValue) : resolve(input.projectRoot, dataDirValue);
  // 控制台静态目录与数据目录同一条规则：相对量一律按项目根解析，绝不按 process.cwd()。
  const consoleStaticDirValue = readText(input.env, "WORLD_PRISM_CONSOLE_STATIC_DIR") ?? consoleStaticDirRelativeToRoot;
  const consoleStaticDir = isAbsolute(consoleStaticDirValue)
    ? resolve(consoleStaticDirValue)
    : resolve(input.projectRoot, consoleStaticDirValue);
  const assemblyRef = readText(input.env, "WORLD_PRISM_ASSEMBLY") ?? deploymentDefaults.assemblyRef;
  const configuredTokens: Partial<Record<TokenRole, string>> = {};
  for (const role of tokenRoles) {
    const credential = readText(input.env, tokenEnvNames[role]);
    if (typeof credential === "string") {
      configuredTokens[role] = credential;
    }
  }
  assertDistinctTokens(tokenRoles.map((role) => ({
    label: tokenEnvNames[role],
    credential: configuredTokens[role],
  })));
  return {
    projectRoot: input.projectRoot,
    serverHost: host,
    serverPort,
    clientPort,
    dataDir,
    consoleStaticDir,
    assemblyRef,
    modelLayoutRef: readText(input.env, "WORLD_PRISM_MODEL_LAYOUT") ?? defaultModelLayoutRefFor(assemblyRef),
    rosterRef: readText(input.env, "WORLD_PRISM_ROSTER") ?? deploymentDefaults.rosterRef,
    migrateOnlineRun: readBooleanFlag(input.env, "WORLD_PRISM_MIGRATE_ONLINE_RUN"),
    configuredTokens,
  };
}

/** 读取环境文件并并入进程环境；文件不存在时跳过。 */
export function loadEnvFileIfPresent(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }
  try {
    process.loadEnvFile(file);
  } catch (error) {
    throw new Error(`读取环境文件失败：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  return true;
}

/** 加载项目根 `.env` 后解析部署配置；进程环境中的同名变量优先。 */
export function loadDeploymentConfig(options: { readonly projectRoot?: string } = {}): DeploymentConfig {
  const projectRoot = options.projectRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  loadEnvFileIfPresent(join(projectRoot, ".env"));
  return parseDeploymentConfig({ env: process.env, projectRoot });
}

function readStoredCredentials(filePath: string): Partial<Record<TokenRole, string>> {
  if (!existsSync(filePath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`凭据文件不是合法 JSON：${filePath}；删除该文件可重新生成令牌`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`凭据文件不是对象：${filePath}`);
  }
  const record = parsed as Record<string, unknown>;
  const tokens: Partial<Record<TokenRole, string>> = {};
  for (const role of generatedTokenRoles) {
    const key = `${role}Token`;
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`凭据文件字段 ${key} 必须是非空字符串：${filePath}`);
    }
    tokens[role] = value.trim();
  }
  return tokens;
}

function sameStoredTokens(
  left: Partial<Record<TokenRole, string>>,
  right: Partial<Record<TokenRole, string>>,
): boolean {
  return generatedTokenRoles.every((role) => left[role] === right[role]);
}

/** 凭据写入暂存句柄：暂存文件已落盘，由调用方决定原子发布或丢弃。 */
export interface StagedCredentialsFile {
  /** 把暂存文件原子改名为正式凭据文件；失败时清理暂存文件并抛出。 */
  publish(): void;
  /** 丢弃暂存文件；返回清理失败原因，没有需要清理的文件时返回 null。 */
  discard(): string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 删除暂存文件；文件已不存在视为已清理，其余失败返回原因供调用方记录。 */
function removeStagingFile(stagingPath: string): string | null {
  try {
    unlinkSync(stagingPath);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : errorMessage(error);
  }
}

function credentialsFileContents(tokens: Partial<Record<TokenRole, string>>): string {
  const record: Record<string, string | number> = { version: credentialsFileVersion };
  for (const role of generatedTokenRoles) {
    const credential = tokens[role];
    if (typeof credential === "string") {
      record[`${role}Token`] = credential;
    }
  }
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * 把令牌写入数据目录内的暂存文件并刷新到磁盘，暂不在正式名称下可见。
 * 暂存文件以排他模式创建并显式请求 0600；数据目录无论新建还是已存在都收紧为 0700，
 * Windows 的权限位语义受限，该收紧在其上只调整写位。
 */
function stageCredentials(
  filePath: string,
  tokens: Partial<Record<TokenRole, string>>,
  existing: Partial<Record<TokenRole, string>>,
): StagedCredentialsFile | null {
  const directory = dirname(filePath);
  // mkdir 的 mode 只作用于本次新建的目录；数据目录可能由用户或旧版本预先创建，
  // 这里对新建与已存在两种情况统一显式收紧为 0700，与备份暂存目录保持同一口径，
  // 避免宽权限目录向本机其他用户暴露凭据文件名与轮换节奏。
  // 收紧必须发生在令牌未变化的提前返回之前，保证每次启动都生效，而不只在令牌轮换时生效。
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (sameStoredTokens(tokens, existing)) {
    return null;
  }
  const stagingPath = `${filePath}.${randomBytes(6).toString("hex")}.staging`;
  let handle: number | undefined;
  try {
    handle = openSync(stagingPath, "wx", 0o600);
    writeFileSync(handle, credentialsFileContents(tokens), "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
  } catch (error) {
    const cleanupErrors: string[] = [];
    // 只在已成功创建暂存文件时清理，避免把同名但非本次创建的残留文件当作自己的暂存文件删除。
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch (closeError) {
        cleanupErrors.push(`关闭暂存文件失败：${errorMessage(closeError)}`);
      }
      const unlinkError = removeStagingFile(stagingPath);
      if (unlinkError !== null) {
        cleanupErrors.push(`删除暂存文件失败：${unlinkError}`);
      }
    }
    const cleanupSuffix = cleanupErrors.length === 0 ? "" : `；${cleanupErrors.join("；")}`;
    throw new Error(`写入凭据文件失败：${filePath}（${errorMessage(error)}）${cleanupSuffix}`, { cause: error });
  }
  let published = false;
  return {
    publish: () => {
      try {
        renameSync(stagingPath, filePath);
        published = true;
      } catch (error) {
        const unlinkError = removeStagingFile(stagingPath);
        const cleanupSuffix = unlinkError === null ? "" : `；删除暂存文件失败：${unlinkError}`;
        throw new Error(`发布凭据文件失败：${filePath}（${errorMessage(error)}）${cleanupSuffix}`, { cause: error });
      }
    },
    // 发布后暂存文件已不存在；重复丢弃不再报错，避免失败路径二次掩盖原始错误。
    discard: () => (published ? null : removeStagingFile(stagingPath)),
  };
}

/**
 * 解析实际生效的令牌：配置值优先，其次凭据文件，最后由本次启动生成（默认立即原子写入）。
 * 只有本次生成的角色进入 generated，供调用方决定是否打印带令牌的登录地址。
 */
export function resolveCredentials(
  config: DeploymentConfig,
  options: { readonly generate?: (role: TokenRole) => string; readonly persist?: boolean } = {},
): ResolvedCredentials {
  const generate = options.generate ?? (() => randomBytes(32).toString("base64url"));
  const filePath = join(config.dataDir, credentialsFileName);
  const stored = readStoredCredentials(filePath);
  const resolved: Partial<Record<TokenRole, string>> = {};
  const generated: TokenRole[] = [];
  for (const role of generatedTokenRoles) {
    const configured = config.configuredTokens[role];
    if (configured !== undefined) {
      resolved[role] = configured;
      continue;
    }
    const persisted = stored[role];
    if (persisted !== undefined) {
      resolved[role] = persisted;
      continue;
    }
    resolved[role] = generate(role);
    generated.push(role);
  }
  for (const role of tokenRoles) {
    if (role === "player" || role === "console") {
      continue;
    }
    const configured = config.configuredTokens[role];
    if (configured !== undefined) {
      resolved[role] = configured;
    }
  }
  assertDistinctTokens(tokenRoles.map((role) => ({
    label: config.configuredTokens[role] === undefined ? `credentials.${role}Token` : tokenEnvNames[role],
    credential: resolved[role],
  })));
  const player = resolved.player;
  const consoleToken = resolved.console;
  if (player === undefined || consoleToken === undefined) {
    throw new Error("未能解析玩家或控制台令牌");
  }
  const credentials: ResolvedCredentials = {
    tokens: {
      player,
      console: consoleToken,
      ...(resolved.operator === undefined ? {} : { operator: resolved.operator }),
      ...(resolved.researcher === undefined ? {} : { researcher: resolved.researcher }),
      ...(resolved.evaluator === undefined ? {} : { evaluator: resolved.evaluator }),
    },
    generated,
    filePath,
  };
  if (options.persist !== false) {
    persistResolvedCredentials(config, credentials);
  }
  return credentials;
}

/**
 * 暂存本次解析出的生成令牌：写入同目录暂存文件并刷新到磁盘，但不发布正式名称。
 * 启动编排在监听成功并输出登录地址之后才调用 publish，监听失败时调用 discard，
 * 从而同时满足“写入失败不监听”和“令牌已落盘却从未展示”。
 */
export function stageResolvedCredentials(
  config: DeploymentConfig,
  credentials: ResolvedCredentials,
): StagedCredentialsFile | null {
  const stored = readStoredCredentials(credentials.filePath);
  const persistable: Partial<Record<TokenRole, string>> = {};
  for (const role of generatedTokenRoles) {
    if (config.configuredTokens[role] === undefined) {
      persistable[role] = credentials.tokens[role];
    }
  }
  return stageCredentials(credentials.filePath, persistable, stored);
}

/** 立即原子写入本次解析出的生成令牌；需要先监听再发布时改用 stageResolvedCredentials。 */
export function persistResolvedCredentials(config: DeploymentConfig, credentials: ResolvedCredentials): void {
  stageResolvedCredentials(config, credentials)?.publish();
}

/** 玩家地址走客户端端口，控制台地址走服务端端口；两者都不指向错误端口。 */
export function loginLinks(
  config: Pick<DeploymentConfig, "serverHost" | "serverPort" | "clientPort">,
): LoginLinks {
  const server = `http://${config.serverHost}:${config.serverPort}`;
  return {
    server,
    player: `http://${config.serverHost}:${config.clientPort}/`,
    console: `${server}/console/`,
  };
}

/** 生成启动日志：总是输出就绪地址，只有本次新生成的令牌才附带登录地址。 */
export function startupLogLines(input: StartupLogInput): readonly string[] {
  const links = loginLinks(input.config);
  const lines: string[] = [`[world-prism] server ready: ${links.server}`];
  if (input.generated.includes("player")) {
    lines.push(`[world-prism] player  login: ${links.player}#token=${encodeURIComponent(input.tokens.player)}`);
  }
  if (input.generated.includes("console")) {
    lines.push(`[world-prism] console login: ${links.console}#token=${encodeURIComponent(input.tokens.console)}`);
  }
  return lines;
}
