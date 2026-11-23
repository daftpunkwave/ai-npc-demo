/**
 * 核心职责：加载实验规格并与内容包、名册和 profile 补丁做交叉校验。
 * 交互契约：依赖配置加载器、内容索引与 profile 解析入口；只校验，不创建分支或启动运行。
 * 约束与禁忌：禁止在不校验脚本分支与变体补丁的情况下展开 run，也禁止静默跳过无法解析的补丁。
 */
import type { ContentPack } from "../content/load-content-pack";
import { LoadingError } from "../loading/errors";
import { applyProfilePatch, loadAgentProfile } from "./agent-profile";
import { experimentSpecSchema, type ExperimentSpec } from "./experiment-spec";
import { loadConfigDocument, type ConfigLoadContext, type LoadedConfig } from "./load-config";
import type { Roster } from "./schema";

/** 加载实验规格；文档 ID 必须与引用一致。 */
export function loadExperimentSpec(
  configRef: string,
  context: ConfigLoadContext,
): LoadedConfig<ExperimentSpec> {
  const loaded = loadConfigDocument(configRef, experimentSpecSchema, context);
  if (loaded.value.experimentId !== configRef) {
    throw new LoadingError({
      code: "reference",
      source: loaded.source,
      path: "experimentId",
      message: `实验 ID「${loaded.value.experimentId}」与引用「${configRef}」不一致`,
    });
  }
  return loaded;
}

/**
 * 交叉校验实验规格：
 * 脚本必须存在且包含声明的全部分支；变体与公共补丁必须能从基线 profile 叠加解析；
 * 内容包必须与模板的世界包一致，名册引用必须与模板一致。
 *
 * 校验顺序刻意从「引用是否存在」到「补丁是否可叠加」：
 * 配置错误应在创建任何分支之前暴露，而不是在实验跑到一半时才发现某个变体不可用。
 */
export function validateExperimentSpec(
  spec: ExperimentSpec,
  content: ContentPack,
  roster: Roster,
  context: ConfigLoadContext,
  source = `experiment:${spec.experimentId}`,
): void {
  function fail(path: string, message: string): never {
    throw new LoadingError({ code: "cross-check", source, path, message });
  }
  if (spec.base.worldPackRef !== content.pack.packId) {
    fail("base.worldPackRef", `内容包「${spec.base.worldPackRef}」与已加载内容包「${content.pack.packId}」不一致`);
  }
  if (spec.base.rosterRef !== roster.rosterId) {
    fail("base.rosterRef", `名册引用「${spec.base.rosterRef}」与已加载名册「${roster.rosterId}」不一致`);
  }
  if (!content.index.scenarios.has(spec.base.scenarioRef)) {
    fail("base.scenarioRef", `剧情「${spec.base.scenarioRef}」不存在`);
  }
  const script = content.index.scripts.get(spec.scriptRef);
  if (script === undefined) {
    fail("scriptRef", `脚本「${spec.scriptRef}」不存在`);
  }
  if (script.rosterRef !== spec.base.rosterRef) {
    fail("scriptRef", `脚本「${script.scriptId}」要求名册「${script.rosterRef}」，与模板的「${spec.base.rosterRef}」不一致`);
  }
  const scriptBranches = new Set((script.branches ?? []).map((branch) => branch.name));
  spec.scriptBranches.forEach((branch, index) => {
    if (!scriptBranches.has(branch)) {
      fail(`scriptBranches.${index}`, `脚本「${script.scriptId}」没有分支「${branch}」`);
    }
  });
  // 变体与公共补丁必须能在基线 profile 上依次叠加；任一不可解析都在预检阶段失败。
  const baseProfile = loadAgentProfile("agent-strategic-default", context);
  for (const [index, patchRef] of [...spec.commonPatchRefs, ...spec.variants].entries()) {
    try {
      applyProfilePatch(baseProfile, patchRef, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`variants.${index}`, `补丁「${patchRef}」无法应用：${message}`);
    }
  }
  const duplicates = spec.variants.filter((variant, index) => spec.variants.indexOf(variant) !== index);
  if (duplicates.length > 0) {
    fail("variants", `变体重复：${[...new Set(duplicates)].join("、")}`);
  }
  if (spec.variants.some((variant) => spec.commonPatchRefs.includes(variant))) {
    fail("variants", "变体不能同时出现在公共补丁中");
  }
}
