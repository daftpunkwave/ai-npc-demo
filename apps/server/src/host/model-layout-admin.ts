/**
 * 核心职责：枚举仓库模型布局，生成去密钥视图、静态路由并执行草稿预检。
 * 交互契约：依赖受信任的配置根、环境字典与当前冻结路由；不发送网络请求或保存草稿。
 * 约束与禁忌：不得返回凭据正文、自动补挂载或接受未声明的供应商环境变量。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 只读取 config/model-layouts 下由 readdir 得到并以 .yaml 结尾的普通文件。 */
/* eslint-disable no-unused-vars -- 构造器参数属性会在类方法中通过 this 使用，Codacy 未能解析 TypeScript 参数属性。 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DomainError,
  modelLayoutDraftSchema,
  modelLayoutRoutesResponseSchema,
  modelLayoutValidateResponseSchema,
  modelLayoutViewSchema,
  modelLayoutsResponseSchema,
  type ModelLayoutDraft,
  type ModelLayoutRoutesResponse,
  type ModelLayoutValidateResponse,
  type ModelLayoutView,
  type ModelLayoutsResponse,
} from "@ai-npc/contracts";
import { LoadingError, loadModelLayout, type ConfigLoadContext, type ModelLayout } from "@ai-npc/experiment";

const publicEndpointEnvironment = "NPC_OPENAI_COMPAT_BASE_URL";
const publicModelEnvironment = "NPC_OPENAI_COMPAT_MODEL";
const layoutEndpointPrefix = "layout:";
const credentialEnvironment = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const maxValidationErrors = 100;

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  // key 已通过 own-property 检查，动态索引不会落到原型链。
  // eslint-disable-next-line security/detect-object-injection
  return record[key];
}

function hostOf(endpoint: string | undefined): string | null {
  if (endpoint === undefined || endpoint.startsWith("env:")) return null;
  try {
    const url = new URL(endpoint);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function endpointRefOf(layoutId: string, endpoint: string | undefined): string | null {
  if (endpoint === undefined) return null;
  return endpoint === `env:${publicEndpointEnvironment}` ? endpoint : `${layoutEndpointPrefix}${layoutId}`;
}

function credentialName(value: string | null): string | null {
  return value === null ? null : value.startsWith("env:") ? value.slice(4) : value;
}

function viewOf(layout: ModelLayout): ModelLayoutView {
  return modelLayoutViewSchema.parse({
    schemaVersion: layout.schemaVersion,
    layoutId: layout.layoutId,
    connections: Object.fromEntries(Object.entries(layout.connections).map(([connectionId, connection]) => [
      connectionId,
      {
        adapterId: connection.adapterId,
        endpointRef: endpointRefOf(layout.layoutId, connection.endpoint),
        endpointHost: hostOf(connection.endpoint),
        credentialRef: credentialName(connection.credentialRef),
        rateLimitKey: connection.rateLimitKey ?? null,
      },
    ])),
    models: Object.fromEntries(Object.entries(layout.models).map(([modelId, model]) => [
      modelId,
      {
        connectionId: model.connectionId,
        externalModel: model.externalModel,
        parameters: model.parameters,
        capabilities: model.capabilities,
        limits: model.limits,
        maxOutputTokensByPurpose: model.maxOutputTokensByPurpose,
      },
    ])),
    mounts: layout.mounts.map((mount) => ({
      modelId: mount.modelId,
      agentIds: [...mount.agentIds],
      purposes: [...mount.purposes],
    })),
    ...(layout.evaluator === undefined ? {} : { evaluator: layout.evaluator }),
  });
}

function routesOf(layout: ModelLayout): ModelLayoutRoutesResponse {
  const routes: ModelLayoutRoutesResponse["routes"][number][] = [];
  for (const mount of layout.mounts) {
    const model = own(layout.models, mount.modelId);
    if (model === undefined) continue;
    const connection = own(layout.connections, model.connectionId);
    if (connection === undefined) continue;
    for (const agentId of mount.agentIds) {
      for (const purpose of mount.purposes) {
        routes.push({
          agentId: agentId as ModelLayoutRoutesResponse["routes"][number]["agentId"],
          purpose,
          modelId: mount.modelId,
          connectionId: model.connectionId,
          adapterId: connection.adapterId,
          externalModel: model.externalModel,
        });
      }
    }
  }
  return modelLayoutRoutesResponseSchema.parse({ routes });
}

function endpointError(endpoint: string | undefined, connectionId: string): { code: string; message: string } | null {
  if (endpoint === undefined) return null;
  if (endpoint.startsWith("env:")) {
    return endpoint === `env:${publicEndpointEnvironment}` ? null
      : { code: "endpoint-environment", message: `连接 ${connectionId} 的端点引用不受支持` };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { code: "endpoint", message: `连接 ${connectionId} 的端点不是合法 URL` };
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    return { code: "endpoint", message: `连接 ${connectionId} 的端点必须是无用户信息、查询或片段的 HTTPS 或回环 HTTP` };
  }
  return null;
}

function validationErrors(
  layout: ModelLayoutDraft,
  knownAgentIds: ReadonlySet<string>,
  repositoryLayout: ModelLayout | null,
) {
  const errors: { code: string; message: string }[] = [];
  const fail = (code: string, message: string): boolean => {
    if (errors.length < maxValidationErrors) errors.push({ code, message });
    return errors.length >= maxValidationErrors;
  };
  const rateLimits = new Map<string, string>();
  const routes = new Set<string>();
  for (const [connectionId, connection] of Object.entries(layout.connections)) {
    let endpoint = connection.endpoint;
    if (endpoint?.startsWith(layoutEndpointPrefix)) {
      const configured = repositoryLayout === null ? undefined : own(repositoryLayout.connections, connectionId);
      if (endpoint !== `${layoutEndpointPrefix}${layout.layoutId}` ||
        configured?.endpoint === undefined || configured.adapterId !== connection.adapterId) {
        if (fail("endpoint-reference", `连接 ${connectionId} 的仓库端点引用无法解析`)) return errors;
        endpoint = undefined;
      } else {
        endpoint = configured.endpoint;
      }
    }
    const issue = endpointError(endpoint, connectionId);
    if (issue !== null && fail(issue.code, issue.message)) return errors;
    const credentialRef = connection.credentialRef?.replace(/^env:/u, "");
    if (credentialRef !== undefined && !credentialEnvironment.test(credentialRef)) {
      if (fail("credential-ref", `连接 ${connectionId} 的 credentialRef 必须是环境变量名`)) return errors;
    }
  }
  for (const [modelId, model] of Object.entries(layout.models)) {
    const connection = own(layout.connections, model.connectionId);
    if (connection === undefined) {
      if (fail("model-connection", `模型 ${modelId} 引用了未知连接 ${model.connectionId}`)) return errors;
      continue;
    }
    if (model.externalModel.startsWith("env:") && model.externalModel.slice(4) !== publicModelEnvironment) {
      if (fail("external-model-environment", `模型 ${modelId} 的供应商模型引用不受支持`)) return errors;
    }
    const limitKey = `${model.limits.requestsPerMinute}:${model.limits.tokensPerMinute}`;
    const prior = rateLimits.get(connection.rateLimitKey ?? model.connectionId);
    if (prior !== undefined && prior !== limitKey) {
      if (fail("rate-limit", `模型 ${modelId} 与同一限流账号的 RPM/TPM 不一致`)) return errors;
    }
    rateLimits.set(connection.rateLimitKey ?? model.connectionId, limitKey);
    const capabilities = model.capabilities;
    if (capabilities !== undefined && (
      capabilities.maxOutputTokens >= capabilities.contextWindowTokens ||
      Object.values(model.maxOutputTokensByPurpose).some((limit) => limit > capabilities.maxOutputTokens))) {
      if (fail("output-limit", `模型 ${modelId} 的输出上限超过能力声明`)) return errors;
    }
  }
  for (const mount of layout.mounts) {
    const model = own(layout.models, mount.modelId);
    if (model === undefined) {
      if (fail("mount-model", `挂载引用了未知模型 ${mount.modelId}`)) return errors;
      continue;
    }
    for (const agentId of mount.agentIds) {
      if (!knownAgentIds.has(agentId)) {
        if (fail("mount-agent", `挂载引用了未知 Agent ${agentId}`)) return errors;
      }
      for (const purpose of mount.purposes) {
        const key = `${agentId}:${purpose}`;
        if (routes.has(key) && fail("mount-duplicate", `模型用途重复挂载 ${key}`)) return errors;
        routes.add(key);
        if (model.capabilities !== undefined && (
          purpose === "decision" && !model.capabilities.toolCalling ||
          ["speech", "memory-maintenance", "compression"].includes(purpose) &&
          model.capabilities.structuredOutput === "none" ||
          purpose === "embedding" && !model.capabilities.embedding)) {
          if (fail("mount-capability", `模型 ${mount.modelId} 不支持 ${purpose}`)) return errors;
        }
      }
    }
  }
  if (layout.evaluator?.enabled === true && !Object.hasOwn(layout.models, layout.evaluator.modelId)) {
    fail("evaluator-model", "评估主体引用了未知模型");
  }
  return errors;
}

export class ModelLayoutAdminPort {
  constructor(
    private readonly loadContext: ConfigLoadContext,
    private readonly knownAgentIds: ReadonlySet<string>,
    private readonly currentRoutes: () => ModelLayoutRoutesResponse,
    private readonly currentLayoutId: () => string | null,
  ) {}

  list(): ModelLayoutsResponse {
    return modelLayoutsResponseSchema.parse({
      layouts: this.layoutIds().map((layoutId) => ({ layoutId, source: "repo" })),
    });
  }

  layout(layoutId: string): ModelLayoutView {
    return viewOf(this.load(layoutId));
  }

  routes(layoutId: string): ModelLayoutRoutesResponse {
    if (this.currentLayoutId() === layoutId) return this.currentRoutes();
    return routesOf(this.load(layoutId));
  }

  validate(layout: unknown): ModelLayoutValidateResponse {
    const parsed = modelLayoutDraftSchema.safeParse(layout);
    if (!parsed.success) {
      return modelLayoutValidateResponseSchema.parse({
        ok: false,
        errors: parsed.error.issues.slice(0, 100).map((issue) => ({
          code: "schema",
          message: issue.path.length === 0 ? issue.message : `${issue.path.join(".")}：${issue.message}`,
        })),
      });
    }
    const layoutId = parsed.data.layoutId;
    const sourceRef = `${layoutEndpointPrefix}${layoutId}`;
    const repositoryLayout = Object.values(parsed.data.connections).some((connection) => connection.endpoint === sourceRef)
      ? this.loadDraftSource(layoutId) : null;
    const errors = validationErrors(parsed.data, this.knownAgentIds, repositoryLayout);
    return modelLayoutValidateResponseSchema.parse({ ok: errors.length === 0, errors });
  }

  private loadDraftSource(layoutId: string): ModelLayout | null {
    try {
      return this.load(layoutId);
    } catch (error) {
      if (error instanceof DomainError && (error.code === "not-found" || error.code === "invalid-state")) return null;
      throw error;
    }
  }

  private layoutIds(): readonly string[] {
    const directory = join(this.loadContext.configDir, "model-layouts");
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (cause) {
      throw new DomainError("not-ready", "无法读取模型布局配置目录", { cause });
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name.slice(0, -".yaml".length))
      .sort((left, right) => left.localeCompare(right));
  }

  private load(layoutId: string): ModelLayout {
    if (!this.layoutIds().includes(layoutId)) throw new DomainError("not-found", `模型布局 ${layoutId} 不存在`);
    try {
      return loadModelLayout(layoutId, this.loadContext);
    } catch (cause) {
      if (!(cause instanceof LoadingError)) throw cause;
      throw new DomainError("invalid-state", `无法加载模型布局 ${layoutId} 的配置`, { cause });
    }
  }
}
