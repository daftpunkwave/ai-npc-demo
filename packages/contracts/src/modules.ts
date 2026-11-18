/**
 * 定义模块描述符、能力引用与装配描述符的契约。
 * 依赖 JSON、ID 与 Zod 校验；数据型描述符用 strict schema，含函数或 schema 的描述符用类型。
 * 禁止在此加载模块实现、解析装配或执行生命周期。
 */
import { z } from "zod";
import { jsonValueSchema, type Json } from "./json";

/** 运行域。 */
export const realmSchema = z.enum(["server", "client", "console"]);

export type Realm = z.infer<typeof realmSchema>;

/** 模块种类。 */
export const moduleKindSchema = z.enum(["service", "contributor", "adapter"]);

export type ModuleKind = z.infer<typeof moduleKindSchema>;

/** 实例作用域。 */
export const instanceScopeSchema = z.enum(["deployment", "run", "branch", "agent", "session"]);

export type InstanceScope = z.infer<typeof instanceScopeSchema>;

/** 能力基数：恰好一个、多个或可选。 */
export const cardinalitySchema = z.enum(["exactly-one", "many", "optional"]);

export type Cardinality = z.infer<typeof cardinalitySchema>;

/** 能力 ID 带品牌，避免与模块 ID 或普通字符串混用。 */
export const capabilityIdSchema = z.string().min(1).brand<"CapabilityId">();

export type CapabilityId = z.infer<typeof capabilityIdSchema>;

/** 模块 ID 为 <group>.<family>.<impl>，group 受 realm 用途约束。 */
export const moduleIdSchema = z
  .string()
  .regex(
    /^(game|agent|platform|transport|client|console)\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/,
    "不是合法的模块 ID",
  );

export type ModuleId = z.infer<typeof moduleIdSchema>;

/** 能力引用：消费方声明基数与实例作用域。 */
export const capabilityRefSchema = z
  .object({
    capability: capabilityIdSchema,
    cardinality: cardinalitySchema,
    instanceScope: instanceScopeSchema,
  })
  .strict();

export type CapabilityRef = z.infer<typeof capabilityRefSchema>;

/** 已解析模块的身份与配置摘要。 */
export const moduleRefSchema = z
  .object({
    moduleId: moduleIdSchema,
    version: z.string().min(1),
    apiVersion: z.string().min(1),
    configHash: z.string().min(1),
  })
  .strict();

export type ModuleRef = z.infer<typeof moduleRefSchema>;

/** 浏览器握手时能拿到的模块集：只含 ID、版本、能力与装配 hash。 */
export const resolvedModuleSetSchema = z
  .object({
    realm: realmSchema,
    protocolVersion: z.string().min(1),
    modules: z.array(moduleRefSchema),
    capabilities: z.array(capabilityRefSchema),
    assemblyHash: z.string().min(1),
  })
  .strict();

export type ResolvedModuleSet = z.infer<typeof resolvedModuleSetSchema>;

/** Agent 槽位。 */
export const agentSlotSchema = z.enum(["perception", "memory", "context", "compression", "toolView", "decision"]);

export type AgentSlot = z.infer<typeof agentSlotSchema>;

export const agentSlots = agentSlotSchema.options as readonly AgentSlot[];

/**
 * 装配里每个槽可选的实现模块；整个对象可省略（无 Agent 运行时），
 * 槽也可先不配置，由预检拒绝缺少必需槽的 profile。
 */
export const agentSlotImplementationsSchema = z
  .object({
    perception: z.array(moduleIdSchema).optional(),
    memory: z.array(moduleIdSchema).optional(),
    context: z.array(moduleIdSchema).optional(),
    compression: z.array(moduleIdSchema).optional(),
    toolView: z.array(moduleIdSchema).optional(),
    decision: z.array(moduleIdSchema).optional(),
  })
  .strict();

export type AgentSlotImplementations = z.infer<typeof agentSlotImplementationsSchema>;

/** 能力绑定：能力指向模块与命名配置块。 */
export const capabilityBindingSchema = z
  .object({
    capability: capabilityIdSchema,
    moduleId: moduleIdSchema,
    configRef: z.string().min(1).nullable(),
    fallbackModuleIds: z.array(moduleIdSchema).optional(),
  })
  .strict();

export type CapabilityBinding = z.infer<typeof capabilityBindingSchema>;

const realmBindingsSchema = z
  .object({
    bindings: z.array(capabilityBindingSchema),
  })
  .strict();

const serverRealmSchema = z
  .object({
    bindings: z.array(capabilityBindingSchema),
    agentSlots: agentSlotImplementationsSchema.optional(),
  })
  .strict();

/**
 * 装配描述符：命名配置块、三个 realm 的绑定与 server 的 Agent 槽位。
 * 主机、端口、数据目录等部署参数不写在这里，由宿主在启动时并入模块配置。
 */
export const assemblyDescriptorSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    assemblyId: z.string().min(1),
    configs: z.record(z.string().min(1), jsonValueSchema),
    realms: z
      .object({
        server: serverRealmSchema,
        client: realmBindingsSchema,
        console: realmBindingsSchema,
      })
      .strict(),
  })
  .strict();

export type AssemblyDescriptor = z.infer<typeof assemblyDescriptorSchema>;

/** 严配置 schema：必须调用过 .strict() 的 Zod object，未知键解析即失败。 */
export type StrictConfigSchema = z.ZodObject<z.core.$ZodShape, z.core.$strict>;

/** 状态迁移路径：fromVersion 的状态经 migrate 变为 toVersion。 */
export interface MigrationPath {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(state: Json): Json;
}

/** 贡献引用：UI 贡献与控制台页面共用。 */
export const contributionRefSchema = z
  .object({
    extensionId: z.string().min(1),
    slot: z.string().min(1),
    order: z.number().int(),
    allowedRoles: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ContributionRef = z.infer<typeof contributionRefSchema>;

/** 实验轴：只用于控制台展示可比较参数。 */
export const experimentAxisSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    values: z.array(jsonValueSchema).optional(),
  })
  .strict();

export type ExperimentAxis = z.infer<typeof experimentAxisSchema>;

/** UI 扩展声明。 */
export const uiExtensionSchema = z
  .object({
    extensionId: z.string().min(1),
    slot: z.string().min(1),
    requiredCapabilities: z.array(capabilityIdSchema),
    order: z.number().int(),
    viewRef: z.string().min(1),
  })
  .strict();

export type UiExtension = z.infer<typeof uiExtensionSchema>;

/** 宿主日志端口；只接受可序列化数据，避免模块自建日志系统。 */
export interface HostLogger {
  info(message: string, data?: Json): void;
  warn(message: string, data?: Json): void;
  error(message: string, data?: Json): void;
}

/** 宿主 trace 端口；span 在同步回调内执行并记录属性。 */
export interface HostTracer {
  span<T>(name: string, attrs: Json, fn: () => T): T;
}

/** 模块获取时间、随机源、ID 与 I/O 的唯一入口。 */
export interface HostServices {
  ids(prefix: string): string;
  nowIso(): string;
  monotonicMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  rng(...seedParts: string[]): () => number;
  hash(value: Json): Promise<string>;
  logger: HostLogger;
  tracer: HostTracer;
  storage?: unknown;
  model?: unknown;
}

/** 模块实例作用域标识。 */
export interface ModuleScope {
  readonly worldId?: string;
  readonly branchId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
}

/** 模块创建输入：配置已按 configSchema 校验并填默认值，端口按 requires 解析。 */
export interface ModuleCreateInput {
  readonly moduleId: string;
  readonly realm: Realm;
  readonly config: Json;
  readonly scope: ModuleScope;
  readonly ports: Readonly<Record<string, unknown>>;
  readonly host: HostServices;
  readonly signal: AbortSignal;
}

/** 模块实例生命周期；port 由 kind/capability 映射收窄，不能作为万能入口。 */
export interface ModuleInstance {
  readonly moduleId: string;
  start(signal: AbortSignal): Promise<void>;
  drain(deadlineMs: number): Promise<void>;
  dispose(): Promise<void>;
  readonly port?: unknown;
}

/** 模块描述符：静态能力声明与工厂。 */
export interface ModuleDefinition {
  readonly id: string;
  readonly realm: Realm;
  readonly kind: ModuleKind;
  readonly version: string;
  readonly apiVersion: string;
  readonly instanceScope: InstanceScope;
  readonly provides: readonly CapabilityRef[];
  readonly requires: readonly CapabilityRef[];
  readonly requiresRemote: readonly CapabilityId[];
  readonly configSchema: StrictConfigSchema;
  readonly defaults?: Json;
  readonly stateSchemaVersion: number | null;
  readonly ownsAggregates?: readonly string[];
  readonly migrationPaths: readonly MigrationPath[];
  readonly contributions?: readonly ContributionRef[];
  readonly experimentAxes?: readonly ExperimentAxis[];
  create(input: ModuleCreateInput): Promise<ModuleInstance>;
}
