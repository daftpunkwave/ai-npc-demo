/**
 * 按服务端返回的浏览器装配校验本地模块目录，并依能力依赖创建、启动与释放模块实例。
 * 依赖公共模块描述符、React 视图贡献与本包宿主上下文；不加载装配外模块或共享服务端对象。
 * 禁止在版本不匹配时静默降级，也禁止忽略 slot 贡献失败或遗留网络订阅。
 */
import {
  DomainError,
  type HostServices,
  type Json,
  type ModuleDefinition,
  type ModuleInstance,
  type ResolvedModuleSet,
} from "@ai-npc/contracts";
import type { ReactNode } from "react";
import type { PreferencePort } from "./preferences";
import type { SlotContribution } from "./slots";

export interface BrowserViewPort {
  renderContribution(extensionId: string): ReactNode;
}

export interface BrowserModuleRuntimeInput {
  readonly definitions: readonly ModuleDefinition[];
  readonly resolved: ResolvedModuleSet;
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
    hash: async (value) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
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

function contributedViews(
  definitions: readonly ModuleDefinition[],
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
    for (const contribution of definition.contributions) {
      result.push({
        ...contribution,
        render: () => port.renderContribution(contribution.extensionId),
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

/** 创建并启动本 realm 全部模块；失败时释放此前已启动实例。 */
export async function startBrowserModules(
  input: BrowserModuleRuntimeInput,
): Promise<StartedBrowserModules> {
  const definitions = dependencyOrder(selectedDefinitions(input.definitions, input.resolved));
  const host = browserHostServices();
  const signal = input.signal ?? new AbortController().signal;
  const instances: ModuleInstance[] = [];
  const providedPorts: Record<string, unknown> = { ...input.fixedPorts };
  try {
    for (const definition of definitions) {
      const config = definition.configSchema.parse(definition.defaults ?? {}) as Json;
      const instance = await definition.create({
        moduleId: definition.id,
        realm: definition.realm,
        config,
        scope: {},
        ports: providedPorts,
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
  const contributions = contributedViews(definitions, providedPorts);
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
