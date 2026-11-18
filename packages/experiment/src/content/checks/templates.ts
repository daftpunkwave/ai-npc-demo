/**
 * 校验模板与词典覆盖内容包要求的全部键。
 * 依赖 prompt 与 locale 的已校验结构与节点索引；只做键覆盖检查。
 * 禁止在此渲染模板、计算文本长度或修改内容。
 */
import type { ContentLocale, ContentNode, ContentPrompts } from "../schema/index";
import { fail } from "./common";

/** 模板与词表错误的固定来源名。 */
const localeSource = "locale/zh-CN.yaml";
const promptsSource = "prompts/zh-CN.yaml";

/** 界面文字至少需要覆盖的键。 */
const requiredUiKeys = [
  "noReply",
  "waitingReply",
  "reconnecting",
  "serverUnavailable",
  "incompleteAssembly",
  "moduleNotLoaded",
] as const;

/** 校验节点与设施名称、必需界面文字及模板版本。 */
export function checkTemplates(
  prompts: ContentPrompts,
  locale: ContentLocale,
  nodes: ReadonlyMap<string, ContentNode>,
): void {
  for (const node of nodes.values()) {
    if (locale.nodes[node.nodeId] === undefined) {
      fail(localeSource, `nodes.${node.nodeId}`, `节点「${node.nodeId}」缺少名称`);
    }
    for (const facility of node.facilities) {
      if (locale.facilities[facility] === undefined) {
        fail(localeSource, `facilities.${facility}`, `设施「${facility}」缺少名称`);
      }
    }
  }
  for (const key of requiredUiKeys) {
    if (locale.ui[key] === undefined) {
      fail(localeSource, `ui.${key}`, `界面文字缺少「${key}」`);
    }
  }
  if (prompts.templateVersion.trim() === "") {
    fail(promptsSource, "templateVersion", "模板版本不能为空");
  }
}
