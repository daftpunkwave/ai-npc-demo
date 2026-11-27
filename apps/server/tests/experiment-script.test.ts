/**
 * 核心职责：验证实验脚本展开为执行计划的规则：预置知识与分支追加步骤的展开、确定性命令 ID、终点 tick、
 * 受控单步分段，以及执行器不支持的脚本形态被显式拒绝。
 * 交互契约：使用内容包里的真实脚本与按实验展开得到的 RunSpec 形状；哈希用确定性替身，不访问存储。
 * 约束与禁忌：不启动宿主；断言计划的具体取值，不只检查存在性。
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, type ContentScript, type Json } from "@world-prism/contracts";
import { loadContentPack, type RunSpec } from "@world-prism/experiment";
import { nextStepTarget, planExperimentScript, scriptExtent, UnsupportedScriptError } from "../src/host/experiment-script";

const content = loadContentPack(resolve(process.cwd(), "content"), "earth-2964-v1");

function script(scriptId: string): ContentScript {
  const found = content.index.scripts.get(scriptId);
  if (found === undefined) throw new Error(`内容包缺少脚本 ${scriptId}`);
  return found;
}

function runSpec(scriptRef: string, branch: string | undefined, factionId: string | null = "human-neutral"): RunSpec {
  return {
    schemaVersion: 1, id: "plan-test", moduleAssemblyRef: "local-slg-test-v1", worldPackRef: "earth-2964-v1",
    scenarioRef: "watergate-v1", rosterRef: "core-3", modelLayoutRef: "deterministic-model-layout-v1", seed: "plan-test",
    player: { principalId: "player-1", factionId }, mode: "closed-loop", initialState: { kind: "cold-start" },
    variant: null, script: branch === undefined ? { scriptRef } : { scriptRef, branch }, clock: { kind: "controlled" },
    budget: { maxTokens: null, maxCost: null }, failurePolicy: "strict",
  };
}

const hash = (value: Json): Promise<string> => Promise.resolve(createHash("sha256").update(canonicalJson(value)).digest("hex"));

describe("实验脚本执行计划", () => {
  it("把分支追加步骤按 tick 插入主线，并为每步派生稳定的命令 ID", async () => {
    const plan = await planExperimentScript({
      script: script("s-promise"), runSpec: runSpec("s-promise", "keep"), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    expect(plan.steps.map(({ atTick, declarationIndex, command }) => [atTick, declarationIndex, command.type])).toEqual([
      [1, 0, "dialogue.say"], [2, 1, "agreement.propose"], [6, 3, "task.dispatch"], [60, 2, "dialogue.say"],
    ]);
    expect(plan.endTick).toBe(62);
    expect(plan.probeCount).toBe(1);
    expect([...plan.checkpoints.keys()]).toEqual([62]);
    for (const step of plan.steps) expect(step.commandId).toMatch(/^cmd-[0-9a-f]{12}$/u);
    const replay = await planExperimentScript({
      script: script("s-promise"), runSpec: runSpec("s-promise", "keep"), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    // 恢复执行时同一步骤必须得到同一命令 ID，命令网关才能按回执去重。
    expect(replay.steps.map(({ commandId }) => commandId)).toEqual(plan.steps.map(({ commandId }) => commandId));
    const otherRun = await planExperimentScript({
      script: script("s-promise"), runSpec: runSpec("s-promise", "keep"), runId: "run-bbbbbbbbbbbb",
      playerPrincipalId: "player-1", hash,
    });
    expect(otherRun.steps[0]?.commandId).not.toBe(plan.steps[0]?.commandId);
  });

  it("受控单步分段不越过检查点、终点与单步上限", async () => {
    const promise = await planExperimentScript({
      script: script("s-promise"), runSpec: runSpec("s-promise", "break"), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    expect(nextStepTarget(promise, 0, 24)).toBe(24);
    expect(nextStepTarget(promise, 48, 24)).toBe(62);
    expect(nextStepTarget(promise, 61, 24)).toBe(62);
    expect(nextStepTarget(promise, 62, 24)).toBe(62);
    const secret = await planExperimentScript({
      script: script("s-secret"), runSpec: runSpec("s-secret", undefined), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    // s-secret 的检查点在 tick 20：第一段只推进到检查点为止。
    expect(nextStepTarget(secret, 0, 24)).toBe(20);
    expect(scriptExtent(script("s-secret"), null)).toEqual({ endTick: 20, probeCount: 2 });
  });

  it("预置知识按声明顺序展开，命令 ID 稳定且与脚本步骤互不相同", async () => {
    const plan = await planExperimentScript({
      script: script("s-rumor"), runSpec: runSpec("s-rumor", undefined), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    expect(plan.setup.map(({ declarationIndex, evidenceId, principalId }) => [declarationIndex, evidenceId, principalId])).toEqual([
      [0, "ev-flood-log", "player-1"],
    ]);
    expect(plan.setup[0]?.commandId).toMatch(/^cmd-[0-9a-f]{12}$/u);
    // 预置与步骤共用 run 内的命令 ID 空间：同一序号不能撞上同一个 ID，否则重放会取回另一条命令的回执。
    expect(plan.steps.map(({ commandId }) => commandId)).not.toContain(plan.setup[0]?.commandId);
    expect(plan.endTick).toBe(70);
    const replay = await planExperimentScript({
      script: script("s-rumor"), runSpec: runSpec("s-rumor", undefined), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    expect(replay.setup).toEqual(plan.setup);
    const promise = await planExperimentScript({
      script: script("s-promise"), runSpec: runSpec("s-promise", "keep"), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    expect(promise.setup).toEqual([]);
  });

  it("非玩家主体的步骤与 RunSpec 开局冲突的脚本被显式拒绝", async () => {
    const base = script("s-secret");
    const actingAgent: ContentScript = {
      ...base,
      steps: [{ atTick: 1, as: "human-earth-alliance", command: { type: "policy.set", payload: { key: "watergate.allocation", value: "rotation" } } }],
    };
    await expect(planExperimentScript({
      script: actingAgent, runSpec: runSpec("s-secret", undefined), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    })).rejects.toMatchObject({ code: "script-principal-unsupported" });
    const mismatch = planExperimentScript({
      script: script("s-promise"), runSpec: runSpec("s-promise", "keep", "human-earth-alliance"), runId: "run-aaaaaaaaaaaa",
      playerPrincipalId: "player-1", hash,
    });
    await expect(mismatch).rejects.toBeInstanceOf(UnsupportedScriptError);
    await expect(mismatch).rejects.toMatchObject({ code: "script-start-mismatch" });
  });
});
