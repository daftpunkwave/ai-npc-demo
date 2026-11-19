/**
 * 验证规则上下文把当前 run 的 seed 绑定为宿主随机源的第一个参数。
 * 依赖 authority 的上下文构造函数与一个只记录参数的假宿主；不读写存储。
 * 禁止在规则模块里读取全局 seed 或让随机源绕过 runSeed。
 */
import { describe, expect, it } from "vitest";
import type { AuthContext, HostServices } from "@ai-npc/contracts";
import type { ApprovedSpeechReader } from "@ai-npc/module-sdk";
import { createHandlerContext } from "../src/handler-context";

const auth: AuthContext = {
  principalId: "player-1",
  kind: "player",
  roles: ["player"],
  worldId: "wld-test",
  branchId: "br-test",
  actingAsAgentId: null,
  controllerEpoch: null,
  turnLeaseEpoch: null,
  turnId: null,
};

const approvedSpeech: ApprovedSpeechReader = { read: () => null };

function recordingHost(recorded: string[][]): HostServices {
  return {
    rng: (...parts) => {
      recorded.push([...parts]);
      return () => 0.5;
    },
    ids: (prefix) => `${prefix}-test`,
  } as unknown as HostServices;
}

function contextWith(host: HostServices, runSeed?: string) {
  return createHandlerContext({
    auth,
    tx: {} as never,
    modules: {},
    content: {},
    approvedSpeech,
    host,
    ...(runSeed === undefined ? {} : { runSeed }),
  });
}

describe("规则随机源的 runSeed 注入", () => {
  it("把 runSeed 作为宿主随机源的第一个参数", () => {
    const recorded: string[][] = [];
    const context = contextWith(recordingHost(recorded), "run-seed-1");
    context.rng("risk", "team-star", "4", "r-gh-or");
    expect(recorded).toEqual([["run-seed-1", "risk", "team-star", "4", "r-gh-or"]]);
  });

  it("未注入 runSeed 时保持既有测试调用形态", () => {
    const recorded: string[][] = [];
    const context = contextWith(recordingHost(recorded));
    context.rng("risk", "team-star", "4", "r-gh-or");
    expect(recorded).toEqual([["risk", "team-star", "4", "r-gh-or"]]);
  });
});
