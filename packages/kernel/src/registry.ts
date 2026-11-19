/**
 * 提供实例级模块注册表：显式注册模块定义、返回精确反注册函数并查询只读目录快照。
 * 依赖公共契约的 ModuleDefinition 与 DomainError；不依赖任何具体模块、应用或环境资源。
 * 禁止提供进程级单例、import 时自动注册或按注册顺序决定后续解析结果。
 */
import { DomainError, type ModuleDefinition } from "@ai-npc/contracts";

/** 按模块 ID、版本排序的只读目录快照。 */
export type CatalogSnapshot = readonly ModuleDefinition[];

/** 宿主启动作用域内的模块注册表；每个宿主实例各建一份，不共享全局状态。 */
export interface ModuleRegistry {
  /** 注册一个模块定义，返回只移除本次注册的反注册函数；重复 id@version 直接报错。 */
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  register(definition: ModuleDefinition): () => void;
  /** 当前全部已注册模块的只读快照，按 id 与版本排序。 */
  snapshot(): CatalogSnapshot;
  /** 同一模块 ID 的全部已注册版本，按版本排序。 */
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  findById(moduleId: string): CatalogSnapshot;
  /** 精确匹配 id@version 的模块定义。 */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents, no-unused-vars -- Codacy 的 Node10 解析把导入类型判成 any；同时接口签名中的参数名只用于表达调用契约，运行时不会读取。
  get(moduleId: string, version: string): ModuleDefinition | null;
}

interface RegistryEntry {
  readonly definition: ModuleDefinition;
  readonly token: symbol;
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const registryKey = (moduleId: string, version: string): string => `${moduleId}@${version}`;

/**
 * 创建一次宿主启动独占的注册表。
 * 反注册函数只在自己那次注册仍是当前条目时生效，避免误删后来重注册的同名条目。
 */
export function createModuleRegistry(): ModuleRegistry {
  const entries = new Map<string, RegistryEntry>();

  const register = (definition: ModuleDefinition): (() => void) => {
    const key = registryKey(definition.id, definition.version);
    if (entries.has(key)) {
      throw new DomainError("plugin-failed", `模块 ${key} 已注册，拒绝重复注册`, {
        details: { moduleId: definition.id, version: definition.version, reason: "duplicate-id-version" },
      });
    }
    const token = Symbol(key);
    entries.set(key, { definition, token });
    return () => {
      const current = entries.get(key);
      if (current !== undefined && current.token === token) {
        entries.delete(key);
      }
    };
  };

  const snapshot = (): CatalogSnapshot => {
    const definitions = [...entries.values()].map((entry) => entry.definition);
    definitions.sort(
      (left, right) =>
        compareText(left.id, right.id) || compareText(left.version, right.version),
    );
    return Object.freeze(definitions);
  };

  const findById = (moduleId: string): CatalogSnapshot => {
    const definitions = [...entries.values()]
      .map((entry) => entry.definition)
      .filter((definition) => definition.id === moduleId);
    definitions.sort((left, right) => compareText(left.version, right.version));
    return Object.freeze(definitions);
  };

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  const get = (moduleId: string, version: string): ModuleDefinition | null =>
    entries.get(registryKey(moduleId, version))?.definition ?? null;

  return { register, snapshot, findById, get };
}
