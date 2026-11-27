/**
 * 直接验证账本事件的基础显著度与标签映射：逐档核对各事件类型的取值，以及标签集合的完整内容。
 * 依赖账本模型的纯函数与按观察构造的账本事件；不经摄入、检索或存储。
 * 禁止只断言部分标签或只抽查少数事件类型，等价性回归依赖这里的完整取值表。
 */
import { describe, expect, it } from "vitest";
import type { AgentObservation, Json } from "@world-prism/contracts";
import { baseSalience, eventFromObservation, tagsFor, type LedgerEvent } from "../src/ledger-model";

const scope = {
  worldId: "wld-000000000001",
  branchId: "br-000000000001",
  agentId: "human-independent",
};

/** 按事件类型、事实、主体与节点构造账本事件；其余观察字段取固定值。 */
function ledgerEvent(
  eventType: string,
  input: { readonly facts?: Json; readonly subjectIds?: readonly string[]; readonly nodeId?: string | null } = {},
): LedgerEvent {
  const observation: AgentObservation = {
    observationId: "obs-000000000001" as AgentObservation["observationId"],
    scope,
    observationSeq: 1,
    sourceEventIds: ["evt-000000000001" as AgentObservation["sourceEventIds"][number]],
    sourceObservationIds: [],
    occurredAtTick: 1,
    sensedAtTick: 1,
    knownAtTick: 1,
    channel: "party",
    epistemic: "witnessed",
    confidence: 1,
    releasePolicyId: "parties:human-independent,player-1",
    content: {
      eventType,
      summaryZh: eventType,
      subjectIds: [...(input.subjectIds ?? [])],
      nodeId: input.nodeId ?? null,
      refs: {},
      facts: input.facts ?? {},
      claim: null,
      detail: "full",
    },
  };
  return eventFromObservation(observation, scope.agentId);
}

describe("baseSalience", () => {
  it.each([
    ["GroupRescued", {}, 0.9],
    ["TaskCompleted", { taskType: "rescue" }, 0.9],
    ["AgreementBreached", {}, 0.8],
    ["CharacterInjured", {}, 0.8],
    ["AgreementTermFulfilled", {}, 0.7],
    ["AgreementFulfilled", {}, 0.7],
    ["AgreementActivated", {}, 0.6],
    ["TaskFailed", {}, 0.6],
    // 救援特例只对完成的任务生效，失败的救援任务仍按任务失败计。
    ["TaskFailed", { taskType: "rescue" }, 0.6],
    ["RelayDown", {}, 0.6],
    ["OrchardCrisis", {}, 0.6],
    ["MigrationCrisis", {}, 0.6],
    ["TaskCompleted", { taskType: "supply" }, 0.5],
    ["TaskCompleted", {}, 0.5],
    ["InformationShared", {}, 0.5],
    ["WorldFactRecorded", {}, 0.5],
    ["PolicyChanged", {}, 0.5],
    ["PassageGranted", {}, 0.5],
    ["TaskInvitationIssued", {}, 0.4],
    ["TaskInvitationAnswered", {}, 0.4],
    ["RumorSpread", {}, 0.4],
    ["DialogueSubmitted", {}, 0.3],
    ["MessageSent", {}, 0.3],
    ["ProbeAsked", {}, 0.3],
    ["MetersChanged", {}, 0.1],
    ["DayPassed", {}, 0.1],
    ["AgreementProposed", {}, 0.2],
    ["SupplyShortage", {}, 0.2],
    ["Unknown", {}, 0.2],
    // 与对象原型同名的事件类型同样落到默认值，不能取到原型上的属性。
    ["toString", {}, 0.2],
  ] as const)("%s（事实 %j）的基础显著度为 %d", (eventType, facts, expected) => {
    expect(baseSalience(ledgerEvent(eventType, { facts }))).toBe(expected);
  });
});

describe("tagsFor", () => {
  it.each([
    ["AgreementBreached", {}, ["agreement", "breach"]],
    ["AgreementFulfilled", {}, ["agreement", "fulfilled"]],
    ["AgreementTermFulfilled", {}, ["agreement", "fulfilled"]],
    ["AgreementProposed", {}, ["agreement"]],
    ["TaskCompleted", { taskType: "rescue" }, ["rescue", "task"]],
    ["TaskInvitationIssued", { taskType: "supply" }, ["supply", "task"]],
    ["TaskFailed", {}, ["task"]],
    ["ResourcesTransferred", {}, ["resource"]],
    ["StockpileAdjusted", {}, ["resource"]],
    ["SupplyShortage", {}, ["resource"]],
    ["RelayDown", {}, ["crisis", "relay"]],
    ["RelayRestored", {}, ["relay"]],
    ["MigrationCrisis", {}, ["crisis", "migration"]],
    ["OrchardCrisis", {}, ["crisis", "water"]],
    ["OrchardDamaged", {}, ["water"]],
    ["PassageGranted", {}, ["road"]],
    ["RoadStatusChanged", {}, ["road"]],
    ["RumorSpread", {}, ["rumor"]],
    ["InformationShared", {}, ["evidence"]],
    ["EvidenceRevealed", {}, ["evidence"]],
    ["InformationShared", { evidenceId: "ev-exchange-draft" }, ["evidence", "exchange"]],
    ["EvidenceRevealed", { evidenceId: "ev-star-charts" }, ["evidence", "exchange"]],
    ["InformationShared", { evidenceId: "ev-water-ledger" }, ["evidence"]],
    ["DialogueSubmitted", {}, ["dialogue"]],
    ["MessageSent", {}, ["dialogue"]],
    ["ProbeAsked", {}, []],
    ["PolicyChanged", { key: "watergate.allocation" }, ["policy", "water"]],
    ["PolicyChanged", { policyKey: "road.status:r-gh-ps" }, ["policy", "road"]],
    ["PolicyChanged", { key: "curfew" }, ["policy"]],
    ["DayPassed", {}, []],
  ] as const)("%s（事实 %j）只产生事件类型与事实派生的标签 %j", (eventType, facts, expected) => {
    expect(tagsFor(ledgerEvent(eventType, { facts }))).toEqual(expected);
  });

  it("并入主体、节点与事实自带标签，去重、去空后按字符串排序", () => {
    const event = ledgerEvent("PassageGranted", {
      facts: { tags: ["harbor", "", "road"], taskType: "rescue" },
      subjectIds: ["player-1", "road", ""],
      nodeId: "grayharbor",
    });
    // taskType 只对任务类事件生效；道路标签来自类型、主体与事实三处，结果中只出现一次。
    expect(tagsFor(event)).toEqual(["grayharbor", "harbor", "player-1", "road"]);
  });
});
