/**
 * 验证 platform.access-policy.roster 与 platform.secrets.env 的端口行为。
 * 依赖真实模块定义与最小宿主服务；不使用进程内全局状态。
 * 禁止在测试中读取真实密钥。
 */
import { describe, expect, it } from "vitest";
import type { HostServices, Json, ModuleCreateInput } from "@ai-npc/contracts";
import { accessPolicyModuleDefinition, type AccessPolicyPort } from "@ai-npc/mod-platform-access-policy-roster";
import { secretsModuleDefinition, type SecretsPort } from "@ai-npc/mod-platform-secrets-env";

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
    expect(port.authorize({ principalId: "player-1", role: "player", action: "command", commandType: "policy.set" })).toMatchObject({ allowed: false });
    expect(port.authorize({ principalId: "operator-1", role: "operator", action: "console" })).toMatchObject({ allowed: true });
    expect(port.authorize({ principalId: "player-1", role: "player", action: "console" })).toMatchObject({ allowed: false });
  });

  it("只解析 allowlist 中的环境变量", async () => {
    process.env.NPC_TEST_SECRET = "test-secret";
    try {
      const instance = await secretsModuleDefinition.create(input("platform.secrets.env", { allowlist: ["NPC_TEST_SECRET"] }));
      const port = instance.port as SecretsPort;
      expect(port.resolve("NPC_TEST_SECRET")).toBe("test-secret");
      expect(port.resolve("PATH")).toBeNull();
    } finally {
      delete process.env.NPC_TEST_SECRET;
    }
  });
});
