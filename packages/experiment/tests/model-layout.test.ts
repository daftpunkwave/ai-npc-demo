/**
 * 模型布局加载测试：供应商返回名别名 servedModels 的结构校验与未声明时的解析形态。
 * 依赖 experiment 包的公开布局加载入口；每个用例在独立临时配置目录写入布局并在结束时删除。
 * 禁止读取真实 API key 或依赖仓库外的配置文件。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoadingError, loadModelLayout } from "../src/index";

const layoutId = "served-models-layout";

function layoutYaml(servedModels: string | null): string {
  return [
    "schemaVersion: 1",
    `layoutId: ${layoutId}`,
    "connections:",
    "  gateway:",
    "    adapterId: platform.model-transport.openai-compatible",
    "    endpoint: env:WORLD_PRISM_OPENAI_COMPAT_BASE_URL",
    "models:",
    "  m1:",
    "    connectionId: gateway",
    "    externalModel: env:WORLD_PRISM_OPENAI_COMPAT_MODEL",
    ...(servedModels === null ? [] : [`    servedModels: ${servedModels}`]),
    "    capabilities: { toolCalling: true, strictTools: false, structuredOutput: json_object, assistantReplay: verbatim, contextWindowTokens: 1000, maxOutputTokens: 100, embedding: false, embeddingDimensions: null }",
    "    limits: { maxConcurrent: 1, requestsPerMinute: 1, tokensPerMinute: 1, requestTimeoutMs: 1000 }",
    "mounts: []",
    "",
  ].join("\n");
}

function loadWith(servedModels: string | null) {
  const configDir = mkdtempSync(join(tmpdir(), "world-prism-served-models-"));
  try {
    writeFileSync(join(configDir, `${layoutId}.yaml`), layoutYaml(servedModels), "utf8");
    return loadModelLayout(layoutId, { configDir });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe("模型布局的供应商返回名别名", () => {
  it("按声明顺序保留精确名称列表", () => {
    expect(loadWith("[deepseek/deepseek-flash, deepseek-v4-flash-0731]").models["m1"]?.servedModels)
      .toEqual(["deepseek/deepseek-flash", "deepseek-v4-flash-0731"]);
  });

  it("未声明时解析结果不含该键，既有布局的冻结摘要不受影响", () => {
    const model = loadWith(null).models["m1"];
    expect(model === undefined ? null : Object.keys(model).sort()).toEqual([
      "capabilities", "connectionId", "externalModel", "limits", "maxOutputTokensByPurpose", "parameters",
    ]);
  });

  it.each([
    ["空列表", "[]", "servedModels"],
    ["重复名称", "[deepseek/deepseek-flash, deepseek/deepseek-flash]", "servedModels 不得重复"],
    ["空字符串", "[\"\"]", "servedModels"],
  ])("拒绝%s", (_label, servedModels, message) => {
    let failure: unknown;
    try {
      loadWith(servedModels);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LoadingError);
    expect(String((failure as LoadingError).message)).toContain(message);
  });
});
