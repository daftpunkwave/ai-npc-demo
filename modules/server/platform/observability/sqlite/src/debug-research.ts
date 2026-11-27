/**
 * 核心职责：实现研究控制台的分支事件差异与调试队列摘要。
 * 交互契约：经数据源端口读取领域事件、调度计数、进行中的模型尝试与记忆整理任务；只读。
 * 约束与禁忌：不发模型请求、不执行审计重放、不修改世界事实。
 */
import {
  branchCompareResponseSchema,
  canonicalJson,
  debugQueuesResponseSchema,
  type BranchCompareResponse,
  type DebugQueuesResponse,
} from "@world-prism/contracts";
import type { ObservabilitySources, ObservedDomainEvent } from "@world-prism/module-sdk";

function branchEvent(event: ObservedDomainEvent | undefined) {
  if (event === undefined) return null;
  return { type: event.type, payload: event.payload, principalId: event.principalId };
}

function oldest(values: readonly string[]): string | null {
  return values.length === 0 ? null : values.reduce((left, right) => left < right ? left : right);
}

export function compareBranchEvents(
  sources: ObservabilitySources,
  left: string,
  right: string,
  atSeq: number,
): BranchCompareResponse {
  const { leftEvents, rightEvents } = sources.read((reader) => ({
    leftEvents: reader.domainEventsAfter(left, atSeq),
    rightEvents: reader.domainEventsAfter(right, atSeq),
  }));
  const leftBySeq = new Map(leftEvents.map((event) => [event.worldSeq, event]));
  const rightBySeq = new Map(rightEvents.map((event) => [event.worldSeq, event]));
  const keys = [...new Set([...leftBySeq.keys(), ...rightBySeq.keys()])].sort((a, b) => a - b);
  const differences = keys.flatMap((seq) => {
    const leftEvent = branchEvent(leftBySeq.get(seq));
    const rightEvent = branchEvent(rightBySeq.get(seq));
    if (canonicalJson(leftEvent) === canonicalJson(rightEvent)) return [];
    return [{ kind: "event" as const, key: String(seq), left: leftEvent, right: rightEvent }];
  });
  return branchCompareResponseSchema.parse({ left, right, atSeq, differences });
}

export function readDebugQueues(sources: ObservabilitySources, branchId: string): DebugQueuesResponse {
  return sources.read((reader) => {
    const queue = reader.schedulerQueue(branchId);
    const startedAttempts = reader.startedModelAttemptTimes(branchId);
    const tasks = reader.pendingMaintenance(branchId);
    return debugQueuesResponseSchema.parse({
      scheduler: { queued: queue.queued, running: queue.running, oldestAt: null },
      modelPool: { queued: null, running: startedAttempts.length, oldestAt: oldest(startedAttempts) },
      maintenance: {
        queued: tasks.filter((task) => task.status === "queued").length,
        running: tasks.filter((task) => task.status === "leased").length,
        oldestAt: oldest(tasks.map((task) => task.createdAt)),
      },
    });
  });
}
