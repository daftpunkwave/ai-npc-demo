/**
 * 核心职责：按 context estimate-v1 口径计算文本与请求的 token 估值。
 * 交互契约：只接收字符串，返回非负整数且不依赖供应商 tokenizer。
 * 约束与禁忌：不得读取环境、模型能力或实际 usage。
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

export function estimateContextTokens(system: string, userSegments: readonly string[]): number {
  return estimateTokens(system) + estimateTokens(userSegments.join("\n\n")) + 4;
}