/**
 * 验证模型决定的驳回明细与 task.inspect 的任务列表：受众只列不被接受的条目、schema 不通过时其余字段照常检查、
 * 可选 ID 的条数上限，以及不指定任务时按最近变化列出任务。
 * 依赖 agent-runtime 的校验与冻结查询函数；输入只构造这些函数读取的字段。
 * 禁止在此启动宿主、访问存储或调用模型。
 */
import { describe, expect, it } from "vitest";
import type { ContentPack, ContextArtifact, Json, MemoryBundle } from "@world-prism/contracts";
import { validateModelDecision } from "../src/model-turn-materials";
import type { QueryExecutionInput } from "../src/tool-gateway-types";
import type { FrozenTurnInput } from "../src/turn-input";
import { turnQueries } from "../src/turn-queries";

const self = "human-independent";
const labels = { schema: "S", audience: "A", subject: "J", "unknown-ref": "U" };
const content = {
  prompts: { decision: { invalidReasons: labels } },
  index: { evidence: new Map([["ev-ledger", {}]]) },
} as unknown as ContentPack;

interface ObservationInput {
  readonly observationId: string;
  readonly tick: number;
  readonly eventType: string;
  readonly facts: Json;
  readonly refs?: Json;
}

function observation({ observationId, tick, eventType, facts, refs = {} }: ObservationInput) {
  return { observationId, occurredAtTick: tick, content: { eventType, facts, refs, summaryZh: "" } };
}

const trigger = observation({
  observationId: "obs-trigger", tick: 1, eventType: "DialogueSubmitted",
  facts: { speakerId: "player-1", dialogueId: "dlg-1", conversationId: "conv-1", audience: [self], text: "我答应送补给。" },
  refs: { conversationId: "conv-1", dialogueId: "dlg-1" },
});

function frozenWith(observations: readonly ReturnType<typeof observation>[], triggers = [trigger]): FrozenTurnInput {
  return {
    scope: { worldId: "w", branchId: "br", agentId: self },
    frontier: { worldTick: 5, conversationCursor: null },
    observations: [...observations],
    triggerObservations: [...triggers],
    world: {
      principalFactions: new Map([["player-1", "human-neutral"], [self, self]]),
      knowledge: new Map([[self, new Set(["ev-ledger"])]]),
      taskInvitations: [], nodeId: null, injured: false, delegations: [],
    },
    degraded: null,
  } as unknown as FrozenTurnInput;
}

function artifactShowing(text: string): ContextArtifact {
  return { segments: [{ role: "user", kind: "input", text }] } as unknown as ContextArtifact;
}

const valid = {
  stance: "inform",
  dialogueIntent: { kind: "acknowledge", audience: ["player-1"], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
  noteworthy: [], citedMemoryIds: [], decisionNote: "",
} satisfies Json;

function validate(candidate: Json, options: { readonly memoryIds?: readonly string[]; readonly text?: string } = {}) {
  const memoryIds = options.memoryIds ?? ["mem-promise"];
  return validateModelDecision({
    candidate,
    artifact: artifactShowing(options.text ?? `- [obs-trigger] 党魁说：“我答应送补给。” [conv-1] [dlg-1]\n${
      memoryIds.map((id) => `- [${id}] 记忆`).join("\n")}\n- [ev-ledger] 证据`),
    frozen: frozenWith([trigger]),
    memory: { items: memoryIds.map((memoryId) => ({ memoryId })) } as unknown as MemoryBundle,
    tools: [], content, messagePrincipalIds: new Set(),
  });
}

describe("模型决定的驳回明细", () => {
  it("合法提交原样通过", () => {
    expect(validate(valid)).toEqual({ decision: valid });
  });

  it("受众混有合法、名册外与重复主体时，只列出不被接受的条目", () => {
    const result = validate({ ...valid, dialogueIntent: { ...valid.dialogueIntent, audience: ["player-1", "洛", "player-1"] } });
    expect(result).toEqual({
      reasons: ["A"],
      violations: [{ rule: "audience", path: "dialogueIntent.audience", value: ["洛", "player-1"],
        issue: "each principal may appear only once", allowed: ["player-1"] }],
    });
  });

  it("schema 不通过时，能读出的引用字段照常检查，规则说明按出现顺序去重", () => {
    const result = validate({
      ...valid, decisionNote: "长".repeat(121),
      dialogueIntent: { ...valid.dialogueIntent, subjectRef: "obs-trigger", factRefs: ["obs-trigger", "mem-unknown"] },
      noteworthy: [{ kind: "promise-by-other", aboutId: "player-1", summary: "答应送补给", dueTick: null, sourceRefs: ["mem-promise"] }],
    });
    expect(result).toEqual({
      reasons: ["S", "J", "U"],
      violations: [
        { rule: "schema", path: "decisionNote", issue: expect.stringContaining("120") },
        { rule: "subject", path: "dialogueIntent.subjectRef", value: "obs-trigger",
          issue: expect.any(String), allowed: ["ev-ledger"] },
        { rule: "unknown-ref", path: "dialogueIntent.factRefs", value: ["mem-unknown"],
          allowed: ["obs-trigger", "conv-1", "dlg-1", "mem-promise", "ev-ledger"] },
        { rule: "unknown-ref", path: "noteworthy[0].sourceRefs", value: ["mem-promise"],
          issue: expect.any(String), allowed: ["obs-trigger"] },
      ],
    });
  });

  it("schema 违规只给路径与校验文本，不回显取值，最多 8 条", () => {
    const result = validate({ ...valid, stance: "maybe", extra1: 1, noteworthy: "x", citedMemoryIds: 3, decisionNote: 7,
      dialogueIntent: { kind: "shout", audience: "all", tone: "loud", reasonCode: "why", subjectRef: 1, factRefs: "x" } });
    expect("violations" in result ? result.violations : []).toHaveLength(8);
    for (const violation of "violations" in result ? result.violations ?? [] : []) {
      expect(violation).toEqual({ rule: "schema", path: expect.any(String), issue: expect.any(String) });
    }
  });

  it("可选 ID 超过 16 个时只列前 16 个，并给出未列出的个数", () => {
    const memoryIds = Array.from({ length: 20 }, (_, index) => `mem-${String(index).padStart(12, "0")}`);
    const result = validate({ ...valid, citedMemoryIds: ["mem-zzzzzzzzzzzz"] }, { memoryIds });
    expect(result).toEqual({
      reasons: ["U"],
      violations: [{ rule: "unknown-ref", path: "citedMemoryIds", value: ["mem-zzzzzzzzzzzz"],
        allowed: memoryIds.slice(0, 16), allowedOmitted: 4 }],
    });
  });
});

describe("task.inspect 的任务列表", () => {
  const query = (frozen: FrozenTurnInput, args: Json) => turnQueries({ frozen, content, toolCalls: [], historyTurns: 0 })(
    { toolId: "task.inspect", arguments: args } as unknown as QueryExecutionInput);

  it("不指定任务时列出本轮材料里的全部任务，每个任务取最新观察，最近有变化的在前", () => {
    const frozen = frozenWith([
      observation({ observationId: "obs-a1", tick: 1, eventType: "TaskDispatched", facts: { taskId: "task-a", taskType: "escort", departTick: 2 } }),
      observation({ observationId: "obs-b1", tick: 2, eventType: "TaskDispatched", facts: { taskId: "task-b", taskType: "scout", departTick: 3 } }),
      observation({ observationId: "obs-msg", tick: 3, eventType: "MessageSent", facts: { fromId: "player-1" } }),
      observation({ observationId: "obs-a2", tick: 4, eventType: "TaskDelayed", facts: { taskId: "task-a", newCompletionTick: 9 } }),
    ]);
    expect(query(frozen, {})).toEqual({ tasks: [
      { taskId: "task-a", observationId: "obs-a2", taskType: null, taskStatus: null, commandStatus: null,
        departTick: null, nominalCompletionTick: null },
      { taskId: "task-b", observationId: "obs-b1", taskType: "scout", taskStatus: null, commandStatus: null,
        departTick: 3, nominalCompletionTick: null },
    ] });
  });

  it("本轮材料里没有任务时返回空列表；指定不存在的任务仍按 not-found 拒绝", () => {
    const frozen = frozenWith([trigger]);
    expect(query(frozen, {})).toEqual({ tasks: [] });
    expect(() => query(frozen, { taskId: "task-missing" })).toThrow(expect.objectContaining({ code: "not-found" }));
  });
});
