/**
 * 核心职责：声明 HTTP 传输层的框架无关上限（请求、连接、帧与请求体）、
 * 判定限流豁免路径，并提供框架级错误分类与限流插件注册。
 * 交互契约：上限与判定以纯函数导出供应用装配与测试共同引用；
 * 限流注册接收 Fastify 实例与「按令牌取会话主体」的回读，不自行持有会话状态。
 * 约束与禁忌：分类判定只按稳定错误码、不匹配文案；不在豁免清单之外绕过限流；不读取配置与环境变量。
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type rateLimit from "@fastify/rate-limit";

/**
 * 客户端 WS 帧上限：客户端只发送 subscribe/ack/ping，公共 schema 不含文本载荷，
 * 合法帧只有数百字节；64 KiB 为后续可选字段留出余量，同时避免超长帧占用接收缓冲。
 */
export const maxWebSocketPayloadBytes = 64 * 1024;

/**
 * HTTP 时间与连接维度上限。Fastify 默认把这些值设为 0（不限），
 * 本服务要求局部阻塞不扩散为整机不可用，因此逐项显式声明并写明依据。
 * 导出供测试锁定取值，避免后续重构把它们删回框架默认。
 */
export const httpTransportLimits = {
  /**
   * 单请求处理上限：最长合法请求是开局与恢复类命令、配置提交，正常远低于 1 秒。
   * 30 秒给慢磁盘与高负载留出余量，同时让慢速发送请求体与卡死的 handler 被打断。
   */
  requestTimeoutMs: 30_000,
  /**
   * socket 空闲上限：底层落到 `server.setTimeout()`（Node 的 socket 空闲超时），
   * 连接在该时长内没有任何读写活动即被关闭。它不约束「收齐请求头」，那由下面的请求头期限管辖。
   * 此处取值目的是让停在半开状态上的连接最终被回收。
   */
  connectionTimeoutMs: 30_000,
  /**
   * 收齐请求头的期限，不得长于请求期限。请求头期限更长时，Node 按请求头期限中断仍在接收的请求，
   * 请求期限随之失效；Fastify 在创建服务器之后才写入 requestTimeout，Node 默认的 60 秒请求头期限
   * 会把 30 秒的请求期限放宽到 60 秒。因此显式取与请求期限相同的值，经服务器创建参数传入。
   */
  headersTimeoutMs: 30_000,
  /**
   * Node 检查请求期限的扫描周期：请求期限不是逐请求计时器，而是按该周期扫描在途连接后中断，
   * 实际中断落在 [期限, 期限 + 本周期] 之间。取值等于 Node 默认值，显式写出以便覆盖。
   */
  connectionsCheckingIntervalMs: 30_000,
  /** handler 执行上限：与请求上限对齐，超时交错误处理器返回 plugin-failed。 */
  handlerTimeoutMs: 30_000,
  /**
   * 单连接请求数上限：本地单玩家场景一个连接远达不到该数量；
   * 设上限是为了让长连接不能无限复用，避免 keep-alive 连接永不释放。
   */
  maxRequestsPerSocket: 1_000,
  /** 请求体上限：最长的命令与配置提交小于 1 MiB，显式写出以免被误当成可随意放宽。 */
  bodyLimitBytes: 1024 * 1024,
} as const;

/**
 * 浏览器可发送的请求头白名单。会话令牌走 Authorization 头而非 Cookie，
 * 控制台角色由 X-Active-Role 声明；其余头不进入跨域允许面。
 */
export const corsAllowedHeaders = ["authorization", "content-type", "x-active-role"] as const;

/** 实际使用的 HTTP 方法：路由只有查询与命令提交两类，预检需要 OPTIONS。 */
export const corsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;

/** ws 在接收帧超过 maxPayload 时抛出带该稳定错误码的 RangeError，并自行以 1009 发起关闭。 */
export function isWebSocketPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
  );
}

/**
 * 框架级请求超时错误码。Fastify 在 handlerTimeout 触发时抛出该错误，
 * 语义是「本次请求未在期限内完成」，不是服务端缺陷，因此按可重试处理。
 */
const fastifyHandlerTimeoutCode = "FST_ERR_HANDLER_TIMEOUT";

/**
 * 判定框架请求超时错误。只按稳定错误码判断，不匹配错误文案，
 * 以免框架调整措辞后分类失效。
 */
export function isHandlerTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === fastifyHandlerTimeoutCode
  );
}

/**
 * 不参与请求次数限流的路径：健康检查与 WebSocket 升级。
 *
 * 健康检查无鉴权且供探活高频调用，限流会让探活本身变成故障源；
 * WebSocket 升级是长连接，请求次数不代表资源占用，由心跳与连接上限约束。
 * 其余路径一律限流——用豁免清单而不是白名单，新增路由默认受保护，
 * 遗漏只会表现为「本可以更宽松」，而不是「本应受保护却裸露」。
 */
export function isRateLimitExempt(url: string): boolean {
  return url === "/api/v1/health" || url === "/api/v1/streams";
}

/** 从 Authorization 头取 Bearer 令牌；非该形态一律视为未提供。 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

/** 需要限流的路由：除豁免清单外的全部 API 路径。 */
export function isRateLimitedRoute(url: string): boolean {
  return url.startsWith("/api/v1/") && !isRateLimitExempt(url);
}



/** 限流注册需要的注入依赖；本模块不持有会话状态，主体由调用方回读。 */
export interface RateLimitRegistrationInput {
  /** 单次读取配额的重载；按方法区分读写。 */
  readonly readLimit?: number;
  readonly writeLimit?: number;
  /** 按 Authorization 头反查已认证会话主体；未知或未认证返回 null。 */
  // eslint-disable-next-line no-unused-vars -- 回调参数名用于表达调用契约。
  readonly sessionPrincipalOf: (header: string | undefined) => string | null;
}

/**
 * 按路径与写读性质注册请求配额，逐路由在 `onRoute` 阶段决定，而不是在各路由注册器里各写一份。
 *
 * 判定分三类：
 * - 写入口：命令、票据、登录、运营动作与配置提交，这些路径会改世界状态或占用会话资源；
 * - 读入口：会话、内容、投影与执行回合快照，按会话数而非请求量增长；
 * - 豁免入口：健康检查与 WebSocket 升级，见 `isRateLimitExempt`。
 *
 * 阈值经 options.rateLimits 覆盖；缺省时给同一套保守默认值。
 * 显式写出而不是依赖隐藏默认值，避免改动后阈值突然变成 0 导致静默失效。
 */
export async function registerRateLimits(
  app: FastifyInstance,
  register: typeof rateLimit,
  input: RateLimitRegistrationInput,
): Promise<void> {
  const rateLimitFor = (method: string): number =>
    method === "GET" || method === "HEAD"
      ? (input.readLimit ?? 60)
      : (input.writeLimit ?? 10);
  app.addHook("onRoute", (route) => {
    // WebSocket 升级不是可重复的请求-响应，连接数由心跳与连接上限约束，不参与请求配额。
    if (route.websocket === true) {
      return;
    }
    if (!isRateLimitedRoute(route.url)) {
      return;
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const write = methods.some((method) => method !== "GET" && method !== "HEAD");
    route.config = {
      ...route.config,
      rateLimit: { max: rateLimitFor(write ? "POST" : "GET"), timeWindow: "10 seconds" },
    };
  });
  await app.register(register, {
    global: false,
    max: input.readLimit ?? 60,
    timeWindow: "10 seconds",
    keyGenerator: (request: FastifyRequest) => {
      // 已认证会话按主体分桶：同一主体持续请求会被限流，不同主体互不挤占。
      const principalId = input.sessionPrincipalOf(request.headers.authorization);
      if (principalId !== null) return `principal:${principalId}`;
      // 未认证来源共享同一个桶，且不按 Authorization 头或 IP 细分。
      // 若按凭据头分桶，请求方每次换一个无效令牌就能落到新计数器上，永远不被限流；
      // 若按 IP 分桶，同一个出口后的大量客户端会互相挤占。凭据本身从不进入键。
      return "unauthenticated";
    },
    errorResponseBuilder: (_request: FastifyRequest, context: { readonly ttl: number }) => ({
      // 与项目统一错误格式一致：429 走 budget-exhausted，并带 retryAfter 秒数。
      statusCode: 429,
      error: {
        code: "budget-exhausted",
        retryable: true,
        safeMessage: `请求过于频繁，请等待 ${Math.ceil(context.ttl / 1000)} 秒`,
        traceId: null,
        detailsArtifactRef: null,
      },
    }),
  });
}
