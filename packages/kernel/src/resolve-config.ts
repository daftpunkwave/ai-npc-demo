/**
 * 按模块 configSchema 严格校验装配配置、合并模块默认值并填入 schema 默认值。
 * 依赖公共契约的 ModuleDefinition、JSON 值校验与 DomainError，不接触任何模块实现。
 * 禁止放宽 schema、静默丢弃未知键或在失败时返回部分配置。
 */
import { DomainError, jsonValueSchema, type Json, type ModuleDefinition } from "@world-prism/contracts";

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
function isJsonObject(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}

function throwConfigFailure(definition: ModuleDefinition, configRef: string | null, issues: readonly string[]): never {
  throw new DomainError("assembly-incompatible", `模块 ${definition.id} 的配置校验失败：${issues.join("；")}`, {
    details: { moduleId: definition.id, configRef, issues: [...issues] },
  });
}

/**
 * 解析一个模块实例的配置：先合并模块 defaults（浅层、配置覆盖默认值），
 * 再按严格 schema 解析以填入 schema 默认值，最后确认结果是 JSON 值。
 * 未知键、类型不符与越界值都由 schema 报出，并带模块 ID 与配置来源。
 */
export function resolveModuleConfig(
  definition: ModuleDefinition,
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  config: Json | undefined,
  configRef: string | null = null,
): Json {
  const raw: Json = config === undefined ? {} : config;
  let candidate: unknown = raw;
  if (definition.defaults !== undefined) {
    if (!isJsonObject(definition.defaults)) {
      throw new DomainError("assembly-incompatible", `模块 ${definition.id} 的 defaults 必须是 JSON 对象`, {
        details: { moduleId: definition.id, reason: "defaults-not-object" },
      });
    }
    candidate = isJsonObject(raw) ? { ...definition.defaults, ...raw } : raw;
  }

  const parsed = definition.configSchema.safeParse(candidate);
  if (!parsed.success) {
    throwConfigFailure(definition, configRef, formatIssues(parsed.error.issues));
  }

  const asJson = jsonValueSchema.safeParse(parsed.data);
  if (!asJson.success) {
    throwConfigFailure(definition, configRef, ["配置输出不是 JSON 值，无法参与哈希与冻结"]);
  }
  return asJson.data;
}
