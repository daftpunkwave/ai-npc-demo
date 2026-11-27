/**
 * 模型布局加载测试：供应商返回名别名 servedModels 的结构校验、未声明时的解析形态，
 * 以及别名与推理开关的可选环境变量解析。
 * 依赖 experiment 包的公开布局入口；需要布局文件的用例在独立临时配置目录写入并在结束时删除，环境只经注入字典提供。
 * 禁止读取真实 API key 或依赖仓库外的配置文件。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoadingError, loadModelLayout, resolveModelThinking, resolveServedModels } from "../src/index";

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

  it("env 形式在加载时保留原始引用，由宿主预检解析", () => {
    expect(loadWith("env:WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS").models["m1"]?.servedModels)
      .toBe("env:WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS");
  });

  it.each([
    ["空列表", "[]", "servedModels"],
    ["重复名称", "[deepseek/deepseek-flash, deepseek/deepseek-flash]", "servedModels 不得重复"],
    ["空字符串", "[\"\"]", "servedModels"],
    ["非 env 引用的单个字符串", "deepseek/deepseek-flash", "servedModels"],
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

/** 断言解析失败并返回 LoadingError，供检查错误码与消息。 */
function loadingFailure(resolve: () => unknown): LoadingError {
  try {
    resolve();
  } catch (error) {
    if (error instanceof LoadingError) return error;
    throw error;
  }
  throw new Error("预期解析失败，但实际成功");
}

describe("可选开关的环境变量解析", () => {
  const servedRef = "env:WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS";
  const thinkingRef = "env:WORLD_PRISM_OPENAI_COMPAT_THINKING";
  const context = (env: Record<string, string>) => ({ configDir: tmpdir(), env });

  it("别名列表原样复制，env 引用按逗号拆分并去掉首尾空白", () => {
    expect(resolveServedModels(["a/b", "c"], context({}))).toEqual(["a/b", "c"]);
    expect(resolveServedModels(servedRef, context({
      WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: " deepseek/deepseek-flash , deepseek-v4-flash-0731 ",
    }))).toEqual(["deepseek/deepseek-flash", "deepseek-v4-flash-0731"]);
  });

  it.each([
    ["未设置", {}],
    ["空值", { WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: "" }],
    ["只含空白", { WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: "  " }],
  ])("别名环境变量%s时视为未声明", (_label, env) => {
    expect(resolveServedModels(servedRef, context(env))).toBeUndefined();
  });

  it("只读注入环境的自有字段，原型链上的同名值不生效", () => {
    const inherited = Object.create({ WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: "outside", WORLD_PRISM_OPENAI_COMPAT_THINKING: "disabled" }) as Record<string, string>;
    expect(resolveServedModels(servedRef, context(inherited))).toBeUndefined();
    expect(resolveModelThinking(thinkingRef, context(inherited))).toBeUndefined();
  });

  it.each([
    ["空项", "a,,b", "含空名称"],
    ["末尾逗号", "a,", "含空名称"],
    ["重复项", "a, a", "含重复名称"],
    ["超过上限", Array.from({ length: 17 }, (_, index) => `m${index}`).join(","), "超过 16 项"],
  ])("别名环境变量含%s时拒绝并指出变量名", (_label, value, problem) => {
    const failure = loadingFailure(() => resolveServedModels(servedRef, context({ WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS: value })));
    expect(failure.code).toBe("env");
    expect(failure.message).toContain(`WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS ${problem}`);
  });

  it.each([["disabled"], ["enabled"]] as const)("推理开关接受 %s", (value) => {
    expect(resolveModelThinking(thinkingRef, context({ WORLD_PRISM_OPENAI_COMPAT_THINKING: ` ${value} ` }))).toBe(value);
  });

  it("推理开关未设置或为空时视为未声明", () => {
    expect(resolveModelThinking(thinkingRef, context({}))).toBeUndefined();
    expect(resolveModelThinking(thinkingRef, context({ WORLD_PRISM_OPENAI_COMPAT_THINKING: "" }))).toBeUndefined();
  });

  it.each([["minimal"], ["Disabled"], ["false"]])("推理开关拒绝取值 %s", (value) => {
    const failure = loadingFailure(() => resolveModelThinking(thinkingRef, context({ WORLD_PRISM_OPENAI_COMPAT_THINKING: value })));
    expect(failure.code).toBe("env");
    expect(failure.message).toBe("model-layout: WORLD_PRISM_OPENAI_COMPAT_THINKING 只能是 disabled 或 enabled");
  });

  it.each([
    ["别名字段引用推理开关变量", () => resolveServedModels(thinkingRef, context({})), "WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS"],
    ["推理开关引用别名变量", () => resolveModelThinking(servedRef, context({})), "WORLD_PRISM_OPENAI_COMPAT_THINKING"],
    ["推理开关引用任意变量", () => resolveModelThinking("env:LEAKED_SECRET", context({ LEAKED_SECRET: "disabled" })), "WORLD_PRISM_OPENAI_COMPAT_THINKING"],
  ])("%s时拒绝", (_label, resolve, allowed) => {
    const failure = loadingFailure(resolve);
    expect(failure.code).toBe("env");
    expect(failure.message).toBe(`model-layout: 该字段只允许引用 ${allowed}`);
  });
});
