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
import { loadModelLayout, type ConfigLoadContext, type ModelLayout } from "@ai-npc/experiment";

const publicEndpointEnvironment = "NPC_OPENAI_COMPAT_BASE_URL";
const publicModelEnvironment = "NPC_OPENAI_COMPAT_MODEL";
const credentialEnvironment = /^[A-Z][A-Z0-9_]*$/u;

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
    return url.hostname;
  } catch {
    return null;
  }
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
        endpointRef: connection.endpoint ?? null,
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

function validationErrors(layout: ModelLayoutDraft, knownAgentIds: ReadonlySet<string>) {
  const errors: { code: string; message: string }[] = [];
  const rateLimits = new Map<string, string>();
  const routes = new Set<string>();
  for (const [connectionId, connection] of Object.entries(layout.connections)) {
    if (connection.endpoint?.startsWith("env:")) {
      const name = connection.endpoint.slice(4);
      if (name !== publicEndpointEnvironment) {
        errors.push({ code: "endpoint-environment", message: `连接 ${connectionId} 的端点引用不受支持` });
      }
    } else if (connection.endpoint !== undefined) {
      try {
        const endpoint = new URL(connection.endpoint);
        const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]";
        if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback) ||
          endpoint.username.length > 0 || endpoint.password.length > 0 ||
          endpoint.search.length > 0 || endpoint.hash.length > 0) {
          errors.push({ code: "endpoint", message: `连接 ${connectionId} 的端点必须是无凭据的 HTTPS 或回环 HTTP` });
        }
      } catch {
        errors.push({ code: "endpoint", message: `连接 ${connectionId} 的端点不是合法 URL` });
      }
    }
    if (connection.credentialRef !== undefined && !credentialEnvironment.test(connection.credentialRef)) {
      errors.push({ code: "credential-ref", message: `连接 ${connectionId} 的 credentialRef 必须是环境变量名` });
    }
  }
  for (const [modelId, model] of Object.entries(layout.models)) {
    const connection = own(layout.connections, model.connectionId);
    if (connection === undefined) {
      errors.push({ code: "model-connection", message: `模型 ${modelId} 引用了未知连接 ${model.connectionId}` });
      continue;
    }
    if (model.externalModel.startsWith("env:") && model.externalModel.slice(4) !== publicModelEnvironment) {
      errors.push({ code: "external-model-environment", message: `模型 ${modelId} 的供应商模型引用不受支持` });
    }
    const limitKey = `${model.limits.requestsPerMinute}:${model.limits.tokensPerMinute}`;
    const prior = rateLimits.get(connection.rateLimitKey ?? model.connectionId);
    if (prior !== undefined && prior !== limitKey) {
      errors.push({ code: "rate-limit", message: `模型 ${modelId} 与同一限流账号的 RPM/TPM 不一致` });
    }
    rateLimits.set(connection.rateLimitKey ?? model.connectionId, limitKey);
    const capabilities = model.capabilities;
    if (capabilities !== undefined && (
      capabilities.maxOutputTokens >= capabilities.contextWindowTokens ||
      Object.values(model.maxOutputTokensByPurpose).some((limit) => limit > capabilities.maxOutputTokens))) {
      errors.push({ code: "output-limit", message: `模型 ${modelId} 的输出上限超过能力声明` });
    }
  }
  for (const mount of layout.mounts) {
    const model = own(layout.models, mount.modelId);
    if (model === undefined) {
      errors.push({ code: "mount-model", message: `挂载引用了未知模型 ${mount.modelId}` });
      continue;
    }
    for (const agentId of mount.agentIds) {
      if (!knownAgentIds.has(agentId)) {
        errors.push({ code: "mount-agent", message: `挂载引用了未知 Agent ${agentId}` });
      }
      for (const purpose of mount.purposes) {
        const key = `${agentId}:${purpose}`;
        if (routes.has(key)) errors.push({ code: "mount-duplicate", message: `模型用途重复挂载 ${key}` });
        routes.add(key);
        if (model.capabilities !== undefined && (
          purpose === "decision" && !model.capabilities.toolCalling ||
          ["speech", "memory-maintenance", "compression"].includes(purpose) &&
          model.capabilities.structuredOutput === "none" ||
          purpose === "embedding" && !model.capabilities.embedding)) {
          errors.push({ code: "mount-capability", message: `模型 ${mount.modelId} 不支持 ${purpose}` });
        }
      }
    }
  }
  if (layout.evaluator?.enabled === true && !Object.hasOwn(layout.models, layout.evaluator.modelId)) {
    errors.push({ code: "evaluator-model", message: "评估主体引用了未知模型" });
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
    const errors = validationErrors(parsed.data, this.knownAgentIds);
    return modelLayoutValidateResponseSchema.parse({ ok: errors.length === 0, errors });
  }

  private layoutIds(): readonly string[] {
    const directory = join(this.loadContext.configDir, "model-layouts");
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name.slice(0, -".yaml".length))
      .sort((left, right) => left.localeCompare(right));
  }

  private load(layoutId: string): ModelLayout {
    if (!this.layoutIds().includes(layoutId)) throw new DomainError("not-found", `模型布局 ${layoutId} 不存在`);
    return loadModelLayout(layoutId, this.loadContext);
  }
}
