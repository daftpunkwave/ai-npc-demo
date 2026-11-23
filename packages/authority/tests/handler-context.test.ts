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

describe("handler 上下文的模块与内容传递", () => {
  it("把 modules 与 content 原样交给处理器，不复制或改写", () => {
    const host = recordingHost([]);
    const modules = { "game.world": { evaluateChapter: () => undefined } };
    const content = { rules: { watergateSeatId: "seat.commune" } };
    const context = createHandlerContext({
      auth,
      tx: {} as never,
      modules,
      content,
      approvedSpeech,
      host,
    });
    // 引用相等：处理器读到的就是宿主装配出的那一份模块端口与内容索引。
    expect(context.modules).toBe(modules);
    expect(context.content).toBe(content);
    expect(context.auth).toBe(auth);
    expect(context.approvedSpeech).toBe(approvedSpeech);
  });

  it("两个属性取值不同也不会互相覆盖", () => {
    const host = recordingHost([]);
    const modules = { "game.map": { roadStatus: () => "open" } };
    const content = { playerNodeId: "grayharbor" };
    const context = createHandlerContext({
      auth,
      tx: {} as never,
      modules,
      content,
      approvedSpeech,
      host,
    });
    // 命令网关在同一对象字面量里同时传入这两个字段；任一被另一覆盖都会在此暴露。
    expect(context.modules).toBe(modules);
    expect(context.content).toBe(content);
    expect(context.modules).not.toBe(context.content);
  });
});
