/**
 * 校验 speech.commit payload 是否符合公共契约 schema，并取出预检字段。
 * 依赖公共契约的 payload schema 与错误类型；只做同步只读解析。
 * 禁止在这里生成对白、扩大受众，或维护与契约 schema 不同步的第二套解析；批准结果判定由 module-sdk 的共享函数提供。
 */
import { DomainError, speechCommitPayloadSchema, type Json, type SpeechCommitPayload } from "@world-prism/contracts";

/** 从已通过契约 schema 校验的 payload 中取出 speech 预检字段。 */
export function readSpeechCommitPayload(payload: Json): SpeechCommitPayload {
  const parsed = speechCommitPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "speech.commit payload 不符合公共契约", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map((segment) => String(segment)).join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}
