/**
 * 验证 profile 继承链合并、variant patch 顺序叠加与继承环检测。
 * 依赖 kernel 的 profile schema/resolveProfile 与测试夹具，不加载真实配置文件。
 * 禁止假设深合并、按加载顺序决定优先级，或放过重复 profile 与环。
 */
import { describe, expect, it } from "vitest";
import { profileDocumentSchema, resolveProfile, type ProfileDocument } from "../src/index";
import { detailsText, expectDomainError } from "./support";

function document(raw: unknown): ProfileDocument {
  return profileDocumentSchema.parse(raw);
}

const baseline = document({
  schemaVersion: 1,
  profileId: "platform-baseline",
  kind: "platform",
  parent: null,
  budgets: { maxModelCallsPerTurn: 6, maxDecisionRounds: 4 },
  readiness: { waitTimeoutMs: 120000 },
  slots: {
    perception: { module: "agent.perception.local", config: { visibleGraphDepth: 0 } },
    memory: { module: "agent.memory.ledger", config: { topK: 5, includeSuperseded: true } },
  },
});

const scene = document({
  schemaVersion: 1,
  profileId: "scene-watergate",
  kind: "scene",
  parent: "platform-baseline",
  scheduling: { module: "agent.scheduling.fair", config: { maxConcurrentTurns: 4 } },
});

const agentProfile = document({
  schemaVersion: 1,
  profileId: "agent-character-default",
  kind: "agent",
  parent: "scene-watergate",
  budgets: { maxDecisionRounds: 8 },
  slots: {
    memory: { module: "agent.memory.ledger", config: { topK: 9 } },
  },
});

function variant(profileId: string, patch: Record<string, unknown>): ProfileDocument {
  return document({ schemaVersion: 1, profileId, kind: "variant", patch });
}

describe("profile 继承链", () => {
  it("按父级在前合并，槽位整块替换且不深合并", () => {
    const resolved = resolveProfile({
      profiles: [baseline, scene, agentProfile],
      profileId: "agent-character-default",
    });
    expect(resolved.chain).toEqual(["platform-baseline", "scene-watergate", "agent-character-default"]);
    expect(resolved.kind).toBe("agent");
    expect(resolved.slots["memory"]).toEqual({ module: "agent.memory.ledger", config: { topK: 9 } });
    expect(resolved.slots["perception"]).toEqual({
      module: "agent.perception.local",
      config: { visibleGraphDepth: 0 },
    });
  });

  it("其他顶层键整键替换，不保留父级同名字段", () => {
    const resolved = resolveProfile({
      profiles: [baseline, scene, agentProfile],
      profileId: "agent-character-default",
    });
    expect(resolved.settings["budgets"]).toEqual({ maxDecisionRounds: 8 });
    expect(resolved.settings["readiness"]).toEqual({ waitTimeoutMs: 120000 });
    expect(resolved.settings["scheduling"]).toEqual({
      module: "agent.scheduling.fair",
      config: { maxConcurrentTurns: 4 },
    });
    expect(Object.keys(resolved.settings).sort()).toEqual(["budgets", "readiness", "scheduling"]);
    expect(resolved.appliedPatchIds).toEqual([]);
  });

  it("父级未定义时报错", () => {
    const missingParent = document({
      schemaVersion: 1,
      profileId: "agent-orphan",
      kind: "agent",
      parent: "missing-parent",
    });
    const error = expectDomainError(
      () => resolveProfile({ profiles: [missingParent], profileId: "agent-orphan" }),
      "assembly-incompatible",
    );
    expect(detailsText(error)).toContain("missing-parent");
  });

  it("重复 profileId 报错", () => {
    expectDomainError(
      () => resolveProfile({ profiles: [scene, scene], profileId: "scene-watergate" }),
      "assembly-incompatible",
    );
  });

  it("继承环报错并给出环路", () => {
    const first = document({ schemaVersion: 1, profileId: "agent-a", kind: "agent", parent: "agent-b" });
    const second = document({ schemaVersion: 1, profileId: "agent-b", kind: "agent", parent: "agent-a" });
    const error = expectDomainError(
      () => resolveProfile({ profiles: [first, second], profileId: "agent-a" }),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("agent-a");
    expect(error.safeMessage).toContain("agent-b");
    expect(error.safeMessage).toContain("->");
    expect(detailsText(error)).toContain("agent-a");
  });

  it("variant 不能作为基线 profile", () => {
    const patch = variant("memory-m0-window", { slots: { memory: { module: "agent.memory.none", config: {} } } });
    expectDomainError(
      () => resolveProfile({ profiles: [patch], profileId: "memory-m0-window" }),
      "assembly-incompatible",
    );
  });

  it("非 variant 声明 patch 报错", () => {
    const invalid = document({
      schemaVersion: 1,
      profileId: "agent-invalid",
      kind: "agent",
      parent: null,
      patch: { slots: {} },
    });
    expectDomainError(
      () => resolveProfile({ profiles: [invalid], profileId: "agent-invalid" }),
      "assembly-incompatible",
    );
  });
});

describe("variant patch 叠加", () => {
  const patchOne = variant("memory-m0-window", {
    slots: { memory: { module: "agent.memory.none", config: {} } },
    budgets: { maxModelCallsPerTurn: 10 },
  });
  const patchTwo = variant("decision-deterministic", {
    slots: { memory: { module: "agent.memory.ledger", config: { topK: 2 } } },
    budgets: { maxDecisionRounds: 20 },
  });

  it("两个 patch 依次叠加，后一个覆盖同名槽与同名键", () => {
    const resolved = resolveProfile({
      profiles: [baseline, scene, agentProfile, patchOne, patchTwo],
      profileId: "agent-character-default",
      patchProfileIds: ["memory-m0-window", "decision-deterministic"],
    });
    expect(resolved.slots["memory"]).toEqual({ module: "agent.memory.ledger", config: { topK: 2 } });
    expect(resolved.slots["perception"]).toEqual({
      module: "agent.perception.local",
      config: { visibleGraphDepth: 0 },
    });
    expect(resolved.settings["budgets"]).toEqual({ maxDecisionRounds: 20 });
    expect(resolved.appliedPatchIds).toEqual(["memory-m0-window", "decision-deterministic"]);
  });

  it("交换 patch 顺序后结果随顺序变化", () => {
    const resolved = resolveProfile({
      profiles: [baseline, scene, agentProfile, patchOne, patchTwo],
      profileId: "agent-character-default",
      patchProfileIds: ["decision-deterministic", "memory-m0-window"],
    });
    expect(resolved.slots["memory"]).toEqual({ module: "agent.memory.none", config: {} });
    expect(resolved.settings["budgets"]).toEqual({ maxModelCallsPerTurn: 10 });
  });

  it("patch 引用未定义时报错", () => {
    expectDomainError(
      () =>
        resolveProfile({
          profiles: [baseline],
          profileId: "platform-baseline",
          patchProfileIds: ["missing-variant"],
        }),
      "assembly-incompatible",
    );
  });

  it("variant 缺少 patch 报错", () => {
    const emptyVariant = document({ schemaVersion: 1, profileId: "empty-variant", kind: "variant" });
    expectDomainError(
      () =>
        resolveProfile({
          profiles: [baseline, emptyVariant],
          profileId: "platform-baseline",
          patchProfileIds: ["empty-variant"],
        }),
      "assembly-incompatible",
    );
  });

  it("patch 不能覆盖元数据键", () => {
    const metadataPatch = variant("bad-variant", { parent: "platform-baseline" });
    expectDomainError(
      () =>
        resolveProfile({
          profiles: [baseline, metadataPatch],
          profileId: "platform-baseline",
          patchProfileIds: ["bad-variant"],
        }),
      "assembly-incompatible",
    );
  });
});
