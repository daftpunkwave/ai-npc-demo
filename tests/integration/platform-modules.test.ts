/**
 * 验证 platform.access-policy.roster 与 platform.secrets.env 的端口行为。
 * 依赖真实模块定义与最小宿主服务；不使用进程内全局状态。
 * 禁止在测试中读取真实密钥。
 */
import { describe, expect, it } from "vitest";
import type { HostServices, Json, ModuleCreateInput } from "@ai-npc/contracts";
import { accessPolicyModuleDefinition, type AccessPolicyPort } from "@ai-npc/mod-platform-access-policy-roster";
import { secretsModuleDefinition, type SecretsPort } from "@ai-npc/mod-platform-secrets-env";
import { OperationsService, type OperationsDriver } from "@ai-npc/mod-platform-operations-standard";
import { transportModuleDefinition, type TransportPort } from "@ai-npc/mod-transport-http-ws-fastify";

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000000`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => {},
  rng: () => () => 0.5,
  hash: async () => "hash",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tracer: { span: (_name, _attrs, fn) => fn() },
};

function input(id: string, config: Json): ModuleCreateInput {
  return { moduleId: id, realm: "server", config, scope: {}, ports: {}, host, signal: new AbortController().signal };
}

describe("platform 模块", () => {
  it("名册裁决玩家命令与控制台角色", async () => {
    const instance = await accessPolicyModuleDefinition.create(input("platform.access-policy.roster", {}));
    const port = instance.port as AccessPolicyPort;
    expect(port.authorize({ principalId: "player-1", role: "player", action: "command", commandType: "campaign.start" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "command", commandType: "policy.set" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "command", commandType: "scenario.draft" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "operator-1", role: "operator", action: "console" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "console" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "player" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "operator-1", role: "operator", action: "player" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "researcher-1", role: "researcher", action: "console-session" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "evaluator-1", role: "evaluator", action: "console" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "console-session" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "channel", channel: "player" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "operator-1", role: "operator", action: "channel", channel: "player" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "researcher-1", role: "researcher", action: "channel", channel: "console.timeline" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "operator-1", role: "operator", action: "channel", channel: "console.timeline" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "channel", channel: "unknown" })).toMatchObject({ allowed: false });
  });

  it("运营服务在快照前暂停", () => {
    const calls: string[] = [];
    const clock = { worldTick: 2, day: 1, hour: 2, mode: "running" as const, runVersion: 3 };
    const driver: OperationsDriver = {
      clock: () => ({ mode: clock.mode, runVersion: clock.runVersion }),
      pause: (expected) => {
        calls.push(`pause:${expected}`);
        return { ...clock, mode: "paused", runVersion: expected + 1 };
      },
      resume: (expected) => {
        calls.push(`resume:${expected}`);
        return { ...clock, mode: "running", runVersion: expected + 1 };
      },
      snapshot: (input) => {
        calls.push(`snapshot:${input.label}`);
        return { snapshotId: "snap-1", worldTick: clock.worldTick };
      },
      restore: (input) => {
        calls.push(`restore:${input.snapshotId}:${input.runId ?? "default"}`);
        return { branchId: "br-1" };
      },
      reset: () => {
        calls.push("reset");
        return { branchId: "br-2", clock };
      },
    };
    const service = new OperationsService(driver);
    expect(service.snapshot("manual", "operator-1")).toMatchObject({ snapshotId: "snap-1" });
    expect(calls).toEqual(["pause:3", "snapshot:manual"]);
    expect(service.reset()).toMatchObject({ branchId: "br-2" });
    expect(calls).toContain("reset");
    expect(service.restore("snap-1", "operator-1", "run-9")).toMatchObject({ branchId: "br-1" });
    expect(calls).toContain("restore:snap-1:run-9");
  });

  it("传输模块只接受回环地址与合法端口", async () => {
    const instance = await transportModuleDefinition.create(input("transport.http-ws.fastify", { port: 3000 }));
    const port = instance.port as TransportPort;
    expect(port.host).toBe("127.0.0.1");
    expect(port.port).toBe(3000);
    await expect(transportModuleDefinition.create(input("transport.http-ws.fastify", { host: "0.0.0.0" }))).rejects.toThrow();
  });

  it("只解析 allowlist 中的环境变量", async () => {
    process.env.NPC_TEST_SECRET = "test-secret";
    process.env.NPC_EMPTY_SECRET = "";
    try {
      const instance = await secretsModuleDefinition.create(input("platform.secrets.env", { allowlist: ["NPC_TEST_SECRET", "NPC_EMPTY_SECRET"] }));
      const port = instance.port as SecretsPort;
      expect(port.resolve("NPC_TEST_SECRET")).toBe("test-secret");
      expect(port.resolve("NPC_EMPTY_SECRET")).toBeNull();
      expect(port.resolve("PATH")).toBeNull();
      expect(port.resolve("__proto__")).toBeNull();
    } finally {
      delete process.env.NPC_TEST_SECRET;
      delete process.env.NPC_EMPTY_SECRET;
    }
  });
});
