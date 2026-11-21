/**
 * 验证统一错误码分组、领域错误与错误响应，以及原因码全集。
 * 依赖公共契约包的 errors 与 reason-codes 主题导出。
 * 禁止吞掉异常或依赖具体错误消息文本；断言只检查码、状态与可安全外传字段。
 */
import { describe, expect, it } from "vitest";
import {
  DomainError,
  domainErrorDetailsSchema,
  errorCodeGroups,
  errorCodes,
  errorCodeSchema,
  errorDetailSchema,
  errorResponseSchema,
  isErrorCode,
  isReasonCode,
  reasonCodeGroups,
  reasonCodes,
  reasonCodeSchema,
} from "../src/index";
import { expectInvalid, expectSchema } from "./support";

/** 错误码五组固定内容，用于目录完整性断言。 */
const expectedErrorCodes = {
  request: ["unauthenticated", "forbidden", "validation", "not-found"],
  state: ["paused", "not-ready", "invalid-state", "budget-exhausted", "cancelled"],
  version: ["idempotency-conflict", "version-conflict", "stale-controller", "stale-turn"],
  assembly: ["module-missing", "capability-conflict", "assembly-incompatible", "realm-violation"],
  provider: ["plugin-failed", "provider-failed"],
} as const;

/** 原因码六组固定内容，用于目录完整性断言。 */
const expectedReasonCodes = {
  common: [
    "invalid-params",
    "unknown-target",
    "no-authority",
    "paused",
    "not-ready",
    "idempotency-conflict",
    "version-conflict",
    "stale-controller",
    "stale-turn",
    "budget-exhausted",
  ],
  communication: ["relay-down", "speech-not-approved", "evidence-not-held", "secret-not-shareable"],
  agreement: [
    "invalid-terms",
    "obligor-not-party",
    "deadline-out-of-range",
    "not-a-party",
    "agreement-not-open",
    "already-responded",
  ],
  task: [
    "team-busy",
    "capability-missing",
    "route-unavailable",
    "route-closed",
    "insufficient-resource",
    "draw-limit-exceeded",
    "over-capacity",
    "participant-unavailable",
    "team-not-at-origin",
    "task-not-cancellable",
    "not-invited",
    "invitation-closed",
  ],
  policyAndScenario: [
    "no-change",
    "unknown-policy",
    "card-not-draft",
    "card-not-triggered",
    "card-not-found",
    "card-already-triggered",
    "invalid-effect",
    "campaign-exists",
    "unknown-faction",
  ],
  agentRefusal: [
    "danger",
    "duty",
    "past-breach",
    "low-trust",
    "lack-resources",
    "policy",
    "need-guarantee",
    "injured",
    "busy",
    "none",
  ],
} as const;

describe("错误码", () => {
  it("五组内容与固定目录逐项一致", () => {
    expect(errorCodeGroups).toEqual(expectedErrorCodes);
    for (const [group, codes] of Object.entries(expectedErrorCodes)) {
      expect((errorCodeGroups as Record<string, readonly string[]>)[group]).toEqual(codes);
    }
  });

  it("展开后的错误码无重复且全部可被 schema 接受", () => {
    expect([...errorCodes]).toEqual(Object.values(expectedErrorCodes).flat());
    expect(new Set(errorCodes).size).toBe(errorCodes.length);
    for (const code of errorCodes) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it("拒绝未登记错误码", () => {
    expectInvalid(errorCodeSchema, "unknown-error");
    expectInvalid(errorCodeSchema, "paused ");
    expect(isErrorCode("unknown-error")).toBe(false);
  });
});

describe("DomainError", () => {
  it("携带错误码、安全消息与可选上下文", () => {
    const error = new DomainError("forbidden", "当前角色无权访问", {
      retryable: true,
      traceId: "trc-k3j9x0a1b2c3",
      detailsArtifactRef: "art-k3j9x0a1b2c3",
      details: { role: "player" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error.code).toBe("forbidden");
    expect(error.safeMessage).toBe("当前角色无权访问");
    expect(error.message).toBe("当前角色无权访问");
    expect(error.retryable).toBe(true);
    expect(error.traceId).toBe("trc-k3j9x0a1b2c3");
    expect(error.detailsArtifactRef).toBe("art-k3j9x0a1b2c3");
    expect(error.details).toEqual({ role: "player" });
  });

  it("默认不可重试且无追踪信息，可携带 cause", () => {
    const cause = new Error("底层失败");
    const error = new DomainError("provider-failed", "供应商调用失败", { cause });
    expect(error.retryable).toBe(false);
    expect(error.traceId).toBeNull();
    expect(error.detailsArtifactRef).toBeNull();
    expect(error.details).toBeNull();
    expect(error.cause).toBe(cause);
  });
});

describe("错误响应 DTO", () => {
  const valid = {
    error: {
      code: "forbidden",
      retryable: false,
      safeMessage: "当前角色无权访问该接口",
      traceId: "trc-k3j9x0a1b2c3",
      detailsArtifactRef: null,
    },
  };

  it("接受统一错误响应", () => {
    expectSchema(errorResponseSchema, valid, { error: { ...valid.error, code: "nope" } });
  });

  it("拒绝缺少字段与额外字段的响应", () => {
    expectInvalid(errorResponseSchema, { error: { code: "forbidden" } });
    expectInvalid(errorResponseSchema, { ...valid, extra: true });
    expectInvalid(errorResponseSchema, { error: { ...valid.error, extra: true } });
  });

  it("错误详情与内联 details 都是受控 JSON", () => {
    expectSchema(errorDetailSchema, valid.error, { ...valid.error, code: "nope" });
    expectSchema(domainErrorDetailsSchema, { role: "player" }, Number.NaN);
    expectInvalid(domainErrorDetailsSchema, () => 1);
  });
});

describe("原因码", () => {
  it("六组内容与固定目录逐项一致", () => {
    expect(reasonCodeGroups).toEqual(expectedReasonCodes);
  });

  it("展开后的原因码无重复且全部可被 schema 接受", () => {
    expect([...reasonCodes]).toEqual(Object.values(expectedReasonCodes).flat());
    expect(new Set(reasonCodes).size).toBe(reasonCodes.length);
    for (const code of reasonCodes) {
      expect(reasonCodeSchema.safeParse(code).success).toBe(true);
      expect(isReasonCode(code)).toBe(true);
    }
  });

  it("拒绝未登记原因码", () => {
    expectInvalid(reasonCodeSchema, "unknown-reason");
    expectInvalid(reasonCodeSchema, "");
    expect(isReasonCode("unknown-reason")).toBe(false);
  });
});
