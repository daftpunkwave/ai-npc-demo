/**
 * 实现固定命令提交流程：分支/主体校验、幂等、暂停、schema、版本、事务保存点、后续钩子与回执。
 * 依赖存储事务、公共契约命令 schema、规则注册表、fencing/发行者策略，以及回执与校验辅助模块。
 * 禁止绕过保存点写入 receipt、吞掉处理器异常、把异步回调当作已提交，或让拒绝命令留下世界事实。
 */
import { createHash } from "node:crypto";
import {
  DomainError,
  authContextSchema,
  canonicalJson,
  commandEnvelopeSchema,
  commandRequestSchema,
  idSchemas,
  isSupportedCommandEnvelopeSchemaVersion,
  type AuthContext,
  type CommandEnvelope,
  type CommandReceipt,
  type Json,
  type ReasonCode,
  type ScopedBranchStorage,
  type StorageTransaction,
} from "@world-prism/contracts";
import { isApprovedSpeechUsable, type HandlerResult } from "@world-prism/module-sdk";
import { readBranch, readClock, type ClockRecord } from "./branch-state";
import {
  checkExpectedVersions,
  commandBranchViolation,
  isPauseExempt,
  issuesOf,
  parseCommandType,
  requireJsonResult,
} from "./command-validation";
import { readReceipt, writeReceipt, type ReceiptInput } from "./command-receipts";
import { verifyFencing } from "./fencing";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
import { isCommandIssuerAllowed } from "./issuer-policy";
import type { RuleRegistry } from "./rule-registry";
import { requireStorageString } from "./storage-values";
import { readSpeechCommitPayload } from "./speech-approval";
import type { CommandGatewayOptions, ContributorScope } from "./types";
import { assertSynchronous, TransactionWorldTx, type TxCollector } from "./world-tx";

/** 处理器内部用异常中断保存点；只有这个类型会被转成拒绝回执，其他异常继续上抛。 */
class CommandRejected extends Error {
  readonly reasonCode: ReasonCode;
  readonly safeMessage: string;

  constructor(reasonCode: ReasonCode, safeMessage: string) {
    super(safeMessage);
    this.name = "CommandRejected";
    this.reasonCode = reasonCode;
    this.safeMessage = safeMessage;
  }
}

/**
 * 一次命令执行的附加上下文。operationId 关联发起该命令的副作用操作（如 Agent 工具调用），
 * 只写入回执、不参与幂等内容哈希：同一 commandId 重放时返回首次回执，其中的 operationId 也保持首次取值。
 */
export interface CommandExecuteOptions {
  readonly operationId?: string;
}

/** 一次执行内写回执所需的固定身份；拒绝与接受两条路径共用。 */
interface ReceiptScope {
  readonly branchStorage: ScopedBranchStorage;
  readonly auth: AuthContext;
  readonly envelope: CommandEnvelope;
  readonly payloadHash: string;
  readonly operationId: string | null;
}

/** 固定命令网关；每次 execute 在单写事务内完成固定流程。 */
export class CommandGateway {
  private readonly storage: CommandGatewayOptions["storage"];
  private readonly host: CommandGatewayOptions["host"];
  private readonly registry: RuleRegistry;
  private readonly modules: unknown;
  private readonly content: unknown;
  private readonly approvedSpeech: CommandGatewayOptions["approvedSpeech"];
  private readonly allowDirectAgentCommands: boolean;
  private readonly moduleBinder: CommandGatewayOptions["moduleBinder"];
  private readonly runSeed: CommandGatewayOptions["runSeed"];

  constructor(options: CommandGatewayOptions) {
    this.storage = options.storage;
    this.host = options.host;
    this.registry = options.registry;
    this.modules = options.modules;
    this.content = options.content;
    this.approvedSpeech = options.approvedSpeech;
    this.allowDirectAgentCommands = options.allowDirectAgentCommands ?? false;
    this.moduleBinder = options.moduleBinder;
    this.runSeed = options.runSeed;
  }

  execute(auth: AuthContext, envelope: CommandEnvelope, options: CommandExecuteOptions = {}): CommandReceipt {
    const parsedAuth = authContextSchema.safeParse(auth);
    if (!parsedAuth.success) {
      throw new DomainError("validation", "认证上下文不合法", { details: { issues: issuesOf(parsedAuth.error) } });
    }
    const parsedEnvelope = commandEnvelopeSchema.safeParse(envelope);
    if (!parsedEnvelope.success) {
      throw new DomainError("validation", "命令信封不合法", {
        details: { issues: issuesOf(parsedEnvelope.error) },
      });
    }
    const operationId = options.operationId ?? null;
    if (operationId !== null && !idSchemas.op.safeParse(operationId).success) {
      throw new DomainError("validation", "operationId 不合法", { details: { operationId } });
    }
    const payloadHash = commandPayloadHash(parsedEnvelope.data);
    return this.storage.transact((tx) =>
      this.executeInTransaction(tx, parsedAuth.data, parsedEnvelope.data, payloadHash, operationId),
    );
  }

  private executeInTransaction(
    tx: StorageTransaction,
    auth: AuthContext,
    envelope: CommandEnvelope,
    payloadHash: string,
    operationId: string | null,
  ): CommandReceipt {
    const branchStorage = tx.branch(auth.branchId);
    const scope: ReceiptScope = { branchStorage, auth, envelope, payloadHash, operationId };
    const existing = branchStorage.table("command_receipts").get({
      principal_id: auth.principalId,
      command_id: envelope.commandId,
    });
    if (existing !== null) {
      const storedHash = requireStorageString(existing, "command_receipts", "payload_hash");
      if (storedHash === payloadHash) {
        return readReceipt(existing);
      }
      // 冲突结果不是新的不可变回执：不生成 ID，交由传输层返回无回执 ID 的 409。
      throw new DomainError("idempotency-conflict", "命令 ID 已被不同内容使用");
    }

    const branch = readBranch(tx, auth.branchId);
    if (branch === null) {
      throw new DomainError("not-found", `分支 ${auth.branchId} 不存在`, {
        details: { branchId: auth.branchId },
      });
    }
    if (branch.worldId !== auth.worldId) {
      throw new DomainError("forbidden", "认证上下文的世界与分支不一致", {
        details: { worldId: auth.worldId, branchWorldId: branch.worldId, branchId: auth.branchId },
      });
    }
    if (branch.status !== "active" && branch.status !== "paused") {
      throw new DomainError("forbidden", `分支 ${auth.branchId} 当前状态不接受命令`, {
        details: { branchId: auth.branchId, status: branch.status },
      });
    }
    const clock = readClock(tx, auth.branchId);
    const type = parseCommandType(envelope.type);
    if (type === null) {
      return this.rejectionReceipt(scope, clock, "invalid-params", "命令类型未登记");
    }
    if (!isCommandIssuerAllowed(type, auth)) {
      return this.rejectionReceipt(scope, clock, "no-authority", "当前主体不能发行该命令");
    }
    // 分支种类限制独立于暂停状态：运行中的正式世界也不能接受沙盒或实验专用命令。
    const branchViolation = commandBranchViolation(type, branch);
    if (branchViolation !== null) {
      return this.rejectionReceipt(scope, clock, "no-authority", branchViolation);
    }
    const fencing = verifyFencing(tx, auth, this.allowDirectAgentCommands, this.host.nowIso());
    if (!fencing.ok) {
      const safeMessage = fencing.reasonCode === "stale-controller" ? "控制权已变更，请刷新后再试" : "turn 租约已失效";
      return this.rejectionReceipt(scope, clock, fencing.reasonCode, safeMessage);
    }
    if (!isPauseExempt(type, auth, branch) && clock.mode !== "running" && clock.mode !== "stepping") {
      return this.rejectionReceipt(scope, clock, "paused", "世界时钟当前不可推进");
    }
    if (!isSupportedCommandEnvelopeSchemaVersion(envelope.schemaVersion)) {
      return this.rejectionReceipt(scope, clock, "invalid-params", "不支持的命令 schema 版本");
    }
    const parsedRequest = commandRequestSchema.safeParse({ type, payload: envelope.payload });
    if (!parsedRequest.success) {
      return this.rejectionReceipt(scope, clock, "invalid-params", "命令参数不合法");
    }
    if (!checkExpectedVersions(branchStorage, envelope)) {
      return this.rejectionReceipt(scope, clock, "version-conflict", "聚合版本已变化，请刷新后再试");
    }
    const registration = this.registry.command(type);
    if (registration === undefined) {
      throw new DomainError("module-missing", `命令类型 ${type} 尚未注册处理器`, {
        details: { type },
      });
    }

    const payload = parsedRequest.data.payload as Json;
    const speechPayload = type === "speech.commit" ? readSpeechCommitPayload(payload) : null;
    if (speechPayload !== null) {
      const speech = this.approvedSpeech.read(speechPayload.approvedSpeechArtifactRef);
      if (!isApprovedSpeechUsable(speech, auth, speechPayload)) {
        return this.rejectionReceipt(scope, clock, "speech-not-approved", "已批准对白不可用或与提交内容不匹配");
      }
    }
    const speechArtifactRef = speechPayload?.approvedSpeechArtifactRef ?? null;
    const collector: TxCollector = { eventIds: [], versions: {} };
    const handlerTx = this.createWorldTx(tx, auth, envelope, registration.owner, clock, collector);
    const handlerContext = createHandlerContext({
      auth,
      tx: handlerTx,
      modules: this.bindModules(tx, auth, envelope, registration.owner.moduleId, clock, collector),
      content: this.content,
      approvedSpeech: this.approvedSpeech,
      host: this.host,
      runSeed: this.runSeed,
    });
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
    let acceptedResult: HandlerResult | null = null;
    let rejection: CommandRejected | null = null;
    try {
      tx.savepoint("cmd", () => {
        if (speechArtifactRef !== null) {
          const consumed = branchStorage
            .table("speech_commits")
            .get({ approved_speech_artifact_ref: speechArtifactRef });
          if (consumed !== null) {
            throw new CommandRejected("speech-not-approved", "该已批准对白已被其他命令消费");
          }
        }
        const outcome = registration.handler(handlerContext, payload, envelope);
        assertSynchronous(outcome, `命令 ${type} 处理器`);
        if (outcome.kind === "rejected") {
          throw new CommandRejected(outcome.reasonCode, outcome.safeMessage);
        }
        acceptedResult = outcome;

        for (const hook of this.registry.afterCommandsFor(type)) {
          const hookTx = this.createWorldTx(tx, auth, envelope, hook.owner, clock, collector);
          const hookContext = createHandlerContext({
            auth,
            tx: hookTx,
            modules: this.bindModules(tx, auth, envelope, this.moduleScopeOf(hook.owner), clock, collector),
            content: this.content,
            approvedSpeech: this.approvedSpeech,
            host: this.host,
            runSeed: this.runSeed,
          });
          const hookOutcome = hook.hook(hookContext, payload, envelope);
          assertSynchronous(hookOutcome, `命令 ${type} 后续钩子`);
          if (hookOutcome.kind === "rejected") {
            throw new CommandRejected(hookOutcome.reasonCode, hookOutcome.safeMessage);
          }
        }
        for (const hook of this.registry.hostAfterCommandsFor(type)) {
          // 宿主钩子直接使用未提交的存储事务，维护 agent_activations 等宿主专用表。
          const hookOutcome = hook.hook({
            tx,
            auth,
            payload,
            envelope,
            worldTick: clock.worldTick,
          });
          assertSynchronous(hookOutcome, `命令 ${type} 宿主后续钩子`);
          if (hookOutcome.kind === "rejected") {
            throw new CommandRejected(hookOutcome.reasonCode, hookOutcome.safeMessage);
          }
        }
        if (speechArtifactRef !== null) {
          if (collector.eventIds.length === 0) {
            throw new CommandRejected("speech-not-approved", "已批准对白没有产生提交事件");
          }
          branchStorage.table("speech_commits").put({
            approved_speech_artifact_ref: speechArtifactRef,
            principal_id: auth.principalId,
            command_id: envelope.commandId,
            event_id: collector.eventIds[0] as string,
          });
        }
      });
    } catch (error) {
      if (error instanceof CommandRejected) {
        rejection = error;
      } else {
        throw error;
      }
    }

    if (rejection !== null) {
      return this.rejectionReceipt(scope, clock, rejection.reasonCode, rejection.safeMessage);
    }
    if (acceptedResult === null) {
      throw new DomainError("invalid-state", "命令处理器未返回可提交的结果");
    }
    const accepted = acceptedResult as Extract<HandlerResult, { readonly kind: "accepted" }>;
    const input: ReceiptInput = {
      auth,
      envelope,
      commandStatus: "accepted",
      reasonCode: null,
      safeMessage: null,
      acceptedEventIds: collector.eventIds,
      operationId,
      resultingVersions: collector.versions,
      result: requireJsonResult(accepted.result),
      worldTick: clock.worldTick,
    };
    return writeReceipt(this.host, branchStorage, input, payloadHash);
  }

  /** 已注册模块使用自身端口视图；宿主附加的后续钩子不属于模块，改用宿主完整视图。 */
  private moduleScopeOf(owner: ContributorScope): string | null {
    return this.registry.contributor(owner.moduleId) === undefined ? null : owner.moduleId;
  }

  /** 按处理器的 owner 作用域与能力声明绑定模块端口；每个处理器与后续钩子都得到独立事务视图。 */
  private bindModules(
    tx: StorageTransaction,
    auth: AuthContext,
    envelope: CommandEnvelope,
    ownerModuleId: string | null,
    clock: ClockRecord,
    collector: TxCollector,
  ): ReturnType<typeof bindModulePorts> {
    return bindModulePorts({
      binder: this.moduleBinder,
      fallback: this.modules,
      moduleId: ownerModuleId,
      registry: this.registry,
      storageTx: tx,
      worldId: auth.worldId,
      branchId: auth.branchId,
      worldTick: clock.worldTick,
      principalId: auth.principalId,
      correlationId: envelope.commandId,
      host: this.host,
      collector,
    });
  }

  /** 构造处理器可见的世界事务：作用域、相关 ID 与事件收集器由网关统一注入。 */
  private createWorldTx(
    tx: StorageTransaction,
    auth: AuthContext,
    envelope: CommandEnvelope,
    owner: ContributorScope,
    clock: ClockRecord,
    collector?: TxCollector,
  ): TransactionWorldTx {
    return new TransactionWorldTx({
      storageTx: tx,
      worldId: auth.worldId,
      branchId: auth.branchId,
      worldTick: clock.worldTick,
      principalId: auth.principalId,
      correlationId: envelope.commandId,
      scope: owner,
      host: this.host,
      eventSchemas: this.registry.eventSchemas(),
      collector,
    });
  }

  /** 写拒绝回执；世界 tick 取当前时钟，缺失时按 0 记录。 */
  private rejectionReceipt(
    scope: ReceiptScope,
    clock: ClockRecord | null,
    reasonCode: ReasonCode,
    safeMessage: string,
  ): CommandReceipt {
    const input: ReceiptInput = {
      auth: scope.auth,
      envelope: scope.envelope,
      commandStatus: "rejected",
      reasonCode,
      safeMessage,
      acceptedEventIds: [],
      operationId: scope.operationId,
      resultingVersions: {},
      result: null,
      worldTick: clock?.worldTick ?? 0,
    };
    return writeReceipt(this.host, scope.branchStorage, input, scope.payloadHash);
  }
}

/**
 * 计算命令幂等内容哈希，覆盖 type、schemaVersion、expectedVersions 与 payload。
 *
 * 这里刻意固定为 SHA-256，而不是走注入的 host.hash：幂等键要写进 command_receipts.payload_hash
 * 并长期留存，是同一 commandId 重复提交时判断「内容是否相同」的唯一依据。若跟随注入实现变化，
 * 更换宿主哈希后同一命令会算出不同摘要，被判成 idempotency-conflict 并拒绝合法重放。
 * manifest、证据与 artifact 的摘要仍走 host.hash，以便测试注入确定性实现。
 */
export function commandPayloadHash(envelope: CommandEnvelope): string {
  const canonical = canonicalJson({
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    expectedVersions: envelope.expectedVersions ?? null,
    payload: envelope.payload,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
