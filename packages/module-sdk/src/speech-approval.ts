/**
 * 校验已批准对白是否可用于当前认证主体与 speech.commit 提交内容。
 * 依赖公共契约的认证上下文与 speech.commit payload 类型，以及本包的已批准对白类型；只做同步只读判断。
 * 禁止生成或改写对白、扩大受众，也禁止在批准结果写入后放宽分支、主体、turn 与受众的一致性要求。
 */
import type { AuthContext, SpeechCommitPayload } from "@ai-npc/contracts";
import type { ApprovedSpeech } from "./ports";

function normalizedAudience(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameAudience(left: readonly string[], right: readonly string[]): boolean {
  const leftValues = normalizedAudience(left);
  const rightValues = normalizedAudience(right);
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues.at(index));
}

/**
 * 批准结果必须属于当前分支、主体与 turn，并与提交的 channel/受众完全一致。
 * system 发行者由宿主代发，不比对 agentId；认证上下文未携带 turn 时不比对 turnId。
 * 返回类型是类型谓词，调用方在拒绝分支返回后可直接使用非空的批准结果。
 */
export function isApprovedSpeechUsable(
  speech: ApprovedSpeech | null,
  auth: AuthContext,
  payload: SpeechCommitPayload,
): speech is ApprovedSpeech {
  if (speech === null || !speech.approved || speech.branchId !== auth.branchId) {
    return false;
  }
  if (speech.channel !== payload.channel || !sameAudience(speech.audience, payload.audience)) {
    return false;
  }
  if (auth.kind !== "system" && speech.agentId !== (auth.actingAsAgentId ?? auth.principalId)) {
    return false;
  }
  return auth.turnId === null || speech.turnId === auth.turnId;
}
