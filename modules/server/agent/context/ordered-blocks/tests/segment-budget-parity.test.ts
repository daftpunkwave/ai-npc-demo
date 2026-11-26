/**
 * 核心职责：锁定段预算的段名在公共契约与有序段落模块配置之间只有一份来源。
 * 交互契约：只使用 ContextBuildRequest 预算 schema 与模块配置 schema，不启动模块或读取存储。
 * 约束与禁忌：不得复制段名清单或按段名写死例外。
 */
import { describe, expect, it } from "vitest";
import {
  contextSegmentBudgetsSchema,
  contextSegmentKindValues,
  contextUserSegmentKindSchema,
  contextUserSegmentKindValues,
} from "@world-prism/contracts";
import { orderedBlocksContextConfigSchema } from "../src/definition";

/** 已知段名的合法配置：契约与模块配置两侧都必须接受。 */
const knownKinds = contextSegmentKindValues;

describe("段预算段名的单一来源", () => {
  it("契约与模块配置对每个已登记段名给出一致结论", () => {
    for (const kind of knownKinds) {
      expect(contextSegmentBudgetsSchema.safeParse({ [kind]: 100 }).success).toBe(true);
      expect(
        orderedBlocksContextConfigSchema.safeParse({
          decision: { maxInputTokens: 8000, safetyTokens: 300, toolLoopReserveTokens: 1600, segmentBudgets: { [kind]: 100 } },
        }).success,
      ).toBe(true);
    }
  });

  it("契约与模块配置都拒绝未登记的段名", () => {
    const unknownKinds = ["memories", "worlds", "task ", ""];
    for (const kind of unknownKinds) {
      expect(contextSegmentBudgetsSchema.safeParse({ [kind]: 100 }).success).toBe(false);
      expect(
        orderedBlocksContextConfigSchema.safeParse({
          decision: { maxInputTokens: 8000, safetyTokens: 300, toolLoopReserveTokens: 1600, segmentBudgets: { [kind]: 100 } },
        }).success,
      ).toBe(false);
    }
  });

  it("user 段枚举是段预算键的真子集，facts 只出现在段预算键里", () => {
    expect([...knownKinds]).toEqual([...contextUserSegmentKindValues, "facts"]);
    expect(contextUserSegmentKindSchema.safeParse("facts").success).toBe(false);
  });

  it("段预算值必须是整数且非负，两侧判定一致", () => {
    for (const value of [-1, 12.5]) {
      expect(contextSegmentBudgetsSchema.safeParse({ memory: value }).success).toBe(false);
      expect(
        orderedBlocksContextConfigSchema.safeParse({
          speech: { maxInputTokens: 2500, safetyTokens: 200, segmentBudgets: { memory: value } },
        }).success,
      ).toBe(false);
    }
  });
});
