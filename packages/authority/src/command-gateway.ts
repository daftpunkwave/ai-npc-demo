/**
 * 实现固定命令提交流程：分支/主体校验、幂等、暂停、schema、版本、事务保存点、后续钩子与回执。
 * 依赖存储事务、公共契约命令 schema、规则注册表与 fencing/发行者策略；处理器必须同步。
 * 禁止绕过保存点写入 receipt、吞掉处理器异常、把异步回调当作已提交，或让拒绝命令留下世界事实。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的联合类型误判为 any。 */
import { createHash } from "node:crypto";
import {
  DomainError,
  authContextSchema,
  canonicalJson,
  commandEnvelopeSchema,
  commandReceiptSchema,
  commandRequestSchema,
  commandTypeSchema,
  jsonValueSchema,
  type AuthContext,
  type CommandEnvelope,
  type CommandReceipt,
  type CommandType,
  type Json,
  type ReasonCode,
  type ScopedBranchStorage,
  type StorageTransaction,
} from "@ai-npc/contracts";
import type { HandlerResult } from "@ai-npc/module-sdk";
import { readBranch, readClock, tryReadClock, type BranchRecord, type ClockRecord } from "./branch-state";
import { verifyFencing } from "./fencing";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
import { isCommandIssuerAllowed } from "./issuer-policy";
import type { RuleRegistry } from "./rule-registry";
import { requireStorageNumber, requireStorageString } from "./storage-values";
import { isApprovedSpeechUsable, readSpeechCommitPayload } from "./speech-approval";
import type { CommandGatewayOptions, ContributorScope } from "./types";
import { assertSynchronous, TransactionWorldTx, type TxCollector } from "./world-tx";

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

interface ReceiptInput {
  readonly auth: AuthContext;
  readonly envelope: CommandEnvelope;
  readonly commandStatus: "accepted" | "rejected";
  readonly reasonCode: ReasonCode | null;
  readonly safeMessage: string | null;
  readonly acceptedEventIds: readonly string[];
  readonly resultingVersions: Readonly<Record<string, number>>;
  readonly result: Json | null;
  readonly worldTick: number;
}

function issuesOf(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

function requireJsonResult(value: unknown): Json | null {
  if (value === undefined) {
    return null;
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "命令处理器返回的 result 不是合法 JSON", {
      details: { issues: issuesOf(parsed.error) },
    });
  }
  return parsed.data;
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

  execute(auth: AuthContext, envelope: CommandEnvelope): CommandReceipt {
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
    const payloadHash = commandPayloadHash(parsedEnvelope.data);
    return this.storage.transact((tx) =>
      this.executeInTransaction(tx, parsedAuth.data, parsedEnvelope.data, payloadHash),
    );
  }

  private executeInTransaction(
    tx: StorageTransaction,
    auth: AuthContext,
    envelope: CommandEnvelope,
    payloadHash: string,
  ): CommandReceipt {
    const branchStorage = tx.branch(auth.branchId);
    const existing = branchStorage.table("command_receipts").get({
      principal_id: auth.principalId,
      command_id: envelope.commandId,
    });
    if (existing !== null) {
      const storedHash = requireStorageString(existing, "command_receipts", "payload_hash");
      if (storedHash === payloadHash) {
        return this.readReceipt(existing);
      }
      const clock = tryReadClock(tx, auth.branchId);
      return this.buildReceipt({
        auth,
        envelope,
        commandStatus: "rejected",
        reasonCode: "idempotency-conflict",
        safeMessage: "命令 ID 已被不同内容使用",
        acceptedEventIds: [],
        resultingVersions: {},
        result: null,
        worldTick: clock?.worldTick ?? 0,
      });
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
    const type = this.parseCommandType(envelope.type);
    if (type === null) {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        "invalid-params",
        "命令类型未登记",
        clock,
      );
    }
    if (!isCommandIssuerAllowed(type, auth)) {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        "no-authority",
        "当前主体不能发行该命令",
        clock,
      );
    }
    const fencing = verifyFencing(tx, auth, this.allowDirectAgentCommands, this.host.nowIso());
    if (!fencing.ok) {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        fencing.reasonCode,
        fencing.reasonCode === "stale-controller" ? "控制权已变更，请刷新后再试" : "turn 租约已失效",
        clock,
      );
    }
    if (!this.isPauseExempt(type, auth, branch) && clock.mode !== "running" && clock.mode !== "stepping") {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        "paused",
        "世界时钟当前不可推进",
        clock,
      );
    }
    if (envelope.schemaVersion !== 1) {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        "invalid-params",
        "不支持的命令 schema 版本",
        clock,
      );
    }
    const parsedRequest = commandRequestSchema.safeParse({ type, payload: envelope.payload });
    if (!parsedRequest.success) {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        "invalid-params",
        "命令参数不合法",
        clock,
      );
    }
    if (!this.checkExpectedVersions(branchStorage, envelope)) {
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        "version-conflict",
        "聚合版本已变化，请刷新后再试",
        clock,
      );
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
        return this.writeRejection(
          branchStorage,
          auth,
          envelope,
          payloadHash,
          "speech-not-approved",
          "已批准对白不可用或与提交内容不匹配",
          clock,
        );
      }
    }
    const speechArtifactRef = speechPayload?.approvedSpeechArtifactRef ?? null;
    const collector: TxCollector = { eventIds: [], versions: {} };
    const handlerTx = this.createWorldTx(tx, auth, envelope, registration.owner, clock, collector);
    const handlerContext = createHandlerContext({
      auth,
      tx: handlerTx,
      modules: bindModulePorts({
        binder: this.moduleBinder,
        fallback: this.modules,
        registry: this.registry,
        storageTx: tx,
        worldId: auth.worldId,
        branchId: auth.branchId,
        worldTick: clock.worldTick,
        principalId: auth.principalId,
        correlationId: envelope.commandId,
        host: this.host,
        collector,
      }),
      content: this.content,
      approvedSpeech: this.approvedSpeech,
      host: this.host,
      runSeed: this.runSeed,
    });
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
            modules: bindModulePorts({
              binder: this.moduleBinder,
              fallback: this.modules,
              registry: this.registry,
              storageTx: tx,
              worldId: auth.worldId,
              branchId: auth.branchId,
              worldTick: clock.worldTick,
              principalId: auth.principalId,
              correlationId: envelope.commandId,
              host: this.host,
              collector,
            }),
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
      return this.writeRejection(
        branchStorage,
        auth,
        envelope,
        payloadHash,
        rejection.reasonCode,
        rejection.safeMessage,
        clock,
      );
    }
    if (acceptedResult === null) {
      throw new DomainError("invalid-state", "命令处理器未返回可提交的结果");
    }
    const accepted = acceptedResult as Extract<HandlerResult, { readonly kind: "accepted" }>;
    return this.writeReceipt(branchStorage, {
      auth,
      envelope,
      commandStatus: "accepted",
      reasonCode: null,
      safeMessage: null,
      acceptedEventIds: collector.eventIds,
      resultingVersions: collector.versions,
      result: requireJsonResult(accepted.result),
      worldTick: clock.worldTick,
    }, payloadHash);
  }

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
      collector,
    });
  }

  private parseCommandType(type: string): CommandType | null {
    const parsed = commandTypeSchema.safeParse(type);
    return parsed.success ? parsed.data : null;
  }

  private isPauseExempt(type: CommandType, auth: AuthContext, branch: BranchRecord): boolean {
    if (type === "campaign.start") {
      return true;
    }
    return (
      type === "probe.ask" &&
      auth.kind === "system" &&
      auth.principalId === "system:world" &&
      branch.kind === "sandbox" &&
      branch.status === "active"
    );
  }

  private checkExpectedVersions(branchStorage: ScopedBranchStorage, envelope: CommandEnvelope): boolean {
    for (const [key, expected] of Object.entries(envelope.expectedVersions ?? {})) {
      const separator = key.indexOf(":");
      if (separator <= 0 || separator === key.length - 1) {
        return false;
      }
      const aggregateType = key.slice(0, separator);
      const aggregateId = key.slice(separator + 1);
      const row = branchStorage.table("aggregate_state").get({
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
      });
      const actual = row === null ? 0 : requireStorageNumber(row, "aggregate_state", "version");
      if (actual !== expected) {
        return false;
      }
    }
    return true;
  }

  private writeRejection(
    branchStorage: ScopedBranchStorage,
    auth: AuthContext,
    envelope: CommandEnvelope,
    payloadHash: string,
    reasonCode: ReasonCode,
    safeMessage: string,
    clock: ClockRecord,
  ): CommandReceipt {
    return this.writeReceipt(branchStorage, {
      auth,
      envelope,
      commandStatus: "rejected",
      reasonCode,
      safeMessage,
      acceptedEventIds: [],
      resultingVersions: {},
      result: null,
      worldTick: clock.worldTick,
    }, payloadHash);
  }

  private buildReceipt(input: ReceiptInput): CommandReceipt {
    const receipt = {
      receiptId: this.host.ids("rcp"),
      commandId: input.envelope.commandId,
      commandStatus: input.commandStatus,
      reasonCode: input.reasonCode,
      safeMessage: input.safeMessage,
      acceptedEventIds: [...input.acceptedEventIds],
      operationId: null,
      resultingVersions: input.resultingVersions,
      result: input.result,
      worldTick: input.worldTick,
    };
    const parsed = commandReceiptSchema.safeParse(receipt);
    if (!parsed.success) {
      throw new DomainError("invalid-state", "构造的命令回执不合法", {
        details: { issues: issuesOf(parsed.error) },
      });
    }
    return parsed.data;
  }

  private writeReceipt(
    branchStorage: ScopedBranchStorage,
    input: ReceiptInput,
    payloadHash: string,
  ): CommandReceipt {
    const receipt = this.buildReceipt(input);
    branchStorage.table("command_receipts").put({
      principal_id: input.auth.principalId,
      command_id: input.envelope.commandId,
      command_type: input.envelope.type,
      payload_hash: payloadHash,
      receipt_json: receipt,
      created_at: this.host.nowIso(),
    });
    return receipt;
  }

  private readReceipt(row: Readonly<Record<string, unknown>>): CommandReceipt {
    const parsed = commandReceiptSchema.safeParse(row["receipt_json"]);
    if (!parsed.success) {
      throw new DomainError("invalid-state", "存储中的命令回执不符合契约", {
        details: { issues: issuesOf(parsed.error) },
      });
    }
    return parsed.data;
  }
}

/** 计算命令幂等内容哈希，覆盖 type、schemaVersion、expectedVersions 与 payload。 */
export function commandPayloadHash(envelope: CommandEnvelope): string {
  const canonical = canonicalJson({
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    expectedVersions: envelope.expectedVersions ?? null,
    payload: envelope.payload,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
