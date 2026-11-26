/**
 * 执行唯一的 Agent turn 管线，并把动作、对白与记忆发布交给各自的守卫。
 * 执行依赖已冻结 profile、授权视图、已装配决策端口与工具网关。
 * 等待和策略计算在事务外进行。旧租约、暂停和接管不得发布结果。
 */
import {
  canonicalJson, DomainError, toModelToolName,
  type AgentTurnStatus, type AuthContext, type CommandEnvelope, type CommandReceipt, type Json, type NormalizedToolCall,
} from "@world-prism/contracts";
import type { ResolvedAgentProfile } from "@world-prism/experiment";
import type {
  AgentDecisionPort,
  DeterministicDecisionInput,
  RunModelPort,
} from "@world-prism/module-sdk";
import { StoredAgentArtifactStore } from "@world-prism/module-sdk";
import { DialogueFlow, messageIntentFromArguments, type SpeechApprovalIndex, type SpeechApprovalInput } from "./dialogue-flow";
import type { MemoryHost } from "./memory-host";
import { ModelTurn, type ModelTurnPorts } from "./model-turn";
import { decisionSubmitTool } from "./model-turn-materials";
import type { AgentRuntimeOptions } from "./runtime";
import { asRecord, errorNameToken } from "./runtime-records";
import { ToolGateway, type ToolCallOutcome, type ToolCatalogPort } from "./tool-gateway";
import { TurnEvidence, type StageSelection, type TurnSpan } from "./turn-evidence";
import { freezeTurnInput, type ReadTurnWorld } from "./turn-input";
import { TurnLeases, TurnStopped, failClaim, type ClaimedTurn } from "./turn-lease";
import { TurnSlotAssembly, deterministicDecisionPort } from "./turn-worker-assembly";
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

/** 关闭时等待在途 turn 的默认上限；与租约期限解耦，避免关闭被单个卡住的 turn 无限拖住。 */
const turnDisposeDeadlineMs = 10_000;

export class TurnWorker {
  private readonly running = new Set<Promise<void>>();
  private readonly assembly: TurnSlotAssembly;
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
    this.assembly = new TurnSlotAssembly(runtime, execution, signal);
    this.leases = new TurnLeases(storage, host, signal);
    this.artifacts = new StoredAgentArtifactStore(storage, host);
    this.dialogue = new DialogueFlow({ host, content, artifacts: this.artifacts, approvals: execution.approvals });
  }

  /** 装配每个 Agent 的 turn 模块；失败即整体启动失败，由宿主统一处理。 */
  async start(): Promise<void> {
    await this.assembly.start();
  }

  dispatch(turnId: string, agentId: string): void {
    const execution = this.run(turnId, agentId)
      .then(() => this.runtime.onStateChange?.())
      .catch((error: unknown) => this.logFailure(turnId, error))
      .finally(() => this.running.delete(execution));
    this.running.add(execution);
  }

  /**
   * 释放在途 turn 与已装配模块。
   * 在途 turn 只等到 `deadlineMs`：卡在模型或长计算里的 turn 不能无限拖住进程退出，
   * 超时后记录仍未结束的 turn 数量并继续释放，让关闭回到有界时间。
   */
  async dispose(deadlineMs = turnDisposeDeadlineMs): Promise<void> {
    await this.settleRunning(deadlineMs);
    await this.assembly.dispose();
  }

  /**
   * 等待在途 turn 结束；超过截止时间只记录未排空数量，不抛错也不取消已经写入的终态。
   * `running` 里的 Promise 自身已带 catch，超时后继续在后台收尾不会产生未处理的 rejection。
   */
  private async settleRunning(deadlineMs: number): Promise<void> {
    if (this.running.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => resolve(), Math.max(0, deadlineMs));
      timer.unref();
    });
    try {
      await Promise.race([Promise.all(this.running), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const outstanding = this.running.size;
    if (outstanding === 0) return;
    this.runtime.host.logger.warn("Agent turn drain timed out", {
      outstanding,
      deadlineMs,
    });
  }

  /**
   * 认领 turn：把 claim 期间抛出的异常转为该 turn 的终态。
   * claim 在事务内读取时钟、触发绑定与租约代次，任何一处损坏都会抛错；若让它冒泡，
   * 该行会停在 `queued` 且租约为空，恢复路径与调度都不会再推进它，于是每轮重复认领并永久占用并发名额。
   * 因此这里按原因落终态，并把失败交给调用方统一记日志。
   */
  private claim(turnId: string, agentId: string, profileHash: string, profile: ResolvedAgentProfile): ClaimedTurn | null {
    try {
      return this.leases.claim(turnId, { ...this.runtime, profileHash, maxTurnMs: profile.budgets.maxTurnMs });
    } catch (error) {
      const reason = error instanceof TurnStopped ? error.reason : "turn-claim-failed";
      const failed = failClaim(this.runtime.storage, turnId, reason, this.runtime.host.nowIso());
      this.runtime.host.logger.error("Agent turn claim failed", {
        turnId,
        agentId,
        reason,
        // 只记错误类型与领域错误码，不写可能含观察正文的原始消息。
        errorCode: error instanceof DomainError ? error.code : errorNameToken(error),
        terminal: failed,
      });
      this.runtime.onStateChange?.();
      return null;
    }
  }

  /**
   * 组合 turn 级取消信号：运行时停止，或到达 `turn.deadlineMs`。
   * 定时器 `unref` 且随 turn 结束清除，避免每个 turn 留一个挂起的计时器。
   */
  private turnSignal(turn: ClaimedTurn): AbortSignal {
    const deadline = new AbortController();
    const remaining = Math.max(1, turn.deadlineMs - this.runtime.host.monotonicMs());
    const timer = setTimeout(() => { deadline.abort(); }, remaining);
    timer.unref();
    const signal = AbortSignal.any([this.signal, deadline.signal]);
    signal.addEventListener("abort", () => { clearTimeout(timer); }, { once: true });
    return signal;
  }


  private async run(turnId: string, agentId: string): Promise<void> {
    const { storage, host, content } = this.runtime;
    const profile = this.requireProfile(agentId);
    const profileHash = this.execution.profileHashes.get(agentId);
    const ports = this.assembly.port(agentId);
    if (profileHash === undefined || ports === undefined) throw new Error(`Turn modules missing for ${agentId}`);
    const claimStarted = host.monotonicMs();
    const turn = this.claim(turnId, agentId, profileHash, profile);
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
      // 本 turn 的工具执行关联 ID：tool_calls 归档去重、上下文构建与确定性工具回传校验共用；
      // 与模型传输 attempt 同用 att 前缀，但作用域是整个 turn 而非单次网络尝试。
      const toolAttemptId = host.ids("att");
      const toolCalls: ToolCallOutcome[] = [];
      const committedMessageIntents = new Set<string>();
      const messagePrincipalIds = new Set([content.index.playerPrincipalId, ...this.runtime.roster.agents.map((entry) => entry.agentId)]);
      messagePrincipalIds.delete(agentId);
      // turn 级取消信号：运行时停止或 turn 截止任一到达都中止在途模型调用。
      // 只用运行时信号无法在 `turn.deadlineMs` 到达时打断模型，工具调用挂起会让决策窗口无限延长。
      const turnSignal = this.turnSignal(turn);
      const model = ports.model === null || this.execution.model == null ? null : new ModelTurn({
        host, pool: this.execution.model, ports: ports.model, content, profile, memory, frozen, turn, evidence,
        signal: turnSignal, artifacts: this.artifacts, assertCurrent: (status) => this.assertCurrent(turn, status),
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
        session: frozen.scope, runId: turn.runId, turnId, agentId, attemptId: toolAttemptId,
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
          if (intent !== null) committedMessageIntents.add(canonicalJson(intent));
        }
        return outcome;
      };
      const executeTool: DeterministicDecisionInput["executeTool"] = (call) => {
        if (call.attemptId !== toolAttemptId) throw new TurnStopped("failed", "invalid-tool-attempt");
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
          attemptId: toolAttemptId, tools: [...(projected?.tools ?? []).filter(({ name }) => !turn.probe || readOnly.has(name)), decisionSubmitTool(content)],
          toolViewLimits: new Map(projected?.bindings.map(({ toolId, viewConstraints }) => [toModelToolName(toolId), viewConstraints.maxTokens])),
          executeTool: (call, round) => executeCall(call, round), toolResults: toolCalls,
          contextSelection: this.selection(profile, "context"), compressionSelection: this.selection(profile, "compression"),
        }) : await this.decideBeforeDeadline(deterministicDecisionPort(ports, agentId), {
          session: frozen.scope, runId: turn.runId, turnId, attemptId: toolAttemptId, frontier: frozen.frontier,
          profileHash, runSeed: this.execution.runSeed, agentTurnIndex: turn.agentTurnIndex,
          triggers: turn.triggers, observations: frozen.observations, memory, prospective,
          self: {
            injured: frozen.world.injured, delegations: frozen.world.delegations,
            skills: content.index.characters.get(agentId)?.skills ?? content.index.factions.get(agentId)?.persona.skills ?? [],
          },
          taskInvitations: frozen.world.taskInvitations, lexicons: content.locale.lexicons,
          executeTool, deadlineMs: turn.deadlineMs,
        }, evidence, turn);
        this.assertCurrent(turn, "deciding");
        if (result.status !== "ok") {
          // terminal_reason 优先取细分原因（round-limit、call-budget、context-window、deadline-backpressure 等），
          // 与租约到期的 turn-deadline 分别记录；无细分时回退到失败类别本身。
          // over-budget 表示决策循环已进入预算停止收尾，终态原因直接取该状态，
          // 避免被轮内细分原因（call-budget/context-window）覆盖成另一类停止。
          const reason = result.status === "over-budget" ? "over-budget" : (result.reason ?? result.status);
          throw new TurnStopped(result.status === "budget-exhausted" ? "budget-exhausted" : "failed", reason);
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
      if (intent.kind === "none" || committedMessageIntents.has(canonicalJson(intent))) {
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

  /**
   * 在截止时间前完成决策：超时、运行时停止与正常完成三者竞争。
   * 截止时把取消传给端口，让在途网络调用随之结束；端口不响应取消时，
   * 迟到的决策仍会被租约与 fencing 拒绝，但会继续占用并发与预算，因此事实要记进证据。
   */
  private async decideBeforeDeadline(
    port: AgentDecisionPort<DeterministicDecisionInput>,
    input: Omit<DeterministicDecisionInput, "signal">,
    evidence: TurnEvidence,
    turn: ClaimedTurn,
  ) {
    // 与模型路径共用同一个 turn 级信号：截止与运行时停止任一到达都中止在途调用。
    const signal = this.turnSignal(turn);
    const started = this.runtime.host.monotonicMs();
    // 端口自身的 promise 单独持有，用于判断超时后它是否还在后台运行。
    let settled = false;
    const deciding = port.decide({ ...input, signal });
    void deciding.then(() => { settled = true; }, () => { settled = true; });
    try {
      const remaining = Math.max(0, input.deadlineMs - started);
      const deadline = this.runtime.host.sleep(remaining, signal).then(() => {
        throw new TurnStopped("budget-exhausted", "turn-deadline");
      }, (error: unknown) => {
        if (this.signal.aborted) throw new TurnStopped("cancelled", "runtime-stopped");
        throw error;
      });
      return await Promise.race([deciding, deadline]);
    } finally {
      // 放弃等待时端口仍未结束：说明取消没有被响应，事实记进证据而不是假装已停止。
      if (!settled) {
        evidence.record("turn.decision-cancel", started, {
          status: "skipped", reason: "cancelled-not-honored", effective: { deadlineMs: input.deadlineMs },
        });
      }
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
