/**
 * 验证命令幂等哈希的固定算法约束。
 * 依赖 authority 的 commandPayloadHash 与公共契约命令信封类型；不使用存储、事务或真实模块。
 * 禁止让幂等键随注入的宿主哈希实现变化——那会让同一命令在更换宿主后被判成内容冲突。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type CommandEnvelope } from "@world-prism/contracts";
import { commandPayloadHash } from "../src/command-gateway";

const envelope: CommandEnvelope = {
  commandId: "cmd-000000000001",
  type: "policy.set",
  schemaVersion: 1,
  payload: { key: "water.ration", value: "strict" },
};

/** 独立复算固定口径：规范 JSON 上的 SHA-256，不经过 authority 内部实现。 */
function fixedSha256(envelope: CommandEnvelope): string {
  return createHash("sha256").update(canonicalJson({
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    expectedVersions: envelope.expectedVersions ?? null,
    payload: envelope.payload,
  })).digest("hex");
}

describe("命令幂等哈希口径", () => {
  it("摘要等于规范 JSON 的固定 SHA-256，与注入的宿主哈希实现无关", () => {
    // 替换 host.hash 不会改变本函数签名与结果：它不接受宿主，因此无法随宿主实现漂移。
    expect(commandPayloadHash(envelope)).toBe(fixedSha256(envelope));
    expect(commandPayloadHash(envelope)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同一内容的不同对象字面量得到同一摘要", () => {
    const reordered: CommandEnvelope = {
      payload: { value: "strict", key: "water.ration" },
      schemaVersion: 1,
      type: "policy.set",
      commandId: "cmd-000000000001",
    };
    expect(commandPayloadHash(reordered)).toBe(commandPayloadHash(envelope));
  });

  it("payload 或 type 变化必须得出不同摘要", () => {
    const base = commandPayloadHash(envelope);
    expect(commandPayloadHash({ ...envelope, payload: { key: "water.ration", value: "loose" } })).not.toBe(base);
    expect(commandPayloadHash({ ...envelope, type: "clock.step" })).not.toBe(base);
    expect(commandPayloadHash({ ...envelope, expectedVersions: { policy: 2 } } as CommandEnvelope)).not.toBe(base);
  });
});
