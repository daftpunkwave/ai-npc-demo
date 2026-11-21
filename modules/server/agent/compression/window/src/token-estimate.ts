/**
 * 核心职责：提供窗口压缩使用的确定性 token 估值。
 * 交互契约：文本估值与 context estimate-v1 保持同一字符分类。
 * 约束与禁忌：不得调用供应商计数接口。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateArtifactTokens(system: string, userTexts: readonly string[]): number {
  return estimateTokens(system) + estimateTokens(userTexts.join("\n\n")) + 4;
}