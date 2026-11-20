/**
 * 解析部署配置与登录凭据：加载项目根 .env、校验双端固定拓扑、生成并持久化启动令牌。
 * 依赖 Node 进程环境、文件系统与 crypto；不启动宿主、不监听端口。
 * 禁止读取旧式 PORT/HOST/DATA_DIR，禁止接受非回环主机或约定之外的端口。
 */
/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- 只按约定的环境变量名与数据目录内固定文件名读取，路径已由配置解析与目录检查限制。 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 类型与回调参数名用于表达调用契约。 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 双端拓扑固定的服务端监听地址。 */
export const fixedServerHost = "127.0.0.1";
/** 双端拓扑固定的服务端端口。 */
export const fixedServerPort = 3000;
/** 双端拓扑固定的客户端端口。 */
export const fixedClientPort = 5173;
/** 自动生成令牌的持久化文件名，位于数据目录下。 */
export const credentialsFileName = "dev-tokens.json";

const defaultDataDir = "./data";
const defaultAssemblyRef = "local-slg-standard-v1";
const defaultModelLayoutRef = "shared-model-layout-v1";
const defaultRosterRef = "standard-20";
const credentialsFileVersion = 1;

/** 启动令牌对应的身份；单角色令牌只发放对应控制台角色。 */
export type TokenRole = "player" | "console" | "operator" | "researcher" | "evaluator";

/** 全部启动令牌角色，按冲突预检与输出顺序排列。 */
const tokenRoles: readonly TokenRole[] = ["player", "console", "operator", "researcher", "evaluator"];

/** 缺省时自动生成并持久化的主令牌；单角色令牌只取配置值。 */
const generatedTokenRoles: readonly TokenRole[] = ["player", "console"];

/** 各令牌来源的环境变量名。 */
export const tokenEnvNames: Readonly<Record<TokenRole, string>> = {
  player: "NPC_PLAYER_TOKEN",
  console: "NPC_CONSOLE_TOKEN",
  operator: "NPC_OPERATOR_TOKEN",
  researcher: "NPC_RESEARCHER_TOKEN",
  evaluator: "NPC_EVALUATOR_TOKEN",
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
  readonly assemblyRef: string;
  readonly modelLayoutRef: string;
  readonly rosterRef: string;
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
  const host = readText(input.env, "NPC_SERVER_HOST") ?? fixedServerHost;
  if (host !== fixedServerHost) {
    throw new Error(`NPC_SERVER_HOST 必须是 ${fixedServerHost}（只允许回环监听），收到 "${host}"`);
  }
  const serverPort = readFixedPort(input.env, "NPC_SERVER_PORT", fixedServerPort);
  const clientPort = readFixedPort(input.env, "NPC_CLIENT_PORT", fixedClientPort);
  const dataDirValue = readText(input.env, "NPC_DATA_DIR") ?? defaultDataDir;
  const dataDir = isAbsolute(dataDirValue) ? resolve(dataDirValue) : resolve(input.projectRoot, dataDirValue);
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
    assemblyRef: readText(input.env, "NPC_ASSEMBLY") ?? defaultAssemblyRef,
    modelLayoutRef: readText(input.env, "NPC_MODEL_LAYOUT") ?? defaultModelLayoutRef,
    rosterRef: readText(input.env, "NPC_ROSTER") ?? defaultRosterRef,
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

function persistCredentials(
  filePath: string,
  tokens: Partial<Record<TokenRole, string>>,
  existing: Partial<Record<TokenRole, string>>,
): void {
  if (sameStoredTokens(tokens, existing)) {
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const record: Record<string, string | number> = { version: credentialsFileVersion };
  for (const role of generatedTokenRoles) {
    const credential = tokens[role];
    if (typeof credential === "string") {
      record[`${role}Token`] = credential;
    }
  }
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows 对 POSIX 权限位支持有限，收紧失败时保留文件系统默认 ACL。
  }
}

/**
 * 解析实际生效的令牌：配置值优先，其次凭据文件，最后由本次启动生成并写入。
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
 * 把本次解析出的生成令牌写入凭据文件；调用方在成功输出登录地址之后再调用，
 * 避免启动失败时令牌已落盘却从未展示。
 */
export function persistResolvedCredentials(config: DeploymentConfig, credentials: ResolvedCredentials): void {
  const stored = readStoredCredentials(credentials.filePath);
  const persistable: Partial<Record<TokenRole, string>> = {};
  for (const role of generatedTokenRoles) {
    if (config.configuredTokens[role] === undefined) {
      persistable[role] = credentials.tokens[role];
    }
  }
  persistCredentials(credentials.filePath, persistable, stored);
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
  const lines: string[] = [`[ai-npc] server ready: ${links.server}`];
  if (input.generated.includes("player")) {
    lines.push(`[ai-npc] player  login: ${links.player}#token=${encodeURIComponent(input.tokens.player)}`);
  }
  if (input.generated.includes("console")) {
    lines.push(`[ai-npc] console login: ${links.console}#token=${encodeURIComponent(input.tokens.console)}`);
  }
  return lines;
}
