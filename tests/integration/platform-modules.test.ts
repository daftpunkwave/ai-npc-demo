/**
 * 验证 platform.access-policy.roster 与 platform.secrets.env 的端口行为。
 * 依赖真实模块定义与最小宿主服务；不使用进程内全局状态。
 * 禁止在测试中读取真实密钥。
 */
import { describe, expect, it } from "vitest";
import type { HostServices, Json, ModuleCreateInput } from "@world-prism/contracts";
import { accessPolicyModuleDefinition, type AccessPolicyPort } from "@world-prism/mod-platform-access-policy-roster";
import { secretsModuleDefinition, type SecretsPort } from "@world-prism/mod-platform-secrets-env";
import { OperationsService, type OperationsDriver } from "@world-prism/mod-platform-operations-standard";
import { transportModuleDefinition, type TransportPort } from "@world-prism/mod-transport-http-ws-fastify";

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000000`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => {},
  rng: () => () => 0.5,
  hash: async () => "hash",
  hashText: async () => "hash",
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
      step: (expected, ticks) => {
        calls.push(`step:${expected}:${ticks}`);
        return { ...clock, mode: "stepping", runVersion: expected + 1 };
      },
      snapshot: (input) => {
        calls.push(`snapshot:${input.label}`);
        return { snapshotId: "snap-1", worldTick: clock.worldTick };
      },
      restore: (input) => {
        calls.push(`restore:${input.snapshotId}:${input.runId ?? "default"}`);
        return { branchId: "br-1" };
      },
      reset: (createdBy) => {
        calls.push(`reset:${createdBy}`);
        return { branchId: "br-2", clock };
      },
    };
    const service = new OperationsService(driver);
    expect(service.snapshot("manual", "operator-1")).toMatchObject({ snapshotId: "snap-1" });
    expect(calls).toEqual(["pause:3", "snapshot:manual"]);
    // 非幂等重开同样记录调用方主体，不使用固定的操作者 ID。
    expect(service.reset("operator-7")).toMatchObject({ branchId: "br-2" });
    expect(calls).toContain("reset:operator-7");
    expect(service.restore("snap-1", "operator-1", "run-9")).toMatchObject({ branchId: "br-1" });
    expect(calls).toContain("restore:snap-1:run-9");
  });

  it("运营服务在 stepping 中的非幂等快照先暂停", () => {
    const calls: string[] = [];
    const clock = { worldTick: 2, day: 1, hour: 2, mode: "stepping" as const, runVersion: 3 };
    const driver: OperationsDriver = {
      clock: () => ({ mode: clock.mode, runVersion: clock.runVersion }),
      pause: (expected) => {
        calls.push(`pause:${expected}`);
        return { ...clock, mode: "paused", runVersion: expected + 1 };
      },
      resume: (expected) => ({ ...clock, mode: "running", runVersion: expected + 1 }),
      step: (expected) => ({ ...clock, mode: "stepping", runVersion: expected + 1 }),
      snapshot: (input) => {
        calls.push(`snapshot:${input.label}`);
        return { snapshotId: "snap-1", worldTick: clock.worldTick };
      },
      restore: () => ({ branchId: "br-1" }),
      reset: () => ({ branchId: "br-2", clock }),
    };
    const service = new OperationsService(driver);
    expect(service.snapshot("单步中存档", "operator-1")).toMatchObject({ snapshotId: "snap-1" });
    expect(calls).toEqual(["pause:3", "snapshot:单步中存档"]);
  });

  it("运营驱动未提供在线名册时，名册读取、休眠与唤醒按 not-ready 拒绝", () => {
    const clock = { worldTick: 0, day: 1, hour: 0, mode: "paused" as const, runVersion: 0 };
    const service = new OperationsService({
      clock: () => ({ mode: clock.mode, runVersion: clock.runVersion }),
      pause: () => clock,
      resume: () => clock,
      step: () => clock,
      snapshot: () => ({ snapshotId: "snap-1", worldTick: 0 }),
      restore: () => ({ branchId: "br-1" }),
      reset: () => ({ branchId: "br-2", clock }),
    });
    const operation = { operationId: "op-000000000001", principalId: "operator-1", branchId: "br-000000000001" };
    for (const call of [
      () => service.rosterState(),
      () => service.hibernateRoster(operation),
      () => service.wakeRoster(operation),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: "not-ready" }) as Error);
    }
  });

  it("传输模块只接受回环地址与合法端口", async () => {
    const instance = await transportModuleDefinition.create(input("transport.http-ws.fastify", { port: 3000 }));
    const port = instance.port as TransportPort;
    expect(port.host).toBe("127.0.0.1");
    expect(port.port).toBe(3000);
    await expect(transportModuleDefinition.create(input("transport.http-ws.fastify", { host: "0.0.0.0" }))).rejects.toThrow();
  });

  it("只解析 allowlist 中的环境变量", async () => {
    process.env.WORLD_PRISM_TEST_SECRET = "test-secret";
    process.env.WORLD_PRISM_EMPTY_SECRET = "";
    try {
      const instance = await secretsModuleDefinition.create(input("platform.secrets.env", { allowlist: ["WORLD_PRISM_TEST_SECRET", "WORLD_PRISM_EMPTY_SECRET"] }));
      const port = instance.port as SecretsPort;
      expect(port.resolve("WORLD_PRISM_TEST_SECRET")).toBe("test-secret");
      expect(port.resolve("WORLD_PRISM_EMPTY_SECRET")).toBeNull();
      expect(port.resolve("PATH")).toBeNull();
      expect(port.resolve("__proto__")).toBeNull();
    } finally {
      delete process.env.WORLD_PRISM_TEST_SECRET;
      delete process.env.WORLD_PRISM_EMPTY_SECRET;
    }
  });
});
