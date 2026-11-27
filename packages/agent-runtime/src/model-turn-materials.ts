/**
 * 将冻结的 Agent 材料渲染为首轮决策请求，并校验模型引用。
 * 复用内容模板、profile 预算及已授权观察、证据、对话和记忆。
 * 禁止把未经授权的事实、压缩丢弃的引用或模型自报 ID 作为输入事实。
 */
import {
  cleanJsonSchemaForModel, decisionSubmissionSchema, decisionSubmitWireSchema, dialogueSubmittedPayloadSchema,
  DomainError, type ContextArtifact, type ContextBuildRequest, type Json, type MemoryBundle, type NormalizedTool,
} from "@world-prism/contracts";
import type { ContentPack, ResolvedAgentProfile } from "@world-prism/contracts";
import type { DecisionValidation, DecisionViolation, ModelRoute } from "@world-prism/module-sdk";
import { asRecord } from "./runtime-records";
import type { ToolCallOutcome } from "./tool-gateway-types";
import type { FrozenTurnInput } from "./turn-input";
import type { ClaimedTurn } from "./turn-lease";

const decisionToolSchema = cleanJsonSchemaForModel(decisionSubmitWireSchema);

export function decisionSubmitTool(content: ContentPack): NormalizedTool {
  return { name: "decision_submit", description: content.prompts.toolDescriptions["decision.submit"], inputSchema: decisionToolSchema };
}

function render(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/gu, (_substr, key: string) => values[key] ?? "");
}

function displayName(content: ContentPack, id: string): string {
  const faction = content.index.factions.get(id);
  return content.index.characters.get(id)?.name ?? faction?.leaderName ?? faction?.name ??
    (id === content.index.playerPrincipalId ? content.locale.playerName : id);
}

/**
 * 名字后附方括号 ID，如「洛[npc-luo]」：工具参数、受众与 aboutId 都只认 ID，
 * 只给名字时模型会拿名字或猜测的拼写去调用。名字本身就是 ID 时不重复。
 */
function namedRef(content: ContentPack, id: string): string {
  const name = displayName(content, id);
  return name === id ? `[${id}]` : `${name}[${id}]`;
}

const principalFactKeys = ["speakerId", "fromId", "proposerId", "dispatcherId", "askedBy"] as const;

/**
 * 一条触发观察里可作为对白受众的其他主体（与 triggerPrincipals 同一口径），按事实字段顺序去重，
 * 用于在输入行后注明名字与 ID 的对应。
 */
function observationPrincipals(facts: Readonly<Record<string, Json>>, frozen: FrozenTurnInput): readonly string[] {
  const principals = new Set<string>();
  for (const key of principalFactKeys) {
    const principal = facts[key];
    if (typeof principal === "string" && principal !== frozen.scope.agentId &&
      (frozen.world.principalFactions.has(principal) || principal === facts["askedBy"])) principals.add(principal);
  }
  return [...principals];
}

/**
 * 读取 profile 上下文配置中指定用途的预算块。
 * decision 与 speech 预算块都是模型决策装配的必需项：缺失或非对象（含 null）
 * 会让窗口上限经 Number(undefined) 变成 NaN，使启动预检与运行期预算比较全部
 * 失真，因此统一按缺失配置拒绝；块内字段的有效性由模块配置 schema 保证。
 * historyTurns 在 ordered-blocks schema 中是可选项：缺失时按 0 条处理，不用
 * Number(undefined) 得到的 NaN 参与切片（Array.prototype.slice(-NaN) 会返回全部元素）。
 */
export function modelContextBudget(
  profile: ResolvedAgentProfile,
  purpose: "decision" | "speech",
): ContextBuildRequest["budget"] {
  const settings = asRecord(profile.slots.context?.config);
  const block = settings[purpose];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new DomainError("assembly-incompatible",
      `Agent profile「${profile.profileId}」的上下文配置缺少 ${purpose} 预算块，无法启用模型决策`);
  }
  const budget = asRecord(block);
  const historyTurns = settings["historyTurns"];
  return {
    maxInputTokens: Number(budget["maxInputTokens"]),
    reservedOutputTokens: profile.budgets.reserveOutputTokens[purpose],
    safetyTokens: Number(budget["safetyTokens"]),
    toolLoopReserveTokens: purpose === "decision" ? Number(budget["toolLoopReserveTokens"]) : 0,
    segmentBudgets: Object.fromEntries(Object.entries(asRecord(budget["segmentBudgets"])).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    )),
    historyTurns: typeof historyTurns === "number" ? historyTurns : 0,
    lendUnusedBudget: settings["lendUnusedBudget"] === true,
  };
}

export function decisionSystem(content: ContentPack, agentId: string, maxToolCallsPerRound: number): string {
  const character = content.index.characters.get(agentId);
  const faction = content.index.factions.get(agentId);
  const persona = character ?? faction?.persona;
  if (persona === undefined) throw new Error("Agent persona missing from the frozen content pack");
  const trust = content.prompts.labels.trust;
  const trustNames = [trust.hostile, trust.wary, trust.neutral, trust.trusting, trust.devoted];
  const relations = character !== undefined
    ? character.initialRelations.map(({ targetId, label, trust }) => `${namedRef(content, targetId)}（${label}，${trustNames[trust + 2]}）`)
    : (faction?.relations ?? []).map(({ targetId, trust }) => `${namedRef(content, targetId)}（${trustNames[trust + 2]}）`);
  const kind = faction === undefined ? "character" : "strategic";
  return render(content.prompts.decision.system, {
    agentId, kindLabel: content.prompts.labels.kinds[kind], name: displayName(content, agentId),
    factionName: faction?.name ?? content.index.factions.get(character?.factionId ?? "")?.name ?? "",
    role: persona.role, values: persona.values.join("、"), speechStyle: persona.speechStyle,
    bottomLines: persona.bottomLines.join("、"), goals: persona.goals.join("、"), initialRelations: relations.join("；") || "无",
    loreSummary: content.lore.summary, maxToolCallsPerRound: String(maxToolCallsPerRound),
  });
}

export function decisionContext(input: {
  readonly frozen: FrozenTurnInput;
  readonly turn: ClaimedTurn;
  readonly content: ContentPack;
  readonly profile: ResolvedAgentProfile;
  readonly memory: MemoryBundle;
  readonly attemptId: string;
  readonly route: Pick<ModelRoute, "capabilities" | "maxOutputTokens">;
}): ContextBuildRequest {
  const { frozen, turn, content, profile, memory, route } = input;
  const { agentId } = frozen.scope;
  const { worldTick } = frozen.frontier;
  const system = decisionSystem(content, agentId, profile.budgets.maxToolCallsPerRound);

  const nodeId = frozen.world.nodeId;
  const node = nodeId === null ? undefined : content.index.nodes.get(nodeId);
  const locationLine = content.index.factions.has(agentId) ? "你在派系驻地处理事务，不在地图上。"
    : [node === undefined || nodeId === null ? "" : `你在${node.name}[${nodeId}]。`, frozen.world.injured ? "你有伤在身。" : ""].join("");
  const grants = [...(frozen.world.knowledge.get(agentId) ?? [])];
  const worldLines = grants.flatMap((id) => {
    const evidence = content.index.evidence.get(id);
    if (evidence !== undefined) return [`- [${id}] 证据《${evidence.title}》：${evidence.content}`];
    const secret = content.index.secrets.get(id);
    return secret === undefined ? [] : [`- [${id}] 只有你知道（不可外传）：${secret.content}`];
  });
  const inputLines = frozen.triggerObservations.flatMap((observation) => {
    const data = asRecord(observation.content);
    const claim = asRecord(data["claim"]);
    const summary = typeof data["summaryZh"] === "string" ? data["summaryZh"] : "";
    const refs = Object.values(asRecord(data["refs"])).filter((ref): ref is string => typeof ref === "string");
    const claimText = typeof claim["text"] === "string" && !summary.includes(claim["text"]) ? `\n  ${claim["text"]}` : "";
    const principals = observationPrincipals(asRecord(data["facts"]), frozen);
    const principalText = principals.length === 0 ? "" : `\n  涉及：${principals.map((id) => namedRef(content, id)).join("、")}`;
    return [`- [${observation.observationId}] ${summary}${refs.map((ref) => ` [${ref}]`).join("")}${claimText}${principalText}`];
  });
  const affairs = frozen.world.taskInvitations.map(({ taskId, dispatcherId }) =>
    `- [${taskId}] ${namedRef(content, dispatcherId)} 邀请你参与任务，待答复。`);
  const budget = modelContextBudget(profile, "decision");
  const history = budget.historyTurns === 0 ? [] : frozen.observations.filter((observation) =>
    !frozen.triggerObservations.includes(observation)).flatMap((observation) => {
    const parsed = dialogueSubmittedPayloadSchema.safeParse(asRecord(observation.content)["facts"]);
    return parsed.success ? [`- [${parsed.data.dialogueId}] ${displayName(content, parsed.data.speakerId)}：${parsed.data.text}`] : [];
  }).slice(-budget.historyTurns);
  const paragraphs = content.prompts.decision.user.split(/\n\s*\n/u);
  const paragraph = (key: string, lines: readonly string[]) => lines.length === 0 ? "" :
    render(paragraphs.find((part) => part.includes(`{{${key}}}`)) ?? `{{${key}}}`, { [key]: lines.join("\n") });
  const time = render(paragraphs.find((part) => part.includes("{{worldTick}}")) ?? "", {
    day: String(Math.floor(worldTick / 24) + 1), hour: String(worldTick % 24), worldTick: String(worldTick), locationLine,
  });
  return {
    session: frozen.scope, runId: turn.runId, turnId: turn.auth.turnId, attemptId: input.attemptId,
    phase: "decision", targetAudience: [], frontier: frozen.frontier, profileHash: turn.profileHash,
    templateVersion: content.prompts.templateVersion, systemIdentity: system, loreSummary: "",
    worldViewText: paragraph("worldViewLines", worldLines), affairsText: paragraph("affairsLines", affairs),
    historyText: paragraph("historyLines", history), inputText: [time, paragraph("inputLines", inputLines)].filter(Boolean).join("\n"),
    observations: [...frozen.triggerObservations], memoryBundle: memory,
    modelWindowTokens: route.capabilities.contextWindowTokens, budget,
  };
}

export function triggerPrincipals(frozen: FrozenTurnInput): readonly string[] {
  return [...new Set(frozen.triggerObservations.flatMap((observation) =>
    observationPrincipals(asRecord(asRecord(observation.content)["facts"]), frozen)))];
}

/** 收集工具结果里引用字段（键名以 Id/Ref 结尾，以及 path、blockedRoads）中出现的 ID，按出现先后去重。 */
function collectReturnedRefs(value: Json, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReturnedRefs(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:Id|Ref)s?$/u.test(key) || key === "path" || key === "blockedRoads") {
      if (typeof item === "string") into.add(item);
      else if (Array.isArray(item)) for (const entry of item) if (typeof entry === "string") into.add(entry);
    }
    collectReturnedRefs(item, into);
  }
}

/** 违规明细里最多列出的可选 ID 与 schema 问题条数：足够模型改正，又不让驳回结果挤占下一轮的输入窗口。 */
const maxAllowedListed = 16;
const maxSchemaIssues = 8;
const subjectRefPattern = /^(agr|task|inv|ev)-/u;

function pathOf(segments: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of segments) text += typeof segment === "number" ? `[${segment}]` : `${text === "" ? "" : "."}${String(segment)}`;
  return text === "" ? "$" : text;
}

function allowedList(ids: Iterable<string>): { readonly allowed: readonly string[]; readonly allowedOmitted?: number } {
  const all = [...new Set(ids)];
  const omitted = all.length - maxAllowedListed;
  return { allowed: all.slice(0, maxAllowedListed), ...(omitted > 0 ? { allowedOmitted: omitted } : {}) };
}

/** 能读出来的引用字段：schema 不通过时也据此做语义检查，避免一个 schema 问题掩盖其他字段的违规、白白耗掉唯一一次改正。 */
interface ReferenceView {
  readonly intentKind: string | null;
  readonly audience: readonly string[] | null;
  readonly subjectRef: string | null;
  readonly factRefs: readonly string[];
  readonly citedMemoryIds: readonly string[];
  readonly noteworthySources: ReadonlyMap<number, readonly string[]>;
}

/** 取数组中的字符串条目；不是数组时为 null。 */
function stringEntries(value: Json | undefined): readonly string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function referenceView(candidate: Json): ReferenceView {
  const root = asRecord(candidate);
  const intent = asRecord(root["dialogueIntent"]);
  const noteworthySources = new Map<number, readonly string[]>();
  (Array.isArray(root["noteworthy"]) ? root["noteworthy"] : []).forEach((item, index) => {
    const sources = stringEntries(asRecord(item)["sourceRefs"]);
    if (sources !== null) noteworthySources.set(index, sources);
  });
  return {
    intentKind: typeof intent["kind"] === "string" ? intent["kind"] : null,
    audience: stringEntries(intent["audience"]),
    subjectRef: typeof intent["subjectRef"] === "string" ? intent["subjectRef"] : null,
    factRefs: stringEntries(intent["factRefs"]) ?? [],
    citedMemoryIds: stringEntries(root["citedMemoryIds"]) ?? [],
    noteworthySources,
  };
}

/** 受众违规：只列出不被接受的条目（自己、不在可选范围内的主体与重复项），可选主体另列。 */
function audienceViolation(
  view: ReferenceView,
  audiences: ReadonlySet<string>,
  self: string,
): DecisionViolation | null {
  const listed = view.audience;
  if (view.intentKind === null || view.intentKind === "none" || listed === null) return null;
  const allowed = allowedList([...audiences].filter((id) => id !== self));
  if (listed.length === 0) {
    return { rule: "audience", path: "dialogueIntent.audience", value: [],
      issue: "audience must not be empty unless dialogueIntent.kind is none", ...allowed };
  }
  const outside = listed.filter((id) => id === self || !audiences.has(id));
  const duplicates = listed.filter((id, index) => listed.indexOf(id) !== index);
  if (outside.length === 0 && duplicates.length === 0) return null;
  return { rule: "audience", path: "dialogueIntent.audience", value: [...new Set([...outside, ...duplicates])],
    ...(duplicates.length > 0 ? { issue: "each principal may appear only once" } : {}), ...allowed };
}

/** 本次请求里各类引用的可选集合，按在请求中出现的先后排列。 */
interface ReferenceScope {
  readonly visible: ReadonlySet<string>;
  readonly returned: ReadonlySet<string>;
  readonly knownSubjects: ReadonlySet<string>;
  readonly knownRefs: ReadonlySet<string>;
  readonly memoryIds: ReadonlySet<string>;
  readonly observationIds: ReadonlySet<string>;
}

/**
 * noteworthy 的来源只认本次输入里列出的观察。没有可引用的观察（如巡检唤醒）时，提示删掉该条而不是清空 sourceRefs：
 * 清空会违反至少 1 项的 schema，模型会在两条规则之间来回改。
 */
function noteworthyViolations(
  view: ReferenceView,
  visible: ReadonlySet<string>,
  observationIds: ReadonlySet<string>,
): readonly DecisionViolation[] {
  const allowedSources = allowedList([...visible].filter((id) => observationIds.has(id)));
  const violations: DecisionViolation[] = [];
  for (const [index, sources] of view.noteworthySources) {
    const unknownSources = [...new Set(sources.filter((ref) => !observationIds.has(ref) || !visible.has(ref)))];
    if (allowedSources.allowed.length === 0) {
      violations.push({ rule: "unknown-ref", path: `noteworthy[${index}]`, value: unknownSources,
        issue: "this turn has no input observation to cite; remove this item (noteworthy may be empty)" });
    } else if (sources.length === 0 || unknownSources.length > 0) {
      violations.push({ rule: "unknown-ref", path: `noteworthy[${index}].sourceRefs`, value: unknownSources,
        issue: "cite 1 to 3 observation IDs listed under the input to handle in this turn, or remove this item", ...allowedSources });
    }
  }
  return violations;
}

function referenceViolations(view: ReferenceView, scope: ReferenceScope): readonly DecisionViolation[] {
  const { visible, returned, knownSubjects, knownRefs, memoryIds, observationIds } = scope;
  const violations: DecisionViolation[] = [];
  const subject = view.subjectRef;
  if (subject !== null && (!subjectRefPattern.test(subject) ||
    !(visible.has(subject) && knownSubjects.has(subject) || returned.has(subject)))) {
    violations.push({ rule: "subject", path: "dialogueIntent.subjectRef", value: subject,
      issue: "use null or one of the allowed agreement/task/invitation/evidence IDs",
      ...allowedList([...[...visible].filter((id) => knownSubjects.has(id)), ...returned].filter((id) => subjectRefPattern.test(id))) });
  }
  const unknownFacts = view.factRefs.filter((ref) => !(visible.has(ref) && knownRefs.has(ref) || returned.has(ref)));
  if (unknownFacts.length > 0) {
    violations.push({ rule: "unknown-ref", path: "dialogueIntent.factRefs", value: [...new Set(unknownFacts)],
      ...allowedList([...[...visible].filter((id) => knownRefs.has(id)), ...returned]) });
  }
  const unknownMemories = view.citedMemoryIds.filter((ref) => !memoryIds.has(ref) || !visible.has(ref));
  if (unknownMemories.length > 0) {
    violations.push({ rule: "unknown-ref", path: "citedMemoryIds", value: [...new Set(unknownMemories)],
      ...allowedList([...visible].filter((id) => memoryIds.has(id))) });
  }
  violations.push(...noteworthyViolations(view, visible, observationIds));
  return violations;
}

/**
 * 按实际请求校验模型提交的决定。全部规则都检查一遍再返回：schema 不通过时，能读出来的受众与引用字段照常做语义检查。
 * 驳回时 `reasons` 按规则给出内容包的说明，`violations` 逐字段指出不被接受的取值与可以填写的 ID，让模型一次改全。
 */
export function validateModelDecision(input: {
  readonly candidate: Json;
  readonly artifact: ContextArtifact;
  readonly frozen: FrozenTurnInput;
  readonly memory: MemoryBundle;
  readonly tools: readonly ToolCallOutcome[];
  readonly content: ContentPack;
  readonly messagePrincipalIds: ReadonlySet<string>;
}): DecisionValidation {
  const { candidate, artifact, frozen, memory, tools, content } = input;
  const labels = content.prompts.decision.invalidReasons;
  const self = frozen.scope.agentId;
  const parsed = decisionSubmissionSchema.safeParse(candidate);
  const violations: DecisionViolation[] = parsed.success ? [] : parsed.error.issues.slice(0, maxSchemaIssues).map((issue) => ({
    rule: "schema" as const, path: pathOf(issue.path), issue: issue.message,
  }));
  const view = referenceView(candidate);

  const audiences = new Set([...triggerPrincipals(frozen), ...input.messagePrincipalIds]);
  for (const observation of frozen.triggerObservations) {
    const line = dialogueSubmittedPayloadSchema.safeParse(asRecord(observation.content)["facts"]);
    if (line.success && line.data.dialogueId === frozen.frontier.conversationCursor) {
      for (const principal of line.data.audience) audiences.add(principal);
    }
  }
  const audience = audienceViolation(view, audiences, self);
  if (audience !== null) violations.push(audience);

  const returned = new Set<string>();
  for (const { modelText } of tools) collectReturnedRefs(JSON.parse(modelText) as Json, returned);
  const observedRefs = frozen.observations.flatMap((observation) => Object.values(asRecord(asRecord(observation.content)["refs"]))
    .filter((ref): ref is string => typeof ref === "string"));
  const grants = frozen.world.knowledge.get(self) ?? [];
  const knownSubjects = new Set([
    ...observedRefs,
    ...frozen.world.taskInvitations.map(({ taskId }) => taskId),
    ...[...grants].filter((id) => content.index.evidence.has(id)),
  ]);
  const memoryIds = new Set<string>(memory.items.map(({ memoryId }) => memoryId));
  violations.push(...referenceViolations(view, {
    visible: new Set(artifact.segments.filter(({ role }) => role === "user").flatMap(({ text }) =>
      [...text.matchAll(/\[([a-z][a-z0-9-]+)\]/gu)].map((match) => match[1]!))),
    returned, knownSubjects, memoryIds,
    knownRefs: new Set([...knownSubjects, ...grants, ...memoryIds, ...frozen.observations.map(({ observationId }) => observationId)]),
    observationIds: new Set(frozen.triggerObservations.map(({ observationId }) => observationId)),
  }));
  if (parsed.success && violations.length === 0) return { decision: parsed.data };
  return { reasons: [...new Set(violations.map(({ rule }) => labels[rule]))], violations };
}
