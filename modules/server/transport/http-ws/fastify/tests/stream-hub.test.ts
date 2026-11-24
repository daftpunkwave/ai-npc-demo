/**
 * 验证流中心在投影读取失败时向上抛出，不吞错也不静默跳过发布。
 * 依赖 StreamHub 与注入的假投影；不建立真实 WS 连接。
 * 禁止在本文件复现投影 schema 或依赖连接建立流程。
 */
import { describe, expect, it } from "vitest";
import type { PlayerProjection } from "@ai-npc/contracts";
import { StreamHub } from "../src/stream-hub";
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
