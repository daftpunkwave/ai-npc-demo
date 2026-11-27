/**
 * 按模块 configSchema 严格校验装配配置、合并模块默认值并填入 schema 默认值，并核对 schema 对自身输出幂等。
 * 依赖公共契约的 ModuleDefinition、JSON 值校验、规范 JSON 与 DomainError，不接触任何模块实现。
 * 禁止放宽 schema、静默丢弃未知键、接受对自身输出不幂等的 schema，或在失败时返回部分配置。
 */
import { DomainError, canonicalJson, jsonValueSchema, type Json, type ModuleDefinition } from "@world-prism/contracts";

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
 * 核对 configSchema 对自身输出幂等：再次解析已解析配置必须成功，且得到同一份规范 JSON。
 * 浏览器 realm 只拿到服务端解析后的输出，并用同一 configSchema 复核后启动模块；
 * 改变类型的 transform（如 `z.string().transform(Number)`）会让复核按输入类型误判失败，
 * 不可重入的 transform 会让两端看到不同的值。在解析阶段拒绝，错误指向 schema 而不是浏览器。
 */
function assertConfigIdempotent(definition: ModuleDefinition, output: Json, configRef: string | null): void {
  const reparsed = definition.configSchema.safeParse(output);
  const reparsedJson = reparsed.success ? jsonValueSchema.safeParse(reparsed.data) : null;
  const sameOutput = reparsedJson?.success === true && canonicalJson(reparsedJson.data) === canonicalJson(output);
  if (sameOutput) {
    return;
  }
  const issues = reparsed.success
    ? ["再次解析得到的配置与首次解析输出不同"]
    : formatIssues(reparsed.error.issues).map((issue) => `再次解析失败：${issue}`);
  throw new DomainError(
    "assembly-incompatible",
    `模块 ${definition.id} 的 configSchema 对自身输出不幂等：${issues.join("；")}。` +
      "改变类型或不可重入的 transform 会让浏览器复核服务端下发的已解析配置时失败或取值不同",
    { details: { moduleId: definition.id, configRef, reason: "config-not-idempotent", issues: [...issues] } },
  );
}

/**
 * 解析一个模块实例的配置：先合并模块 defaults（浅层、配置覆盖默认值），
 * 再按严格 schema 解析以填入 schema 默认值，确认结果是 JSON 值并核对 schema 对该输出幂等。
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
  assertConfigIdempotent(definition, asJson.data, configRef);
  return asJson.data;
}
