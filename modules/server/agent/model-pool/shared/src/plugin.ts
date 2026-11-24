/**
 * 路由冻结模型调用，获取队列配额，按尝试扣账、重试与归档。
 * 传输只接收一次请求及对应凭据，控制权在发出与返回时重新验证。
 * 禁止静默切换模型或向已失效工作返回可执行的结果。
 */
import {
  DomainError, estimateModelInputTokens, estimateTokens, modelRequestSchema, modelResponseSchema, modelTransportErrorSchema,
  type AgentModelCallResult, type ModelRequest, type ModelResponse, type ModelTransportError,
  type ModelTransportPort, type ModuleCreateInput, type Purpose, type StoragePort,
} from "@ai-npc/contracts";
import {
  createStatelessModule, isRetryableModelError, modelTransportFailure, type AgentBudgetPort, type AgentModelPoolPort, type ModelCallInput,
  type ModelObservabilityPort, type ModelRoute, type ModelRunLimits, type ModelWorkScope,
} from "@ai-npc/module-sdk";
import { AttemptEvidence, modelSubstituted } from "./attempt-evidence";
import { sharedModelPoolDefinition } from "./definition";
import { backpressure, currentWork, hasRequestHeadroom, ModelAdmission } from "./admission";

/** 重试退避的固定序列；超过长度即不再重试。 */
const retryDelays = [1000, 4000];
/** 单次重试等待的上限，避免供应商给的 retry-after 无限拉长本轮。 */
const maxRetryWaitMs = 30_000;

function requireCurrent(scope: ModelWorkScope): void {
  if (!currentWork(scope)) throw new DomainError("cancelled", "模型调用的工作租约已失效");
}

function providerFailure(error: ModelTransportError, response: ModelResponse | null): DomainError {
  return new DomainError("provider-failed", "模型调用未产生可用响应", {
    details: { kind: error.kind, finishReason: response?.finishReason ?? null },
  });
}

export function createSharedModelPool(input: ModuleCreateInput) {
  const { host, ports } = input;
  const transports = new Map((ports["platform.model-transport"] as readonly ModelTransportPort[])
    .map((transport) => [transport.adapterId, transport] as const));
  const budget = ports["platform.budget"] as AgentBudgetPort;
  const secrets = ports["platform.secrets"] as { resolve(ref: string): string | null };
  const admission = new ModelAdmission(host);
  const evidence = new AttemptEvidence(ports["platform.storage"] as StoragePort, host,
    ports["platform.observability"] as ModelObservabilityPort, sharedModelPoolDefinition.version);
  evidence.recoverInterrupted();

  /** 解析路由的单个凭据明文，未配置引用时返回 null；同时经传输适配器校验连接与凭据形态。 */
  function resolveCredential(route: ModelRoute, adapter: ModelTransportPort): string | null {
    const credential = route.credentialRef === null ? null : secrets.resolve(route.credentialRef);
    if (adapter.validateConnection !== undefined) adapter.validateConnection(route.endpoint, credential !== null);
    else if (route.credentialRef !== null && credential === null) {
      throw new DomainError("assembly-incompatible", "模型连接缺少已授权的密钥引用");
    }
    return credential;
  }

  async function complete(
    adapter: ModelTransportPort, request: ModelRequest, route: ModelRoute,
    credential: string | null, scope: ModelWorkScope, jsonOutputSuffix: string | undefined,
  ) {
    const timer = new AbortController();
    const signal = AbortSignal.any([scope.signal, timer.signal]);
    try {
      const response = await Promise.race([
        adapter.complete(request, credential, {
          endpoint: route.endpoint, fixtures: route.fixtureRows, signal, capabilities: route.capabilities,
          ...(jsonOutputSuffix === undefined ? {} : { jsonOutputSuffix }),
        }),
        host.sleep(request.timeoutMs, signal).then(() => { throw modelTransportFailure("timeout"); }),
      ]);
      const parsed = modelResponseSchema.safeParse(response);
      if (!parsed.success) return { response: null, error: modelTransportFailure("protocol") };
      const invalid = parsed.data.finishReason === "length" || parsed.data.finishReason === "refusal" ||
        parsed.data.jsonError !== null || (request.output.kind === "json" && parsed.data.json === null);
      return { response: parsed.data, error: invalid ? modelTransportFailure("protocol") : null };
    } catch (error) {
      const classified = modelTransportErrorSchema.safeParse(error);
      return { response: null, error: classified.success ? classified.data : modelTransportFailure("protocol") };
    } finally {
      timer.abort();
    }
  }

  async function call(
    scope: ModelWorkScope, route: ModelRoute, limits: ModelRunLimits, reserveOutputTokens: number, requestInput: ModelCallInput,
    jsonOutputSuffix: string | undefined,
  ): Promise<AgentModelCallResult> {
    requireCurrent(scope);
    const adapter = transports.get(route.adapterId);
    if (adapter === undefined) throw new DomainError("assembly-incompatible", "模型传输未装配");
    const credential = resolveCredential(route, adapter);
    const jsonInstructionTokens = requestInput.output.kind === "json" && route.capabilities.structuredOutput === "json_object"
      ? estimateTokens(jsonOutputSuffix ?? "") : 0;
    const estimated = estimateModelInputTokens(requestInput) + jsonInstructionTokens;
    if (!Number.isSafeInteger(reserveOutputTokens) || reserveOutputTokens < 1 || reserveOutputTokens > route.maxOutputTokens) {
      throw new DomainError("assembly-incompatible", "模型输出预留与挂载不兼容");
    }
    // 请求硬上限取挂载的用途上限，预算预留只在账本上占额：
    // 预留是成本估算，用它当 max_tokens 会让含思考的模型在思考阶段就耗尽输出预算。
    if (estimated > requestInput.inputLimit || estimated + route.maxOutputTokens > route.capabilities.contextWindowTokens) {
      throw new DomainError("budget-exhausted", "模型输入超过本轮窗口", { details: { kind: "over-budget" } });
    }
    if (requestInput.tools.length > 0 && (requestInput.output.kind !== "text" || !route.capabilities.toolCalling) ||
      requestInput.output.kind === "json" && route.capabilities.structuredOutput === "none") {
      throw new DomainError("assembly-incompatible", "模型请求与挂载能力不兼容");
    }
    const llmCallId = host.ids("llm");
    const attempts: AgentModelCallResult["attempts"][number][] = [];
    const reservation = { scope, limits, route, reservedInput: estimated, reservedOutput: reserveOutputTokens };
    for (let index = 0; ; index += 1) {
      requireCurrent(scope);
      budget.check(reservation);
      const queuedAt = host.monotonicMs();
      const release = await admission.acquire({ scope, route, tokens: estimated + reserveOutputTokens });
      const attemptId = host.ids("att");
      let sent = false;
      let reserved = false;
      let releaseAttemptQuota: (() => void) | void = undefined;
      let result: Awaited<ReturnType<typeof complete>>;
      let request: ModelRequest;
      let startedAt: number;
      let respondedAt: number;
      const previous = attempts.at(-1);
      try {
        requireCurrent(scope);
        startedAt = host.monotonicMs();
        if (!hasRequestHeadroom(scope, route.requestTimeoutMs, startedAt)) throw backpressure();
        request = modelRequestSchema.parse({
          llmCallId, attemptId, purpose: route.purpose, externalModel: route.externalModel,
          system: requestInput.system, messages: requestInput.messages, tools: requestInput.tools, output: requestInput.output,
          parameters: route.parameters, maxOutputTokens: route.maxOutputTokens,
          timeoutMs: Math.floor(Math.min(route.requestTimeoutMs, scope.deadlineMs - startedAt)),
          context: {
            agentId: scope.agentId, evaluatorId: null, workRef: scope.workRef, round: requestInput.round,
            triggerPrincipalIds: scope.triggerPrincipalIds,
            ...(requestInput.contextArtifactId === undefined ? {} : { contextArtifactId: requestInput.contextArtifactId }),
          },
        });
        budget.reserve({ ...reservation, entryId: attemptId });
        reserved = true;
        releaseAttemptQuota = scope.beforeAttempt?.();
        evidence.begin(scope, route, request, previous?.attemptId);
        if (previous !== undefined) attempts[attempts.length - 1] = { ...previous, status: "superseded" };
        sent = true;
        result = await complete(adapter, request, route, credential, scope, jsonOutputSuffix);
        respondedAt = host.monotonicMs();
      } finally {
        release(sent);
        if (!sent) {
          try {
            if (reserved) budget.settle({ entryId: attemptId, actualInput: null, actualOutput: null, sent, price: route.price });
          } finally {
            releaseAttemptQuota?.();
          }
        }
      }
      const { response, error } = result;
      let status: Awaited<ReturnType<AttemptEvidence["finish"]>>;
      try {
        budget.settle({
          entryId: attemptId, actualInput: response?.usage.inputTokens ?? null,
          actualOutput: response?.usage.outputTokens ?? null, sent, price: route.price,
        });
        status = await evidence.finish({
          scope, route, request, response, error, credential, queuedAt, startedAt, respondedAt,
          status: () => {
            if (!currentWork(scope)) return response === null ? "cancelled" : "superseded";
            return error === null ? "succeeded" : "failed";
          },
        });
      } catch (error) {
        evidence.incomplete(scope.runId);
        throw new DomainError("provider-failed", "模型调用证据未能完整保存", { cause: error });
      }
      requireCurrent(scope);
      if (status === "failed" && error === null) throw providerFailure(modelTransportFailure("protocol"), null);
      attempts.push({
        attemptId, status, error: error === null ? null : { kind: error.kind },
        modelId: route.modelId, servedModel: response?.servedModel ?? null, substituted: modelSubstituted(route, response),
      });
      if (status === "succeeded" && response !== null) return { response, attempts };
      const failure = error ?? modelTransportFailure("protocol");
      const delay = retryDelays[index];
      if (delay === undefined || !failure.retryable || !isRetryableModelError(failure.kind)) throw providerFailure(failure, response);
      const wait = Math.min(maxRetryWaitMs, Math.max(delay, failure.retryAfterMs ?? 0));
      if (!hasRequestHeadroom(scope, route.requestTimeoutMs, host.monotonicMs() + wait)) throw backpressure();
      budget.check(reservation);
      try {
        await host.sleep(wait, scope.signal);
      } catch (error) {
        requireCurrent(scope);
        throw error;
      }
    }
  }

  const pool: AgentModelPoolPort = {
    bindRun({ routes, limits, jsonOutputSuffix }) {
      const mounts = new Map<string, ModelRoute>();
      for (const route of routes) {
        const key = `${route.agentId}:${route.purpose}`;
        if (mounts.has(key)) throw new DomainError("assembly-incompatible", "模型用途重复挂载");
        const adapter = transports.get(route.adapterId);
        if (adapter === undefined) throw new DomainError("assembly-incompatible", "模型连接引用了未装配的传输");
        const supported = adapter.capabilities(route.parameters, route);
        if ((route.capabilities.toolCalling && !supported.toolCalling) ||
          (route.capabilities.strictTools && !supported.strictTools) ||
          (route.capabilities.structuredOutput !== "none" && supported.structuredOutput === "none") ||
          (route.capabilities.structuredOutput === "json_schema" && supported.structuredOutput !== "json_schema") ||
          (route.capabilities.assistantReplay === "verbatim" && supported.assistantReplay !== "verbatim") ||
          (route.capabilities.embedding && (!supported.embedding || route.capabilities.embeddingDimensions !== supported.embeddingDimensions)) ||
          route.capabilities.contextWindowTokens > supported.contextWindowTokens || route.maxOutputTokens > supported.maxOutputTokens) {
          throw new DomainError("assembly-incompatible", "模型布局声明了传输不支持的能力");
        }
        resolveCredential(route, adapter);
        mounts.set(key, route);
      }
      function mounted(agentId: string, purpose: Purpose): ModelRoute {
        const route = mounts.get(`${agentId}:${purpose}`);
        if (route === undefined) throw new DomainError("assembly-incompatible", "主体缺少所需模型挂载");
        return route;
      }
      return {
        route(agentId, purpose) {
          const { capabilities, maxOutputTokens } = mounted(agentId, purpose);
          return { capabilities, maxOutputTokens };
        },
        call(scope, purpose, reserveOutputTokens, request) {
          return call(scope, mounted(scope.agentId, purpose), limits, reserveOutputTokens, request, jsonOutputSuffix);
        },
      };
    },
  };
  return createStatelessModule(input, pool);
}
