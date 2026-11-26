/**
 * 管理 WS 会话与一次性票据：登录、认证、注销、票据签发/消费、过期清理与容量上限。
 * 依赖注入的 ID/令牌生成、时钟与活动连接查询；不持有连接、不发送消息，撤销会话时只回调宿主清理。
 * 禁止无限保留过期会话或未消费票据，禁止在认证时改写票据状态，也禁止为腾位驱逐有活动连接的会话。
 */
import { DomainError, type IdPrefix } from "@world-prism/contracts";
import type { StreamIdentity, StreamSession, StreamTicket } from "./stream-types";
import { timingSafeTokenEquals, tokenDigest } from "./timing-safe-token";

export interface SessionRegistryOptions {
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  readonly ids: (prefix: IdPrefix) => string;
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  readonly tokens: (kind: "session" | "ticket") => string;
  readonly now: () => number;
  readonly sessionTtlMs: number;
  readonly ticketTtlMs: number;
  readonly maxSessions: number;
  readonly maxTickets: number;
  /** 当前在线分支；认证返回的会话据此刷新 auth.branchId。 */
  readonly currentBranchId: () => string;
  /** 会话被撤销（过期、注销或容量淘汰）时通知流中心关闭连接并清理缓冲。 */
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  readonly onSessionRevoked: (sessionId: string, reason: string) => void;
  /** 会话是否有活动 WS 连接；容量淘汰只考虑没有活动连接的会话。 */
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  readonly hasActiveConnection: (sessionId: string) => boolean;
}

/** 票据索引项：摘要键只用于定位候选，原始令牌用于命中判定。 */
interface TicketEntry {
  readonly token: string;
  readonly ticket: StreamTicket;
}

/**
 * 会话与票据的独立存储；所有撤销都经回调交给流中心做连接清理。
 * 会话与票据以 SHA-256 摘要为索引键，避免未认证请求用任意令牌触发全表扫描；
 * 摘要只负责定位候选，命中与否仍由原始令牌的常量时间比较决定。
 */
export class SessionRegistry {
  private readonly options: SessionRegistryOptions;
  private readonly sessionsByDigest = new Map<string, StreamSession>();
  private readonly sessionById = new Map<string, StreamSession>();
  private readonly ticketsByDigest = new Map<string, TicketEntry>();

  constructor(options: SessionRegistryOptions) {
    this.options = options;
  }

  /**
   * 创建会话；容量不足时先清理过期会话，再淘汰无活动连接中最早过期的会话。
   * 全部会话仍保持活动连接时以 budget-exhausted 拒绝新会话，不驱逐活跃会话。
   */
  login(identity: StreamIdentity): StreamSession {
    if (this.sessionsByDigest.size >= this.options.maxSessions) {
      this.ensureSessionCapacity();
    }
    const session: StreamSession = {
      sessionId: this.options.ids("ses"),
      auth: identity.auth,
      // 误报：token 的值来自运行时令牌生成器，不是硬编码令牌。
      // nosemgrep
      token: this.options.tokens("session"),
      expiresAt: this.options.now() + this.options.sessionTtlMs,
    };
    this.sessionsByDigest.set(tokenDigest(session.token), session);
    this.sessionById.set(session.sessionId, session);
    return session;
  }

  /** 按令牌读取仍有效的会话；过期时立即撤销并返回 null，分支取当前在线入口。 */
  authenticate(token: string): StreamSession | null {
    const session = this.findSessionByToken(token);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= this.options.now()) {
      this.revokeSession(session.sessionId, "session expired");
      return null;
    }
    return { ...session, auth: { ...session.auth, branchId: this.options.currentBranchId() } };
  }

  /** 注销令牌对应的会话；缺失、重复注销都保持幂等。 */
  logout(token: string): void {
    const session = this.findSessionByToken(token);
    if (session !== undefined) {
      this.revokeSession(session.sessionId, "logged out");
    }
  }

  /** 签发一次性 WS 票据；未消费票据在过期后由清理路径删除。 */
  issueTicket(sessionId: string): { readonly ticket: string; readonly expiresAt: number } {
    if (this.ticketsByDigest.size >= this.options.maxTickets) {
      this.evictTicket();
    }
    const ticket = this.options.tokens("ticket");
    const expiresAt = this.options.now() + this.options.ticketTtlMs;
    this.ticketsByDigest.set(tokenDigest(ticket), {
      token: ticket,
      ticket: { sessionId, expiresAt },
    });
    return { ticket, expiresAt };
  }

  /** 消费票据：无论后续校验是否通过都不再可用；未命中返回 undefined。 */
  takeTicket(value: string | undefined): StreamTicket | undefined {
    if (value === undefined) {
      return undefined;
    }
    const digest = tokenDigest(value);
    const entry = this.ticketsByDigest.get(digest);
    if (entry === undefined || !timingSafeTokenEquals(entry.token, value)) {
      return undefined;
    }
    this.ticketsByDigest.delete(digest);
    return entry.ticket;
  }

  /** 读取仍有效的会话；过期时撤销并返回 null。 */
  activeSession(sessionId: string): StreamSession | null {
    const session = this.sessionById.get(sessionId);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= this.options.now()) {
      this.revokeSession(sessionId, "session expired");
      return null;
    }
    return session;
  }

  /** 清理过期会话与票据；连接与重放缓冲由流中心另行清理。 */
  sweep(now: number): void {
    for (const session of [...this.sessionById.values()]) {
      if (session.expiresAt <= now) {
        this.revokeSession(session.sessionId, "session expired");
      }
    }
    for (const [digest, entry] of [...this.ticketsByDigest]) {
      if (entry.ticket.expiresAt <= now) {
        this.ticketsByDigest.delete(digest);
      }
    }
  }

  sessionCount(): number {
    return this.sessionsByDigest.size;
  }

  ticketCount(): number {
    return this.ticketsByDigest.size;
  }

  /** 关闭清理：丢弃全部会话与票据，不再回调流中心。 */
  clear(): void {
    this.sessionsByDigest.clear();
    this.sessionById.clear();
    this.ticketsByDigest.clear();
  }

  private revokeSession(sessionId: string, reason: string): void {
    const session = this.sessionById.get(sessionId);
    if (session === undefined) {
      return;
    }
    this.sessionById.delete(sessionId);
    const digest = tokenDigest(session.token);
    if (this.sessionsByDigest.get(digest) === session) {
      this.sessionsByDigest.delete(digest);
    }
    for (const [ticketDigest, entry] of [...this.ticketsByDigest]) {
      if (entry.ticket.sessionId === sessionId) {
        this.ticketsByDigest.delete(ticketDigest);
      }
    }
    this.options.onSessionRevoked(sessionId, reason);
  }

  /** 先用摘要定位候选，再对原始令牌做常量时间比较；摘要碰撞不能冒充合法令牌。 */
  private findSessionByToken(token: string): StreamSession | undefined {
    const session = this.sessionsByDigest.get(tokenDigest(token));
    if (session === undefined || !timingSafeTokenEquals(session.token, token)) {
      return undefined;
    }
    return session;
  }

  /**
   * 容量不足时按“过期 → 无活动连接中最早过期”的顺序腾位。
   * 全部会话仍有活动连接时以 budget-exhausted 拒绝：该码表达容量配额耗尽，
   * retryable 表示等待会话过期或注销后可以重试，响应由传输层统一映射为 429。
   */
  private ensureSessionCapacity(): void {
    for (const session of [...this.sessionById.values()]) {
      if (session.expiresAt <= this.options.now()) {
        this.revokeSession(session.sessionId, "session expired");
      }
    }
    if (this.sessionsByDigest.size < this.options.maxSessions) {
      return;
    }
    let victim: StreamSession | undefined;
    for (const session of this.sessionById.values()) {
      if (this.options.hasActiveConnection(session.sessionId)) {
        continue;
      }
      if (victim === undefined || session.expiresAt < victim.expiresAt) {
        victim = session;
      }
    }
    if (victim !== undefined) {
      this.revokeSession(victim.sessionId, "session capacity evicted");
      return;
    }
    throw new DomainError("budget-exhausted", "会话容量已满", { retryable: true });
  }

  private evictTicket(): void {
    let victim: string | undefined;
    let victimExpiresAt = Number.POSITIVE_INFINITY;
    for (const [digest, entry] of this.ticketsByDigest) {
      if (entry.ticket.expiresAt <= this.options.now()) {
        this.ticketsByDigest.delete(digest);
        return;
      }
      if (entry.ticket.expiresAt < victimExpiresAt) {
        victim = digest;
        victimExpiresAt = entry.ticket.expiresAt;
      }
    }
    if (victim !== undefined) {
      this.ticketsByDigest.delete(victim);
    }
  }
}
