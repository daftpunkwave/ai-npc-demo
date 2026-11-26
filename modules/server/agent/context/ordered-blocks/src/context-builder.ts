/**
 * 核心职责：把宿主已过滤的上下文材料组装为有序、可追踪且受预算约束的 artifact。
 * 交互契约：依赖 ContextBuildRequest、AgentContextPort 与 HostServices，输出不可变段落及剔除报告。
 * 约束与禁忌：不得补查受限原文、改变 release policy、执行模型或持久化世界状态。
 */
import {
  canonicalJson,
  resolveContextTokenLimits,
  type ContextArtifact,
  type ContextBuildRequest,
  type ContextUserSegmentKind,
  type Json,
  type MemoryBundleItem,
} from "@world-prism/contracts";
import type { AgentContextPort } from "@world-prism/module-sdk";
import type { OrderedBlocksContextConfig } from "./definition";
import { estimateContextTokens, estimateTokens } from "./token-estimate";

type UserSegmentKind = ContextUserSegmentKind;
type ContextSegment = ContextArtifact["segments"][number];
type Omission = ContextArtifact["omissions"][number];

interface DraftSegment {
  readonly segmentId: string;
  readonly kind: UserSegmentKind;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly releasePolicyIds: readonly string[];
  readonly protected: boolean;
}

const defaultBudgets: Readonly<Record<UserSegmentKind, number>> = {
  world: 800,
  task: 500,
  memory: 1000,
  history: 800,
  input: 400,
};

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

function trimLinesToBudget(
  text: string,
  budget: number,
  keepFirst: boolean,
): { readonly text: string; readonly removed: boolean; readonly fits: boolean } {
  const lines = nonEmptyLines(text);
  if (lines.length === 0 || budget === 0) {
    return { text: "", removed: lines.length > 0, fits: !keepFirst && lines.length === 0 };
  }
  let current = [...lines];
  let removed = false;
  while (estimateTokens(current.join("\n")) > budget && current.length > (keepFirst ? 1 : 0)) {
    current.pop();
    removed = true;
  }
  const nextText = current.join("\n");
  return {
    text: nextText,
    removed,
    fits: estimateTokens(nextText) <= budget,
  };
}

function policyValues(request: ContextBuildRequest): readonly string[] {
  const values = request.observations.map((observation) => observation.releasePolicyId);
  return values.length === 0 ? ["public"] : uniqueStrings(values);
}

function observationRefs(request: ContextBuildRequest): readonly string[] {
  const values = request.observations.map((observation) => observation.observationId);
  return values.length === 0 ? [`frontier:${request.frontier.observationSeq}`] : uniqueStrings(values);
}

function relationText(request: ContextBuildRequest): string {
  return request.memoryBundle.relationSummary.map((relation) =>
    `- ${relation.targetId}: trust=${relation.trust}, affinity=${relation.affinity}, wariness=${relation.wariness}`,
  ).join("\n");
}

function memoryItemText(item: MemoryBundleItem): string {
  return `- [${item.memoryId}] ${item.summaryZh} (${item.epistemic}, tick ${item.validFromTick})`;
}

function relationRefs(request: ContextBuildRequest): string[] {
  return uniqueStrings(request.memoryBundle.relationSummary.flatMap((relation) => relation.reasonMemoryIds));
}

function buildMemorySegment(
  request: ContextBuildRequest,
  budget: number,
): { readonly segment: DraftSegment | null; readonly omissions: readonly Omission[]; readonly fits: boolean; readonly tokenEstimate: number } {
  const bundle = request.memoryBundle;
  const omissions: Omission[] = [];
  const core = bundle.coreBlock?.trim() ?? "";
  const relations = relationText(request);
  const baseLines = [core, relations].filter((value) => value.length > 0);
  const baseText = baseLines.join("\n");
  if (estimateTokens(baseText) > budget) {
    const refs = relationRefs(request);
    for (const sourceRef of refs.length === 0 ? [`memory:${request.session.agentId}`] : refs) {
      omissions.push({ sourceRef, reason: "budget" });
    }
    return { segment: null, omissions, fits: false, tokenEstimate: budget };
  }

  const selected: MemoryBundleItem[] = [];
  let text = baseText;
  for (const item of bundle.items) {
    const candidate = [text, memoryItemText(item)].filter((value) => value.length > 0).join("\n");
    if (estimateTokens(candidate) <= budget) {
      selected.push(item);
      text = candidate;
      continue;
    }
    omissions.push({ sourceRef: item.memoryId, reason: "budget" });
    if (item.mustInclude) {
      return { segment: null, omissions, fits: false, tokenEstimate: budget };
    }
  }
  if (text.length === 0) return { segment: null, omissions, fits: true, tokenEstimate: 0 };
  return {
    segment: {
      segmentId: "memory",
      kind: "memory",
      text,
      sourceRefs: uniqueStrings([
        ...relationRefs(request),
        ...selected.flatMap((item) => [item.memoryId, ...item.sourceObservationIds]),
      ]),
      releasePolicyIds: uniqueStrings([
        ...bundle.items.map((item) => item.releasePolicyId),
        ...request.observations.map((observation) => observation.releasePolicyId),
      ]),
      protected: core.length > 0 || relations.length > 0 || bundle.items.some((item) => item.mustInclude),
    },
    omissions,
    fits: true,
    tokenEstimate: estimateTokens(text),
  };
}

function buildDraftSegments(
  request: ContextBuildRequest,
  order: readonly UserSegmentKind[],
): { readonly drafts: readonly DraftSegment[]; readonly omissions: Omission[]; readonly fits: boolean } {
  const omissions: Omission[] = [];
  let fits = true;
  const byKind = new Map<UserSegmentKind, DraftSegment>();
  const addTextSegment = (
    kind: "world" | "task" | "history" | "input",
    text: string,
    sourceRefs: readonly string[],
    releasePolicyIds: readonly string[],
    protectedValue: boolean,
    budgetOverride?: number,
  ): void => {
    if (text.trim().length === 0) return;
    const budget = budgetOverride ?? request.budget.segmentBudgets[kind] ?? defaultBudgets[kind];
    const trimmed = trimLinesToBudget(text, budget, kind === "world" || kind === "task" ? true : protectedValue);
    if (trimmed.removed) {
      for (const sourceRef of sourceRefs) omissions.push({ sourceRef, reason: "budget" });
    }
    if (!trimmed.fits || trimmed.text.trim().length === 0) {
      fits = false;
      return;
    }
    byKind.set(kind, {
      segmentId: kind,
      kind,
      text: trimmed.text,
      sourceRefs: [...sourceRefs],
      releasePolicyIds: [...releasePolicyIds],
      protected: protectedValue,
    });
  };

  const worldRelease = policyValues(request);
  const worldBudget = request.budget.segmentBudgets.world ?? defaultBudgets.world;
  addTextSegment("world", request.worldViewText, [`world:${request.session.agentId}`], worldRelease, false, worldBudget);
  let carry = request.budget.lendUnusedBudget
    ? Math.max(0, worldBudget - estimateTokens(request.worldViewText))
    : 0;
  const taskBudget = (request.budget.segmentBudgets.task ?? defaultBudgets.task) + carry;
  addTextSegment(
    "task",
    request.affairsText,
    [`affairs:${request.session.agentId}`],
    request.targetAudience.length === 0 ? ["public"] : [`parties:${request.targetAudience.join(",")}`],
    true,
    taskBudget,
  );
  carry = request.budget.lendUnusedBudget
    ? Math.max(0, taskBudget - estimateTokens(request.affairsText))
    : 0;
  const memoryBudget = (request.budget.segmentBudgets.memory ?? defaultBudgets.memory) + carry;
  const memory = buildMemorySegment(request, memoryBudget);
  omissions.push(...memory.omissions);
  if (memory.segment !== null) byKind.set("memory", memory.segment);
  fits &&= memory.fits;
  carry = request.budget.lendUnusedBudget
    ? Math.max(0, memoryBudget - memory.tokenEstimate)
    : 0;
  const historyBudget = (request.budget.segmentBudgets.history ?? defaultBudgets.history) + carry;
  addTextSegment(
    "history",
    request.historyText,
    [`history:${request.session.agentId}`],
    request.targetAudience.length === 0 ? ["public"] : [`parties:${request.targetAudience.join(",")}`],
    false,
    historyBudget,
  );
  carry = request.budget.lendUnusedBudget
    ? Math.max(0, historyBudget - estimateTokens(request.historyText))
    : 0;
  const inputBudget = (request.budget.segmentBudgets.input ?? defaultBudgets.input) + carry;
  addTextSegment("input", request.inputText, observationRefs(request), policyValues(request), true, inputBudget);

  return {
    drafts: order.flatMap((kind) => {
      const segment = byKind.get(kind);
      return segment === undefined ? [] : [segment];
    }),
    omissions,
    fits,
  };
}

function asSegment(segment: DraftSegment, role: "system" | "user"): ContextSegment {
  return {
    segmentId: segment.segmentId,
    kind: segment.kind,
    role,
    sourceRefs: [...segment.sourceRefs],
    releasePolicyIds: [...segment.releasePolicyIds],
    text: segment.text,
    tokenEstimate: estimateTokens(segment.text),
    protected: segment.protected,
  };
}

function dedupeOmissions(omissions: readonly Omission[]): Omission[] {
  const seen = new Set<string>();
  return omissions.filter((omission) => {
    const key = `${omission.sourceRef}\u0000${omission.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class OrderedBlocksContextBuilder implements AgentContextPort {
  constructor(
    private readonly config: OrderedBlocksContextConfig,
    private readonly host: { hash(value: Json): Promise<string>; ids(prefix: string): string },
  ) {}

  async build(request: ContextBuildRequest): Promise<ContextArtifact> {
    const protocol: DraftSegment = {
      segmentId: "protocol",
      kind: "input",
      text: request.systemIdentity,
      sourceRefs: [`template:${request.templateVersion}`],
      releasePolicyIds: ["public"],
      protected: true,
    };
    const identityText = request.loreSummary.trim();
    const identity: DraftSegment | null = identityText.length === 0 ? null : {
      segmentId: "identity",
      kind: "task",
      text: identityText,
      sourceRefs: [`lore:${request.templateVersion}`],
      releasePolicyIds: ["public"],
      protected: true,
    };
    const built = buildDraftSegments(request, this.config.segmentOrder);
    const system = [protocol.text, identity?.text ?? ""].filter((value) => value.length > 0).join("\n\n");
    const userSegments = built.drafts.map((segment) => segment.text);
    const tokenEstimate = estimateContextTokens(system, userSegments);
    const { effectiveMaxTokens, targetTokens } = resolveContextTokenLimits(request);
    const status = request.memoryBundle.status === "not-ready"
      ? "not-ready"
      : effectiveMaxTokens === 0 || !built.fits || tokenEstimate > targetTokens
        ? "over-budget"
        : "ready";
    const failureReason = status === "ready"
      ? null
      : !built.fits
        ? "protected-content-over-budget"
        : status === "not-ready"
          ? "not-ready"
          : "request-over-budget";
    const artifactWithoutId = {
      parentArtifactId: null,
      session: request.session,
      turnId: request.turnId,
      phase: request.phase,
      frontier: request.frontier,
      profileHash: request.profileHash,
      templateVersion: request.templateVersion,
      status,
      system,
      segments: [
        asSegment(protocol, "system"),
        ...(identity === null ? [] : [asSegment(identity, "system")]),
        ...built.drafts.map((segment) => asSegment(segment, "user")),
      ],
      omissions: dedupeOmissions(built.omissions),
      tokenEstimate,
      failureReason,
    } satisfies Omit<ContextArtifact, "artifactId" | "hash">;
    return {
      artifactId: this.host.ids("art"),
      ...artifactWithoutId,
      hash: await this.host.hash(canonicalJson(artifactWithoutId) as Json),
    };
  }
}