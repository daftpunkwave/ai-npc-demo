/**
 * 验证记忆模块启动失败时释放已创建的实例。
 * 禁止启动存储、计时器或网络资源。
 */
import { describe, expect, it } from "vitest";
import {
  emptyModuleConfigSchema,
  type HostServices,
  type ModuleDefinition,
} from "@ai-npc/contracts";
import { AgentModuleHandle } from "../src/agent-module-handle";

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000001`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => {
    // The handle test does not wait.
  },
  rng: () => () => 0.5,
  hash: async () => "hash",
  logger: {
    info: () => {
      // No log assertions are needed.
    },
    warn: () => {
      // No log assertions are needed.
    },
    error: () => {
      // No log assertions are needed.
    },
  },
  tracer: {
    span: (_name, _attrs, fn) => fn(),
  },
};

describe("AgentModuleHandle", () => {
  it("disposes a module that fails during start", async () => {
    const startupError = new Error("start failed");
    let disposals = 0;
    const definition: ModuleDefinition = {
      id: "agent.memory.test",
      realm: "server",
      kind: "service",
      version: "1.0.0",
      apiVersion: "1",
      instanceScope: "agent",
      provides: [],
      requires: [],
      requiresRemote: [],
      configSchema: emptyModuleConfigSchema,
      defaults: {},
      stateSchemaVersion: null,
      migrationPaths: [],
      create: async (input) => ({
        moduleId: input.moduleId,
        start: async () => {
          throw startupError;
        },
        drain: async () => {
          // Nothing is running.
        },
        dispose: async () => {
          disposals += 1;
        },
        port: {},
      }),
    };

    await expect(AgentModuleHandle.create({
      agentId: "human-independent",
      moduleId: definition.id,
      config: {},
      definition,
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      host,
      signal: new AbortController().signal,
    })).rejects.toBe(startupError);
    expect(disposals).toBe(1);
  });
});
