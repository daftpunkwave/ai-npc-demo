/**
 * 校验 speech.commit 引用的人工批准结果是否可用于当前主体与受众。
 * 依赖公共契约的认证上下文和 module-sdk 的已批准对白类型；只做同步只读判断。
 * 禁止在这里生成对白、扩大受众或把未批准结果当作可提交事实。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的联合类型误判为 any。 */
import { DomainError, type AuthContext, type Json } from "@ai-npc/contracts";
import type { ApprovedSpeech } from "@ai-npc/module-sdk";

/** speech.commit 中 authority 需要预检的字段。 */
export interface SpeechCommitPayload {
  readonly approvedSpeechArtifactRef: string;
  readonly channel: "dialogue" | "message" | "broadcast";
  readonly audience: readonly string[];
}

/** 从已通过契约 schema 校验的 payload 中取出 speech 预检字段。 */
export function readSpeechCommitPayload(payload: Json): SpeechCommitPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new DomainError("invalid-state", "speech.commit payload 不是对象");
  }
  const ref = payload["approvedSpeechArtifactRef"];
  const channel = payload["channel"];
  const audience = payload["audience"];
  if (typeof ref !== "string" || ref.length === 0) {
    throw new DomainError("invalid-state", "speech.commit payload 缺少批准结果引用");
  }
  if (channel !== "dialogue" && channel !== "message" && channel !== "broadcast") {
    throw new DomainError("invalid-state", "speech.commit payload 的 channel 不合法");
  }
  if (!Array.isArray(audience) || audience.some((item) => typeof item !== "string")) {
    throw new DomainError("invalid-state", "speech.commit payload 的 audience 不合法");
  }
  return { approvedSpeechArtifactRef: ref, channel, audience: audience as string[] };
}

function normalizedAudience(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameAudience(left: readonly string[], right: readonly string[]): boolean {
  const leftValues = normalizedAudience(left);
  const rightValues = normalizedAudience(right);
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues.at(index));
}

/** 批准结果必须属于当前分支、主体与 turn，并与提交的 channel/受众完全一致。 */
export function isApprovedSpeechUsable(
  speech: ApprovedSpeech | null,
  auth: AuthContext,
  payload: SpeechCommitPayload,
): boolean {
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
