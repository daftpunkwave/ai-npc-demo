/**
 * 从已授权事件信封和内容包生成 full/summary 两种观察内容。
 * 依赖内容索引、prompts 模板、locale 名称与受众声明。
 * 禁止读取未发布卡片、他人秘密或把 summary 的明细字段重新补回。
 */
import type { ContentPack, ContentLocale } from "@world-prism/contracts";
import { probeAskedPayloadSchema, type Json } from "@world-prism/contracts";
import type { PerceptionRequest } from "@world-prism/module-sdk";

type JsonObject = Readonly<Record<string, Json>>;

function object(value: Json | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function string(value: Json | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nameOf(content: ContentPack, id: string): string {
  return (
    content.index.characters.get(id)?.name ??
    content.index.factions.get(id)?.name ??
    (id === content.index.playerPrincipalId ? content.locale.playerName : id)
  );
}

function nodeName(locale: ContentLocale, id: string): string {
  return locale.nodes[id] ?? id;
}

function termsText(content: ContentPack, terms: Json | undefined): string {
  if (!Array.isArray(terms)) return "（没有条款）";
  const names = content.prompts?.termTemplates;
  if (names === undefined) return "（条款已提交）";
  return terms.map((term) => {
    const value = object(term);
    return `${string(value["kind"], "term")}（${string(value["obligorId"], "主体")}）`;
  }).join("；");
}

function templateValues(content: ContentPack, payload: JsonObject): Readonly<Record<string, string>> {
  const nodeIds = ["grayharbor", "watergate", "orchard", "pass", "archive", "anchor"];
  const values: Record<string, string> = {
    fromName: nameOf(content, string(payload["fromId"])),
    speakerName: nameOf(content, string(payload["speakerId"])),
    sourceName: nameOf(content, string(payload["sourceId"])),
    askedByName: nameOf(content, string(payload["askedBy"])),
    agentName: nameOf(content, string(payload["agentId"])),
    obligorName: nameOf(content, string(payload["obligorId"])),
    byName: nameOf(content, string(payload["byId"])),
    name: nameOf(content, string(payload["id"] ?? payload["agentId"])),
    fromNodeName: nodeName(content.locale, string(payload["fromNodeId"])),
    toNodeName: nodeName(content.locale, string(payload["toNodeId"])),
    nodeName: nodeName(content.locale, string(payload["nodeId"])),
    text: string(payload["text"], string(object(payload["payload"])["text"])),
    question: string(payload["question"]),
    taskId: string(payload["taskId"]),
    taskTypeName: (content.locale.taskTypes as unknown as Record<string, string>)[string(payload["taskType"])] ?? string(payload["taskType"]),
    departTick: String(payload["departTick"] ?? ""),
    newCompletionTick: String(payload["newCompletionTick"] ?? ""),
    effectsText: Array.isArray(payload["effects"])
      ? payload["effects"].map((effect) => {
          const kind = string(object(effect)["kind"]);
          return (content.prompts.effectTemplates as unknown as Record<string, string>)[kind] ?? kind;
        }).join("；")
      : "已完成",
    reasonText: (content.locale.reasonCodes as unknown as Record<string, string>)[string(payload["reasonCode"])] ?? string(payload["reasonCode"]),
    day: String(payload["day"] ?? ""),
    untilTick: String(payload["untilTick"] ?? ""),
    groupName: string(payload["groupId"]),
    roadName: string(payload["roadId"]),
    evidenceTitle: content.index.evidence.get(string(payload["evidenceId"]))?.title ?? string(payload["evidenceId"]),
    agreementId: string(payload["agreementId"]),
    termsText: termsText(content, payload["terms"]),
    termText: "条款",
    keyName: (content.locale.policyKeys as unknown as Record<string, string>)[string(payload["key"])] ?? string(payload["key"]),
    newValueName: (content.locale.policyValues as unknown as Record<string, string>)[string(payload["newValue"])] ?? string(payload["newValue"]),
    changesText: Array.isArray(payload["changes"])
      ? payload["changes"].map((change) => {
          const value = object(change);
          return `${(content.locale.meters as unknown as Record<string, string>)[string(value["meter"])] ?? string(value["meter"])}：${String(value["from"] ?? "")} → ${String(value["to"] ?? "")}（${(content.prompts.causeNames as unknown as Record<string, string>)[string(value["cause"])] ?? string(value["cause"])}）`;
        }).join("；")
      : "指标已变化",
  };
  for (const nodeId of nodeIds) values[`${nodeId}Name`] = nodeName(content.locale, nodeId);
  return values;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{?([A-Za-z][A-Za-z0-9]*)\}?\}/g, (_match, key: string) => values[key] ?? "");
}

function partiesPolicy(principalIds: readonly string[]): string {
  const sorted = [...new Set(principalIds)].sort((left, right) => left === right ? 0 : left < right ? -1 : 1);
  return `parties:${sorted.join(",")}`;
}

export function observationReleasePolicy(event: Pick<PerceptionRequest["event"], "type" | "audience" | "payload">): string {
  if (event.type === "InformationShared") {
    return `holders:${string(object(event.payload)["evidenceId"])}`;
  }
  if (event.type === "ProbeAsked") {
    const probe = probeAskedPayloadSchema.parse(event.payload);
    return partiesPolicy([probe.askedBy, probe.agentId]);
  }
  const audience = event.audience.map(object);
  if (audience.some((entry) => entry["kind"] === "public")) return "public";
  const principalIds = audience
    .filter((audience) => audience["kind"] === "principals")
    .flatMap((audience) => Array.isArray(audience["ids"]) ? audience["ids"] : [])
    .filter((id): id is string => typeof id === "string");
  if (principalIds.length > 0) return partiesPolicy(principalIds);
  const faction = audience.find((entry) => entry["kind"] === "faction");
  if (faction !== undefined) return `faction:${string(faction["factionId"])}`;
  return "private";
}

function deliveryTick(payload: JsonObject, agentId: string, eventTick: number): number {
  const deliveries = payload["deliveries"];
  if (!Array.isArray(deliveries)) return eventTick;
  const own = deliveries.map(object).find((delivery) => delivery["principalId"] === agentId);
  return typeof own?.["deliverAtTick"] === "number"
    ? Math.max(eventTick, own["deliverAtTick"])
    : eventTick;
}

function refs(payload: JsonObject): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [key, field] of [
    ["agreementId", "agreementId"],
    ["taskId", "taskId"],
    ["invitationId", "invitationId"],
    ["evidenceId", "evidenceId"],
    ["conversationId", "conversationId"],
    ["dialogueId", "dialogueId"],
    ["messageId", "messageId"],
  ] as const) {
    if (typeof payload[field] === "string") values[key] = payload[field];
  }
  return values;
}

export function renderObservation(input: {
  readonly content: ContentPack;
  readonly event: PerceptionRequest["event"];
  readonly agentId: string;
  readonly full: boolean;
}): PerceptionRequest["rendered"] {
  const payload = object(input.event.payload);
  const template = input.content.prompts.observationTemplates[input.event.type as keyof typeof input.content.prompts.observationTemplates] ?? "事件状态已更新。";
  const summaryZh = input.full
    ? renderTemplate(template, templateValues(input.content, payload))
    : `${input.event.type} · ${nodeName(input.content.locale, string(payload["nodeId"]))} · ${nameOf(input.content, input.event.principalId)}`;
  const subjectIds = [
    payload["agentId"],
    payload["speakerId"],
    payload["fromId"],
    payload["dispatcherId"],
    payload["proposerId"],
    input.event.principalId,
  ].filter((id): id is string => typeof id === "string");
  const detail = {
    summaryZh,
    subjectIds: [...new Set(subjectIds)],
    nodeId:
      typeof payload["nodeId"] === "string"
        ? payload["nodeId"]
        : typeof payload["toNodeId"] === "string"
          ? payload["toNodeId"]
          : null,
    refs: refs(payload),
    facts: input.full ? input.event.payload : {},
    claim:
      input.event.type === "DialogueSubmitted" ||
      input.event.type === "MessageSent" ||
      input.event.type === "RumorSpread"
        ? {
            sourceId: string(payload["speakerId"] ?? payload["fromId"] ?? payload["sourceId"]),
            senderId: string(payload["speakerId"] ?? payload["fromId"] ?? input.event.principalId),
            text: string(payload["text"]),
          }
        : null,
  };
  return {
    full: detail,
    summary: {
      summaryZh,
      subjectIds: [...detail.subjectIds],
      nodeId: detail.nodeId,
      refs: {},
      facts: {},
      claim: null,
    },
    releasePolicyId: input.full ? observationReleasePolicy(input.event) : "public",
    knownAtTick: deliveryTick(payload, input.agentId, input.event.worldTick),
  };
}
