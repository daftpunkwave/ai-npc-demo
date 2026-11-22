/**
 * 为一个已认领 turn 绑定模型调用、上下文档案与独立对白入口。
 * 复用冻结 frontier、策略端口、工具结果和当前阶段的租约守卫。
 * 禁止传送未经授权的 decision 历史到 speech 或把过期模型结果交给策略。
 */
import {
  estimateModelInputTokens, resolveContextTokenLimits, type AgentTurnStatus, type ContextArtifact, type HostServices, type MemoryBundle,
} from "@ai-npc/contracts";
import type { ContentPack, ResolvedAgentProfile } from "@ai-npc/experiment";
import type {
  AgentArtifactStore, AgentCompressionPort, AgentContextPort, ModelCallInput, ModelDecisionPort, ModelWorkScope, RunModelPort,
} from "@ai-npc/module-sdk";
import { AgentContextPipeline } from "./context-pipeline";
import type { SpeechGenerator } from "./dialogue-flow";
import { decisionContext, modelContextBudget, triggerPrincipals, validateModelDecision } from "./model-turn-materials";
import type { ToolCallOutcome } from "./tool-gateway-types";
import type { TurnEvidence } from "./turn-evidence";
import type { FrozenTurnInput } from "./turn-input";
import { TurnStopped, type ClaimedTurn } from "./turn-lease";

type DecisionInput = Parameters<ModelDecisionPort["decide"]>[0];

export interface ModelTurnPorts {
  readonly decision: ModelDecisionPort;
  readonly context: AgentContextPort;
  readonly compression: AgentCompressionPort;
}

interface ModelTurnOptions {
  readonly host: HostServices;
  readonly pool: RunModelPort;
  readonly ports: ModelTurnPorts;
  readonly content: ContentPack;
  readonly profile: ResolvedAgentProfile;
  readonly memory: MemoryBundle;
  readonly frozen: FrozenTurnInput;
  readonly turn: ClaimedTurn;
  readonly evidence: TurnEvidence;
  readonly artifacts: AgentArtifactStore;
  readonly signal: AbortSignal;
  readonly messagePrincipalIds: ReadonlySet<string>;
  readonly assertCurrent: (status: AgentTurnStatus) => void;
}

export class ModelTurn {
  constructor(private readonly options: ModelTurnOptions) {}

  async decide(input: {
    readonly attemptId: string;
    readonly tools: DecisionInput["tools"];
    readonly toolViewLimits: DecisionInput["toolViewLimits"];
    readonly executeTool: DecisionInput["executeTool"];
    readonly toolResults: readonly ToolCallOutcome[];
    readonly contextSelection: Parameters<TurnEvidence["record"]>[3];
    readonly compressionSelection: Parameters<TurnEvidence["record"]>[3];
  }) {
    const { ports, content, host, evidence, pool, turn, profile, frozen, artifacts } = this.options;
    const route = pool.route(frozen.scope.agentId, "decision");
    const request = decisionContext({ ...this.options, attemptId: input.attemptId, route });
    const limits = resolveContextTokenLimits(request);
    const toolTokens = estimateModelInputTokens({ system: "", messages: [], tools: input.tools, output: { kind: "text" } });
    const contextLimit = limits.effectiveMaxTokens - toolTokens;
    if (contextLimit <= 0) throw new TurnStopped("failed", "over-budget");
    const pipeline = new AgentContextPipeline({ context: ports.context, compression: ports.compression, host });
    const prepared = await evidence.stage("turn.context", async () => {
      const value = await pipeline.prepareFirstRequest({ ...request, budget: { ...request.budget, maxInputTokens: contextLimit } });
      for (const artifact of value.original === undefined ? [value.artifact] : [value.original, value.artifact]) {
        await artifacts.put({ artifactId: artifact.artifactId, runId: turn.runId, kind: "context", value: artifact });
      }
      return value;
    }, ({ artifact, original }) => ({
      status: artifact.status === "ready" || original?.status === "ready" ? "applied" : "failed",
      reason: original?.failureReason ?? artifact.failureReason,
      effective: { artifactId: (original ?? artifact).artifactId, templateVersion: request.templateVersion },
    }), input.contextSelection);
    evidence.record("turn.compression", evidence.start(), {
      status: prepared.compressionStatus === "compressed" ? "applied" : prepared.ready ? "skipped" : "failed",
      reason: prepared.compressionStatus, effective: { artifactId: prepared.artifact.artifactId, lossReport: prepared.lossReport },
    }, input.compressionSelection);
    if (!prepared.ready) throw new TurnStopped("failed", prepared.artifact.failureReason ?? "over-budget");

    const artifact = prepared.artifact;
    let parentArtifactId = artifact.artifactId;
    const call = this.call("decision", "deciding");
    const user = renderUser(artifact, request.inputText.split("\n")[0] ?? "", content.prompts.decision.user);
    const validate: DecisionInput["validate"] = (candidate) => validateModelDecision({
      candidate, artifact, frozen, memory: this.options.memory, tools: input.toolResults, content,
      messagePrincipalIds: this.options.messagePrincipalIds,
    });
    const result = await ports.decision.decide({
      system: artifact.system, user, tools: input.tools, inputLimit: limits.effectiveMaxTokens,
      firstInputLimit: limits.targetTokens, toolViewLimits: input.toolViewLimits,
      maxRounds: profile.budgets.maxDecisionRounds, maxCallsPerRound: profile.budgets.maxToolCallsPerRound,
      maxCallsPerTurn: profile.budgets.maxToolCallsPerTurn,
      nudgeSubmit: content.prompts.decision.nudgeSubmit, budgetStop: content.prompts.decision.budgetStop,
      call: async (round) => {
        if (round.round > 1) {
          const next = await artifacts.put({ runId: turn.runId, kind: "context", value: {
            phase: "decision", parentArtifactId, turnId: turn.auth.turnId, round: round.round,
            messages: [...round.messages],
          } });
          parentArtifactId = next.artifactId;
        }
        return call({ ...round, contextArtifactId: parentArtifactId });
      },
      executeTool: input.executeTool,
      validate,
    });
    if (result.status !== "ok") return result;
    const checked = validate(result.decision);
    return "decision" in checked
      ? { ...result, decision: checked.decision }
      : { ...result, status: "invalid-decision" as const, decision: null };
  }

  speech(status: "executing" | "speaking"): SpeechGenerator {
    const { pool, ports, profile, frozen } = this.options;
    const route = pool.route(frozen.scope.agentId, "speech");
    const { effectiveMaxTokens } = resolveContextTokenLimits({
      phase: "speech", budget: modelContextBudget(profile, "speech", route),
      modelWindowTokens: route.capabilities.contextWindowTokens,
    });
    return (request, round) => ports.decision.speak({
      request, round, inputLimit: effectiveMaxTokens, call: this.call("speech", status),
    });
  }

  private call(purpose: "decision" | "speech", status: AgentTurnStatus) {
    const { pool, profile, frozen, turn, evidence, signal, assertCurrent } = this.options;
    const scope: ModelWorkScope = {
      ...frozen.scope, runId: turn.runId, workRef: turn.auth.turnId, traceId: evidence.traceId,
      worldTick: frozen.frontier.worldTick, triggerPrincipalIds: triggerPrincipals(frozen),
      maxModelCalls: profile.budgets.maxModelCallsPerTurn, maxDailyTokens: profile.budgets.maxTokensPerAgentPerDay,
      deadlineMs: turn.deadlineMs, signal,
      fence: () => {
        try {
          assertCurrent(status);
          return true;
        } catch (error) {
          if (error instanceof TurnStopped) return false;
          throw error;
        }
      },
    };
    return async (request: ModelCallInput) => {
      const started = evidence.start();
      try {
        const result = await pool.call(scope, purpose, profile.budgets.reserveOutputTokens[purpose], request);
        assertCurrent(status);
        const substituted = result.attempts.some((attempt) => attempt.substituted === true);
        evidence.record("turn.model", started, {
          status: "applied", reason: substituted ? "model-substituted" : null,
          effective: { purpose, round: request.round, attempts: [...result.attempts] },
        });
        return result;
      } catch (error) {
        assertCurrent(status);
        throw error;
      }
    };
  }
}

function renderUser(artifact: ContextArtifact, time: string, template: string): string {
  const memoryHeading = template.split(/\n\s*\n/u).find((p) => p.includes("{{memoryLines}}"))?.replace("{{memoryLines}}", "").trim();
  const body = artifact.segments.filter(({ role }) => role === "user").map(({ kind, text }) => {
    if (kind === "memory" && memoryHeading) return `${memoryHeading}\n${text}`;
    if (kind === "input" && time && text.startsWith(time)) return text.slice(time.length).trimStart();
    return text;
  });
  return [time, ...body].filter(Boolean).join("\n\n");
}
