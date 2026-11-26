/**
 * 核心职责：验证传输层按访问裁决的原因区分「角色合法但无权」与「provider 未覆盖该角色」，并各自给出正确响应与上报。
 * 交互契约：注入桩权限端口与最小 reply 替身，不建立 Fastify 实例、不启动监听。
 * 约束与禁忌：禁止让拒绝原因影响 403 响应体，避免向调用方泄露角色存在性。
 */
import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import type { AccessDecision, AccessPolicy, AccessRequest } from "@world-prism/module-sdk";
import { requireCommand, requireConsole, requirePlayer, type RouteContext } from "../src/routes/context";
import type { HttpSession } from "../src/routes/contracts";

/** 记录一次 sendHttpError 的落点；只保留状态码与解析后的错误码，足以断言拒绝语义。 */
interface ReplyCapture {
  readonly reply: FastifyReply;
  statusCode(): number | null;
  errorCode(): string | null;
}

function createReply(): ReplyCapture {
  let code: number | null = null;
  let body: unknown = null;
  const fake = {
    code(value: number) {
      code = value;
      return fake;
    },
    send(payload: unknown) {
      body = payload;
      return fake;
    },
  };
  return {
    reply: fake as unknown as FastifyReply,
    statusCode: () => code,
    errorCode: () => {
      if (typeof body !== "object" || body === null) {
        return null;
      }
      const error = (body as { readonly error?: { readonly code?: unknown } }).error;
      return typeof error?.code === "string" ? error.code : null;
    },
  };
}

function sessionWithRoles(roles: readonly string[]): HttpSession {
  return {
    sessionId: "ses-000000000001",
    token: "session-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
    auth: {
      principalId: "operator-1",
      kind: "operator",
      roles: [...roles],
      branchId: "br-000000000001",
      worldId: "wld-000000000001",
    },
  } as unknown as HttpSession;
}

/** 按动作给出固定裁决；request.action 之外的字段只用于记录调用。 */
function policyOf(decide: (request: AccessRequest) => AccessDecision): AccessPolicy {
  return { authorize: decide };
}

function contextWith(policy: AccessPolicy, reported: string[]): RouteContext {
  return {
    options: { accessPolicy: policy },
    reportInternalError: (message: string) => {
      reported.push(message);
    },
  } as unknown as RouteContext;
}

describe("传输层按拒绝原因分支", () => {
  it("角色合法但无权时返回 403，且不误报为配置漂移", () => {
    const reported: string[] = [];
    const capture = createReply();
    const context = contextWith(policyOf(() => ({ allowed: false, reason: "forbidden" })), reported);

    const allowed = requirePlayer(context, sessionWithRoles(["player"]), capture.reply);

    expect(allowed).toBe(false);
    expect(capture.statusCode()).toBe(403);
    expect(capture.errorCode()).toBe("forbidden");
    expect(reported).toEqual([]);
  });

  it("provider 未覆盖该角色时仍返回 403，但把原因上报为内部错误", () => {
    const reported: string[] = [];
    const capture = createReply();
    const context = contextWith(policyOf(() => ({ allowed: false, reason: "unknown-role" })), reported);

    const allowed = requirePlayer(context, sessionWithRoles(["auditor"]), capture.reply);

    expect(allowed).toBe(false);
    // 响应体与普通拒绝一致：不向调用方透露角色是否存在于 provider 配置中。
    expect(capture.statusCode()).toBe(403);
    expect(capture.errorCode()).toBe("forbidden");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("玩家入口裁决未覆盖会话角色");
  });

  it("命令入口分别裁决玩家入口与命令类型，只在两者都未放行时才可能是配置漂移", () => {
    const reported: string[] = [];
    const capture = createReply();
    // 玩家入口放行、命令类型被拒：属于业务拒绝，不是 provider 配置问题。
    const context = contextWith(
      policyOf((request) =>
        request.action === "player" ? { allowed: true, reason: "allowed" } : { allowed: false, reason: "forbidden" },
      ),
      reported,
    );

    const allowed = requireCommand(context, sessionWithRoles(["player"]), "policy.set", capture.reply);

    expect(allowed).toBe(false);
    expect(capture.errorCode()).toBe("forbidden");
    expect(reported).toEqual([]);
  });

  it("命令入口的角色未被 provider 覆盖时上报配置漂移", () => {
    const reported: string[] = [];
    const capture = createReply();
    const context = contextWith(
      policyOf((request) =>
        request.action === "player"
          ? { allowed: false, reason: "forbidden" }
          : { allowed: false, reason: "unknown-role" },
      ),
      reported,
    );

    const allowed = requireCommand(context, sessionWithRoles(["researcher"]), "campaign.start", capture.reply);

    expect(allowed).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("命令入口裁决未覆盖会话角色");
  });

  it("控制台入口按请求头选中的角色裁决，并用同一原因区分拒绝", () => {
    const reported: string[] = [];
    const capture = createReply();
    const context = contextWith(policyOf(() => ({ allowed: false, reason: "unknown-role" })), reported);
    const request = {
      headers: { "x-active-role": "operator" },
    } as unknown as Parameters<typeof requireConsole>[1];

    const allowed = requireConsole(context, request, sessionWithRoles(["operator"]), capture.reply);

    expect(allowed).toBe(false);
    expect(capture.statusCode()).toBe(403);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("控制台入口裁决未覆盖会话角色");
  });
});
