/**
 * 核心职责：按固定规则估算上下文文本的模型 token 数量。
 * 交互契约：接收纯文本，返回可重复计算的 estimate-v1 口径结果。
 * 约束与禁忌：不得调用供应商 tokenizer，也不得把估值当成实际计费 usage。
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

/** Estimate a system block plus one user message with a stable message overhead. */
export function estimateSystemAndUserTokens(system: string, userText: string): number {
  return estimateTokens(system) + estimateTokens(userText) + 4;
}