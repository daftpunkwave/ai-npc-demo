/**
 * 共享上下文、预算与确定性传输使用的 estimate-v1 口径。
 * 输入为模型可见的文本或规范化请求，不依赖供应商 tokenizer。
 * 禁止把估算值标记为供应商报告的实际 token 数。
 */
import { canonicalJson } from "./json";
import type { ModelRequest } from "./model";

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateSystemAndUserTokens(system: string, userText: string): number {
  return estimateTokens(system) + estimateTokens(userText) + 4;
}

/** 计入供应商实际回放的 assistant 消息、工具 schema 和结构化输出协议。 */
export function estimateModelInputTokens(request: {
  readonly system: string;
  readonly messages: readonly ModelRequest["messages"][number][];
  readonly tools: readonly ModelRequest["tools"][number][];
  readonly output: ModelRequest["output"];
}): number {
  const messages = request.messages.reduce((tokens, message) => {
    if (message.role !== "assistant") return tokens + estimateTokens(message.content) + 4;
    const body = message.providerReplay ?? {
      content: message.content,
      toolCalls: message.toolCalls.map(({ id, name, argumentsRaw }) => ({ id, name, argumentsRaw })),
    };
    return tokens + estimateTokens(canonicalJson(body)) + 4;
  }, 0);
  return estimateTokens(request.system) + messages +
    (request.tools.length === 0 ? 0 : estimateTokens(canonicalJson([...request.tools]))) +
    (request.output.kind === "text" ? 0 : estimateTokens(canonicalJson(request.output)));
}
