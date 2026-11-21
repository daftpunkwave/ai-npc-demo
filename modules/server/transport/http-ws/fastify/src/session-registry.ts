/**
 * 管理 WS 会话与一次性票据：登录、认证、注销、票据签发/消费、过期清理与容量上限。
 * 依赖注入的 ID/令牌生成与时钟；不持有连接、不发送消息，撤销会话时只回调宿主清理。
 * 禁止无限保留过期会话或未消费票据，也禁止在认证时改写票据状态。
 */
import type { IdPrefix } from "@ai-npc/contracts";
import type { StreamIdentity, StreamSession, StreamTicket } from "./stream-types";

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
}

/** 会话与票据的独立存储；所有撤销都经回调交给流中心做连接清理。 */
export class SessionRegistry {
  private readonly options: SessionRegistryOptions;
  private readonly sessions = new Map<string, StreamSession>();
  private readonly sessionById = new Map<string, StreamSession>();
  private readonly tickets = new Map<string, StreamTicket>();

  constructor(options: SessionRegistryOptions) {
    this.options = options;
  }

  /** 创建会话；到达上限时先撤销过期会话，再淘汰最早过期的会话。 */
  login(identity: StreamIdentity): StreamSession {
    if (this.sessions.size >= this.options.maxSessions) {
      this.evictSession();
    }
    const session: StreamSession = {
      sessionId: this.options.ids("ses"),
      auth: identity.auth,
      // 误报：token 的值来自运行时令牌生成器，不是硬编码令牌。
      // nosemgrep
      token: this.options.tokens("session"),
      expiresAt: this.options.now() + this.options.sessionTtlMs,
    };
    this.sessions.set(session.token, session);
    this.sessionById.set(session.sessionId, session);
    return session;
  }

  /** 按令牌读取仍有效的会话；过期时立即撤销并返回 null，分支取当前在线入口。 */
  authenticate(token: string): StreamSession | null {
    const session = this.sessions.get(token);
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
    const session = this.sessions.get(token);
    if (session !== undefined) {
      this.revokeSession(session.sessionId, "logged out");
    }
  }

  /** 签发一次性 WS 票据；未消费票据在过期后由清理路径删除。 */
  issueTicket(sessionId: string): { readonly ticket: string; readonly expiresAt: number } {
    if (this.tickets.size >= this.options.maxTickets) {
      this.evictTicket();
    }
    const ticket = this.options.tokens("ticket");
    const expiresAt = this.options.now() + this.options.ticketTtlMs;
    this.tickets.set(ticket, { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  /** 消费票据：无论后续校验是否通过都不再可用；未命中返回 undefined。 */
  takeTicket(value: string | undefined): StreamTicket | undefined {
    if (value === undefined) {
      return undefined;
    }
    const ticket = this.tickets.get(value);
    this.tickets.delete(value);
    return ticket;
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
    for (const [ticketValue, ticket] of [...this.tickets]) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(ticketValue);
      }
    }
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  ticketCount(): number {
    return this.tickets.size;
  }

  /** 关闭清理：丢弃全部会话与票据，不再回调流中心。 */
  clear(): void {
    this.sessions.clear();
    this.sessionById.clear();
    this.tickets.clear();
  }

  private revokeSession(sessionId: string, reason: string): void {
    const session = this.sessionById.get(sessionId);
    if (session === undefined) {
      return;
    }
    this.sessionById.delete(sessionId);
    if (this.sessions.get(session.token) === session) {
      this.sessions.delete(session.token);
    }
    for (const [ticketValue, ticket] of [...this.tickets]) {
      if (ticket.sessionId === sessionId) {
        this.tickets.delete(ticketValue);
      }
    }
    this.options.onSessionRevoked(sessionId, reason);
  }

  private evictSession(): void {
    let victim: StreamSession | undefined;
    for (const session of this.sessionById.values()) {
      if (session.expiresAt <= this.options.now()) {
        this.revokeSession(session.sessionId, "session expired");
        return;
      }
      if (victim === undefined || session.expiresAt < victim.expiresAt) {
        victim = session;
      }
    }
    if (victim !== undefined) {
      this.revokeSession(victim.sessionId, "session capacity evicted");
    }
  }

  private evictTicket(): void {
    let victim: string | undefined;
    let victimExpiresAt = Number.POSITIVE_INFINITY;
    for (const [ticketValue, ticket] of this.tickets) {
      if (ticket.expiresAt <= this.options.now()) {
        this.tickets.delete(ticketValue);
        return;
      }
      if (ticket.expiresAt < victimExpiresAt) {
        victim = ticketValue;
        victimExpiresAt = ticket.expiresAt;
      }
    }
    if (victim !== undefined) {
      this.tickets.delete(victim);
    }
  }
}
