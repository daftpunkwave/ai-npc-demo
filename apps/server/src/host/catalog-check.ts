/**
 * 校验 server 组合根与 config/assemblies 目录下的全部装配：模块目录、realm/kind 白名单、
 * 能力名与绑定匹配、运行时 requires 闭包、作用域/重复绑定、拓扑顺序、模块配置 schema 与必需能力。
 * 依赖 kernel 的统一解析器、module-sdk 描述符校验与组合根模块目录；不启动服务、不打开存储。
 * 装配目录的枚举与文件级约束复用启动路径的扫描实现，这里只在其上追加逐装配的解析检查。
 * 禁止写死装配文件名、放宽 schema 或用首错掩盖同一次预检中的其他失败项。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import { resolve } from "node:path";
import {
  DomainError,
  moduleKindSchema,
  type AssemblyDescriptor,
  type CapabilityRef,
  type ContentPack,
  type ModuleDefinition,
  type Realm,
} from "@world-prism/contracts";
import { createModuleRegistry, resolveRealmPlan, type ResolvedRealmPlan } from "@world-prism/kernel";
import { loadContentPack } from "@world-prism/experiment";
import { REALM_NAMESPACES, validateModuleDefinition } from "@world-prism/module-sdk";
import {
  allModuleDefinitions,
  clientRequiredCapabilities,
  serverRequiredCapabilities,
} from "./module-catalog";
import { deploymentDefaults } from "../deployment-defaults";
import { checkModuleCapabilityUsage } from "./module-capability-usage";
import { needsContentPack, scanAssemblyDirectory, serverAssemblyInputs } from "./assembly";

/** 一条装配预检失败：文件、稳定代码与可直接定位的原因。 */
export interface CatalogViolation {
  readonly file: string;
  readonly code: string;
  readonly message: string;
}

/** 预检结果；violations 为空表示目录下全部装配与模块目录一致。 */
export interface CatalogCheckReport {
  readonly moduleCount: number;
  readonly assemblies: readonly string[];
  readonly violations: readonly CatalogViolation[];
}

export interface CatalogCheckOptions {
  readonly root?: string;
  /** 待校验的模块目录；缺省使用组合根登记的 server 模块定义。 */
  readonly definitions?: readonly ModuleDefinition[];
  /** 宿主固定必需能力；缺省在真实目录下使用 server 必需能力，注入自定义目录时为空。 */
  readonly requiredCapabilities?: readonly CapabilityRef[];
}

export interface CatalogCliOptions extends CatalogCheckOptions {
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

const realms: readonly Realm[] = ["server", "client", "console"];

function leadingNamespace(value: string): string {
  const separator = value.indexOf(".");
  return separator === -1 ? value : value.slice(0, separator);
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "catalog-error";
}

function errorMessage(error: unknown): string {
  if (error instanceof DomainError) {
    return `${error.code}: ${error.safeMessage}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 收集模块目录自身的问题：重复 ID、描述符字段、realm 命名空间与 kind 白名单。 */
function checkDefinitions(
  definitions: readonly ModuleDefinition[],
  violations: CatalogViolation[],
): Map<string, ModuleDefinition> {
  const byId = new Map<string, ModuleDefinition>();
  for (const definition of definitions) {
    try {
      validateModuleDefinition(definition);
    } catch (error) {
      violations.push({
        // eslint-disable-next-line xss/no-mixed-html -- "<module-catalog>" 是预检诊断的占位文件名，不是 HTML 片段。
        file: "<module-catalog>",
        code: errorCode(error),
        message: `模块 ${definition.id} 描述符非法：${errorMessage(error)}`,
      });
    }
    if (!moduleKindSchema.safeParse(definition.kind).success) {
      violations.push({
        // eslint-disable-next-line xss/no-mixed-html -- "<module-catalog>" 是预检诊断的占位文件名，不是 HTML 片段。
        file: "<module-catalog>",
        code: "module-kind",
        message: `模块 ${definition.id} 的 kind 不在 service/contributor/adapter 白名单内`,
      });
    }
    const namespace = leadingNamespace(definition.id);
    const realmNamespaces = REALM_NAMESPACES[definition.realm];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时目录可能带有未知 realm，保留防御性检查。
    if (realmNamespaces === undefined || !realmNamespaces.includes(namespace)) {
      violations.push({
        // eslint-disable-next-line xss/no-mixed-html -- "<module-catalog>" 是预检诊断的占位文件名，不是 HTML 片段。
        file: "<module-catalog>",
        code: "realm-violation",
        message: `模块 ${definition.id} 的 ID 命名空间 ${namespace} 不属于 ${String(definition.realm)} realm`,
      });
    }
    if (byId.has(definition.id)) {
      violations.push({
        // eslint-disable-next-line xss/no-mixed-html -- "<module-catalog>" 是预检诊断的占位文件名，不是 HTML 片段。
        file: "<module-catalog>",
        code: "module-duplicate",
        message: `重复模块 ID: ${definition.id}`,
      });
      continue;
    }
    byId.set(definition.id, definition);
  }
  return byId;
}

/** 逐条绑定检查独立问题，便于一次报告同一次预检中的多个绑定错误。 */
function checkBindings(
  file: string,
  realm: Realm,
  assembly: AssemblyDescriptor,
  byId: ReadonlyMap<string, ModuleDefinition>,
  violations: CatalogViolation[],
): boolean {
  let failed = false;
  const boundCapabilities = new Map<string, string>();
  // eslint-disable-next-line security/detect-object-injection -- realm 是受限字面量联合，只索引装配中已声明的三个 realm。
  for (const binding of assembly.realms[realm].bindings) {
    // eslint-disable-next-line security/detect-object-injection -- realm 同上，来自受限联合而非外部输入。
    if (!REALM_NAMESPACES[realm].includes(leadingNamespace(binding.capability))) {
      violations.push({
        file,
        code: "capability-namespace",
        message: `能力 ${binding.capability} 不属于 ${realm} realm 的能力命名空间`,
      });
      failed = true;
    }
    const definition = byId.get(binding.moduleId);
    if (definition === undefined) {
      violations.push({
        file,
        code: "module-missing",
        message: `能力 ${binding.capability} 绑定了未登记模块 ${binding.moduleId}`,
      });
      failed = true;
      continue;
    }
    const provided = definition.provides.find((item) => item.capability === binding.capability);
    const previousModuleId = boundCapabilities.get(binding.capability);
    if (previousModuleId !== undefined && provided?.cardinality !== "many") {
      violations.push({
        file,
        code: "binding-duplicate",
        message: `能力 ${binding.capability} 重复绑定到 ${previousModuleId} 与 ${binding.moduleId}`,
      });
      failed = true;
    } else {
      boundCapabilities.set(binding.capability, binding.moduleId);
    }
    if (definition.realm !== realm) {
      violations.push({
        file,
        code: "realm-violation",
        message: `能力 ${binding.capability} 在 ${realm} realm 绑定了 ${definition.realm} 模块 ${binding.moduleId}`,
      });
      failed = true;
      continue;
    }
    if (provided === undefined) {
      violations.push({
        file,
        code: "capability-mismatch",
        message: `模块 ${binding.moduleId} 未声明提供能力 ${binding.capability}`,
      });
      failed = true;
    }
    if (binding.configRef !== null && assembly.configs[binding.configRef] === undefined) {
      violations.push({
        file,
        code: "config-missing",
        message: `模块 ${binding.moduleId} 引用了不存在的配置块 ${binding.configRef}`,
      });
      failed = true;
    }
  }
  return failed;
}

/** 解析器输出必须满足“提供者先于消费者”；失败时给出具体模块对。 */
function checkTopology(
  file: string,
  plan: ResolvedRealmPlan,
  violations: CatalogViolation[],
): void {
  const positions = new Map(plan.modules.map((module, index) => [module.moduleId, index]));
  for (const [consumerIndex, module] of plan.modules.entries()) {
    for (const requirement of module.requires) {
      for (const provider of requirement.providers) {
        const providerIndex = positions.get(provider.moduleId);
        if (providerIndex !== undefined && providerIndex > consumerIndex) {
          violations.push({
            file,
            code: "topology",
            message: `模块 ${module.moduleId} 依赖 ${provider.moduleId}，但提供者排在消费者之后`,
          });
        }
      }
    }
  }
}

/** 内容包是按需加载的：只有把工具描述注入 agent.tools 的装配才需要它。 */
interface ContentPackSource {
  readonly pack: () => ContentPack;
}

/** 校验一个已通过 schema 的装配：三个 realm 各自解析，失败原因带文件与 realm。 */
function checkAssembly(
  root: string,
  file: string,
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
  definitionsById: ReadonlyMap<string, ModuleDefinition>,
  requiredCapabilities: Readonly<Record<Realm, readonly CapabilityRef[]>>,
  content: ContentPackSource,
  violations: CatalogViolation[],
): void {
  const registry = createModuleRegistry();
  try {
    for (const definition of definitions) {
      registry.register(definition);
    }
  } catch (error) {
    violations.push({ file, code: errorCode(error), message: errorMessage(error) });
    return;
  }
  const snapshot = registry.snapshot();
  for (const realm of realms) {
    const bindingFailed = checkBindings(file, realm, assembly, definitionsById, violations);
    try {
      const plan = resolveRealmPlan({
        assembly,
        realm,
        catalog: snapshot,
        ...(realm === "server"
          ? serverAssemblyInputs(
            assembly,
            requiredCapabilities.server,
            needsContentPack(assembly) ? { content: content.pack() } : {},
            root,
          )
          : { requiredCapabilities: requiredCapabilities[realm] }),
      });
      checkTopology(file, plan, violations);
    } catch (error) {
      // 逐条绑定检查已经给出同一条失败原因时，不再重复解析器的首错。
      if (!bindingFailed) {
        violations.push({
          file,
          code: errorCode(error),
          message: `${realm}: ${errorMessage(error)}`,
        });
      }
    }
  }
}

/** 读取目录下全部 YAML 装配并执行完整预检；违规累积返回，供 CLI 决定退出码。 */
export function checkCatalog(options: CatalogCheckOptions = {}): CatalogCheckReport {
  const root = resolve(options.root ?? process.cwd());
  const definitions = options.definitions ?? allModuleDefinitions;
  const requiredCapabilities: Readonly<Record<Realm, readonly CapabilityRef[]>> =
    options.definitions === undefined
      ? {
          server: options.requiredCapabilities ?? serverRequiredCapabilities,
          client: clientRequiredCapabilities,
          console: [],
        }
      : {
          server: options.requiredCapabilities ?? [],
          client: [],
          console: [],
        };
  const violations: CatalogViolation[] = [];
  const definitionsById = checkDefinitions(definitions, violations);
  // 自定义目录测试无法提供真实模块源码；只有仓库真实目录才做源码访问与 requires 的静态对账。
  if (options.definitions === undefined) {
    violations.push(...checkModuleCapabilityUsage({ root, definitions }));
  }
  // 文件枚举与文件级约束（普通文件、realpath 越界、schema、assemblyId 唯一）复用启动路径的同一实现，
  // 避免 check:catalog 通过而启动失败，或反之。
  const scan = scanAssemblyDirectory(root);
  violations.push(...scan.failures.map((failure) => ({
    file: failure.file,
    code: failure.code,
    message: failure.message,
  })));
  if (scan.directory.length === 0) {
    return { moduleCount: definitions.length, assemblies: [], violations };
  }
  if (scan.assemblies.length === 0 && scan.failures.length === 0) {
    violations.push({
      file: scan.directory,
      code: "assemblies-empty",
      message: "装配目录中没有 YAML 文件",
    });
  }

  const assemblies = scan.assemblies.map((entry) => entry.assembly.assemblyId);
  // 内容包只影响 server 装配的工具描述注入：整轮预检加载一次并复用，逐装配重复读取会按装配数量倍数放大成本。
  // 没有装配需要它时（如只校验模块目录的自定义夹具）保持不读盘。
  let loadedContent: ContentPack | null = null;
  const content: ContentPackSource = {
    pack: () => {
      loadedContent ??= loadContentPack(resolve(root, "content"), deploymentDefaults.contentPackId);
      return loadedContent;
    },
  };
  for (const { fileName, assembly } of scan.assemblies) {
    checkAssembly(
      root,
      fileName,
      assembly,
      [...definitionsById.values()],
      definitionsById,
      requiredCapabilities,
      content,
      violations,
    );
  }

  return { moduleCount: definitions.length, assemblies, violations };
}

/** 输出预检结果并返回退出码；失败项逐行打印原因，成功时报告装配数量。 */
export function runCatalogCheckCli(options: CatalogCliOptions = {}): number {
  const report = checkCatalog(options);
  const writeStdout = options.writeStdout ?? ((text: string): void => {
    process.stdout.write(text);
  });
  const writeStderr = options.writeStderr ?? ((text: string): void => {
    process.stderr.write(text);
  });
  if (report.violations.length === 0) {
    writeStdout(`catalog ok: ${report.moduleCount} modules, ${report.assemblies.length} assemblies\n`);
    return 0;
  }
  writeStderr(`catalog 校验失败：${report.violations.length} 项。\n`);
  for (const violation of report.violations) {
    writeStderr(`  [${violation.code}] ${violation.file}: ${violation.message}\n`);
  }
  return 1;
}
