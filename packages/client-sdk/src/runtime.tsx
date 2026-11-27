/**
 * 按服务端返回的浏览器装配校验本地模块目录（协议、版本、realm 与远端能力）与下发配置（configHash 与 configSchema），
 * 并依能力依赖创建、启动与释放模块实例；每个模块的创建输入与视图只拿到宿主固定端口和自己声明的能力端口。
 * 依赖公共模块描述符、kernel 的远端能力对账与配置摘要、React 视图贡献与本包宿主上下文；不加载装配外模块或共享服务端对象。
 * 禁止在版本不匹配时静默降级，也禁止忽略 slot 贡献失败或遗留网络订阅。
 */
import {
  DomainError,
  canonicalJson,
  isSupportedProtocolVersion,
  type HostServices,
  type Json,
  type ModuleDefinition,
  type ModuleInstance,
  type ResolvedModuleSet,
} from "@world-prism/contracts";
import { assertRemoteCapabilities, computeConfigHash } from "@world-prism/kernel";
import type { ReactNode } from "react";
import { ModulePortScope } from "./context";
import { contractedHostPorts, declaredModulePorts } from "./module-ports";
import type { PreferencePort } from "./preferences";
import type { SlotContribution } from "./slots";

export interface BrowserViewPort {
  renderContribution(extensionId: string): ReactNode;
}

export interface BrowserModuleRuntimeInput {
  readonly definitions: readonly ModuleDefinition[];
  readonly resolved: ResolvedModuleSet;
  /** 宿主固定端口；键必须在本 realm 的宿主固定端口契约（BROWSER_HOST_PORTS）内。 */
  readonly fixedPorts?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface StartedBrowserModules {
  readonly ports: Readonly<Record<string, unknown>>;
  readonly contributions: readonly SlotContribution[];
  readonly instances: readonly ModuleInstance[];
  readonly dispose: () => Promise<void>;
}

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function compareModuleIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function randomText(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** 规范 JSON 文本的 SHA-256 十六进制摘要，与服务端 canonicalHasher 同一算法；浏览器只能经 Web Crypto 异步计算。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserHostServices(): HostServices {
  const startedAt = performance.now();
  return {
    ids: (prefix) => `${prefix}-${randomText(12)}`,
    nowIso: () => new Date().toISOString(),
    monotonicMs: () => performance.now() - startedAt,
    sleep: (milliseconds, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }),
    rng: (...seedParts) => {
      let state = [...seedParts.join("\0")].reduce(
        (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
        2166136261,
      );
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
    },
    // 先规范化再取摘要：JSON.stringify 保留插入键序，同一配置会得到与服务端不同的摘要。
    hash: async (value) => sha256Hex(canonicalJson(value)),
    hashText: sha256Hex,
    logger: {
      info: (message, data) => console.info(message, data ?? ""),
      warn: (message, data) => console.warn(message, data ?? ""),
      error: (message, data) => console.error(message, data ?? ""),
    },
    tracer: {
      span: (_name, _attrs, fn) => fn(),
    },
  };
}

function selectedDefinitions(
  definitions: readonly ModuleDefinition[],
  resolved: ResolvedModuleSet,
): readonly ModuleDefinition[] {
  if (!isSupportedProtocolVersion(resolved.protocolVersion)) {
    throw new DomainError(
      "assembly-incompatible",
      `服务端协议版本 ${resolved.protocolVersion} 不受当前客户端支持`,
      { details: { protocolVersion: resolved.protocolVersion, realm: resolved.realm } },
    );
  }
  const catalog = new Map(definitions.map((definition) => [definition.id, definition]));
  const selected: ModuleDefinition[] = [];
  for (const reference of resolved.modules) {
    const definition = catalog.get(reference.moduleId);
    if (definition === undefined) {
      throw new DomainError("module-missing", `浏览器目录缺少装配模块 ${reference.moduleId}`, {
        details: { moduleId: reference.moduleId },
      });
    }
    if (definition.version !== reference.version || definition.apiVersion !== reference.apiVersion) {
      throw new DomainError("assembly-incompatible", `模块 ${reference.moduleId} 的版本与装配不匹配`, {
        details: {
          moduleId: reference.moduleId,
          localVersion: definition.version,
          resolvedVersion: reference.version,
          localApiVersion: definition.apiVersion,
          resolvedApiVersion: reference.apiVersion,
        },
      });
    }
    if (definition.realm !== resolved.realm) {
      throw new DomainError("realm-violation", `模块 ${reference.moduleId} 不属于 ${resolved.realm} realm`);
    }
    selected.push(definition);
  }
  // 本地模块目录的 requiresRemote 以握手下发的远端能力描述为准复核：缺口在加载页面前拒绝，
  // 而不是等页面发出第一个 API 请求才失败。旧载荷没有该描述时按空集处理，声明了远端依赖的模块随之拒绝。
  assertRemoteCapabilities(selected, resolved.remoteCapabilities ?? [], resolved.realm);
  return selected;
}

function dependencyOrder(definitions: readonly ModuleDefinition[]): readonly ModuleDefinition[] {
  const providers = new Map<string, ModuleDefinition[]>();
  for (const definition of definitions) {
    for (const provided of definition.provides) {
      const group = providers.get(provided.capability) ?? [];
      group.push(definition);
      providers.set(provided.capability, group);
    }
  }
  const dependencies = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const requiredModules = new Set<string>();
    for (const requirement of definition.requires) {
      const candidates = providers.get(requirement.capability) ?? [];
      if (candidates.length === 0) {
        throw new DomainError(
          "capability-conflict",
          `模块 ${definition.id} 缺少能力 ${requirement.capability} 的浏览器提供者`,
          { details: { moduleId: definition.id, capability: requirement.capability } },
        );
      }
      if (requirement.cardinality === "exactly-one" && candidates.length > 1) {
        throw new DomainError(
          "capability-conflict",
          `能力 ${requirement.capability} 在浏览器目录中不唯一`,
          {
            details: {
              capability: requirement.capability,
              modules: candidates.map((candidate) => candidate.id),
            },
          },
        );
      }
      for (const candidate of candidates) {
        if (candidate.id !== definition.id) {
          requiredModules.add(candidate.id);
        }
      }
    }
    dependencies.set(definition.id, requiredModules);
  }
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const remaining = new Set(byId.keys());
  const ordered: ModuleDefinition[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => [...(dependencies.get(id) ?? [])].every((dependency) => !remaining.has(dependency)))
      .sort(compareModuleIds);
    if (ready.length === 0) {
      throw new DomainError("assembly-incompatible", "浏览器模块能力依赖存在环", {
        details: { modules: [...remaining] },
      });
    }
    for (const id of ready) {
      const definition = byId.get(id);
      if (definition !== undefined) {
        ordered.push(definition);
      }
      remaining.delete(id);
    }
  }
  return ordered;
}

/** 收集视图贡献；每个贡献在该模块的端口作用域内渲染，视图里的 usePort 只能取到模块声明的端口。 */
function contributedViews(
  definitions: readonly ModuleDefinition[],
  hostPorts: Readonly<Record<string, unknown>>,
  ports: Readonly<Record<string, unknown>>,
): readonly SlotContribution[] {
  const result: SlotContribution[] = [];
  for (const definition of definitions) {
    if (definition.contributions === undefined) {
      continue;
    }
    const port = ports[definition.provides[0]?.capability ?? ""];
    if (!isViewPort(port)) {
      throw new DomainError("assembly-incompatible", `模块 ${definition.id} 未暴露视图贡献入口`);
    }
    const viewPorts = declaredModulePorts(definition, hostPorts, ports, true);
    for (const contribution of definition.contributions) {
      result.push({
        ...contribution,
        render: () => (
          <ModulePortScope moduleId={definition.id} ports={viewPorts}>
            {port.renderContribution(contribution.extensionId)}
          </ModulePortScope>
        ),
      });
    }
  }
  return result;
}

function isViewPort(value: unknown): value is BrowserViewPort {
  return (
    typeof value === "object" &&
    value !== null &&
    "renderContribution" in value &&
    typeof (value as { readonly renderContribution?: unknown }).renderContribution === "function"
  );
}

/** 一个待启动模块及其已核对的启动配置。 */
interface PreparedModule {
  readonly definition: ModuleDefinition;
  readonly config: Json;
}

/**
 * 为每个选中模块准备启动配置：下发配置必须存在、与 configHash 一致并通过 configSchema。
 * 全部核对在创建任何实例之前完成，失败时不留下半启动的模块。
 */
async function prepareModules(
  definitions: readonly ModuleDefinition[],
  resolved: ResolvedModuleSet,
): Promise<readonly PreparedModule[]> {
  const references = new Map(resolved.modules.map((module) => [module.moduleId, module]));
  const prepared: PreparedModule[] = [];
  for (const definition of definitions) {
    // 用装配解析出的配置启动，而不是模块自带的 defaults：
    // 浏览器没有装配解析器，握手下发的 config 才是服务端冻结并计入 configHash 的那份。
    // 选中的定义必然来自 resolved.modules，因此配置一定存在；缺失说明契约被绕过，直接拒绝。
    const reference = references.get(definition.id);
    if (reference?.config === undefined) {
      throw new DomainError("assembly-incompatible", `模块 ${definition.id} 缺少装配下发的配置`, {
        details: { moduleId: definition.id },
      });
    }
    // 服务端按 sha256(canonicalJson(config)) 计算 configHash，这里用 kernel 的同一实现复算。
    // 下发值被替换成另一组同样能通过 configSchema 的配置时，只有这一步能发现；
    // 两端算法一致后不存在合法的不一致，因此不一致即拒绝，不降级为告警。
    const actualConfigHash = await computeConfigHash(reference.config, sha256Hex);
    if (actualConfigHash !== reference.configHash) {
      throw new DomainError("assembly-incompatible", `模块 ${definition.id} 的下发配置与 configHash 不一致`, {
        details: {
          moduleId: definition.id,
          expectedConfigHash: reference.configHash,
          actualConfigHash,
        },
      });
    }
    prepared.push({ definition, config: parseResolvedConfig(definition, reference.config) });
  }
  return prepared;
}

/**
 * 校验并应用握手下发的配置。
 * schema 失败包装为 `assembly-incompatible` 域错误：这是装配与服务端不一致，
 * 不是模块运行期故障，必须给出可定位的模块 ID 而不是抛原始 ZodError。
 */
function parseResolvedConfig(definition: ModuleDefinition, config: Json): Json {
  // 下发值已在服务端经过同一 schema 解析（含 transform）。kernel 解析配置时已要求 configSchema 对自身输出幂等，
  // 因此服务端输出在这里必然能再次通过；仍失败说明本地模块定义与服务端不一致。这里只用 safeParse 校验：
  // 再取 parsed.data 会二次执行 transform，浏览器实际用的配置就与服务端冻结结果不一致。
  const parsed = definition.configSchema.safeParse(config);
  if (!parsed.success) {
    throw new DomainError(
      "assembly-incompatible",
      `模块 ${definition.id} 的装配配置未通过本地 configSchema 校验：下发值是服务端解析后的输出，本地模块定义与服务端不一致`,
      {
        details: {
          moduleId: definition.id,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
          })),
        },
      },
    );
  }
  // 校验通过后以「服务端下发值」为准，只用解析结果补齐下发值缺失的可选字段（schema 默认值）：
  // 直接返回 parsed.data 会二次执行 transform，直接返回 config 又丢默认值。
  return mergeResolvedDefaults(config, parsed.data as Json);
}

/**
 * 合并已解析结果：下发值已有的键一律保留，只补下发值缺失的键。
 * 这样 schema 默认值仍能生效，而 transform 的输出不会被客户端二次转换的结果覆盖。
 */
function mergeResolvedDefaults(delivered: Json, parsed: Json): Json {
  if (
    typeof delivered !== "object" ||
    delivered === null ||
    Array.isArray(delivered) ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return delivered;
  }
  const merged: { [key: string]: Json } = { ...parsed };
  for (const [key, value] of Object.entries(delivered)) {
    merged[key] = value as Json;
  }
  return merged;
}

/** 创建并启动本 realm 全部模块；失败时释放此前已启动实例。 */
export async function startBrowserModules(
  input: BrowserModuleRuntimeInput,
): Promise<StartedBrowserModules> {
  const definitions = dependencyOrder(selectedDefinitions(input.definitions, input.resolved));
  const hostPorts = contractedHostPorts(input.resolved.realm, input.fixedPorts);
  const host = browserHostServices();
  const signal = input.signal ?? new AbortController().signal;
  const instances: ModuleInstance[] = [];
  // 宿主外壳仍拿到全部端口；模块只经 declaredModulePorts 拿到固定端口与自己声明的能力端口。
  const providedPorts: Record<string, unknown> = { ...hostPorts };
  const prepared = await prepareModules(definitions, input.resolved);
  try {
    for (const { definition, config } of prepared) {
      const instance = await definition.create({
        moduleId: definition.id,
        realm: definition.realm,
        config,
        scope: {},
        ports: declaredModulePorts(definition, hostPorts, providedPorts, false),
        host,
        signal,
      });
      instances.push(instance);
      if (instance.port !== undefined) {
        for (const provided of definition.provides) {
          providedPorts[provided.capability] = instance.port;
        }
      }
    }
    for (const instance of instances) {
      await instance.start(signal);
    }
  } catch (error) {
    for (const instance of [...instances].reverse()) {
      try {
        await instance.dispose();
      } catch {
        // 释放失败不能覆盖最初的装配错误。
      }
    }
    throw error;
  }
  const contributions = contributedViews(definitions, hostPorts, providedPorts);
  let disposed = false;
  return {
    ports: providedPorts,
    contributions,
    instances,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const instance of [...instances].reverse()) {
        await instance.dispose();
      }
    },
  };
}

/** 生成稳定的内存偏好端口，仅供宿主没有持久化实现时使用。 */
export function memoryPreferencePort(): PreferencePort {
  const values = new Map<string, unknown>();
  return {
    get: (key) => (values.get(key) as never) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}
