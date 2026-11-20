/**
 * 覆盖命令受理与投影刷新分离：刷新失败不得让调用方误判命令未受理。
 * 依赖内存命令端口与最小宿主服务；不启动浏览器、网络或真实服务端。
 * 禁止在命令已受理后要求重新生成 commandId。
 */
import { describe, expect, it } from "vitest";
import {
  playerProjectionSchema,
  type CommandReceipt,
  type HostServices,
  type ModuleCreateInput,
  type SessionDescriptor,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";
import { createWorldViewModule, type WorldViewPort } from "../src/plugin";

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

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000001`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => undefined,
  rng: () => () => 0.5,
  hash: async () => "hash",
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  tracer: { span: (_name, _attrs, fn) => fn() },
};

const session: SessionDescriptor = {
  principalId: "player-1",
  roles: ["player"],
  worldId: "wld-000000000001",
  branchId: "br-000000000001",
  protocolVersion: "1",
  serverAssembly: {
    realm: "server",
    protocolVersion: "1",
    modules: [],
    capabilities: [],
    assemblyHash: "server",
  },
  clientAssembly: null,
};

const projection = playerProjectionSchema.parse({
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
});

function moduleInput(api: ApiClient, command: object): ModuleCreateInput {
  return {
    moduleId: "client.world-view.standard",
    realm: "client",
    config: {},
    scope: {},
    ports: {
      "host.api": api,
      "host.command": command,
      "host.session": session,
    },
    host,
    signal: new AbortController().signal,
  };
}

describe("WorldViewController 命令受理", () => {
  it("命令已受理而投影刷新失败时返回 accepted 与独立刷新错误", async () => {
    const command = {
      send: async () => receipt,
    };
    let refreshes = 0;
    const api = {
      worldView: async () => {
        refreshes += 1;
        if (refreshes === 1) {
          throw new Error("projection refresh failed");
        }
        return { streamSeq: 1, projectionVersion: 1, projection };
      },
    } as unknown as ApiClient;
    const instance = await createWorldViewModule(moduleInput(api, command));
    const port = instance.port as WorldViewPort;

    await expect(port.sendDialogue("human-independent", "请确认道路")).resolves.toBe(true);
    expect(port.refreshError()).toBe("projection refresh failed");
    await port.refresh();
    expect(port.refreshError()).toBeNull();
  });
});
