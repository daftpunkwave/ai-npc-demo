/**
 * 核心职责：验证模型挂载预检对供应商返回名别名与推理开关（含环境变量形式）的冻结，
 * 并锁定仓库既有模型布局与价目的冻结摘要。
 * 交互契约：经 resolveRunConfiguration 走创建 run 与实验执行器共用的解析实现；布局变体经草稿读取注入，
 * 部署环境只经加载上下文的 env 字典注入。
 * 约束与禁忌：不启动宿主、不打开存储、不发模型请求，不读写进程环境变量。
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, type Json } from "@world-prism/contracts";
import {
  experimentSpecSchema, loadContentPack, loadExperimentSpec, loadModelLayout, loadRoster, loadRunSpec,
  type ConfigLoadContext, type ModelLayout,
} from "@world-prism/experiment";
import { canonicalHasher, serverModuleDefinitions } from "@world-prism/app-server";
import { runsOfExperiment } from "../src/host/experiment-write";
import { resolveRunConfiguration } from "../src/host/run-configuration";

const content = loadContentPack("content", "earth-2964-v1");
const deepseekEnv = {
  WORLD_PRISM_OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com/v1",
  WORLD_PRISM_OPENAI_COMPAT_MODEL: "deepseek-flash",
};

function contextOf(env: Readonly<Record<string, string>>, drafts: readonly ModelLayout[] = []): ConfigLoadContext {
  return {
    configDir: "config", env,
    drafts: { read: (kind, configId) => kind === "model-layout" ? drafts.find(({ layoutId }) => layoutId === configId) : undefined },
  };
}

async function frozenModels(input: {
  readonly loadContext: ConfigLoadContext;
  readonly modelLayoutRef: string;
  readonly assemblyRef?: string;
  readonly rosterRef?: string;
}) {
  const { loadContext, modelLayoutRef } = input;
  const runSpec = loadRunSpec("online-default", loadContext, {
    seed: "model-configuration-test", moduleAssemblyRef: input.assemblyRef ?? "local-slg-standard-v1",
    rosterRef: input.rosterRef ?? "standard-15", modelLayoutRef,
  }).value;
  const resolved = await resolveRunConfiguration({
    content, definitions: serverModuleDefinitions, contentVersion: content.pack.contentVersion,
    loadRoster: (ref) => loadRoster(ref, loadContext), loadContext, repoRoot: process.cwd(),
  }, runSpec);
  if ("failures" in resolved) {
    throw new Error(resolved.failures.map(({ code, message }) => `${code}: ${message}`).join("; "));
  }
  const models = resolved.configuration.manifest.models as Readonly<Record<string, Json>> | undefined;
  if (models === undefined) throw new Error("装配没有冻结模型挂载");
  return { models, routes: models["routes"] as readonly Readonly<Record<string, Json>>[] };
}

describe("既有模型布局的冻结摘要", () => {
  // 在线 run 与实验 run 在重启或执行前都会按当前布局与价目复算 manifest 并比对 manifest_hash。
  // 这里锁定的值来自引入别名与推理开关之前的实现：布局 schema、价目文件或路由形状的改动若让它们变化，
  // 既有 run 就无法恢复，必须改为新增布局与价目文件。
  it.each([
    {
      layout: "shared-model-layout-v1", assemblyRef: "local-slg-standard-v1", rosterRef: "standard-15",
      layoutHash: "1461b970cfd6dc563ab49219aa8f67a8f93a978b3d5624876213f6d518ca0380",
      pricingHash: "b88121a91d5bf4e758e16c20da61f88db5e6295e4bea26a63d76a7115684e233",
      routesHash: "3c76c9ae92af46ca788c05e1719c850a4f0a2eafdaf0d19ffc4c42947c7df19c",
    },
    {
      layout: "claude-model-layout-v1", assemblyRef: "local-slg-standard-v1", rosterRef: "standard-15",
      layoutHash: "5ebec547df5d3634807cfae28bb3187eef0d1eb6483f28bd94046dfc2f809e7b",
      pricingHash: "b88121a91d5bf4e758e16c20da61f88db5e6295e4bea26a63d76a7115684e233",
      routesHash: "eeceba1f6eff23c26e26a0f9adb47e3e8f32ac9a05bc4d9969f79e598a45b73a",
    },
    {
      layout: "deterministic-model-layout-v1", assemblyRef: "local-slg-test-v1", rosterRef: "core-3",
      layoutHash: "2b7cbf41a9e66e4ffa3180426a98542522e063414be0f56b40b8bbb301ffa930",
      pricingHash: "d05029b99ad62b1d5c6c354318c04c71a3f53921447a4fc06b93335f23539c5e",
      routesHash: null,
    },
  ])("$layout 的布局、价目与路由摘要保持不变", async ({ layout, assemblyRef, rosterRef, layoutHash, pricingHash, routesHash }) => {
    const { models } = await frozenModels({ loadContext: contextOf(deepseekEnv), modelLayoutRef: layout, assemblyRef, rosterRef });
    expect(models).toMatchObject({ layoutId: layout, layoutHash, pricingHash });
    // 确定性布局的路由含夹具正文摘要，夹具随测试演进，只锁定布局与价目。
    if (routesHash !== null) expect(await canonicalHasher(canonicalJson(models["routes"] ?? null))).toBe(routesHash);
  });
});

describe("供应商返回名别名的冻结", () => {
  it("声明的别名写入每条冻结路由并改变路由摘要，其余字段与未声明时一致", async () => {
    const shared = loadModelLayout("shared-model-layout-v1", contextOf(deepseekEnv));
    const sharedChat = shared.models["npc-chat"];
    if (sharedChat === undefined) throw new Error("共享布局缺少 npc-chat");
    const aliased: ModelLayout = {
      ...shared, layoutId: "served-alias-draft",
      models: { "npc-chat": { ...sharedChat, servedModels: ["deepseek/deepseek-flash"] } },
    };
    const before = await frozenModels({ loadContext: contextOf(deepseekEnv), modelLayoutRef: "shared-model-layout-v1" });
    const after = await frozenModels({ loadContext: contextOf(deepseekEnv, [aliased]), modelLayoutRef: "served-alias-draft" });
    expect(after.routes).toHaveLength(before.routes.length);
    after.routes.forEach((route, index) => {
      const { configHash, servedModels, ...rest } = route;
      const { configHash: priorHash, ...prior } = before.routes[index] ?? {};
      expect(servedModels).toEqual(["deepseek/deepseek-flash"]);
      expect(rest).toEqual(prior);
      expect(configHash).not.toBe(priorHash);
    });
    expect(before.routes.every((route) => !Object.hasOwn(route, "servedModels"))).toBe(true);
  });
});

describe("推理开关与返回名别名的环境变量", () => {
  const shared = loadModelLayout("shared-model-layout-v1", contextOf(deepseekEnv));
  const sharedChat = shared.models["npc-chat"];
  if (sharedChat === undefined || typeof sharedChat.parameters !== "object" || sharedChat.parameters === null ||
    Array.isArray(sharedChat.parameters)) throw new Error("共享布局缺少 npc-chat 的参数对象");
  const envDriven: ModelLayout = {
    ...shared, layoutId: "env-switch-draft",
    models: { "npc-chat": {
      ...sharedChat, servedModels: "env:WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS",
      parameters: { ...sharedChat.parameters, thinking: "env:WORLD_PRISM_OPENAI_COMPAT_THINKING" },
    } },
  };
  const resolveWith = (env: Readonly<Record<string, string>>) =>
    frozenModels({ loadContext: contextOf({ ...deepseekEnv, ...env }, [envDriven]), modelLayoutRef: envDriven.layoutId });

  it("两个变量都未设置或为空时，冻结路由与共享布局逐字节一致", async () => {
    const baseline = await frozenModels({ loadContext: contextOf(deepseekEnv), modelLayoutRef: "shared-model-layout-v1" });
    const unset = await resolveWith({});
    const blank = await resolveWith({ WORLD_PRISM_OPENAI_COMPAT_THINKING: "", WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: " " });
    expect(canonicalJson(unset.models["routes"] ?? null)).toBe(canonicalJson(baseline.models["routes"] ?? null));
    expect(canonicalJson(blank.models["routes"] ?? null)).toBe(canonicalJson(baseline.models["routes"] ?? null));
  });

  it("设置后把解析值冻结进每条路由的参数与别名", async () => {
    const { routes } = await resolveWith({
      WORLD_PRISM_OPENAI_COMPAT_THINKING: "disabled",
      WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: "deepseek/deepseek-flash, deepseek-v4-flash-0731",
    });
    // standard-15 名册的 15 个身份各挂 decision、speech、memory-maintenance 三个用途。
    expect(routes).toHaveLength(45);
    for (const route of routes) {
      expect(route["parameters"]).toEqual({ temperature: 0.6, maxTokensField: "max_tokens", thinking: "disabled" });
      expect(route["servedModels"]).toEqual(["deepseek/deepseek-flash", "deepseek-v4-flash-0731"]);
    }
  });

  it.each([
    ["推理开关取值无效", { WORLD_PRISM_OPENAI_COMPAT_THINKING: "minimal" }, "WORLD_PRISM_OPENAI_COMPAT_THINKING 只能是 disabled 或 enabled"],
    ["别名列表含空项", { WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: "deepseek/deepseek-flash," }, "WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS 含空名称"],
  ])("%s时预检失败并指出变量", async (_label, env, message) => {
    await expect(resolveWith(env)).rejects.toThrow(message);
  });
});

describe("OpenAI 兼容网关布局", () => {
  const gatewayLayout = "openai-compatible-gateway-layout-v1";
  const gatewayModel = "deepseek-v4.1-flash-official";
  const gatewayEnv = { WORLD_PRISM_OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com/v1", WORLD_PRISM_OPENAI_COMPAT_MODEL: gatewayModel };
  const withoutModelName = (routes: readonly Readonly<Record<string, Json>>[]) =>
    routes.map(({ configHash: _configHash, externalModel: _externalModel, ...route }) => route);

  it("以网关模型名通过预检，冻结估算价目、推理开关与返回名别名", async () => {
    const { models, routes } = await frozenModels({
      loadContext: contextOf({
        ...gatewayEnv, WORLD_PRISM_OPENAI_COMPAT_THINKING: "disabled", WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: "deepseek/deepseek-flash",
      }),
      modelLayoutRef: gatewayLayout,
    });
    expect(models).toMatchObject({ layoutId: gatewayLayout, pricingVersion: "2026-11-gateway-estimate" });
    expect(routes).toHaveLength(45);
    for (const route of routes) {
      expect(route).toMatchObject({
        modelId: "npc-chat", externalModel: gatewayModel, servedModels: ["deepseek/deepseek-flash"],
        parameters: { temperature: 0.6, maxTokensField: "max_tokens", thinking: "disabled" },
        price: { inputPerMTok: 0.3, outputPerMTok: 1.2, currency: "USD" },
      });
    }
    expect(Object.fromEntries(routes.filter(({ agentId }) => agentId === "npc-yinuo")
      .map(({ purpose, maxOutputTokens }) => [String(purpose), maxOutputTokens])))
      .toEqual({ decision: 1500, speech: 400, "memory-maintenance": 800 });
  });

  it("两个变量未设置时，除供应商模型名外与共享布局的冻结路由一致", async () => {
    const gateway = await frozenModels({ loadContext: contextOf(gatewayEnv), modelLayoutRef: gatewayLayout });
    const shared = await frozenModels({ loadContext: contextOf(deepseekEnv), modelLayoutRef: "shared-model-layout-v1" });
    expect(gateway.routes.every(({ externalModel }) => externalModel === gatewayModel)).toBe(true);
    expect(withoutModelName(gateway.routes)).toEqual(withoutModelName(shared.routes));
  });

  it("v2 布局只提高 npc-chat 的限额，冻结路由的其余字段与 v1 一致", async () => {
    const loadContext = contextOf({ ...gatewayEnv, WORLD_PRISM_OPENAI_COMPAT_THINKING: "disabled" });
    const v1 = await frozenModels({ loadContext, modelLayoutRef: gatewayLayout });
    const v2 = await frozenModels({ loadContext, modelLayoutRef: "openai-compatible-gateway-layout-v2" });
    const withoutLimits = (routes: readonly Readonly<Record<string, Json>>[]) => routes.map(({
      configHash: _configHash, maxConcurrent: _concurrent, requestsPerMinute: _requests, tokensPerMinute: _tokens, ...route
    }) => route);
    expect(withoutLimits(v2.routes)).toEqual(withoutLimits(v1.routes));
    expect(v2.models).toMatchObject({ layoutId: "openai-compatible-gateway-layout-v2", pricingVersion: "2026-11-gateway-estimate" });
    for (const route of v1.routes) expect(route).toMatchObject({ maxConcurrent: 2, requestsPerMinute: 20, tokensPerMinute: 40000 });
    for (const route of v2.routes) expect(route).toMatchObject({ maxConcurrent: 4, requestsPerMinute: 60, tokensPerMinute: 300000 });
  });

  it("供应商模型名与估算价目记录不一致时预检失败", async () => {
    await expect(frozenModels({ loadContext: contextOf(deepseekEnv), modelLayoutRef: gatewayLayout }))
      .rejects.toThrow("模型 npc-chat 的 externalModel 与价目记录不一致");
  });

  it("实验规格只替换 modelLayoutRef 时，每个 run 冻结网关布局", async () => {
    const loadContext = contextOf({ ...gatewayEnv, WORLD_PRISM_OPENAI_COMPAT_THINKING: "disabled" });
    const repository = loadExperimentSpec("exp-memory-promise-v1", loadContext).value;
    const inline = experimentSpecSchema.parse({ ...repository, base: { ...repository.base, modelLayoutRef: gatewayLayout } });
    const runs = runsOfExperiment(inline);
    expect(runs).toHaveLength(24);
    const [first] = runs;
    if (first === undefined) throw new Error("实验没有展开出 run");
    const resolved = await resolveRunConfiguration({
      content, definitions: serverModuleDefinitions, contentVersion: content.pack.contentVersion,
      loadRoster: (ref) => loadRoster(ref, loadContext), loadContext, repoRoot: process.cwd(),
    }, first);
    if ("failures" in resolved) throw new Error(resolved.failures.map(({ message }) => message).join("; "));
    const { manifest } = resolved.configuration;
    expect(manifest.selection).toMatchObject({ runSpecId: first.id, modelLayoutRef: gatewayLayout });
    expect(manifest.models).toMatchObject({ layoutId: gatewayLayout, pricingVersion: "2026-11-gateway-estimate" });
  });
});
