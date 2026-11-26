/**
 * 声明受控时钟模块的身份、能力与存储依赖。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取 clock 表或启动计时器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

export const clockConfigSchema = z
  .object({
    secondsPerTick: z.number().int().positive().default(20),
    maxStepTicks: z.number().int().min(1).max(24).default(24),
    // 断线自动暂停阈值属于装配声明；宿主读取该配置，在全部玩家连接断开超时后暂停 running 时钟。
    autoPauseAfterDisconnectMs: z.number().int().positive().default(60_000),
  })
  .strict();
const clockDefinition: ModuleDefinition = {
  id: "game.clock.controlled",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.clock"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [
    {
      capability: capabilityIdSchema.parse("platform.storage"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requiresRemote: [],
  configSchema: clockConfigSchema,
  defaults: { secondsPerTick: 20, maxStepTicks: 24, autoPauseAfterDisconnectMs: 60_000 },
  stateSchemaVersion: null,
  ownsAggregates: [],
  migrationPaths: [],
  create: async (input) => {
    const { createClockModule } = await import("./plugin");
    return createClockModule(input);
  },
};

/** 经描述符校验的受控时钟模块定义。 */
export const clockModuleDefinition = defineModule(clockDefinition);
