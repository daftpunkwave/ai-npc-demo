/**
 * 验证 speech.commit 批准结果与认证主体、turn、渠道和受众的一致性判定。
 * 依赖 module-sdk 的共享判定函数与公共契约的认证上下文、payload 类型；不经过命令网关。
 * 禁止在测试中复制一份宽松判定，或放宽受众、批准结果引用等约束。
 */
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@world-prism/contracts";
import { isApprovedSpeechUsable, type ApprovedSpeech } from "../src/index";

const branchId = "br-000000000000";

const speechPayload = {
  channel: "dialogue" as const,
  conversationId: null,
  audience: ["npc-cenyuan"],
  approvedSpeechArtifactRef: "art-k3j9x0a1b2c3",
  intentKind: "none" as const,
  replyToId: null,
};

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principalId: "npc-wenyuan",
    kind: "agent",
    roles: ["agent"],
    worldId: "wld-000000000000",
    branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
    ...overrides,
  };
}

function approvedSpeech(overrides: Partial<ApprovedSpeech> = {}): ApprovedSpeech {
  return {
    text: "我会处理。",
    agentId: "npc-wenyuan",
    turnId: "turn-000000000001",
    branchId,
    audience: ["npc-cenyuan"],
    channel: "dialogue",
    approved: true,
    ...overrides,
  };
}

describe("speech.commit 批准结果判定", () => {
  it("agent 主体要求 artifact 的 agentId 与 turnId 同时匹配", () => {
    expect(isApprovedSpeechUsable(approvedSpeech(), auth(), speechPayload)).toBe(true);
    expect(isApprovedSpeechUsable(approvedSpeech({ agentId: "npc-yinuo" }), auth(), speechPayload)).toBe(false);
    expect(
      isApprovedSpeechUsable(approvedSpeech({ turnId: "turn-000000000002" }), auth({ turnId: "turn-000000000001" }), speechPayload),
    ).toBe(false);
    expect(
      isApprovedSpeechUsable(approvedSpeech({ turnId: "turn-000000000001" }), auth({ turnId: "turn-000000000001" }), speechPayload),
    ).toBe(true);
  });

  it("system 主体按宿主代发处理：不比对 agentId，但批准结果与携带的 turn 仍须一致", () => {
    const system = auth({ principalId: "system:world", kind: "system", roles: [] });
    expect(isApprovedSpeechUsable(approvedSpeech(), system, speechPayload)).toBe(true);
    expect(isApprovedSpeechUsable(approvedSpeech({ approved: false }), system, speechPayload)).toBe(false);
    // 系统上下文通常没有 turn；没有 turn 时不比对 artifact 的 turnId。
    expect(isApprovedSpeechUsable(approvedSpeech({ turnId: "turn-000000000099" }), system, speechPayload)).toBe(true);
    expect(
      isApprovedSpeechUsable(
        approvedSpeech({ turnId: "turn-000000000099" }),
        { ...system, turnId: "turn-000000000001" },
        speechPayload,
      ),
    ).toBe(false);
  });

  it("真人席位按被代发 Agent 比对 agentId，并同样校验 turn", () => {
    const seat = auth({ principalId: "operator-1", kind: "operator", roles: ["operator"], actingAsAgentId: "npc-wenyuan" });
    expect(isApprovedSpeechUsable(approvedSpeech(), seat, speechPayload)).toBe(true);
    expect(isApprovedSpeechUsable(approvedSpeech({ agentId: "npc-yinuo" }), seat, speechPayload)).toBe(false);
    expect(
      isApprovedSpeechUsable(
        approvedSpeech({ turnId: "turn-000000000002" }),
        { ...seat, turnId: "turn-000000000001" },
        speechPayload,
      ),
    ).toBe(false);
  });

  it("system 以脚本控制代某个 Agent 发行时按被代发 Agent 比对，不沿用宿主代发的豁免", () => {
    const scripted = auth({ principalId: "npc-wenyuan", kind: "system", roles: [], actingAsAgentId: "npc-wenyuan", controllerEpoch: 2 });
    expect(isApprovedSpeechUsable(approvedSpeech(), scripted, speechPayload)).toBe(true);
    expect(isApprovedSpeechUsable(approvedSpeech({ agentId: "npc-yinuo" }), scripted, speechPayload)).toBe(false);
  });

  it("未批准、channel、受众与分支不匹配时一律拒绝", () => {
    const system = auth({ principalId: "system:world", kind: "system", roles: [] });
    expect(isApprovedSpeechUsable(null, system, speechPayload)).toBe(false);
    expect(isApprovedSpeechUsable(approvedSpeech({ channel: "message" }), system, speechPayload)).toBe(false);
    expect(isApprovedSpeechUsable(approvedSpeech({ audience: ["npc-yinuo"] }), system, speechPayload)).toBe(false);
    expect(isApprovedSpeechUsable(approvedSpeech({ branchId: "br-000000000001" }), system, speechPayload)).toBe(false);
    // 受众比较先去重排序，顺序不同或重复不影响判定。
    expect(
      isApprovedSpeechUsable(approvedSpeech({ audience: ["npc-cenyuan", "npc-cenyuan"] }), system, speechPayload),
    ).toBe(true);
  });
});
