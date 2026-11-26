/**
 * 核心职责：用真实 profile 锁定记忆检索预算的取值来源与大小。
 * 交互契约：加载 config/profiles 下的实际 profile，只读槽位配置与解析后的预算。
 * 约束与禁忌：不得在为既有 profile 加默认值时改变其实际检索上限。
 */
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentProfile } from "@world-prism/experiment";
import { memoryRetrievalBudget } from "../src/turn-materials";

// 仓库根由测试文件位置反推，避免依赖进程工作目录；与配置加载测试的取法一致。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configDir = resolve(repoRoot, "config");

describe("真实 profile 的记忆检索预算", () => {
  it.each([
    { profileId: "agent-character-default", expectedTokens: 1000 },
    { profileId: "agent-strategic-default", expectedTokens: 900 },
  ])("$profileId 的检索预算显式声明且与改动前的上下文段配额一致", ({ profileId, expectedTokens }) => {
    const profile = loadAgentProfile(profileId, { configDir });
    const context = (profile.slots.context?.config ?? {}) as Record<string, unknown>;
    const decision = (context["decision"] ?? {}) as Record<string, unknown>;
    const segmentBudgets = (decision["segmentBudgets"] ?? {}) as Record<string, unknown>;

    // 改动前检索上限取自 context 的 decision.segmentBudgets.memory（缺失时 1000）。
    // 迁移到 memory 槽位后必须逐 profile 保持同一个数值，不能靠默认值碰巧相同。
    expect(segmentBudgets["memory"]).toBe(expectedTokens);
    expect(memoryRetrievalBudget(profile)).toEqual({ maxItems: 8, maxTokens: expectedTokens });
  });
});
