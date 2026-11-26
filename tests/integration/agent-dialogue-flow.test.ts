/**
 * 核心职责：验证 speech 请求隔离、四项校验、安全模板、秘密泄漏与进行中任务状态拦截。
 * 交互契约：使用真实内容包、持久化 artifact 和注入的 speech.commit executor。
 * 约束与禁忌：不得把 decision 隐藏文本注入 speech，也不得把失败校验的正文提交发布。
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandEnvelope,
  CommandReceipt,
  DialogueIntent,
  Json,
} from "@world-prism/contracts";
import {
  DialogueFlow,
  SpeechApprovalIndex,
  StoredAgentArtifactStore,
  renderSafeSpeech,
  type SpeechApprovalInput,
  type ToolGatewayTurn,
} from "@world-prism/agent-runtime";
import {
  createAgentContextToolsHarness,
  testAgentId,
  testBranchId,
  testRunId,
  testTurnId,
  testWorldId,
  testAuth,
  type AgentContextToolsHarness,
} from "./agent-context-tools-support";

const harnesses: AgentContextToolsHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function intent(kind: DialogueIntent["kind"], factRefs: readonly string[] = []): DialogueIntent {
  return {
    kind,
    audience: ["player-1"],
    tone: "neutral",
    reasonCode: kind === "refuse" ? "danger" : "none",
    subjectRef: factRefs[0] ?? null,
    factRefs: [...factRefs],
  };
}

function speechInput(options: {
  readonly intent: DialogueIntent;
  readonly leaks?: readonly string[];
  readonly taskStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly factSummary?: string;
  readonly rejectedCommand?: boolean;
  readonly rejectedToolCommand?: boolean;
}): SpeechApprovalInput {
  const facts = options.factSummary === undefined ? [] : [{
    ref: "ev-000000000001",
    releasePolicyId: "parties:human-independent,player-1",
    summaryZh: options.factSummary,
  }];
  return {
    session: { worldId: testWorldId, branchId: testBranchId, agentId: testAgentId },
    runId: testRunId,
    turnId: testTurnId,
    agentId: testAgentId,
    auth: testAuth(),
    intent: options.intent,
    facts,
    history: [],
    ...(options.rejectedToolCommand === undefined ? {} : { rejectedToolCommand: options.rejectedToolCommand }),
    receipts: options.rejectedCommand === true
      ? [{ receiptId: "rcp-000000000002", commandStatus: "rejected", taskStatus: null, detail: "请求被拒绝" }]
      : options.taskStatus === undefined ? [] : [{
        receiptId: "rcp-000000000001",
        commandStatus: "accepted",
        taskStatus: options.taskStatus,
        detail: "task accepted",
      }],
    secrets: options.leaks === undefined ? [] : [{ secretId: "sec-000000000001", leakTerms: options.leaks }],
    principalFactions: new Map([
      ["human-independent", "human-independent"],
      ["player-1", "human-commune"],
    ]),
    heldEvidenceIds: new Map(),
    heldSecretIds: new Map([
      ["human-independent", new Set(["sec-000000000001"])],
      ["player-1", new Set<string>()],
    ]),
    principalNames: new Map([
      ["human-independent", "岑雁"],
      ["player-1", "党魁"],
    ]),
    speechStyle: "克制、直接",
    maxChars: 80,
    subjectLine: "补给安排",
    channel: "dialogue",
    conversationId: "conv-000000000001",
    replyToId: null,
  };
}

function receipt(host: AgentContextToolsHarness["host"], envelope: CommandEnvelope): CommandReceipt {
  return {
    receiptId: host.ids("rcp"),
    commandId: envelope.commandId,
    commandStatus: "accepted",
    reasonCode: null,
    safeMessage: null,
    acceptedEventIds: [],
    operationId: null,
    resultingVersions: {},
    result: null,
    worldTick: 20,
  };
}

function flow(harness: AgentContextToolsHarness, envelopes: CommandEnvelope[]) {
  const artifacts = new StoredAgentArtifactStore(harness.storage, harness.host);
  const approvals = new SpeechApprovalIndex();
  const dialogue = new DialogueFlow({
    host: harness.host,
    artifacts,
    approvals,
    content: harness.content,
    executeCommand: (_auth, envelope) => {
      envelopes.push(envelope);
      return receipt(harness.host, envelope);
    },
  });
  return { dialogue, artifacts, approvals };
}

describe("Dialogue flow", () => {
  it("speech 请求不携带秘密，leakTerms 命中时回退安全模板并提交批准 artifact", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const envelopes: CommandEnvelope[] = [];
    const setup = flow(harness, envelopes);
    let attempts = 0;
    const result = await setup.dialogue.commit(speechInput({
      intent: intent("answer"),
      leaks: ["北侧", "撤离"],
    }), (request) => {
      attempts += 1;
      expect(Object.keys(request).sort()).toEqual(["output", "system", "user"]);
      return { utterance: "根庭会从北侧撤离。", citedRefs: [] };
    });
    expect(attempts).toBe(2);
    expect(result.artifact.fallback).toBe(true);
    expect(result.artifact.text).not.toContain("北侧");
    expect(result.preparation.request.user).not.toContain("北侧");
    expect(envelopes).toHaveLength(1);
    const sent = envelopes[0];
    if (sent === undefined) throw new Error("speech.commit envelope is missing");
    expect(sent.type).toBe("speech.commit");
    expect((sent.payload as { readonly approvedSpeechArtifactRef: string }).approvedSpeechArtifactRef)
      .toBe(result.artifact.artifactId);
    expect(setup.approvals.read(result.artifact.artifactId)?.approved).toBe(true);
    const validation = result.artifact.validation as unknown as {
      readonly finalValidation: { readonly checks: readonly { readonly name: string }[] };
    };
    expect(validation.finalValidation.checks.map((check) => check.name)).toEqual([
      "schema",
      "cited-refs",
      "leak-terms",
      "status-claims",
    ]);
  });

  it("权威拒绝回执未进入可披露事实时，对白守卫仍拦截把动作说成成功的声明", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const setup = flow(harness, []);
    // 拒绝回执本身不出现在 receipts 里，只能靠 rejectedToolCommand 布尔证据触发状态守卫。
    const result = await setup.dialogue.approve(speechInput({
      intent: intent("answer"),
      rejectedToolCommand: true,
    }), () => ({ utterance: "护送已经安排，请放心。", citedRefs: [] }));
    expect(result.artifact.fallback).toBe(true);
    expect(result.artifact.text).not.toContain("已经安排");
    const validation = result.artifact.validation as unknown as {
      readonly attempts: readonly { readonly failedChecks: readonly string[] }[];
    };
    expect(validation.attempts.every((attempt) => attempt.failedChecks.includes("status-claims"))).toBe(true);
  });

  it("拒绝回执进入可披露事实时模型完成声明被拦截并回退安全模板", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const setup = flow(harness, []);
    const result = await setup.dialogue.approve(speechInput({
      intent: intent("answer"),
      rejectedCommand: true,
      factSummary: "护送请求已登记",
    }), () => ({ utterance: "任务已经完成，请放心。", citedRefs: [] }));
    expect(result.artifact.fallback).toBe(true);
    expect(result.artifact.text).not.toContain("已经完成");
    const validation = result.artifact.validation as unknown as {
      readonly attempts: readonly { readonly failedChecks: readonly string[] }[];
    };
    expect(validation.attempts.every((attempt) => attempt.failedChecks.includes("status-claims"))).toBe(true);
  });

  it("进行中的任务拦截“已经送到”类完成声明", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const setup = flow(harness, []);
    const result = await setup.dialogue.commit(speechInput({
      intent: intent("answer"),
      taskStatus: "pending",
    }), () => ({ utterance: "补给已经送到。", citedRefs: [] }));
    expect(result.artifact.fallback).toBe(true);
    expect(result.artifact.text).not.toContain("已经送到");
    const validation = result.artifact.validation as unknown as {
      readonly attempts: readonly { readonly failedChecks: readonly string[] }[];
    };
    expect(validation.attempts.every((attempt) => attempt.failedChecks.includes("status-claims"))).toBe(true);
  });

  it("失败、取消或缺少完成凭据时仍拦截完成声明", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const setup = flow(harness, []);
    for (const taskStatus of ["failed", "cancelled"] as const) {
      const result = await setup.dialogue.approve(speechInput({
        intent: intent("answer"),
        taskStatus,
      }), () => ({ utterance: "补给已经完成。", citedRefs: [] }));
      expect(result.artifact.fallback, taskStatus).toBe(true);
    }
    const missingReceipt = await setup.dialogue.approve(speechInput({ intent: intent("answer") }), () =>
      ({ utterance: "补给已经完成。", citedRefs: [] }));
    expect(missingReceipt.artifact.fallback).toBe(true);
  });
  it("每个 intent 都能由安全模板生成非空且无占位符的对白", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const kinds: readonly Exclude<DialogueIntent["kind"], "none">[] = [
      "acknowledge", "answer", "agree", "refuse", "counter-offer", "request", "inform",
      "warn", "thank", "apologize", "decline-to-disclose", "report-result", "remind",
    ];
    const fact = {
      ref: "ev-000000000001",
      releasePolicyId: "parties:human-independent,player-1",
      summaryZh: "路线暂时不开放",
    };
    for (const kind of kinds) {
      const text = renderSafeSpeech({
        intent: intent(kind, [fact.ref]),
        facts: [fact],
        receipts: [{
          receiptId: "rcp-000000000001",
          commandStatus: "accepted",
          taskStatus: "pending",
          detail: "task accepted",
        }],
        subject: "补给安排",
        maxChars: 80,
        prompts: harness.content.prompts,
      });
      expect(text.length, kind).toBeGreaterThan(0);
      expect(text, kind).not.toMatch(/\{[^}]+\}/u);
      expect(Array.from(text).length, kind).toBeLessThanOrEqual(80);
    }
  });

  it("安全模板剥离结尾分隔符时保留正文与内部标点", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const prompts = harness.content.prompts;
    const fact = {
      ref: "ev-000000000001",
      releasePolicyId: "parties:human-independent,player-1",
      summaryZh: "路线暂时不开放",
    };
    const template = "补给安排：{facts}，请稍候： ";
    const render = (subject: string, chosen: string = template): string =>
      renderSafeSpeech({
        intent: intent("inform", [fact.ref]),
        facts: [fact],
        receipts: [],
        subject,
        maxChars: 200,
        prompts: { ...prompts, speechTemplates: { ...prompts.speechTemplates, inform: chosen } },
      });
    // 结尾的混合分隔符（冒号 + 空格）整体剥离，正文自身的冒号与逗号必须原样保留。
    expect(render("补给安排")).toBe("补给安排：路线暂时不开放，请稍候");
    // 剥离是整段进行，不会只去掉末尾一个字符而留下前面的分隔符。
    expect(render("补给安排")).not.toMatch(/[，：:\s]$/u);
    // 全部内容都是分隔符、剥离后为空时回退到无事实提示语，不产出空串。
    expect(render("", "：： ")).toBe(prompts.speechNoFacts);
  });

  it("message 工具通过固定 commandId 进入 speech.commit", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const envelopes: CommandEnvelope[] = [];
    const setup = flow(harness, envelopes);
    const speech: SpeechApprovalInput = {
      ...speechInput({ intent: intent("acknowledge") }),
      intent: { ...intent("acknowledge"), audience: ["npc-wenzhao"] },
      channel: "dialogue",
    };
    const turn: ToolGatewayTurn = {
      session: speech.session,
      runId: speech.runId,
      turnId: speech.turnId,
      attemptId: "att-000000000001",
      agentId: speech.agentId,
      round: 1,
      phase: "decision",
      audience: speech.intent.audience,
      auth: speech.auth,
      narrowing: {},
    };
    const result = await setup.dialogue.executeMessage({
      arguments: { to: ["player-1"], intent: intent("inform") },
      turn,
      operationId: "op-000000000001",
      commandId: "cmd-000000000001",
      providerCallId: "provider-call-message",
      speech,
      generator: () => ({ utterance: "我明白了。", citedRefs: [] }),
    });
    expect(result.receipt.commandStatus).toBe("accepted");
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      commandId: "cmd-000000000001",
      type: "speech.commit",
      payload: { channel: "message", audience: ["player-1"], intentKind: "inform" },
    });
  });
  it("auth scope、acting agent 或 turnId 不匹配时拒绝生成", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const setup = flow(harness, []);
    const base = speechInput({ intent: intent("answer") });
    await expect(setup.dialogue.approve({
      ...base,
      auth: { ...base.auth, branchId: "br-000000000099" },
    })).rejects.toThrow("auth scope");
    await expect(setup.dialogue.approve({
      ...base,
      auth: { ...base.auth, actingAsAgentId: "npc-wenzhao" },
    })).rejects.toThrow("auth subject");
    await expect(setup.dialogue.approve({
      ...base,
      auth: { ...base.auth, turnId: "turn-000000000099" },
    })).rejects.toThrow("auth turnId");
  });
  it("公开受众不能披露 private fact", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const setup = flow(harness, []);
    const input: SpeechApprovalInput = {
      ...speechInput({ intent: intent("answer", ["ev-000000000001"]), factSummary: "只有我知道的秘密" }),
      facts: [{
        ref: "ev-000000000001",
        releasePolicyId: "private:sec-000000000001",
        summaryZh: "只有我知道的秘密",
      }],
    };
    const result = await setup.dialogue.approve(input, () => ({ utterance: "这件事我不清楚。", citedRefs: [] }));
    expect(result.preparation.visibleFacts).toHaveLength(0);
    expect(result.preparation.omittedFactRefs).toEqual(["ev-000000000001"]);
  });
});