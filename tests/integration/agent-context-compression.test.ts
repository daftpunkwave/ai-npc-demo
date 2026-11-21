/**
 * 核心职责：验证有序上下文空段省略，以及窗口压缩的阈值、尾部保留和剔除报告。
 * 交互契约：通过 kernel 解析的小装配取得真实模块端口，不进入主装配。
 * 约束与禁忌：不得手工实例化模块或把不可压缩内容伪装为成功。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ContextArtifact } from "@ai-npc/contracts";
import { AgentContextPipeline } from "@ai-npc/agent-runtime";
import { baseContextRequest, createAgentContextToolsHarness, type AgentContextToolsHarness } from "./agent-context-tools-support";

const harnesses: AgentContextToolsHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function artifactWithHistory(): ContextArtifact {
  const request = baseContextRequest();
  return {
    artifactId: "art-000000000100",
    parentArtifactId: null,
    session: request.session,
    turnId: request.turnId,
    phase: "decision",
    frontier: request.frontier,
    profileHash: request.profileHash,
    templateVersion: request.templateVersion,
    status: "ready",
    system: "system",
    segments: [
      {
        segmentId: "history",
        kind: "history",
        role: "user",
        sourceRefs: ["dlg-000000000001", "dlg-000000000002", "dlg-000000000003", "dlg-000000000004"],
        releasePolicyIds: ["parties:human-independent,player-1"],
        text: [
          "- [dlg-000000000001] 党魁：请先准备运输队。",
          "- [dlg-000000000002] 党魁：路线还没有确认。",
          "- [dlg-000000000003] 岑雁：我知道了。",
          "- [dlg-000000000004] 党魁：那就先等消息。",
        ].join("\n"),
        tokenEstimate: 60,
        protected: false,
      },
      {
        segmentId: "memory",
        kind: "memory",
        role: "user",
        sourceRefs: ["mem-000000000001"],
        releasePolicyIds: ["parties:human-independent,player-1"],
        text: `- [mem-000000000001] ${"旧记忆".repeat(300)}`,
        tokenEstimate: 900,
        protected: false,
      },
      {
        segmentId: "world",
        kind: "world",
        role: "user",
        sourceRefs: ["world"],
        releasePolicyIds: ["public"],
        text: `- ${"旧局势".repeat(300)}`,
        tokenEstimate: 900,
        protected: false,
      },
    ],
    omissions: [],
    tokenEstimate: 1800,
    hash: "artifact-hash",
    failureReason: null,
  };
}

describe("Ordered context and window compression", () => {
  it("按 segmentOrder 输出并整体省略空段", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.none");
    harnesses.push(harness);
    const artifact = await harness.context.build(baseContextRequest());
    expect(artifact.status).toBe("ready");
    expect(artifact.segments.filter((segment) => segment.role === "user").map((segment) => segment.segmentId))
      .toEqual(["world", "task", "input"]);
    expect(artifact.segments.some((segment) => segment.segmentId === "history")).toBe(false);
    expect(artifact.segments.some((segment) => segment.segmentId === "memory")).toBe(false);
  });

  it("首轮请求前由上下文管线触发窗口压缩", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.window");
    harnesses.push(harness);
    const request = baseContextRequest();
    request.modelWindowTokens = 500;
    request.budget.maxInputTokens = 500;
    request.budget.safetyTokens = 0;
    request.budget.toolLoopReserveTokens = 100;
    request.budget.segmentBudgets.history = 5000;
    request.historyText = [
      `- [dlg-000000000001] 党魁：${"旧话".repeat(80)}`,
      `- [dlg-000000000002] 岑雁：${"回应".repeat(80)}`,
      `- [dlg-000000000003] 党魁：${"追问".repeat(80)}`,
    ].join("\n");
    const pipeline = new AgentContextPipeline({
      context: harness.context,
      compression: harness.compression,
      host: harness.host,
    });
    const prepared = await pipeline.prepareFirstRequest(request);
    expect(prepared.compressionStatus).toBe("compressed");
    expect(prepared.ready).toBe(true);
    expect(prepared.artifact.parentArtifactId).toBeTruthy();
    expect(prepared.lossReport).toMatchObject({ removed: { historyGroups: expect.any(Number) } });
  });
  it("未过阈值时不触发压缩并记录实际估值", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.window");
    harnesses.push(harness);
    const artifact = artifactWithHistory();
    artifact.tokenEstimate = 100;
    const result = harness.compression.compress({ artifact, effectiveMaxTokens: 1000, targetTokens: 600 });
    expect(result.status).toBe("not-triggered");
    expect(result.lossReport).toMatchObject({
      inputTokens: 100,
      outputTokens: 100,
      triggerTokens: 600,
      configuredTriggerTokens: 800,
    });
    expect(result.segments).toBe(artifact.segments);
  });

  it("请求目标低于触发阈值时仍按目标预算触发压缩", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.window");
    harnesses.push(harness);
    const artifact = artifactWithHistory();
    artifact.tokenEstimate = 150;
    const result = harness.compression.compress({
      artifact,
      effectiveMaxTokens: 1000,
      targetTokens: 100,
    });
    expect(result.status).toBe("compressed");
    expect(result.lossReport).toMatchObject({
      triggerTokens: 100,
      configuredTriggerTokens: 800,
      targetTokens: 100,
    });
  });

  it("受保护内容超预算时不压缩且保持失败状态", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.window");
    harnesses.push(harness);
    const request = baseContextRequest();
    request.inputText = "关".repeat(500);
    request.budget.segmentBudgets.input = 20;
    const built = await harness.context.build(request);
    expect(built.status).toBe("over-budget");
    expect(built.failureReason).toBe("protected-content-over-budget");
    const pipeline = new AgentContextPipeline({
      context: harness.context,
      compression: harness.compression,
      host: harness.host,
    });
    const prepared = await pipeline.prepareFirstRequest(request);
    expect(prepared.ready).toBe(false);
    expect(prepared.compressionStatus).toBe("not-triggered");
    expect(prepared.lossReport).toMatchObject({ reason: "ineligible-context-status" });
  });

  it("记忆未就绪时保持 not-ready 状态", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.window");
    harnesses.push(harness);
    const request = baseContextRequest();
    request.memoryBundle.status = "not-ready";
    const pipeline = new AgentContextPipeline({
      context: harness.context,
      compression: harness.compression,
      host: harness.host,
    });
    const prepared = await pipeline.prepareFirstRequest(request);
    expect(prepared.artifact.status).toBe("not-ready");
    expect(prepared.ready).toBe(false);
    expect(prepared.compressionStatus).toBe("not-triggered");
  });

  it("含 mustInclude 的记忆段标记为受保护", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const request = baseContextRequest();
    request.memoryBundle = {
      ...request.memoryBundle,
      status: "ok",
      items: [{
        memoryId: "mem-000000000001",
        kind: "episodic",
        epistemic: "verified-event",
        summaryZh: "必须保留的事实",
        validFromTick: 1,
        score: 1,
        mustInclude: true,
        releasePolicyId: "parties:human-independent,player-1",
        sourceObservationIds: ["obs-000000000001"],
      }],
    };
    const built = await harness.context.build(request);
    expect(built.segments.find((segment) => segment.kind === "memory")?.protected).toBe(true);
  });
  it("触发后保留最近历史组并按 memory、world 顺序裁剪", async () => {
    const harness = await createAgentContextToolsHarness("agent.compression.window");
    harnesses.push(harness);
    const artifact = artifactWithHistory();
    const result = harness.compression.compress({ artifact, effectiveMaxTokens: 1000, targetTokens: 600 });
    expect(result.status).toBe("compressed");
    expect(result.lossReport).toMatchObject({
      policy: "window",
      removed: {
        historyGroups: 2,
        linesByKind: {
          memory: expect.any(Number),
          world: expect.any(Number),
        },
      },
      sourceMap: { removedDialogueIds: expect.arrayContaining(["dlg-000000000001", "dlg-000000000002"]) },
    });
    expect(result.lossReport).not.toMatchObject({ outputTokens: 1800 });
    expect(result.segments.find((segment) => segment.kind === "history")?.text).toContain("更早的 3 条对话已省略");
  });
});