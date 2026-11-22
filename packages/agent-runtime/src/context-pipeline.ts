/**
 * 核心职责：在一次 decision 首轮请求前组装上下文，并按压缩端口结果决定是否生成替代 artifact。
 * 交互契约：依赖不可变 ContextBuildRequest、AgentContextPort、AgentCompressionPort 与宿主 ID/hash。
 * 约束与禁忌：不得在工具循环后续轮次重写历史，也不得把 cannot-fit 冒充 ready。
 */
import {
  canonicalJson,
  estimateSystemAndUserTokens,
  resolveContextTokenLimits,
  type ContextArtifact,
  type ContextBuildRequest,
  type Json,
} from "@ai-npc/contracts";
import type { AgentCompressionPort, AgentContextPort } from "@ai-npc/module-sdk";

export interface ContextPipelineOptions {
  readonly context: AgentContextPort;
  readonly compression: AgentCompressionPort;
  readonly host: {
    ids(prefix: string): string;
    hash(value: Json): Promise<string>;
  };
}

export interface PreparedContext {
  readonly artifact: ContextArtifact;
  readonly original?: ContextArtifact;
  readonly compressionStatus: "not-triggered" | "compressed" | "cannot-fit";
  readonly lossReport: Json;
  readonly ready: boolean;
}

export class AgentContextPipeline {
  constructor(private readonly options: ContextPipelineOptions) {}

  async prepareFirstRequest(input: ContextBuildRequest): Promise<PreparedContext> {
    const built = await this.options.context.build(input);
    const eligibleForCompression = built.status === "ready" ||
      (built.status === "over-budget" && built.failureReason === "request-over-budget");
    if (!eligibleForCompression) {
      return {
        artifact: built,
        compressionStatus: "not-triggered",
        lossReport: {
          policy: "skipped",
          reason: "ineligible-context-status",
          status: built.status,
          failureReason: built.failureReason,
        },
        ready: built.status === "ready",
      };
    }
    const { effectiveMaxTokens, targetTokens } = resolveContextTokenLimits(input);
    if (effectiveMaxTokens === 0) {
      return {
        artifact: built,
        compressionStatus: "cannot-fit",
        lossReport: {
          policy: "skipped",
          reason: "window-exhausted",
          effectiveMaxTokens,
          targetTokens,
          status: built.status,
          failureReason: built.failureReason,
        },
        ready: false,
      };
    }
    const compressed = this.options.compression.compress({
      artifact: built,
      effectiveMaxTokens,
      targetTokens,
    });
    if (compressed.status !== "compressed") {
      return {
        artifact: built,
        compressionStatus: compressed.status,
        lossReport: compressed.lossReport,
        ready: built.status === "ready" && compressed.status !== "cannot-fit",
      };
    }
    const userSegments = compressed.segments.filter((segment) => segment.role === "user").map((segment) => segment.text);
    const tokenEstimate = estimateSystemAndUserTokens(compressed.system, userSegments.join("\n\n"));
    const artifactWithoutIdentity = {
      parentArtifactId: built.artifactId,
      session: built.session,
      turnId: built.turnId,
      phase: built.phase,
      frontier: built.frontier,
      profileHash: built.profileHash,
      templateVersion: built.templateVersion,
      status: tokenEstimate <= targetTokens ? "ready" as const : "over-budget" as const,
      system: compressed.system,
      segments: compressed.segments.map((segment) => ({ ...segment })),
      omissions: built.omissions.map((omission) => ({ ...omission })),
      tokenEstimate,
      failureReason: tokenEstimate <= targetTokens ? null : "compression-cannot-fit",
    };
    return {
      original: built,
      artifact: {
        artifactId: this.options.host.ids("art"),
        ...artifactWithoutIdentity,
        hash: await this.options.host.hash(canonicalJson(artifactWithoutIdentity)),
      },
      compressionStatus: "compressed",
      lossReport: compressed.lossReport,
      ready: tokenEstimate <= targetTokens,
    };
  }
}
