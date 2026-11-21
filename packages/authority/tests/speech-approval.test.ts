/**
 * 验证 speech.commit 预检直接复用公共契约 schema。
 * 依赖 authority 的预检入口与公共契约的 payload schema；不经过命令网关。
 * 禁止在测试中复制一份宽松解析或放宽受众、批准结果引用等约束。
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "@ai-npc/contracts";
import { readSpeechCommitPayload } from "../src/speech-approval";

const validPayload = {
  channel: "dialogue" as const,
  conversationId: null,
  audience: ["npc-cenyan"],
  approvedSpeechArtifactRef: "art-k3j9x0a1b2c3",
  intentKind: "inform" as const,
  replyToId: null,
};

function expectRejected(payload: unknown): void {
  let caught: unknown;
  try {
    readSpeechCommitPayload(payload as never);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe("invalid-state");
}

describe("speech.commit 预检", () => {
  it("接受契约 schema 允许的 payload", () => {
    expect(readSpeechCommitPayload(validPayload)).toEqual(validPayload);
  });

  it("拒绝空受众、错误引用格式、未知渠道与多余字段", () => {
    expectRejected({ ...validPayload, audience: [] });
    expectRejected({ ...validPayload, approvedSpeechArtifactRef: "not-an-artifact" });
    expectRejected({ ...validPayload, channel: "whisper" });
    expectRejected({ ...validPayload, extra: true });
  });

  it("拒绝缺少字段与错误类型", () => {
    expectRejected({ ...validPayload, audience: undefined });
    expectRejected({ ...validPayload, audience: [1] });
    expectRejected({ ...validPayload, conversationId: "conv-1" });
  });
});
