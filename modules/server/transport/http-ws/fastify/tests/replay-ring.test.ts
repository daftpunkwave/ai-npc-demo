/**
 * 验证重放环形缓冲与重放缓冲集合：写满后只保留最新的 replayLimit 帧且保持写入顺序，
 * 回绕后的游标补发仍连续，被覆盖的旧游标退回完整快照，清空后不再补发。
 * 依赖重放缓冲实现与流类型常量；不启动 Fastify 或真实连接。
 * 禁止只断言条数而不核对帧序号，或省略回绕后的缺口判定。
 */
import { describe, expect, it } from "vitest";
import { ReplayRing } from "../src/replay-ring";
import { ReplayStore } from "../src/replay-store";
import { replayLimit, type ReplayFrame } from "../src/stream-types";

const frame = (streamSeq: number): ReplayFrame => ({ streamSeq, projectionVersion: streamSeq, set: {} });
const seqs = (frames: readonly ReplayFrame[]): number[] => frames.map((entry) => entry.streamSeq);

describe("重放环形缓冲", () => {
  it("未写满时按写入顺序返回游标之后的帧", () => {
    const ring = new ReplayRing<ReplayFrame>(4);
    [1, 2, 3].forEach((seq) => { ring.push(frame(seq)); });
    expect(ring.length).toBe(3);
    expect(seqs(ring.after(0))).toEqual([1, 2, 3]);
    expect(seqs(ring.after(2))).toEqual([3]);
    expect(ring.after(3)).toEqual([]);
  });

  it("写满后覆盖最旧帧，多次回绕仍保持写入顺序", () => {
    const ring = new ReplayRing<ReplayFrame>(3);
    for (let seq = 1; seq <= 8; seq += 1) ring.push(frame(seq));
    expect(ring.length).toBe(3);
    expect(seqs(ring.after(0))).toEqual([6, 7, 8]);
  });

  it("清空后长度归零，可重新写入", () => {
    const ring = new ReplayRing<ReplayFrame>(2);
    [1, 2, 3].forEach((seq) => { ring.push(frame(seq)); });
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.after(0)).toEqual([]);
    ring.push(frame(9));
    expect(seqs(ring.after(0))).toEqual([9]);
  });

  it.each([0, -1, 1.5])("拒绝非正整数容量 %s", (capacity) => {
    expect(() => new ReplayRing<ReplayFrame>(capacity)).toThrow(RangeError);
  });
});

describe("重放缓冲集合的容量淘汰", () => {
  const store = (): ReplayStore => new ReplayStore({
    now: () => 0,
    maxReplayBuffers: 4,
    retentionMs: 60_000,
    hasActiveConnection: () => true,
  });

  it("超过 replayLimit 后只保留最新帧，回绕后的连续游标仍可补发", () => {
    const replay = store();
    replay.resetAll("br-1", 1);
    const buffer = replay.ensure("ses-1", "player");
    const total = replayLimit + 5;
    for (let seq = 1; seq <= total; seq += 1) replay.append(frame(seq));
    expect(buffer.frames.length).toBe(replayLimit);
    const resumed = replay.select(buffer, 5, total);
    expect(resumed).not.toBeNull();
    expect(seqs(resumed ?? [])).toEqual(Array.from({ length: replayLimit }, (_, index) => index + 6));
    expect(seqs(replay.select(buffer, total - 2, total) ?? [])).toEqual([total - 1, total]);
  });

  it("游标落在已被覆盖的帧上时返回 null，由调用方改发完整快照", () => {
    const replay = store();
    replay.resetAll("br-1", 1);
    const buffer = replay.ensure("ses-1", "player");
    const total = replayLimit + 5;
    for (let seq = 1; seq <= total; seq += 1) replay.append(frame(seq));
    expect(replay.select(buffer, 4, total)).toBeNull();
  });

  it("分支切换清空缓冲，旧序号不再补发", () => {
    const replay = store();
    replay.resetAll("br-1", 1);
    const buffer = replay.ensure("ses-1", "player");
    [1, 2, 3].forEach((seq) => { replay.append(frame(seq)); });
    replay.resetAll("br-2", 2);
    expect(buffer.frames.length).toBe(0);
    expect(replay.select(buffer, 1, 3)).toBeNull();
  });
});
