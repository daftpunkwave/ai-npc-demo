/**
 * 校验玩家投影 reducer 的快照、连续增量、断档重取与重复对白抑制。
 * 依赖公共 fixture、内存状态与投影 store；不启动网络或服务端。
 * 禁止把缺口后的旧增量继续套用，或让重复 append 改写投影版本。
 */
import { describe, expect, it } from "vitest";
import type { PlayerProjection, StreamDeltaMessage, StreamSnapshotMessage } from "@ai-npc/contracts";
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

function snapshot(streamSeq: number): StreamSnapshotMessage {
  return {
    type: "snapshot",
    channel: "player",
    streamSeq,
    projectionVersion: streamSeq,
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
    store.applySnapshot(snapshot(4), "wld-000000000001", "br-000000000001");
    expect(store.applyDelta(delta(5, 1)).needsSnapshot).toBe(false);
    expect(store.getSnapshot()?.projection.clock.worldTick).toBe(1);
    expect(store.streamSeq).toBe(5);
  });

  it("序号缺口要求重新取快照且不应用增量", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(2), "wld-000000000001", "br-000000000001");
    const result = store.applyDelta(delta(4, 4));
    expect(result.needsSnapshot).toBe(true);
    expect(store.streamSeq).toBe(2);
    expect(store.needsSnapshot()).toBe(true);
  });

  it("重复对白 append 不重复写入", () => {
    const store = new ProjectionStore();
    store.applySnapshot(snapshot(1), "wld-000000000001", "br-000000000001");
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
});
