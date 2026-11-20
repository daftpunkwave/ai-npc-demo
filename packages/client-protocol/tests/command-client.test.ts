/**
 * 校验命令重试始终复用同一个 commandId，并只重试可恢复错误。
 * 依赖内存命令传输与固定 ID 生成器；不访问真实服务端。
 * 禁止在业务 rejected receipt 上伪造重试，或每次网络失败后改变幂等键。
 */
import { describe, expect, it } from "vitest";
import { DomainError, type CommandEnvelope, type CommandReceipt } from "@ai-npc/contracts";
import { CommandClient } from "../src";

const receipt: CommandReceipt = {
  receiptId: "rcp-000000000001",
  commandId: "cmd-000000000001",
  commandStatus: "accepted",
  reasonCode: null,
  safeMessage: null,
  acceptedEventIds: [],
  operationId: null,
  resultingVersions: {},
  result: null,
  worldTick: 0,
};

describe("CommandClient", () => {
  it("网络失败重试复用同一 commandId", async () => {
    const seen: string[] = [];
    let calls = 0;
    const client = new CommandClient({
      api: {
        sendCommand: async (envelope: CommandEnvelope) => {
          seen.push(envelope.commandId);
          calls += 1;
          if (calls < 3) {
            throw new TypeError("network");
          }
          return receipt;
        },
      },
      newCommandId: () => "cmd-000000000001",
      wait: async () => undefined,
    });
    await client.send("dialogue.say", {});
    expect(seen).toEqual([
      "cmd-000000000001",
      "cmd-000000000001",
      "cmd-000000000001",
    ]);
  });

  it("不可重试领域错误立即失败", async () => {
    let calls = 0;
    const client = new CommandClient({
      api: {
        sendCommand: async () => {
          calls += 1;
          throw new DomainError("forbidden", "无权");
        },
      },
      newCommandId: () => "cmd-000000000001",
      wait: async () => undefined,
    });
    await expect(client.send("task.dispatch", {})).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toBe(1);
  });
});
