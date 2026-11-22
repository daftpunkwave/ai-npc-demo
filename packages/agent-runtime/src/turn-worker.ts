/**
 * 执行唯一的 Agent turn 管线，并把动作、对白与记忆发布交给各自的守卫。
 * 执行依赖已冻结 profile、授权视图、已装配决策端口与工具网关。
 * 等待和策略计算在事务外进行。旧租约、暂停和接管不得发布结果。
 */
import {
  canonicalJson, toModelToolName,
  type AgentTurnStatus, type AuthContext, type CommandEnvelope, type CommandReceipt, type Json, type NormalizedToolCall,
} from "@ai-npc/contracts";
import type { ResolvedAgentProfile } from "@ai-npc/experiment";
import {
  agentModelPoolCapability, bindAgentModelRoutes,
  type AgentDecisionPort, type AgentToolViewPort, type AgentContextPort, type AgentCompressionPort,
  type DeterministicDecisionInput, type ModelDecisionPort, type RunModelPort,
} from "@ai-npc/module-sdk";
import { AgentModuleHandle } from "./agent-module-handle";
import { StoredAgentArtifactStore } from "@ai-npc/module-sdk";
import { DialogueFlow, messageIntentFromArguments, type SpeechApprovalIndex, type SpeechApprovalInput } from "./dialogue-flow";
import type { MemoryHost } from "./memory-host";
import { ModelTurn, type ModelTurnPorts } from "./model-turn";
import { decisionSubmitTool } from "./model-turn-materials";
import type { AgentRuntimeOptions } from "./runtime";
import { asRecord } from "./runtime-records";
import { ToolGateway, type ToolCallOutcome, type ToolCatalogPort } from "./tool-gateway";
import { TurnEvidence, type StageSelection, type TurnSpan } from "./turn-evidence";
import { freezeTurnInput, type ReadTurnWorld } from "./turn-input";
import { TurnLeases, TurnStopped, type ClaimedTurn } from "./turn-lease";
import { checkedDecision, probeQuestion, prospectiveInputs, speechInput, turnMemoryQuery } from "./turn-materials";
import { turnQueries } from "./turn-queries";
import { disclosedTurnReceipts } from "./turn-speech-receipts";

export interface TurnExecutionOptions {
  readonly runSeed: string;
  readonly profileHashes: ReadonlyMap<string, string>;
  readonly tools: ToolCatalogPort;
  readonly approvals: SpeechApprovalIndex;
  readonly readWorld: ReadTurnWorld;
  readonly recordSpan: (span: TurnSpan) => void;
  readonly executeCommand: (auth: AuthContext, envelope: CommandEnvelope) => CommandReceipt;
  readonly probeScriptId?: string;
  readonly ports: Readonly<Record<string, unknown>>;
  readonly model?: RunModelPort | null;
}

type TurnPorts = { readonly toolView: AgentToolViewPort } & (
  { readonly model: ModelTurnPorts; readonly decision: null } |
  { readonly model: null; readonly decision: AgentDecisionPort<DeterministicDecisionInput> }
);

export class TurnWorker {
  private readonly ports = new Map<string, TurnPorts>();
  private readonly disposables: { dispose(): Promise<void> }[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly leases: TurnLeases;
  private readonly artifacts: StoredAgentArtifactStore;
  private readonly dialogue: DialogueFlow;

  constructor(
    private readonly runtime: AgentRuntimeOptions,
    private readonly execution: TurnExecutionOptions,
    private readonly memory: MemoryHost,
    private readonly signal: AbortSignal,
  ) {
    const { content, host, storage } = runtime;
    this.leases = new TurnLeases(storage, host, signal);
    this.artifacts = new StoredAgentArtifactStore(storage, host);
    this.dialogue = new DialogueFlow({ host, content, artifacts: this.artifacts, approvals: execution.approvals });
  }

  async start(): Promise<void> {
    for (const agent of this.runtime.roster.agents) {
      const profile = this.requireProfile(agent.agentId);
      if (!this.execution.profileHashes.has(agent.agentId)) throw new Error(`Missing profile hash for ${agent.agentId}`);
      const { agentId } = agent;
      const { slots } = profile;
      const toolView = (await this.createSlot<AgentToolViewPort>(agentId, slots.toolView)).port;
      const definition = this.runtime.moduleDefinitions.get(slots.decision?.module ?? "");
      if (definition?.requires.some(({ capability }) => capability === agentModelPoolCapability)) {
        const pool = this.execution.model;
        if (pool == null) throw new Error(`No scoped model pool for ${agentId}`);
        const decision = (await this.createSlot<ModelDecisionPort>(agentId, slots.decision, {
          ...this.execution.ports,
          [agentModelPoolCapability]: bindAgentModelRoutes(pool, agentId),
        })).port;
        const context = (await this.createSlot<AgentContextPort>(agentId, slots.context)).port;
        const compression = (await this.createSlot<AgentCompressionPort>(agentId, slots.compression)).port;
        this.ports.set(agentId, { decision: null, toolView, model: { decision, context, compression } });
      } else {
        const decision = (await this.createSlot<AgentDecisionPort<DeterministicDecisionInput>>(agentId, slots.decision)).port;
        this.ports.set(agentId, { decision, toolView, model: null });
      }
    }
  }

  dispatch(turnId: string, agentId: string): void {
    const execution = this.run(turnId, agentId)
      .then(() => this.runtime.onStateChange?.())
      .catch((error: unknown) => this.logFailure(turnId, error))
      .finally(() => this.running.delete(execution));
    this.running.add(execution);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.running);
    let failure: unknown;
    for (const handle of this.disposables.splice(0).reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async createSlot<Port>(agentId: string, selected: ResolvedAgentProfile["slots"]["decision"], ports = this.execution.ports) {
    const definition = selected === undefined ? undefined : this.runtime.moduleDefinitions.get(selected.module);
    if (selected === undefined || definition === undefined) throw new Error(`Unresolved turn module for ${agentId}`);
    const handle = await AgentModuleHandle.create<Port>({
      ...this.runtime, agentId, moduleId: selected.module, config: selected.config, definition,
      ports, signal: this.signal,
    });
    this.disposables.push(handle);
    return handle;
  }

  private async run(turnId: string, agentId: string): Promise<void> {
    const { storage, host, content } = this.runtime;
    const profile = this.requireProfile(agentId);
    const profileHash = this.execution.profileHashes.get(agentId);
    const ports = this.ports.get(agentId);
    if (profileHash === undefined || ports === undefined) throw new Error(`Turn modules missing for ${agentId}`);
    const claimStarted = host.monotonicMs();
    const turn = this.leases.claim(turnId, { ...this.runtime, profileHash, maxTurnMs: profile.budgets.maxTurnMs });
    if (turn === null) return;
    const evidence = new TurnEvidence(storage, host, turn, this.execution.recordSpan);
    try {
      evidence.record("turn.claim", claimStarted, {
        status: "applied", reason: null, effective: { triggerIds: turn.triggers.map(({ triggerId }) => triggerId) },
      });
      const frozen = await evidence.stage("turn.readiness", () => freezeTurnInput({
        storage, host, profile, turn, leases: this.leases, readWorld: this.execution.readWorld, signal: this.signal,
      }), (result) => ({ status: "applied", reason: result.degraded, effective: {
        frontier: result.frontier, degraded: result.degraded !== null,
      } }));
      evidence.record("turn.perception", evidence.start(), {
        status: "applied", reason: null, effective: { observationIds: frozen.observations.map(({ observationId }) => observationId) },
      }, this.selection(profile, "perception"));
      const prospectiveIds = new Set(turn.triggers.filter(({ kind }) => kind === "prospective").map(({ sourceRef }) => sourceRef));
      const records = this.memory.prospectiveRecords(agentId, frozen.frontier.memoryRevision, prospectiveIds);
      const promises = prospectiveInputs(agentId, records);
      const query = turnMemoryQuery(frozen, promises, content, profile);
      const memory = await evidence.stage("turn.memory.retrieve", () => {
        const bundle = this.memory.retrieve(agentId, query);
        if (bundle.status === "not-ready" || bundle.revision !== frozen.frontier.memoryRevision) {
          throw new TurnStopped("failed", "not-ready");
        }
        return bundle;
      }, (result) => ({ status: "applied", reason: null, effective: {
        revision: result.revision, status: result.status, memoryIds: result.items.map(({ memoryId }) => memoryId),
      } }), this.selection(profile, "memory"));
      const retrieved = new Set<string>(memory.items.map(({ memoryId }) => memoryId));
      const prospective = promises.filter(({ memoryId }) => retrieved.has(memoryId));
      const attemptId = host.ids("att");
      const toolCalls: ToolCallOutcome[] = [];
      const sent = new Set<string>();
      const messagePrincipalIds = new Set([content.index.playerPrincipalId, ...this.runtime.roster.agents.map((entry) => entry.agentId)]);
      messagePrincipalIds.delete(agentId);
      const model = ports.model === null || this.execution.model == null ? null : new ModelTurn({
        host, pool: this.execution.model, ports: ports.model, content, profile, memory, frozen, turn, evidence,
        signal: this.signal, artifacts: this.artifacts, assertCurrent: (status) => this.assertCurrent(turn, status),
        messagePrincipalIds: this.execution.tools.bindingsFor(agentId).some(({ toolId }) => toolId === "message.send")
          ? messagePrincipalIds : new Set(),
      });
      const prepareSpeech = (intent: SpeechApprovalInput["intent"], channel?: SpeechApprovalInput["channel"]) => {
        const speech = speechInput({ frozen, turn, content, profile, memory, prospective, intent,
          ...(channel === undefined ? {} : { channel }) });
        return {
          ...speech, ...disclosedTurnReceipts(storage, speech, toolCalls),
          rejectedToolCommand: toolCalls.some(({ result }) => result.commandStatus === "rejected"),
        };
      };
      const gateway = new ToolGateway({
        storage, host, tools: this.execution.tools, toolView: ports.toolView, artifacts: this.artifacts,
        executeQuery: turnQueries({
          frozen, content, toolCalls, historyTurns: Number(asRecord(profile.slots.context?.config)["historyTurns"]),
        }),
        executeCommand: (auth, envelope) => this.commit(turn, "executing", auth, envelope),
        executeMessage: async (message) => {
          const intent = messageIntentFromArguments(message.arguments);
          const allowed = model === null ? undefined : new Set([...messagePrincipalIds, "public"]);
          if (intent === null || checkedDecision({
            stance: "inform", dialogueIntent: intent, noteworthy: [], citedMemoryIds: [], decisionNote: "",
          }, frozen, memory, prospective, toolCalls.map(({ result }) => result), allowed) === null) {
            throw new TurnStopped("failed", "invalid-message-intent");
          }
          const channel = intent.audience[0] === "public" ? "broadcast" : "message";
          const approved = await this.dialogue.approve(prepareSpeech(intent, channel), model?.speech("executing"), message.commandId, model === null);
          try {
            const receipt = this.commit(turn, "executing", turn.auth, approved.commitEnvelope);
            return { receipt, output: receipt.result ?? {} };
          } finally {
            this.execution.approvals.remove(approved.artifact.artifactId);
          }
        },
      });
      const ownsFaction = content.index.factions.has(agentId);
      const toolTurn = {
        session: frozen.scope, runId: turn.runId, turnId, agentId, attemptId,
        auth: turn.auth, phase: "decision" as const, audience: [], narrowing: {
          messagePrincipalIds,
          invitedTaskIds: frozen.world.taskInvitations.map(({ taskId }) => taskId),
          teamIds: [
            ...frozen.world.delegations.flatMap(({ teamIds }) => teamIds),
            ...(ownsFaction ? [...content.index.teams.values()].filter(({ ownerFactionId }) => ownerFactionId === agentId).map(({ teamId }) => teamId) : []),
          ],
          policyKeys: [...content.index.roads.values()].filter(({ controlledBy }) => ownsFaction && controlledBy === agentId)
            .map(({ roadId }) => `road.status:${roadId}`),
          evidenceIds: [...(frozen.world.knowledge.get(agentId) ?? [])].filter((id) => content.index.evidence.has(id)),
        },
      };
      let calls = 0;
      const executeCall = async (call: NormalizedToolCall, round: number, deterministicToolId?: string) => {
        if (turn.probe && !this.execution.tools.definitions().some(({ toolId, effect }) =>
          effect === "query" && toModelToolName(toolId) === call.name)) throw new TurnStopped("failed", "probe-tool-forbidden");
        if (++calls > profile.budgets.maxToolCallsPerTurn) throw new TurnStopped("budget-exhausted", "tool-call-limit");
        this.leases.move(turn, "deciding", "executing");
        const outcome = await evidence.stage("turn.tool", async () => {
          const associated = deterministicToolId !== undefined && turn.triggers.some(({ triggerId }) => triggerId === call.id);
          const operationHash = associated ? await host.hash([agentId, call.id, deterministicToolId]) : null;
          this.assertCurrent(turn, "executing");
          return gateway.executeCall({
            ...toolTurn, round, providerCallId: call.id, wireName: call.name,
            arguments: call.parseError === null ? call.arguments : null, argumentsRaw: call.argumentsRaw,
            ...(operationHash === null ? {} : { operationId: `op-${operationHash.slice(0, 12)}` }),
          });
        }, ({ toolCallId, result }) => ({
          status: result.executionStatus === "ok" ? "applied" : "failed",
          reason: result.reasonCode,
          effective: { toolCallId, resultRef: result.resultRef, receiptId: result.receiptId, commandStatus: result.commandStatus },
        }));
        toolCalls.push(outcome);
        this.leases.move(turn, "executing", "deciding");
        if (outcome.toolId === "message.send" && outcome.result.commandStatus === "accepted") {
          const intent = messageIntentFromArguments(call.arguments);
          if (intent !== null) sent.add(canonicalJson(intent));
        }
        return outcome;
      };
      const executeTool: DeterministicDecisionInput["executeTool"] = (call) => {
        if (call.attemptId !== attemptId) throw new TurnStopped("failed", "invalid-tool-attempt");
        return executeCall({
          id: call.providerCallId, name: toModelToolName(call.toolId), arguments: call.arguments,
          argumentsRaw: canonicalJson(call.arguments), parseError: null,
        }, call.round, call.toolId);
      };
      const skip = (step: string, slot: keyof ResolvedAgentProfile["slots"], why: string): void => {
        evidence.record(step, evidence.start(), { status: "skipped", reason: why, effective: null }, this.selection(profile, slot));
      };
      if (model === null) {
        skip("turn.context", "context", "deterministic-decision");
        skip("turn.compression", "compression", "deterministic-decision");
      }
      this.leases.move(turn, "preparing", "deciding");
      const decision = await evidence.stage("turn.decision", async () => {
        const projected = model === null ? null : gateway.projectTools({ ...toolTurn, round: 1 });
        const readOnly = new Set(this.execution.tools.definitions().filter(({ effect }) =>
          effect === "query").map(({ toolId }) => toModelToolName(toolId)));
        const result = model !== null ? await model.decide({
          attemptId, tools: [...(projected?.tools ?? []).filter(({ name }) => !turn.probe || readOnly.has(name)), decisionSubmitTool(content)],
          toolViewLimits: new Map(projected?.bindings.map(({ toolId, viewConstraints }) => [toModelToolName(toolId), viewConstraints.maxTokens])),
          executeTool: (call, round) => executeCall(call, round), toolResults: toolCalls,
          contextSelection: this.selection(profile, "context"), compressionSelection: this.selection(profile, "compression"),
        }) : await this.decideBeforeDeadline(ports.decision!, {
          session: frozen.scope, runId: turn.runId, turnId, attemptId, frontier: frozen.frontier,
          profileHash, runSeed: this.execution.runSeed, agentTurnIndex: turn.agentTurnIndex,
          triggers: turn.triggers, observations: frozen.observations, memory, prospective,
          self: {
            injured: frozen.world.injured, delegations: frozen.world.delegations,
            skills: content.index.characters.get(agentId)?.skills ?? content.index.factions.get(agentId)?.persona.skills ?? [],
          },
          taskInvitations: frozen.world.taskInvitations, lexicons: content.locale.lexicons,
          executeTool, deadlineMs: turn.deadlineMs,
        });
        this.assertCurrent(turn, "deciding");
        if (result.status !== "ok") {
          throw new TurnStopped(result.status === "budget-exhausted" ? "budget-exhausted" : "failed", result.status);
        }
        const value = model !== null ? result.decision :
          checkedDecision(result.decision, frozen, memory, prospective, toolCalls.map(({ result }) => result));
        if (value === null) throw new TurnStopped("failed", "invalid-decision");
        const artifact = await this.artifacts.put({
          kind: "decision", runId: turn.runId, value: { turnId, frontier: frozen.frontier, decision: value },
        });
        return { value, artifactId: artifact.artifactId };
      }, ({ artifactId }) => ({ status: "applied", reason: null, effective: { artifactId } }), this.selection(profile, "decision"));
      if (toolCalls.length === 0) {
        evidence.record("turn.tool", evidence.start(), { status: "skipped", reason: "no-tool-calls", effective: null });
      }
      evidence.record("turn.tool-view", evidence.start(), {
        status: toolCalls.length === 0 ? "skipped" : "applied",
        reason: toolCalls.length === 0 ? "no-tool-calls" : null,
        effective: toolCalls.map(({ viewArtifact }) => viewArtifact.artifactId),
      }, this.selection(profile, "toolView"));
      const intent = decision.value.dialogueIntent;
      if (intent.kind === "none" || sent.has(canonicalJson(intent))) {
        evidence.record("turn.speech", evidence.start(), {
          status: "skipped", reason: intent.kind === "none" ? "no-dialogue-intent" : "message-already-committed", effective: null,
        });
        this.leases.move(turn, "deciding", "settling");
      } else {
        this.leases.move(turn, "deciding", "speaking");
        await evidence.stage("turn.speech", async () => {
          const approved = await this.dialogue.approve({
            ...prepareSpeech(intent), publication: "turn-reply",
          }, model?.speech("speaking"), host.ids("cmd"), model === null);
          const source = model === null || approved.artifact.fallback ? "safe-template" : "model";
          try {
            if (turn.probe) {
              const probe = probeQuestion(frozen);
              const scriptId = this.execution.probeScriptId;
              if (probe === null || scriptId === undefined) throw new TurnStopped("failed", "invalid-probe");
              storage.transact((tx) => {
                this.leases.require(tx, turn, "speaking");
                tx.rows("probe_results").put({
                  probe_result_id: host.ids("prb"), run_id: turn.runId, script_id: scriptId,
                  probe_id: probe.probeId, agent_id: agentId, asked_at_tick: probe.askedAtTick,
                  answer_text: approved.artifact.text, decision_json: decision.value, score_json: null,
                  valid: 1, invalid_reason: null, created_at: host.nowIso(),
                });
              });
              return { artifactId: approved.artifact.artifactId, receiptId: null, source, fallback: approved.artifact.fallback };
            }
            const receipt = this.commit(turn, "speaking", turn.auth, approved.commitEnvelope);
            if (receipt.commandStatus !== "accepted") throw new TurnStopped("failed", receipt.reasonCode ?? "speech-rejected");
            return { artifactId: approved.artifact.artifactId, receiptId: receipt.receiptId, source, fallback: approved.artifact.fallback };
          } finally {
            this.execution.approvals.remove(approved.artifact.artifactId);
          }
        }, (outcome) => ({ status: "applied", reason: outcome.fallback ? "speech-fallback" : null, effective: outcome }));
        this.leases.move(turn, "speaking", "settling");
      }
      await evidence.stage("turn.settle", () => this.memory.recordUse(agentId, {
        turnId, worldTick: frozen.frontier.worldTick, baseRevision: memory.revision, retrievedMemoryIds: [...retrieved],
        inputObservations: frozen.observations, citedMemoryIds: decision.value.citedMemoryIds,
        noteworthy: decision.value.noteworthy, guard: (tx) => { this.leases.require(tx, turn, "settling"); },
      }), (revision) => ({
        status: "applied", reason: null, effective: { revision, citedMemoryIds: decision.value.citedMemoryIds },
      }), this.selection(profile, "memory"));
      this.leases.finish(turn, "completed", null);
    } catch (error) {
      if (error instanceof TurnStopped) {
        this.leases.finish(turn, error.status, error.reason);
      } else {
        this.leases.finish(turn, "failed", "turn-execution-failed");
        this.logFailure(turnId, error);
      }
    }
  }

  private async decideBeforeDeadline(port: AgentDecisionPort<DeterministicDecisionInput>, input: DeterministicDecisionInput) {
    const timer = new AbortController();
    const signal = AbortSignal.any([timer.signal, this.signal]);
    try {
      const remaining = Math.max(0, input.deadlineMs - this.runtime.host.monotonicMs());
      const deadline = this.runtime.host.sleep(remaining, signal).then(() => {
        throw new TurnStopped("budget-exhausted", "turn-deadline");
      }, (error: unknown) => {
        if (this.signal.aborted) throw new TurnStopped("cancelled", "runtime-stopped");
        throw error;
      });
      return await Promise.race([port.decide(input), deadline]);
    } finally {
      timer.abort();
    }
  }

  private assertCurrent(turn: ClaimedTurn, status: AgentTurnStatus): void {
    this.runtime.storage.transact((tx) => this.leases.require(tx, turn, status));
  }

  private commit(turn: ClaimedTurn, status: AgentTurnStatus, auth: AuthContext, envelope: CommandEnvelope): CommandReceipt {
    this.assertCurrent(turn, status);
    return this.execution.executeCommand(auth, envelope);
  }

  private requireProfile(agentId: string): ResolvedAgentProfile {
    const profile = this.runtime.profiles.get(agentId);
    if (profile === undefined) throw new Error(`Missing Agent profile for ${agentId}`);
    return profile;
  }

  private selection(profile: ResolvedAgentProfile, slot: keyof ResolvedAgentProfile["slots"]): StageSelection | null {
    const selected = profile.slots[slot];
    const definition = selected === undefined ? undefined : this.runtime.moduleDefinitions.get(selected.module);
    return selected === undefined || definition === undefined ? null : {
      moduleId: selected.module, moduleVersion: definition.version, config: selected.config,
    };
  }

  private logFailure(turnId: string, error: unknown): void {
    this.runtime.host.logger.error("Agent turn failed", { turnId, message: error instanceof Error ? error.message : String(error) });
  }
}
