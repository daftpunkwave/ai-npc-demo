/**
 * 验证流中心在投影读取失败时向上抛出，不吞错也不静默跳过发布；注入 tracer 时为每次发布计时。
 * 依赖 StreamHub、注入的假投影与记录型 tracer；不建立真实 WS 连接。
 * 禁止在本文件复现投影 schema 或依赖连接建立流程。
 */
import { describe, expect, it } from "vitest";
import type { HostTracer, PlayerProjection } from "@world-prism/contracts";
import { playerPublishSpan, StreamHub } from "../src/stream-hub";
import type { StreamHubOptions } from "../src/stream-types";

/** 构造最小可用的流中心选项；投影由调用方注入。 */
function hubOptions(projection: () => PlayerProjection): StreamHubOptions {
  return {
    projection,
    worldId: "wld-000000000001",
    channelsFor: () => [],
    ids: (prefix) => `${prefix}-000000000001`,
    tokens: (kind) => `${kind}-token`,
    now: () => 0,
  };
}

/** 增量计算只遍历会话与提醒两个数组；最小投影保证数组字段存在。 */
function minimalProjection(): PlayerProjection {
  return { conversations: [], notifications: [] } as unknown as PlayerProjection;
}

describe("流中心投影异常传播", () => {
  it("投影读取失败时 publish 向上抛出而不是静默返回", () => {
    let calls = 0;
    const hub = new StreamHub(
      hubOptions(() => {
        calls += 1;
        if (calls > 1) {
          throw new Error("projection unavailable");
        }
        return minimalProjection();
      }),
    );
    expect(() => hub.publish()).toThrow("projection unavailable");
  });

  it("投影正常时 publish 推进序号并返回真值", () => {
    const hub = new StreamHub(hubOptions(() => minimalProjection()));
    expect(hub.publish()).toBe(true);
    expect(hub.streamState().streamSeq).toBeGreaterThan(0);
  });
});

/** 记录型 tracer：用共享的可控时钟为每个 span 计时，按完成顺序记录名称、耗时与是否失败。 */
function recordingTracer(clock: { now: number }): {
  readonly tracer: HostTracer;
  readonly spans: Array<{ readonly name: string; readonly elapsed: number; readonly failed: boolean }>;
} {
  const spans: Array<{ readonly name: string; readonly elapsed: number; readonly failed: boolean }> = [];
  return {
    spans,
    tracer: {
      span: (name, _attrs, fn) => {
        const startedAt = clock.now;
        let failed = true;
        try {
          const result = fn();
          failed = false;
          return result;
        } finally {
          spans.push({ name, elapsed: clock.now - startedAt, failed });
        }
      },
    },
  };
}

describe("流中心发布计时", () => {
  it("注入 tracer 时以发布 span 包住整次发布，投影构建耗时计入其中", () => {
    const clock = { now: 0 };
    const { tracer, spans } = recordingTracer(clock);
    let builds = 0;
    const hub = new StreamHub({
      ...hubOptions(() => {
        builds += 1;
        // 每次构建推进 5 ms；发布内部的构建必须落在发布 span 的计时区间内。
        clock.now += 5;
        return minimalProjection();
      }),
      tracer,
    });
    const buildsBefore = builds;
    expect(hub.publish()).toBe(true);
    expect(builds - buildsBefore).toBe(1);
    expect(spans).toEqual([{ name: playerPublishSpan, elapsed: 5, failed: false }]);
  });

  it("发布失败时 span 记为失败并把原错误抛给调用方", () => {
    const clock = { now: 0 };
    const { tracer, spans } = recordingTracer(clock);
    let calls = 0;
    const hub = new StreamHub({
      ...hubOptions(() => {
        calls += 1;
        if (calls > 1) {
          clock.now += 2;
          throw new Error("projection unavailable");
        }
        return minimalProjection();
      }),
      tracer,
    });
    expect(() => hub.publish()).toThrow("projection unavailable");
    expect(spans).toEqual([{ name: playerPublishSpan, elapsed: 2, failed: true }]);
  });

  it("未注入 tracer 时照常发布，不需要任何计时设施", () => {
    const hub = new StreamHub(hubOptions(() => minimalProjection()));
    expect(hub.publish()).toBe(true);
    expect(hub.publish()).toBe(true);
    expect(hub.streamState().streamSeq).toBeGreaterThanOrEqual(2);
  });
});
