/**
 * 校验玩家投影 reducer 的快照、连续增量、断档重取与重复对白抑制。
 * 依赖公共 fixture、内存状态与投影 store；不启动网络或服务端。
 * 禁止把缺口后的旧增量继续套用，或让重复 append 改写投影版本。
 */
import { describe, expect, it } from "vitest";
import {
  playerProjectionSchema,
  serverStreamMessageSchema,
  type PlayerProjection,
  type StreamDeltaMessage,
  type StreamSnapshotMessage,
} from "@ai-npc/contracts";
import { ProjectionStore } from "../src";

function projection(): PlayerProjection {
  return {
    campaign: null,
    clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
    map: { nodes: [], roads: [] },
    meters: null,
    stockpiles: [],
    teams: [],
    characters: [],
    tasks: [],
    agreements: [],
    invitations: [],
    conversations: [],
    inbox: [],
    notebook: [],
    awaitingReplyFrom: [],
    notifications: [],
  };
}

function projectionAtTick(worldTick: number): PlayerProjection {
  const value = projection();
  return {
    ...value,
    clock: { ...value.clock, worldTick },
  };
}

function snapshot(streamSeq: number, branchId = "br-000000000001"): StreamSnapshotMessage {
  return {
    type: "snapshot",
    channel: "player",
    streamSeq,
    projectionVersion: streamSeq,
    worldId: "wld-000000000001",
    branchId,
    data: projection(),
  };
}

function delta(streamSeq: number, tick: number): StreamDeltaMessage {
  return {
    type: "delta",
    channel: "player",
    streamSeq,
    projectionVersion: streamSeq,
    set: { clock: { worldTick: tick, day: 1, hour: tick, mode: "running", runVersion: streamSeq } },
  };
}

describe("ProjectionStore", () => {
  it("应用快照后合并连续增量", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(4));
    expect(store.applyDelta(delta(5, 1)).needsSnapshot).toBe(false);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(1);
    expect(store.streamSeq).toBe(5);
  });

  it("序号缺口要求重新取快照且不应用增量", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(2));
    const result = store.applyDelta(delta(4, 4));
    expect(result.needsSnapshot).toBe(true);
    expect(store.streamSeq).toBe(2);
    expect(store.needsSnapshot()).toBe(true);
  });

  it("较旧的 REST 快照不会覆盖较新的 WS 增量", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(6));
    store.applyDelta(delta(7, 7));

    const stale = store.replaceSnapshot({
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      streamSeq: 6,
      projectionVersion: 6,
      projection: projection(),
    });

    expect(stale).toMatchObject({ changed: false, needsSnapshot: false });
    expect(store.streamSeq).toBe(7);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(7);
  });

  it("较旧的 WS 快照不会回退当前游标", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(8));
    store.applyDelta(delta(9, 9));

    const stale = store.applySnapshot(snapshot(8));

    expect(stale).toMatchObject({ changed: false, needsSnapshot: false });
    expect(store.streamSeq).toBe(9);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(9);
  });

  it("同一流序号下较旧的投影版本不会覆盖当前状态", () => {
    const store = new ProjectionStore();
    store.applySnapshot({ ...snapshot(8), projectionVersion: 8, data: projectionAtTick(8) });

    const stale = store.applySnapshot({ ...snapshot(8), projectionVersion: 7, data: projectionAtTick(7) });

    expect(stale).toMatchObject({ changed: false, needsSnapshot: false });
    expect(store.getSnapshot()?.projectionVersion).toBe(8);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(8);
  });

  it("恢复或重开后的新分支快照被接受并切换本地分支", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(3));

    // 恢复/重开后在线分支变化，服务端重发的快照携带新身份；新分支流序号从 0 重新计数，
    // 因此不能用旧分支的序号比较把它判成迟到帧。
    const switched = store.applySnapshot({
      ...snapshot(0, "br-000000000002"),
      data: projectionAtTick(0),
    });

    expect(switched).toMatchObject({ changed: true, needsSnapshot: false });
    expect(store.getSnapshot()?.branchId).toBe("br-000000000002");
    expect(store.streamSeq).toBe(0);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(0);
  });

  it("不同世界的快照不会覆盖当前状态", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(3));

    const otherWorld = store.applySnapshot({
      ...snapshot(4, "br-000000000002"),
      worldId: "wld-000000000002",
    });

    expect(otherWorld.changed).toBe(false);
    expect(store.getSnapshot()?.worldId).toBe("wld-000000000001");
    expect(store.getSnapshot()?.branchId).toBe("br-000000000001");
  });

  it("同一分支上较旧的 REST 快照仍被拒绝", () => {
    const store = new ProjectionStore();
    store.applySnapshot({ ...snapshot(3), data: projectionAtTick(3) });

    const stale = store.replaceSnapshot({
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      streamSeq: 2,
      projectionVersion: 2,
      projection: projectionAtTick(2),
    });

    expect(stale).toMatchObject({ changed: false, needsSnapshot: false });
    expect(store.getSnapshot()?.branchId).toBe("br-000000000001");
    expect(store.streamSeq).toBe(3);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(3);
  });

  it("REST 替换快照接受新分支并切换本地身份", () => {
    const store = new ProjectionStore();
    store.applySnapshot({ ...snapshot(3), data: projectionAtTick(3) });

    const switched = store.replaceSnapshot({
      worldId: "wld-000000000001",
      branchId: "br-000000000002",
      streamSeq: 0,
      projectionVersion: 0,
      projection: projectionAtTick(0),
    });

    expect(switched).toMatchObject({ changed: true, needsSnapshot: false });
    expect(store.getSnapshot()?.branchId).toBe("br-000000000002");
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(0);
  });

  it("增量补丁里的显式 undefined 不覆盖必填字段", () => {
    const store = new ProjectionStore();
    store.applySnapshot({ ...snapshot(1), data: projectionAtTick(3) });

    // partial 会接受显式 undefined，若直接合并会把 clock 覆盖成 undefined。
    store.applyDelta({
      ...delta(2, 4),
      set: { clock: undefined } as unknown as StreamDeltaMessage["set"],
    });

    const projection = store.getSnapshot()?.projection;
    expect(projection?.clock).toBeDefined();
    expect(projection?.clock.worldTick).toBe(3);
    // 合并结果仍满足完整契约，没有被 undefined 破坏。
    expect(playerProjectionSchema.safeParse(projection).success).toBe(true);
  });

  it("append 的 item 入库时与调用方对象隔离", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1));
    const line = {
      seq: 0,
      dialogueId: "dlg-000000000001",
      speakerId: "player-1",
      speakerName: "党魁",
      text: "你好",
      worldTick: 0,
      channel: "face-to-face" as const,
    };

    store.applyAppend({
      type: "append",
      channel: "player",
      streamSeq: 2,
      kind: "dialogue",
      item: line,
    });
    // 调用方事后改动同一个对象，已提交的投影不得跟着变。
    line.text = "被改写的文本";

    expect(store.getSnapshot()?.projection.conversations[0]?.text).toBe("你好");
  });

  it("重复对白 append 不重复写入", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1));
    const message = {
      type: "append" as const,
      channel: "player" as const,
      streamSeq: 2,
      kind: "dialogue" as const,
      item: {
        seq: 0,
        dialogueId: "dlg-000000000001",
        speakerId: "player-1",
        speakerName: "党魁",
        text: "你好",
        worldTick: 0,
        channel: "face-to-face" as const,
      },
    };
    store.applyAppend(message);
    store.applyAppend(message);
    expect(store.getSnapshot()?.projection.conversations).toHaveLength(1);
  });

  it("增量只校验补丁本身：拒绝未知顶层字段与非法的补丁值", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1));

    // strict partial 仍拒绝未在投影契约中声明的顶层字段。
    expect(() =>
      store.applyDelta({
        ...delta(2, 1),
        set: { unknownField: 1 },
      }),
    ).toThrow();
    // 已知字段的类型仍按完整 schema 校验：meters 不接受字符串。
    expect(() =>
      store.applyDelta({
        ...delta(2, 1),
        set: { meters: "not-an-object" },
      }),
    ).toThrow();

    // 校验失败不得推进游标，缺口语义保持不变。
    expect(store.streamSeq).toBe(1);
    expect(store.applyDelta(delta(2, 1)).changed).toBe(true);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(1);
  });

  it("合并不合法补丁后投影仍满足完整契约", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1));
    store.applyDelta({
      ...delta(2, 1),
      set: {
        map: {
          nodes: [{ nodeId: "nd-000000000001", name: "灰港", x: 0, y: 0, facilities: [] }],
          roads: [],
        },
      },
    });

    // 合并结果必须仍然通过完整 playerProjectionSchema：省略全量 parse 不能放松契约。
    expect(playerProjectionSchema.safeParse(store.getSnapshot()?.projection).success).toBe(true);
  });

  it("append 的 item 由 kind 绑定：非法 item 与未实现种类在传输校验处被拒绝", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1));
    const line = {
      seq: 0,
      dialogueId: "dlg-000000000001",
      speakerId: "player-1",
      speakerName: "党魁",
      text: "你好",
      worldTick: 0,
      channel: "face-to-face" as const,
    };

    // 传输层按 kind 判别：dialogue 的 item 必须满足 ConversationLine。
    expect(
      serverStreamMessageSchema.safeParse({
        type: "append",
        channel: "player",
        streamSeq: 2,
        kind: "dialogue",
        item: { dialogueId: "dlg-000000000001" },
      }).success,
    ).toBe(false);
    // 未实现的 timeline 种类不在公开 schema 内，不能被误判成「暂无数据」。
    expect(
      serverStreamMessageSchema.safeParse({
        type: "append",
        channel: "player",
        streamSeq: 2,
        kind: "timeline",
        item: line,
      }).success,
    ).toBe(false);
    // 非玩家频道不承载 append。
    expect(
      serverStreamMessageSchema.safeParse({
        type: "append",
        channel: "console.timeline",
        streamSeq: 2,
        kind: "dialogue",
        item: line,
      }).success,
    ).toBe(false);
    // 合法帧仍然通过。
    expect(
      serverStreamMessageSchema.safeParse({
        type: "append",
        channel: "player",
        streamSeq: 2,
        kind: "dialogue",
        item: line,
      }).success,
    ).toBe(true);
  });

  it("applySnapshot 对完整投影校验，非法基线不写入状态", () => {
    const store = new ProjectionStore();

    // 缺必填字段：快照必须在写入前被完整 schema 拒绝。
    expect(() =>
      store.applySnapshot({
        ...snapshot(1),
        data: { clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 } } as unknown as PlayerProjection,
      }),
    ).toThrow();
    expect(store.getSnapshot()).toBeNull();

    // 未知顶层字段同样被 strict 拒绝。
    expect(() =>
      store.applySnapshot({
        ...snapshot(1),
        data: { ...projection(), unexpected: true } as unknown as PlayerProjection,
      }),
    ).toThrow();
    expect(store.getSnapshot()).toBeNull();

    // 合法快照才成为基线。
    expect(store.applySnapshot(snapshot(1)).changed).toBe(true);
    expect(playerProjectionSchema.safeParse(store.getSnapshot()?.projection).success).toBe(true);
  });

  it("applySnapshot 的基线足以承接后续增量，无需求助合并结果复验", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1));

    // 基线合法是 applyDelta 省略合并复验的前提：连续多条增量后仍满足完整契约。
    for (let seq = 2; seq <= 5; seq += 1) {
      expect(store.applyDelta(delta(seq, seq)).changed).toBe(true);
      expect(playerProjectionSchema.safeParse(store.getSnapshot()?.projection).success).toBe(true);
    }
    expect(store.streamSeq).toBe(5);
  });

  it("replaceSnapshot 对完整投影校验，非法 REST 响应不覆盖已有基线", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(4));

    // REST 响应缺必填字段时不得替换掉已合法的投影。
    expect(() =>
      store.replaceSnapshot({
        worldId: "wld-000000000001",
        branchId: "br-000000000001",
        streamSeq: 9,
        projectionVersion: 9,
        projection: { campaign: null } as unknown as PlayerProjection,
      }),
    ).toThrow();
    expect(store.streamSeq).toBe(4);
    expect(playerProjectionSchema.safeParse(store.getSnapshot()?.projection).success).toBe(true);

    // 合法但更旧的响应仍按序保护丢弃；合法且更新的才被接受。
    const stale = store.replaceSnapshot({
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      streamSeq: 3,
      projectionVersion: 3,
      projection: projectionAtTick(3),
    });
    expect(stale).toMatchObject({ changed: false });
    expect(store.streamSeq).toBe(4);
  });
});
