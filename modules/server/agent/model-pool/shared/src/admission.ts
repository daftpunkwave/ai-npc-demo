/**
 * 为整个模型池调度有界候选队列，按用途份额和主体轮转。
 * 依赖单调时钟，按模型并发和账号的 60 秒滑动窗口预留。
 * 不持久化模型消息，不绕过 deadline、取消或控制权 fencing。
 */
import { DomainError, type HostServices } from "@ai-npc/contracts";
import type { ModelRoute, ModelWorkScope } from "@ai-npc/module-sdk";

type Group = "interactive" | "maintenance" | "evaluation";
type Request = {
  readonly scope: ModelWorkScope;
  readonly route: ModelRoute;
  readonly tokens: number;
};
type Waiting = Request & {
  readonly group: Group;
  readonly resolve: (release: (sent: boolean) => void) => void;
  readonly reject: (error: unknown) => void;
};
type Debit = { readonly time: number; readonly tokens: number };

const shares: readonly Group[] = [
  "interactive", "interactive", "maintenance", "interactive", "interactive",
  "maintenance", "interactive", "interactive", "interactive", "evaluation",
];
const windowMs = 60_000;

export function currentWork(scope: ModelWorkScope): boolean {
  return !scope.signal.aborted && scope.fence();
}

export function backpressure(): DomainError {
  return new DomainError("provider-failed", "模型队列在截止前无法接纳调用", { details: { kind: "backpressure" } });
}

function groupFor(purpose: ModelRoute["purpose"]): Group {
  if (purpose === "evaluation") return "evaluation";
  return purpose === "decision" || purpose === "speech" ? "interactive" : "maintenance";
}

export class ModelAdmission {
  private readonly queue = new Set<Waiting>();
  private readonly active = new Map<string, number>();
  private readonly accounts = new Map<string, Set<Debit>>();
  private readonly waitingAgents = new Map<Group, Set<string>>();
  private slot = 0;
  private alarm: AbortController | null = null;

  constructor(private readonly host: HostServices) {}

  acquire(request: Request): Promise<(sent: boolean) => void> {
    if (this.queue.size >= 200 || request.tokens > request.route.tokensPerMinute) return Promise.reject(backpressure());
    return new Promise((resolve, reject) => {
      const signal = request.scope.signal;
      const onAbort = () => this.pump();
      const removeListener = () => signal.removeEventListener("abort", onAbort);
      const group = groupFor(request.route.purpose);
      const agents = this.waitingAgents.get(group) ?? new Set<string>();
      agents.add(request.scope.agentId);
      this.waitingAgents.set(group, agents);
      this.queue.add({
        ...request,
        group,
        resolve: (release) => { removeListener(); resolve(release); },
        reject: (error) => { removeListener(); reject(error); },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    this.alarm?.abort();
    this.alarm = null;
    const now = this.host.monotonicMs();
    for (const [key, debits] of this.accounts) {
      for (const debit of debits) if (debit.time <= now - windowMs) debits.delete(debit);
      if (debits.size === 0) this.accounts.delete(key);
    }
    for (const item of this.queue) {
      try {
        if (!currentWork(item.scope)) throw new DomainError("cancelled", "模型调用的工作租约已失效");
        if (item.scope.deadlineMs <= now) throw backpressure();
      } catch (error) {
        this.remove(item, false);
        item.reject(error);
      }
    }
    while (this.queue.size > 0) {
      const item = this.next(now);
      if (item === undefined) break;
      this.remove(item, true);
      this.start(item, now);
    }
    if (this.queue.size === 0) return;
    let wake = Math.min(...[...this.queue].map(({ scope }) => scope.deadlineMs));
    for (const { route } of this.queue) {
      const oldest = this.accounts.get(route.rateLimitKey)?.values().next().value;
      if (oldest !== undefined) wake = Math.min(wake, oldest.time + windowMs);
    }
    const alarm = new AbortController();
    this.alarm = alarm;
    void this.host.sleep(Math.max(1, wake - now), alarm.signal).then(() => this.pump(), (error: unknown) => {
      if (alarm.signal.aborted) return;
      this.host.logger.error("模型队列等待失败", { error: error instanceof Error ? error.name : "unknown" });
      for (const item of this.queue) item.reject(backpressure());
      this.queue.clear();
      this.waitingAgents.clear();
    });
  }

  // 准入成功时先把主体移出组内等待集合，其余请求仍在队列时再重新加入，使其排到该组轮转末尾，
  // 避免同一主体的并发请求连续占据份额名额；拒绝路径不改变位置，仅清理已无剩余请求的主体。
  private remove(item: Waiting, admitted: boolean): void {
    this.queue.delete(item);
    const agents = this.waitingAgents.get(item.group);
    if (agents === undefined) return;
    const { agentId } = item.scope;
    const stillWaiting = [...this.queue].some((entry) => entry.group === item.group && entry.scope.agentId === agentId);
    if (!stillWaiting || admitted) agents.delete(agentId);
    if (stillWaiting && admitted) agents.add(agentId);
    if (agents.size === 0) this.waitingAgents.delete(item.group);
  }

  private next(now: number): Waiting | undefined {
    const groups = [...shares.slice(this.slot), ...shares.slice(0, this.slot)];
    for (const [offset, group] of groups.entries()) {
      const agents = this.waitingAgents.get(group);
      if (agents === undefined) continue;
      const candidates = new Map<string, Waiting>();
      for (const item of this.queue) {
        const { agentId } = item.scope;
        if (item.group === group && !candidates.has(agentId) && this.fits(item, now)) candidates.set(agentId, item);
      }
      for (const agentId of agents) {
        const item = candidates.get(agentId);
        if (item === undefined) continue;
        this.slot = (this.slot + offset + 1) % shares.length;
        return item;
      }
    }
    return undefined;
  }

  private fits({ scope, route, tokens }: Request, now: number): boolean {
    if (scope.deadlineMs - now < route.requestTimeoutMs / 2 ||
      (this.active.get(route.modelId) ?? 0) >= route.maxConcurrent) return false;
    const debits = this.accounts.get(route.rateLimitKey);
    return debits === undefined || (debits.size < route.requestsPerMinute &&
      [...debits].reduce((sum, debit) => sum + debit.tokens, tokens) <= route.tokensPerMinute);
  }

  private start(item: Waiting, now: number): void {
    const { modelId, rateLimitKey } = item.route;
    this.active.set(modelId, (this.active.get(modelId) ?? 0) + 1);
    const debit = { time: now, tokens: item.tokens };
    const debits = this.accounts.get(rateLimitKey) ?? new Set<Debit>();
    debits.add(debit);
    this.accounts.set(rateLimitKey, debits);
    item.resolve((sent) => {
      const count = (this.active.get(modelId) ?? 1) - 1;
      if (count === 0) this.active.delete(modelId);
      else this.active.set(modelId, count);
      if (!sent) debits.delete(debit);
      this.pump();
    });
  }
}
