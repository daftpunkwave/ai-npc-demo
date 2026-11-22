/**
 * 核心职责：构建全新的 speech 请求、执行四项校验、生成安全模板并提交 speech.commit。
 * 交互契约：依赖内容包模板、按受众过滤的事实、receipt 状态、artifact store 与命令 executor。
 * 约束与禁忌：不得复用 decision 会话、把秘密注入请求、绕过 authority 或提交未经批准的正文。
 */
import {
  cleanJsonSchemaForModel,
  DomainError,
  dialogueIntentSchema,
  speechArtifactSchema,
  speechOutputSchema,
  speechOutputWireSchema,
  type AuthContext,
  type CommandEnvelope,
  type CommandReceipt,
  type DialogueIntent,
  type Json,
  type MemoryScope,
  type ModelOutput,
  type SpeechArtifact,
} from "@ai-npc/contracts";
import type { AgentArtifactStore, ApprovedSpeech, ApprovedSpeechReader } from "@ai-npc/module-sdk";
import type { MessageExecutionInput, MessageExecutionResult } from "./tool-gateway";
import type { ContentPack } from "@ai-npc/experiment";
import {
  filterDisclosableFacts,
  type SpeechFact,
} from "./disclosure";
import {
  validateSpeechOutput,
  type SpeechGenerationOutput,
  type SpeechReceiptState,
  type SpeechSecret,
  type SpeechValidation,
} from "./speech-guards";
import { renderSafeSpeech } from "./speech-template";

export interface SpeechHistoryLine {
  readonly dialogueId: string;
  readonly speakerName: string;
  readonly text: string;
}

export interface SpeechApprovalInput {
  readonly session: MemoryScope;
  readonly runId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly auth: AuthContext;
  readonly intent: DialogueIntent;
  readonly facts: readonly SpeechFact[];
  readonly history: readonly SpeechHistoryLine[];
  readonly receipts: readonly SpeechReceiptState[];
  readonly rejectedToolCommand?: boolean;
  readonly secrets: readonly SpeechSecret[];
  readonly principalFactions: ReadonlyMap<string, string>;
  readonly heldEvidenceIds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly heldSecretIds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly speechStyle: string;
  readonly maxChars: number;
  readonly subjectLine: string;
  readonly channel: "dialogue" | "message" | "broadcast";
  readonly conversationId: string | null;
  readonly replyToId: string | null;
  readonly publication?: "turn-reply";
}

export interface SpeechGenerationRequest {
  readonly system: string;
  readonly user: string;
  readonly output: ModelOutput;
}

export interface SpeechPreparation {
  readonly request: SpeechGenerationRequest;
  readonly visibleFacts: readonly SpeechFact[];
  readonly omittedFactRefs: readonly string[];
  readonly restrictedSecrets: readonly SpeechSecret[];
  readonly allowedRefs: readonly string[];
  readonly receipts: readonly SpeechReceiptState[];
}

export type SpeechGenerator = (
  request: SpeechGenerationRequest,
  attempt: number,
) => unknown | Promise<unknown>;

const speechWireSchema = cleanJsonSchemaForModel(speechOutputWireSchema);

export interface SpeechApprovalResult {
  readonly artifact: SpeechArtifact;
  readonly approvedSpeech: ApprovedSpeech;
  readonly commitEnvelope: CommandEnvelope;
  readonly preparation: SpeechPreparation;
}

export interface SpeechCommitResult extends SpeechApprovalResult {
  readonly receipt: CommandReceipt;
}

export interface DialogueFlowOptions {
  readonly host: {
    ids(prefix: string): string;
    hash(value: Json): Promise<string>;
  };
  readonly artifacts: AgentArtifactStore;
  readonly approvals: SpeechApprovalIndex;
  readonly content: ContentPack;
  readonly executeCommand?: (auth: AuthContext, envelope: CommandEnvelope) => CommandReceipt | Promise<CommandReceipt>;
}

export function messageIntentFromArguments(value: Json): DialogueIntent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { readonly [key: string]: Json };
  const to = record["to"];
  const rawIntent = record["intent"];
  if (!Array.isArray(to) || to.length === 0 || to.length > 4 ||
      to.some((item) => typeof item !== "string" || item.length === 0)) return null;
  if (typeof rawIntent !== "object" || rawIntent === null || Array.isArray(rawIntent)) return null;
  if (to.includes("public") && (to.length !== 1 || to[0] !== "public")) return null;
  const intent = rawIntent as { readonly [key: string]: Json };
  const parsed = dialogueIntentSchema.safeParse({
    kind: intent["kind"],
    audience: to,
    tone: intent["tone"],
    reasonCode: intent["reasonCode"],
    subjectRef: intent["subjectRef"],
    factRefs: intent["factRefs"],
  });
  if (!parsed.success || parsed.data.kind === "none") return null;
  return parsed.data;
}
function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/gu, (_match, key: string) => values[key] ?? "");
}

function lines(values: readonly string[], fallback = "无"): string {
  return values.length === 0 ? fallback : values.join("\n");
}

function receiptLine(receipt: SpeechReceiptState): string {
  const command = receipt.commandStatus === null ? "" : `，commandStatus=${receipt.commandStatus}`;
  const task = receipt.taskStatus === null ? "" : `，taskStatus=${receipt.taskStatus}`;
  return `- [${receipt.receiptId}]${command}${task}：${receipt.detail}`;
}

function restrictedSecrets(
  input: SpeechApprovalInput,
): readonly SpeechSecret[] {
  return input.secrets.filter((secret) =>
    input.intent.audience.some((principalId) =>
      !(input.heldSecretIds.get(principalId)?.has(secret.secretId) ?? false)
    )
  );
}

function subjectLine(input: SpeechApprovalInput, visibleRefs: ReadonlySet<string>): string {
  if (input.intent.subjectRef === null) return "无";
  return visibleRefs.has(input.intent.subjectRef) ? input.subjectLine : "暂时无法说明";
}

export class SpeechApprovalIndex implements ApprovedSpeechReader {
  private readonly values = new Map<string, ApprovedSpeech>();

  register(artifactId: string, value: ApprovedSpeech): void {
    this.values.set(artifactId, value);
  }

  read(ref: string): ApprovedSpeech | null {
    return this.values.get(ref) ?? null;
  }

  remove(ref: string): void {
    this.values.delete(ref);
  }
}

export class DialogueFlow {
  constructor(private readonly options: DialogueFlowOptions) {}

  prepare(input: SpeechApprovalInput): SpeechPreparation {
    this.assertAuth(input);
    if (input.intent.kind === "none") throw new Error("speech intent cannot be none");
    if (input.intent.audience.length === 0) throw new Error("speech audience cannot be empty");
    const requestedRefs = [...input.intent.factRefs, ...(input.intent.subjectRef === null ? [] : [input.intent.subjectRef])];
    const filtered = filterDisclosableFacts(input.facts, requestedRefs, {
      audience: input.intent.audience,
      principalFactions: input.principalFactions,
      heldEvidenceIds: input.heldEvidenceIds,
    });
    const visibleRefs = new Set(filtered.visible.map((fact) => fact.ref));
    const audienceNames = input.intent.audience
      .map((principalId) => input.principalNames.get(principalId) ?? principalId)
      .join("、");
    const prompts = this.options.content.prompts;
    const labels = prompts.labels;
    const requestSystem = renderTemplate(prompts.speech.system, {
      name: input.principalNames.get(input.agentId) ?? input.agentId,
      audienceNames,
      intentLabel: labels.intents[input.intent.kind],
      toneLabel: labels.tones[input.intent.tone],
      reasonLabel: labels.reasons[input.intent.reasonCode],
      speechStyle: input.speechStyle,
      maxChars: String(input.maxChars),
    });
    const requestUser = renderTemplate(prompts.speech.user, {
      audienceLines: lines(input.intent.audience.map((principalId) =>
        `- ${input.principalNames.get(principalId) ?? principalId}（${principalId}）`)),
      publicHistoryLines: lines(input.history.map((line) =>
        `- [${line.dialogueId}] ${line.speakerName}：${line.text}`)),
      disclosableFactLines: lines(filtered.visible.map((fact) =>
        `- [${fact.ref}] ${fact.summaryZh}`)),
      receiptLines: lines(input.receipts.map(receiptLine)),
      intentKind: labels.intents[input.intent.kind],
      reasonCode: labels.reasons[input.intent.reasonCode],
      subjectLine: subjectLine(input, visibleRefs),
    });
    return {
      request: {
        system: requestSystem,
        user: requestUser,
        output: {
          kind: "json",
          schemaName: "speech",
          schema: speechWireSchema,
        },
      },
      visibleFacts: filtered.visible,
      omittedFactRefs: filtered.omitted.map((fact) => fact.ref),
      restrictedSecrets: restrictedSecrets(input),
      allowedRefs: filtered.visible.map((fact) => fact.ref),
      receipts: input.receipts,
    };
  }

  validate(input: SpeechApprovalInput, preparation: SpeechPreparation, output: unknown): SpeechValidation {
    const lexicons = this.options.content.locale.lexicons;
    return validateSpeechOutput({
      output,
      maxChars: input.maxChars,
      allowedRefs: preparation.allowedRefs,
      restrictedSecrets: preparation.restrictedSecrets,
      receipts: input.receipts,
      rejectedToolCommand: input.rejectedToolCommand === true,
      completionClaims: lexicons.completionClaims,
      progressClaims: lexicons.progressClaims,
    });
  }

  async approve(
    input: SpeechApprovalInput,
    generator?: SpeechGenerator,
    commandId = this.options.host.ids("cmd"),
    templateOnly = false,
  ): Promise<SpeechApprovalResult> {
    const preparation = this.prepare(input);
    const attempts: Json[] = [];
    let selected: SpeechGenerationOutput | null = null;
    let fallbackReason: string | null = generator === undefined && !templateOnly ? "model-unavailable" : null;
    if (generator !== undefined) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const candidate = await generator(preparation.request, attempt);
          const validation = this.validate(input, preparation, candidate);
          attempts.push({
            attempt,
            status: validation.ok ? "passed" : "failed",
            failedChecks: validation.checks.filter((check) => !check.passed).map((check) => check.name),
          });
          if (validation.ok) {
            selected = speechOutputSchema.parse(candidate);
            fallbackReason = null;
            break;
          }
          fallbackReason = "validation-failed";
        } catch (error) {
          if (error instanceof DomainError && error.code === "cancelled") throw error;
          attempts.push({
            attempt,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          fallbackReason = error instanceof DomainError && error.code === "budget-exhausted" ? "budget-exhausted" : "generation-failed";
          if (fallbackReason === "budget-exhausted") break;
        }
      }
    }

    let text: string;
    let citedRefs: readonly string[];
    let fallback: boolean;
    let finalValidation: SpeechValidation;
    if (selected === null) {
      text = renderSafeSpeech({
        intent: input.intent,
        facts: preparation.visibleFacts,
        receipts: input.receipts,
        subject: subjectLine(input, new Set(preparation.allowedRefs)),
        maxChars: input.maxChars,
        prompts: this.options.content.prompts,
      });
      citedRefs = [];
      fallback = !templateOnly;
      finalValidation = this.validate(input, preparation, { utterance: text, citedRefs });
      if (!finalValidation.ok) {
        throw new Error("safe speech template failed its guard checks");
      }
    } else {
      text = selected.utterance;
      citedRefs = [...selected.citedRefs];
      fallback = false;
      finalValidation = this.validate(input, preparation, selected);
    }

    const artifactId = this.options.host.ids("art");
    const artifact = speechArtifactSchema.parse({
      artifactId,
      turnId: input.turnId,
      agentId: input.agentId,
      audience: input.intent.audience,
      intent: input.intent,
      text,
      citedRefs,
      fallback,
      validation: {
        source: selected === null ? "safe-template" : "model",
        ...(input.publication === undefined ? {} : { publication: input.publication }),
        attempts,
        fallbackReason,
        finalValidation: finalValidation as unknown as Json,
        preparation: {
          omittedFactRefs: [...preparation.omittedFactRefs],
          allowedRefs: [...preparation.allowedRefs],
        },
      } satisfies Json,
    });
    await this.options.artifacts.put({
      artifactId,
      runId: input.runId,
      kind: "speech",
      value: artifact as unknown as Json,
    });
    const approvedSpeech: ApprovedSpeech = {
      text: artifact.text,
      agentId: artifact.agentId,
      turnId: artifact.turnId,
      branchId: input.session.branchId,
      audience: artifact.audience,
      channel: input.channel,
      approved: true,
    };
    this.options.approvals.register(artifact.artifactId, approvedSpeech);
    return {
      artifact,
      approvedSpeech,
      commitEnvelope: buildSpeechCommitEnvelope({
        auth: input.auth,
        commandId,
        artifact,
        channel: input.channel,
        conversationId: input.conversationId,
        replyToId: input.replyToId,
      }),
      preparation,
    };
  }

  async commitWithCommandId(
    input: SpeechApprovalInput,
    commandId: string,
    generator?: SpeechGenerator,
  ): Promise<SpeechCommitResult> {
    const approved = await this.approve(input, generator, commandId);
    if (this.options.executeCommand === undefined) throw new Error("speech.commit executor is not configured");
    const receipt = await this.options.executeCommand(input.auth, approved.commitEnvelope);
    return { ...approved, receipt };
  }

  async commit(input: SpeechApprovalInput, generator?: SpeechGenerator): Promise<SpeechCommitResult> {
    return this.commitWithCommandId(input, this.options.host.ids("cmd"), generator);
  }

  async executeMessage(input: MessageExecutionInput & {
    readonly speech: SpeechApprovalInput;
    readonly generator?: SpeechGenerator;
  }): Promise<MessageExecutionResult> {
    const messageIntent = messageIntentFromArguments(input.arguments);
    if (messageIntent === null) throw new Error("message.send arguments are invalid");
    if (input.speech.turnId !== input.turn.turnId || input.speech.agentId !== input.turn.agentId) {
      throw new Error("message speech input does not match the active tool turn");
    }
    const channel = messageIntent.audience.length === 1 && messageIntent.audience[0] === "public"
      ? "broadcast"
      : "message";
    const speech: SpeechApprovalInput = { ...input.speech, intent: messageIntent, channel };
    const committed = await this.commitWithCommandId(speech, input.commandId, input.generator);
    return { receipt: committed.receipt, output: committed.receipt.result ?? {} };
  }

  private assertAuth(input: SpeechApprovalInput): void {
    if (input.auth.worldId !== input.session.worldId || input.auth.branchId !== input.session.branchId) {
      throw new Error("speech auth scope does not match session scope");
    }
    if ((input.auth.actingAsAgentId ?? input.auth.principalId) !== input.agentId) {
      throw new Error("speech auth subject does not match speaker");
    }
    if (input.auth.turnId !== null && input.auth.turnId !== input.turnId) {
      throw new Error("speech auth turnId does not match the active turn");
    }
  }
}

export function buildSpeechCommitEnvelope(input: {
  readonly auth: AuthContext;
  readonly commandId: string;
  readonly artifact: SpeechArtifact;
  readonly channel: "dialogue" | "message" | "broadcast";
  readonly conversationId: string | null;
  readonly replyToId: string | null;
}): CommandEnvelope {
  return {
    commandId: input.commandId,
    type: "speech.commit",
    schemaVersion: 1,
    payload: {
      channel: input.channel,
      conversationId: input.conversationId,
      audience: input.artifact.audience,
      approvedSpeechArtifactRef: input.artifact.artifactId,
      intentKind: input.artifact.intent.kind,
      replyToId: input.replyToId,
    },
  };
}
