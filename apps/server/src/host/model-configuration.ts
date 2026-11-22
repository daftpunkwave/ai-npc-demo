/**
 * 预检布局引用与所选 Agent 策略的模型要求，从解析结果生成冻结模型清单。
 * 只处理已装配的传输，加载夹具正文并保留路由、摘要与价格版本。
 * 禁止解析密钥正文、自动补挂载或把未验证的 endpoint 写入清单。
 */
import { canonicalJson, DomainError, type Json } from "@ai-npc/contracts";
import { loadModelFixtures, loadModelLayout, loadModelPricing, resolveModelEnv,
  type ConfigLoadContext, type ResolvedAgentProfile, type RunSpec } from "@ai-npc/experiment";
import type { ResolvedRealmPlan } from "@ai-npc/kernel";
import { parseModelEndpoint, type ModelRoute, type ModelRunLimits } from "@ai-npc/module-sdk";
import { canonicalHasher } from "../host-services";

const fixtureAdapter = "platform.model-transport.deterministic";
const openAICompatibleAdapter = "platform.model-transport.openai-compatible";

export interface ModelConfiguration {
  readonly routes: readonly ModelRoute[];
  readonly limits: ModelRunLimits;
  readonly manifest: Json;
}

export function hasModelPool(plan: ResolvedRealmPlan): boolean {
  return plan.modules.some(({ definition }) => definition.provides.some(({ capability }) => capability === "agent.model-pool"));
}

export function usesFixtureModelTransport(plan: ResolvedRealmPlan): boolean {
  return plan.modules.some(({ moduleId }) => moduleId === fixtureAdapter);
}

function fail(message: string): never {
  throw new DomainError("assembly-incompatible", message);
}

function endpointOf(value: string, loadContext: ConfigLoadContext): string {
  const url = parseModelEndpoint(resolveModelEnv(value, loadContext, "NPC_OPENAI_COMPAT_BASE_URL"));
  if (url === null) {
    fail("模型端点必须使用 HTTPS 或回环 HTTP，且不携带凭据、参数或片段");
  }
  return url.href;
}

export async function resolveModelConfiguration(input: {
  readonly plan: ResolvedRealmPlan;
  readonly runSpec: RunSpec;
  readonly loadContext: ConfigLoadContext;
  readonly knownAgentIds: ReadonlySet<string>;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly modelAgents: ReadonlySet<string>;
  readonly promptConfig: { readonly templateVersion: string; readonly value: Json };
}): Promise<ModelConfiguration | null> {
  const { plan, runSpec, loadContext, knownAgentIds, modelAgents, profiles } = input;
  if (!hasModelPool(plan)) return null;
  const adapters = new Set(plan.modules.filter(({ definition }) =>
    definition.provides.some(({ capability }) => capability === "platform.model-transport")).map(({ moduleId }) => moduleId));
  if (adapters.has(fixtureAdapter) && adapters.size > 1) fail("确定性传输不能与真实传输共用装配");
  const layout = loadModelLayout(runSpec.modelLayoutRef, loadContext);
  const pricing = loadModelPricing(loadContext, layout.pricingRef);
  const connections = new Map(await Promise.all(Object.entries(layout.connections).map(async ([connectionId, connection]) => {
    if (!adapters.has(connection.adapterId)) fail(`模型连接 ${connectionId} 引用了未装配的传输`);
    const fixture = connection.adapterId === fixtureAdapter;
    if ((fixture && (connection.endpoint !== undefined || connection.credentialRef !== null)) ||
      (!fixture && connection.fixtureFiles.length > 0) ||
      (connection.adapterId === openAICompatibleAdapter && connection.endpoint === undefined)) {
      fail(`模型连接 ${connectionId} 使用了不适用的端点、密钥或夹具`);
    }
    const fixtureRows = connection.fixtureFiles.length === 0 ? [] : loadModelFixtures(connection.fixtureFiles, loadContext);
    const resolved = {
      connectionId, adapterId: connection.adapterId,
      credentialRef: connection.credentialRef?.replace(/^env:/u, "") ?? null,
      endpoint: connection.endpoint === undefined ? null : endpointOf(connection.endpoint, loadContext),
      rateLimitKey: connection.rateLimitKey ?? connectionId,
      fixturesHash: fixture ? await canonicalHasher(canonicalJson(fixtureRows)) : null,
    };
    return [connectionId, { ...resolved, fixtureRows }] as const;
  })));
  const rateLimits = new Map<string, string>();
  const models = new Map(Object.entries(layout.models).map(([modelId, model]) => {
    const connection = connections.get(model.connectionId);
    if (connection === undefined) fail(`模型 ${modelId} 引用了未知连接`);
    if (connection.adapterId === fixtureAdapter && canonicalJson(model.parameters) !== "{}") {
      fail(`确定性模型 ${modelId} 的 parameters 必须为空对象`);
    }
    const price = pricing.models[modelId];
    if (price === undefined) fail(`模型 ${modelId} 缺少价目`);
    const { requestsPerMinute, tokensPerMinute } = model.limits;
    const limits = `${requestsPerMinute}:${tokensPerMinute}`;
    const existing = rateLimits.get(connection.rateLimitKey);
    if (existing !== undefined && existing !== limits) fail("同一个限流账号的 RPM/TPM 必须一致");
    rateLimits.set(connection.rateLimitKey, limits);
    if (model.capabilities.maxOutputTokens >= model.capabilities.contextWindowTokens ||
      Object.values(model.maxOutputTokensByPurpose).some((limit) => limit > model.capabilities.maxOutputTokens)) {
      fail(`模型 ${modelId} 的输出上限超过能力声明`);
    }
    const externalModel = resolveModelEnv(model.externalModel, loadContext, "NPC_OPENAI_COMPAT_MODEL");
    if (price.externalModel !== externalModel) {
      fail(`模型 ${modelId} 的 externalModel 与价目记录不一致`);
    }
    const { externalModel: _pricedExternalModel, ...priceFields } = price;
    return [modelId, {
      ...model, connection, externalModel, modelId,
      price: { ...priceFields, currency: pricing.currency },
    }] as const;
  }));
  if (layout.evaluator !== undefined && !models.has(layout.evaluator.modelId)) fail("评估主体引用了未知模型");
  if (layout.evaluator?.enabled === true) fail("当前运行装配未启用模型评估主体");
  const mounts = new Map<string, Omit<ModelRoute, "configHash"> & { readonly fixturesHash: string | null }>();
  for (const mount of layout.mounts) {
    const model = models.get(mount.modelId);
    if (model === undefined) fail(`挂载引用了未知模型 ${mount.modelId}`);
    const { connection } = model;
    for (const agentId of mount.agentIds) {
      if (!knownAgentIds.has(agentId)) fail(`模型挂载引用了未知 Agent ${agentId}`);
      for (const purpose of mount.purposes) {
        const key = `${agentId}:${purpose}`;
        if (mounts.has(key)) fail(`模型用途重复挂载 ${key}`);
        if (purpose === "decision" && !model.capabilities.toolCalling ||
          ["speech", "memory-maintenance", "compression"].includes(purpose) && model.capabilities.structuredOutput === "none" ||
          purpose === "embedding" && !model.capabilities.embedding) fail(`模型 ${model.modelId} 不支持 ${purpose}`);
        mounts.set(key, {
          ...connection, agentId, purpose, modelId: model.modelId, externalModel: model.externalModel,
          parameters: model.parameters, capabilities: model.capabilities, ...model.limits, price: model.price,
          maxOutputTokens: model.maxOutputTokensByPurpose[purpose] ?? Math.min(4096, model.capabilities.maxOutputTokens),
        });
      }
    }
  }
  for (const [agentId, profile] of profiles) {
    if (!modelAgents.has(agentId)) continue;
    for (const purpose of ["decision", "speech"] as const) {
      const route = mounts.get(`${agentId}:${purpose}`);
      if (route === undefined) fail(`Agent ${agentId} 缺少必需的 ${purpose} 挂载`);
      if (profile.budgets.reserveOutputTokens[purpose] > route.maxOutputTokens) {
        fail(`Agent ${agentId} 的 ${purpose} 输出预留超过挂载上限`);
      }
    }
  }
  const routes = await Promise.all([...mounts.values()].filter(({ agentId }) => profiles.has(agentId))
    .map(async ({ fixtureRows, ...route }) => ({
      ...route, fixtureRows, configHash: await canonicalHasher(canonicalJson(route)),
    })));
  const frozenRoutes = routes.map(({ fixtureRows: _fixtureRows, ...route }) => route);
  return {
    routes, limits: runSpec.budget,
    manifest: {
      layoutId: layout.layoutId, pricingVersion: pricing.pricingVersion, limits: runSpec.budget, routes: frozenRoutes,
      templateVersion: input.promptConfig.templateVersion,
      promptHash: await canonicalHasher(canonicalJson(input.promptConfig.value)),
      layoutHash: await canonicalHasher(canonicalJson(layout)),
      pricingHash: await canonicalHasher(canonicalJson(pricing)),
    },
  };
}
