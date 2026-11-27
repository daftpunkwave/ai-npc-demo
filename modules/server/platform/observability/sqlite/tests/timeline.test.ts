/**
 * 核心职责：校验时间线把筛选、排序与真实 limit 交给数据源查询，并把领域事件与生命周期事件按时间合并截取。
 * 交互契约：依赖进程内数据源端口记录查询参数；存储端口不可访问，证明时间线不直接读表。
 * 约束与禁忌：不打开 SQLite 或读取生产数据；筛选在数据源查询内的行为由数据所有者一侧的测试覆盖。
 */
import { describe, expect, it } from "vitest";
import type { DomainEventTimelineQuery, ObservedDomainEvent, TimelineFilter } from "@world-prism/module-sdk";
import { ObservabilityPort } from "../src/plugin";
import { fakeSources, inaccessibleStorage } from "./fake-sources";

const branchId = "br-000000000001";

function domainEvent(): ObservedDomainEvent {
  return {
    worldSeq: 40,
    worldTick: 4,
    eventId: "evt-000000000040",
    type: "late.event",
    principalId: "human-independent",
    audience: { kind: "public" },
    payload: { agentId: "human-independent", nodeId: "node-gate" },
    correlationId: "corr-000000000040",
    committedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("ObservabilityPort timeline", () => {
  it("把类型、主体、节点筛选与最新优先交给数据源，并以截断后的 limit 查询", () => {
    const domainQueries: DomainEventTimelineQuery[] = [];
    const lifecycleQueries: TimelineFilter[] = [];
    const sources = fakeSources({
      domainEventTimeline: (query) => {
        domainQueries.push(query);
        return [domainEvent()];
      },
      lifecycleTimeline: (query) => {
        lifecycleQueries.push(query);
        return [];
      },
    });
    const port = new ObservabilityPort(inaccessibleStorage(), { timelineLimit: 5 });
    port.bind(sources);

    const response = port.timeline({
      branchId,
      fromSeq: 7,
      limit: 10,
      order: "desc",
      types: ["late.event"],
      agentId: "human-independent",
      nodeId: "node-gate",
    });

    const filter = {
      branchId,
      limit: 5,
      order: "desc",
      types: ["late.event"],
      involving: "human-independent",
      mentioning: "node-gate",
    };
    expect(domainQueries).toEqual([{ ...filter, afterSeq: 7 }]);
    expect(lifecycleQueries).toEqual([filter]);
    expect(sources.reads()).toBe(1);
    expect(response.events).toEqual([{
      kind: "domain",
      worldSeq: 40,
      worldTick: 4,
      eventId: "evt-000000000040",
      type: "late.event",
      principalId: "human-independent",
      audience: { kind: "public" },
      summaryZh: "late.event · human-independent",
      payload: { agentId: "human-independent", nodeId: "node-gate" },
      correlationId: "corr-000000000040",
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
  });

  it("生命周期事件与领域事件统一按时间排序后截取，系统事件以「系统」标注主体", () => {
    const sources = fakeSources({
      domainEventTimeline: () => [domainEvent()],
      lifecycleTimeline: () => [
        {
          seq: 2,
          type: "AgentActivated",
          subjectId: "human-independent",
          payload: {},
          createdAt: "2026-01-01T00:00:20.000Z",
        },
        { seq: 3, type: "ModuleStarted", subjectId: null, payload: {}, createdAt: "2026-01-01T00:00:10.000Z" },
      ],
    });
    const port = new ObservabilityPort(inaccessibleStorage(), { timelineLimit: 200 });
    port.bind(sources);

    const latestFirst = port.timeline({ branchId, fromSeq: 0, limit: 2, order: "desc" });
    expect(latestFirst.events.map(({ kind, type, summaryZh }) => ({ kind, type, summaryZh }))).toEqual([
      { kind: "lifecycle", type: "AgentActivated", summaryZh: "AgentActivated · human-independent" },
      { kind: "lifecycle", type: "ModuleStarted", summaryZh: "ModuleStarted · 系统" },
    ]);
    const oldestFirst = port.timeline({ branchId, fromSeq: 0, limit: 1, order: "asc" });
    expect(oldestFirst.events).toEqual([expect.objectContaining({ kind: "domain", worldSeq: 40 })]);
  });

  it("数据源尚未绑定时以 not-ready 拒绝，而不是返回空时间线", () => {
    const port = new ObservabilityPort(inaccessibleStorage(), { timelineLimit: 200 });
    expect(() => port.timeline({ branchId, fromSeq: 0, limit: 10 }))
      .toThrow(expect.objectContaining({ code: "not-ready" }));
  });
});
