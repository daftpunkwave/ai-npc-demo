/**
 * 核心职责：验证模型挂载预检对供应商返回名别名的冻结，并锁定仓库既有模型布局与价目的冻结摘要。
 * 交互契约：经 resolveRunConfiguration 走创建 run 与实验执行器共用的解析实现；布局变体经草稿读取注入，
 * 部署环境只经加载上下文的 env 字典注入。
 * 约束与禁忌：不启动宿主、不打开存储、不发模型请求，不读写进程环境变量。
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, type Json } from "@world-prism/contracts";
import {
  loadContentPack, loadModelLayout, loadRoster, loadRunSpec, type ConfigLoadContext, type ModelLayout,
} from "@world-prism/experiment";
import { canonicalHasher, serverModuleDefinitions } from "@world-prism/app-server";
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
