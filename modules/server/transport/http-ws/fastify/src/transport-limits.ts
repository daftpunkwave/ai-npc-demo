/**
 * 核心职责：声明 HTTP 传输层的框架无关上限（请求、连接、帧与请求体），
 * 并提供两个框架级错误分类：WS 帧超限与 handler 请求超时。
 * 交互契约：上限以常量导出供应用装配与测试共同引用；分类函数只按稳定错误码判定，不匹配文案。
 * 约束与禁忌：不在此注册插件、路由或处理器，也不读取配置与环境变量。
 */

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
   * 连接在该时长内没有任何读写活动即被关闭。它不约束「收齐请求头」——
   * 那由 Node 的 `headersTimeout` 管辖且 Fastify 未暴露为选项，本服务沿用其默认值。
   * 此处取值目的是让停在半开状态上的连接最终被回收。
   */
  connectionTimeoutMs: 30_000,
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
