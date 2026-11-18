/**
 * 模块描述符的字段级校验原语：realm 命名空间、能力引用、远端能力、严格配置 schema 与可选声明字段。
 * 依赖公共契约的模块、能力与 JSON 校验 schema，以及统一领域错误；不加载模块实现或创建资源。
 * 禁止放宽 realm 命名空间、重复能力、未知配置键或非法可选字段，错误必须带字段定位信息。
 */
import {
  DomainError,
  capabilityIdSchema,
  capabilityRefSchema,
  contributionRefSchema,
  experimentAxisSchema,
  jsonValueSchema,
  type ErrorCode,
  type Realm,
  type StrictConfigSchema,
} from "@ai-npc/contracts";

/** 各 realm 可用的模块 ID 与本地能力命名空间；server 的四个职能族与浏览器两族固定。 */
export const REALM_NAMESPACES: Readonly<Record<Realm, readonly string[]>> = {
  server: ["game", "agent", "platform", "transport"],
  client: ["client"],
  console: ["console"],
};

/** 只有服务端能力可以被浏览器 realm 通过握手远程消费。 */
const REMOTE_NAMESPACES: readonly string[] = REALM_NAMESPACES["server"];

/** 探测配置 schema 是否拒绝未知键的哨兵键；它不会出现在任何真实配置里。 */
const UNKNOWN_CONFIG_PROBE_KEY = "ai-npc-sdk-unknown-config-key";

/** 统一的描述符校验失败出口：错误码、字段与原因都进入 details，便于定位模块作者笔误。 */
export function descriptorFailure(
  code: ErrorCode,
  moduleId: string | null,
  field: string,
  reason: string,
): never {
  const label = moduleId ?? "<未知 ID>";
  throw new DomainError(code, `模块描述符 ${label} 的字段 ${field} 非法：${reason}`, {
    details: { moduleId, field, reason },
  });
}

/** 取点分 ID 的首段，用于比较模块 ID 与能力的 realm 命名空间。 */
export function leadingNamespace(value: string): string {
  const separator = value.indexOf(".");
  return separator === -1 ? value : value.slice(0, separator);
}

export function requireNonEmptyString(moduleId: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    descriptorFailure("assembly-incompatible", moduleId, field, "必须是非空字符串");
  }
  return value;
}

/** 校验能力引用数组：逐项符合契约、同名能力不重复、命名空间属于当前 realm。 */
export function validateCapabilityRefs(
  moduleId: string,
  realm: Realm,
  field: "provides" | "requires",
  value: unknown,
): void {
  if (!Array.isArray(value)) {
    descriptorFailure("assembly-incompatible", moduleId, field, "必须是能力引用数组");
  }
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = capabilityRefSchema.safeParse(item);
    if (!parsed.success) {
      descriptorFailure("assembly-incompatible", moduleId, field, "包含不符合能力引用 schema 的条目");
    }
    const capability = parsed.data.capability;
    if (seen.has(capability)) {
      descriptorFailure("assembly-incompatible", moduleId, field, `重复声明能力 ${capability}`);
    }
    seen.add(capability);
    if (!REALM_NAMESPACES[realm].includes(leadingNamespace(capability))) {
      const hint =
        realm === "server"
          ? "服务端模块只能声明服务端能力命名空间"
          : "浏览器 realm 只能声明本 realm 的能力，服务端能力必须声明到 requiresRemote";
      descriptorFailure(
        "realm-violation",
        moduleId,
        field,
        `能力 ${capability} 不属于 ${realm} realm 命名空间（${hint}）`,
      );
    }
  }
}

/** 校验 requiresRemote：只允许浏览器 realm 使用，且只能指向服务端能力。 */
export function validateRemoteCapabilities(moduleId: string, realm: Realm, value: unknown): void {
  if (!Array.isArray(value)) {
    descriptorFailure("assembly-incompatible", moduleId, "requiresRemote", "必须是能力 ID 数组");
  }
  if (realm === "server" && value.length > 0) {
    descriptorFailure("realm-violation", moduleId, "requiresRemote", "服务端模块不能声明 requiresRemote");
  }
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = capabilityIdSchema.safeParse(item);
    if (!parsed.success) {
      descriptorFailure("assembly-incompatible", moduleId, "requiresRemote", "只能包含非空能力 ID");
    }
    const capability = parsed.data;
    if (seen.has(capability)) {
      descriptorFailure("assembly-incompatible", moduleId, "requiresRemote", `重复声明远端能力 ${capability}`);
    }
    seen.add(capability);
    if (!REMOTE_NAMESPACES.includes(leadingNamespace(capability))) {
      descriptorFailure(
        "realm-violation",
        moduleId,
        "requiresRemote",
        `能力 ${capability} 不是服务端能力；本 realm 能力应声明到 requires`,
      );
    }
  }
}

/**
 * 判断配置 schema 是否为严格对象 schema。
 * 不依赖 zod 内部结构：以未知哨兵键探测，只有明确返回 unrecognized_keys 才视为拒绝未知键。
 */
export function isStrictConfigSchema(value: unknown): value is StrictConfigSchema {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly safeParse?: unknown };
  if (typeof candidate.safeParse !== "function") {
    return false;
  }
  let probe: unknown;
  try {
    probe = (candidate.safeParse as (input: unknown) => unknown)({ [UNKNOWN_CONFIG_PROBE_KEY]: true });
  } catch {
    return false;
  }
  if (typeof probe !== "object" || probe === null) {
    return false;
  }
  const result = probe as { readonly success?: unknown; readonly error?: { readonly issues?: unknown } };
  if (result.success !== false || !Array.isArray(result.error?.issues)) {
    return false;
  }
  return result.error.issues.some((issue) => {
    if (typeof issue !== "object" || issue === null) {
      return false;
    }
    const typed = issue as { readonly code?: unknown; readonly keys?: unknown };
    return (
      typed.code === "unrecognized_keys" &&
      Array.isArray(typed.keys) &&
      typed.keys.includes(UNKNOWN_CONFIG_PROBE_KEY)
    );
  });
}

export function validateDefaults(moduleId: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    descriptorFailure("assembly-incompatible", moduleId, "defaults", "必须是 JSON 值");
  }
  if (typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) {
    descriptorFailure("assembly-incompatible", moduleId, "defaults", "必须是 JSON 对象（按浅层默认值合并）");
  }
}

export function validateOwnsAggregates(moduleId: string, realm: Realm, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (realm !== "server") {
    descriptorFailure(
      "realm-violation",
      moduleId,
      "ownsAggregates",
      "只有 server realm 模块可以声明拥有的聚合类型",
    );
  }
  if (!Array.isArray(value)) {
    descriptorFailure("assembly-incompatible", moduleId, "ownsAggregates", "必须是聚合类型名数组");
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      descriptorFailure("assembly-incompatible", moduleId, "ownsAggregates", "只能包含非空聚合类型名");
    }
    if (seen.has(item)) {
      descriptorFailure("assembly-incompatible", moduleId, "ownsAggregates", `重复声明聚合类型 ${item}`);
    }
    seen.add(item);
  }
}

export function validateContributions(moduleId: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    descriptorFailure("assembly-incompatible", moduleId, "contributions", "必须是贡献引用数组");
  }
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = contributionRefSchema.safeParse(item);
    if (!parsed.success) {
      descriptorFailure("assembly-incompatible", moduleId, "contributions", "包含不符合贡献 schema 的条目");
    }
    const conflictKey = `${parsed.data.slot}\u0000${parsed.data.extensionId}`;
    if (seen.has(conflictKey)) {
      descriptorFailure(
        "assembly-incompatible",
        moduleId,
        "contributions",
        `slot ${parsed.data.slot} 中扩展 ID ${parsed.data.extensionId} 重复`,
      );
    }
    seen.add(conflictKey);
  }
}

export function validateExperimentAxes(moduleId: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    descriptorFailure("assembly-incompatible", moduleId, "experimentAxes", "必须是实验轴数组");
  }
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = experimentAxisSchema.safeParse(item);
    if (!parsed.success) {
      descriptorFailure("assembly-incompatible", moduleId, "experimentAxes", "包含不符合实验轴 schema 的条目");
    }
    if (seen.has(parsed.data.key)) {
      descriptorFailure("assembly-incompatible", moduleId, "experimentAxes", `重复声明实验轴 ${parsed.data.key}`);
    }
    seen.add(parsed.data.key);
  }
}
