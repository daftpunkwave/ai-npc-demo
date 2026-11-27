/**
 * 保存单次传输的模型原文、状态与 trace。
 * 请求和响应经凭据扫描后写入不可变 artifact，尝试行关联同一工作的 trace。
 * 归档失败时标记运行证据不完整，禁止把敏感正文写入日志。
 */
import type { HostServices, Json, ModelRequest, ModelResponse, ModelTransportError, StoragePort } from "@world-prism/contracts";
import { insertLifecycleAuditEvent, StoredAgentArtifactStore, type ModelObservabilityPort, type ModelRoute, type ModelWorkScope } from "@world-prism/module-sdk";

export type AttemptStatus = "succeeded" | "failed" | "superseded" | "cancelled";

export class AttemptEvidence {
  private readonly artifacts: StoredAgentArtifactStore;

  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
    private readonly observability: ModelObservabilityPort,
    /** 模块定义声明的版本；span 元数据与实际模块定义保持同一来源。 */
    private readonly moduleVersion: string,
  ) {
    this.artifacts = new StoredAgentArtifactStore(storage, host);
  }

  recoverInterrupted(): void {
    this.storage.transact((tx) => {
      const attempts = tx.rows("model_attempts");
      const runs = tx.rows("runs");
      for (const row of attempts.list({ status: "started" })) {
        attempts.put({ ...row, status: "failed", is_effective: 0, error_json: { kind: "process-interrupted" } });
        const run = runs.get({ run_id: String(row["run_id"]) });
        if (run !== null && run["evidence_complete"] !== 0) runs.put({ ...run, evidence_complete: 0 });
      }
    });
  }

  begin(scope: ModelWorkScope, route: ModelRoute, request: ModelRequest, supersedes: string | undefined): void {
    this.storage.transact((tx) => {
      const attempts = tx.rows("model_attempts");
      if (supersedes !== undefined) {
        const prior = attempts.get({ attempt_id: supersedes });
        if (prior === null) throw new Error("Previous model attempt is missing");
        attempts.put({ ...prior, status: "superseded", is_effective: 0 });
      }
      attempts.put({
        attempt_id: request.attemptId, llm_call_id: request.llmCallId, run_id: scope.runId,
        work_ref: scope.workRef, agent_id: scope.agentId, evaluator_id: null, purpose: request.purpose,
        model_id: route.modelId, connection_id: route.connectionId, adapter_id: route.adapterId,
        status: "started", is_effective: 0, request_artifact_id: null, response_artifact_id: null,
        usage_json: null, timings_json: null, error_json: null, created_at: this.host.nowIso(),
      });
    });
  }

  async finish(input: {
    readonly scope: ModelWorkScope;
    readonly route: ModelRoute;
    readonly request: ModelRequest;
    readonly response: ModelResponse | null;
    readonly error: ModelTransportError | null;
    readonly credential: string | null;
    readonly status: () => AttemptStatus;
    readonly queuedAt: number;
    readonly startedAt: number;
    readonly respondedAt: number;
  }): Promise<AttemptStatus> {
    const { scope, route, request, response, credential } = input;
    let containedCredential = false;
    const redact = (value: Json): Json => {
      if (typeof value === "string" && credential && value.includes(credential)) {
        containedCredential = true;
        return value.replaceAll(credential, "[REDACTED]");
      }
      if (Array.isArray(value)) return value.map(redact);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, part]) => [redact(key), redact(part)]));
      }
      return value;
    };
    const { wire, ...responseFields } = response ?? {};
    // 请求名在 request.externalModel 中，声明的别名一并归档，审计无需回查 manifest 就能核对别名判定。
    const requestArtifact = await this.artifacts.put({
      kind: "model-request", runId: scope.runId,
      value: redact({
        request, wire: wire?.requestBody ?? null, modelConfigHash: route.configHash,
        ...(route.servedModels === undefined ? {} : { servedModels: [...route.servedModels] }),
      }),
    });
    const error = input.error === null ? null : redact({ ...input.error });
    const responseArtifact = await this.artifacts.put({
      kind: "model-response", runId: scope.runId,
      value: redact({ response: response === null ? null : responseFields, wire: wire?.responseBody ?? null, error }),
    });
    const substituted = modelSubstituted(route, response);
    const servedModel = redact(response?.servedModel ?? null);
    const status = containedCredential ? "failed" : input.status();
    const timings = { queueMs: input.startedAt - input.queuedAt, firstTokenMs: null, totalMs: input.respondedAt - input.startedAt };
    this.storage.transact((tx) => {
      const attempts = tx.rows("model_attempts");
      const attempt = attempts.get({ attempt_id: request.attemptId });
      if (attempt === null) throw new Error("Model attempt was not started");
      attempts.put({
        ...attempt, status, is_effective: status === "succeeded" ? 1 : 0,
        request_artifact_id: requestArtifact.artifactId, response_artifact_id: responseArtifact.artifactId,
        usage_json: response?.usage ?? null, timings_json: timings, error_json: error,
      });
      if (containedCredential) {
        // 脱敏审计与 attempt 终态同事务写入：attempt 更新失败则审计一并回滚，反之亦然。
        insertLifecycleAuditEvent(tx, {
          runId: scope.runId, branchId: scope.branchId, type: "ModelCredentialRedacted",
          subjectId: scope.agentId, payload: { attemptId: request.attemptId }, createdAt: this.host.nowIso(),
        });
      }
    });
    this.observability.recordSpan({
      spanId: this.host.ids("spn"), traceId: scope.traceId, parentSpanId: null, runId: scope.runId,
      branchId: scope.branchId, agentId: scope.agentId, turnId: scope.workRef.startsWith("turn-") ? scope.workRef : null,
      moduleId: "agent.model-pool.shared", moduleVersion: this.moduleVersion,
      name: "model.attempt", status: status === "succeeded" ? "ok" : status === "failed" ? "error" : "skipped",
      startMs: input.startedAt, endMs: input.respondedAt,
      attrs: {
        attemptId: request.attemptId, llmCallId: request.llmCallId, purpose: request.purpose,
        modelId: route.modelId, modelConfigHash: route.configHash,
        servedModel, status,
        reason: substituted ? "model-substituted" : servedByAlias(route, response) ? "served-model-alias" : null,
        requestArtifactId: requestArtifact.artifactId, responseArtifactId: responseArtifact.artifactId, timings,
      },
    });
    return status;
  }

  incomplete(runId: string): void {
    this.storage.transact((tx) => {
      const runs = tx.rows("runs");
      const run = runs.get({ run_id: runId });
      if (run !== null) runs.put({ ...run, evidence_complete: 0 });
    });
  }
}

export function modelSubstituted(route: ModelRoute, response: ModelResponse | null): boolean {
  return response !== null && (response.fallbackUsed || (response.servedModel !== null &&
    response.servedModel !== route.externalModel && route.servedModels?.includes(response.servedModel) !== true));
}

/**
 * 供应商报告的名称不同于请求名、但精确命中布局声明的别名。
 * span 单独标注这种情况，审计能区分“报告名就是请求名”与“按声明的别名认定为同一模型”。
 */
function servedByAlias(route: ModelRoute, response: ModelResponse | null): boolean {
  const served = response?.servedModel ?? null;
  return served !== null && served !== route.externalModel && route.servedModels?.includes(served) === true;
}
