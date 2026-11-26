/**
 * 将冻结的 Agent 材料渲染为首轮决策请求，并校验模型引用。
 * 复用内容模板、profile 预算及已授权观察、证据、对话和记忆。
 * 禁止把未经授权的事实、压缩丢弃的引用或模型自报 ID 作为输入事实。
 */
import {
  cleanJsonSchemaForModel, decisionSubmissionSchema, decisionSubmitWireSchema, dialogueSubmittedPayloadSchema,
  DomainError, type ContextArtifact, type ContextBuildRequest, type Json, type MemoryBundle, type NormalizedTool,
} from "@world-prism/contracts";
import type { ContentPack, ResolvedAgentProfile } from "@world-prism/experiment";
import type { DecisionValidation, ModelRoute } from "@world-prism/module-sdk";
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
    ? character.initialRelations.map(({ targetId, label, trust }) => `${displayName(content, targetId)}（${label}，${trustNames[trust + 2]}）`)
    : (faction?.relations ?? []).map(({ targetId, trust }) => `${displayName(content, targetId)}（${trustNames[trust + 2]}）`);
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
    : [node === undefined ? "" : `你在${node.name}。`, frozen.world.injured ? "你有伤在身。" : ""].join("");
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
    return [`- [${observation.observationId}] ${summary}${refs.map((ref) => ` [${ref}]`).join("")}${claimText}`];
  });
  const affairs = frozen.world.taskInvitations.map(({ taskId, dispatcherId }) =>
    `- [${taskId}] ${displayName(content, dispatcherId)} 邀请你参与任务，待答复。`);
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
  const principals = new Set<string>();
  for (const observation of frozen.triggerObservations) {
    const facts = asRecord(asRecord(observation.content)["facts"]);
    for (const principal of [facts["speakerId"], facts["fromId"], facts["proposerId"], facts["dispatcherId"], facts["askedBy"]]) {
      if (typeof principal === "string" && principal !== frozen.scope.agentId &&
        (frozen.world.principalFactions.has(principal) || principal === facts["askedBy"])) principals.add(principal);
    }
  }
  return [...principals];
}

function containsRef(value: Json, ref: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRef(item, ref));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    const referenceField = /(?:Id|Ref)s?$/u.test(key) || key === "path" || key === "blockedRoads";
    if (referenceField && (item === ref || (Array.isArray(item) && item.includes(ref)))) return true;
    return containsRef(item, ref);
  });
}

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
  const fail = (name: keyof typeof labels): DecisionValidation => ({ reasons: [labels[name]] });
  const parsed = decisionSubmissionSchema.safeParse(candidate);
  if (!parsed.success) return fail("schema");
  const decision = parsed.data;
  const { dialogueIntent: intent } = decision;
  const audiences = new Set([...triggerPrincipals(frozen), ...input.messagePrincipalIds]);
  for (const observation of frozen.triggerObservations) {
    const line = dialogueSubmittedPayloadSchema.safeParse(asRecord(observation.content)["facts"]);
    if (line.success && line.data.dialogueId === frozen.frontier.conversationCursor) {
      for (const principal of line.data.audience) audiences.add(principal);
    }
  }
  if (intent.kind !== "none" && (intent.audience.length === 0 ||
    new Set(intent.audience).size !== intent.audience.length ||
    intent.audience.some((id) => id === frozen.scope.agentId || !audiences.has(id)))) return fail("audience");
  const visible = new Set(artifact.segments.filter(({ role }) => role === "user").flatMap(({ text }) =>
    [...text.matchAll(/\[([a-z][a-z0-9-]+)\]/gu)].map((match) => match[1]!)));
  const modelResults = tools.map(({ modelText }) => JSON.parse(modelText) as Json);
  const returned = (ref: string) => modelResults.some((result) => containsRef(result, ref));
  const observedRefs = frozen.observations.flatMap((observation) => Object.values(asRecord(asRecord(observation.content)["refs"]))
    .filter((ref): ref is string => typeof ref === "string"));
  const grants = frozen.world.knowledge.get(frozen.scope.agentId) ?? [];
  const knownSubjects = new Set([
    ...observedRefs,
    ...frozen.world.taskInvitations.map(({ taskId }) => taskId),
    ...[...grants].filter((id) => content.index.evidence.has(id)),
  ]);
  const memoryIds = new Set<string>(memory.items.map(({ memoryId }) => memoryId));
  const knownRefs = new Set([...knownSubjects, ...grants, ...memoryIds, ...frozen.observations.map(({ observationId }) => observationId)]);
  const shown = (ref: string) => visible.has(ref) && knownRefs.has(ref) || returned(ref);
  if (intent.subjectRef !== null && (!/^(agr|task|inv|ev)-/u.test(intent.subjectRef) ||
    !(visible.has(intent.subjectRef) && knownSubjects.has(intent.subjectRef) || returned(intent.subjectRef)))) return fail("subject");
  const observationIds = new Set<string>(frozen.triggerObservations.map(({ observationId }) => observationId));
  if (intent.factRefs.some((ref) => !shown(ref)) ||
    decision.citedMemoryIds.some((ref) => !memoryIds.has(ref) || !visible.has(ref)) ||
    decision.noteworthy.some((item) => item.sourceRefs.some((ref) => !observationIds.has(ref) || !visible.has(ref)))) {
    return fail("unknown-ref");
  }
  return { decision };
}
