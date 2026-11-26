/**
 * 核心职责：把窗口压缩使用的文本估值接到 estimate-v1 单一实现上。
 * 交互契约：`estimateTokens` 直接复用公共契约，本文件只补充按段拼接的请求估值。
 * 约束与禁忌：不得调用供应商计数接口，也不得在这里保留第二套字符分类。
 */
import { estimateSystemAndUserTokens, estimateTokens } from "@world-prism/contracts";

export { estimateTokens };

/** 请求估值：system 与 user 段按空行拼接后计入固定 4 个消息开销。 */
export function estimateArtifactTokens(system: string, userTexts: readonly string[]): number {
  return estimateSystemAndUserTokens(system, userTexts.join("\n\n"));
}
