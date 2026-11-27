/**
 * 核心职责：加载实验规格并与内容包、名册和 profile 补丁做交叉校验。
 * 交互契约：依赖配置加载器、内容索引与 profile 解析入口；只校验，不创建分支或启动运行。
 * 约束与禁忌：禁止在不校验脚本分支与变体补丁的情况下展开 run，也禁止静默跳过无法解析的补丁。
 */
import type { ContentPack, Roster } from "@world-prism/contracts";
import { crossCheckLoadingError, referenceLoadingError } from "../loading/errors";
import { applyProfilePatch, loadAgentProfile } from "./agent-profile";
import { experimentSpecSchema, type ExperimentSpec } from "./experiment-spec";
import { loadConfigDocument, type ConfigLoadContext, type LoadedConfig } from "./load-config";

/** 加载实验规格；文档 ID 必须与引用一致。 */
export function loadExperimentSpec(
  configRef: string,
  context: ConfigLoadContext,
): LoadedConfig<ExperimentSpec> {
  const loaded = loadConfigDocument(configRef, experimentSpecSchema, context);
  if (loaded.value.experimentId !== configRef) {
    throw referenceLoadingError(
      loaded.source,
      "experimentId",
      `实验 ID「${loaded.value.experimentId}」与引用「${configRef}」不一致`,
    );
  }
  return loaded;
}

/**
 * 交叉校验实验规格：
 * 脚本必须存在且包含声明的全部分支；公共补丁必须能依次叠加到基线 profile 上，
 * 每个变体还必须能在「基线 + 公共补丁」的结果上继续叠加；内容包与名册引用必须一致。
 *
 * 校验顺序刻意从「引用是否存在」到「补丁是否可叠加」：
 * 配置错误应在创建任何分支之前暴露，而不是在实验跑到一半时才发现某个变体不可用。
 *
 * 公共补丁先应用到基线，再逐个变体叠加：这是运行期实际生效的顺序，
 * 若改成「各补丁独立叠加到基线」，就检测不出只在组合后才出现的槽位冲突。
 */
export function validateExperimentSpec(
  spec: ExperimentSpec,
  content: ContentPack,
  roster: Roster,
  context: ConfigLoadContext,
  source = `experiment:${spec.experimentId}`,
): void {
  function fail(path: string, message: string): never {
    throw crossCheckLoadingError(source, path, message);
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

  // 脚本分支：声明必须都存在于脚本，且不得重复；反之，脚本声明了分支就不能留空，
  // 否则展开会漏掉真实分支，把多分支实验悄悄压成单次运行。
  const declaredBranches = (script.branches ?? []).map((branch) => branch.name);
  const declaredSet = new Set(declaredBranches);
  const seenBranches = new Set<string>();
  spec.scriptBranches.forEach((branch, index) => {
    if (!declaredSet.has(branch)) {
      fail(`scriptBranches.${index}`, `脚本「${script.scriptId}」没有分支「${branch}」`);
    }
    if (seenBranches.has(branch)) {
      fail(`scriptBranches.${index}`, `脚本分支「${branch}」重复声明`);
    }
    seenBranches.add(branch);
  });
  if (declaredBranches.length > 0 && spec.scriptBranches.length === 0) {
    fail(
      "scriptBranches",
      `脚本「${script.scriptId}」声明了分支 ${declaredBranches.join("、")}，实验规格不能留空`,
    );
  }

  // 变体与公共补丁不得重复、不得重叠；重复会让同一补丁被叠加两次，重叠会让同一 run 出现两个变体身份。
  const duplicates = spec.variants.filter((variant, index) => spec.variants.indexOf(variant) !== index);
  if (duplicates.length > 0) {
    fail("variants", `变体重复：${[...new Set(duplicates)].join("、")}`);
  }
  const overlapping = spec.variants.filter((variant) => spec.commonPatchRefs.includes(variant));
  if (overlapping.length > 0) {
    fail("variants", `变体不能同时出现在公共补丁中：${overlapping.join("、")}`);
  }

  // 公共补丁按声明顺序叠加到基线，变体再叠加在该结果上；这与运行期生效顺序一致。
  const baseProfile = loadAgentProfile("agent-strategic-default", context);
  let patchedProfile = baseProfile;
  spec.commonPatchRefs.forEach((patchRef, index) => {
    try {
      patchedProfile = applyProfilePatch(patchedProfile, patchRef, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`commonPatchRefs.${index}`, `公共补丁「${patchRef}」无法应用：${message}`);
    }
  });
  spec.variants.forEach((variantRef, index) => {
    try {
      applyProfilePatch(patchedProfile, variantRef, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`variants.${index}`, `变体「${variantRef}」无法在公共补丁之上应用：${message}`);
    }
  });
}
