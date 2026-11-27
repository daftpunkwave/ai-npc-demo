/**
 * 声明 transport.http-ws.fastify 的身份、能力与严格配置 schema。
 * 依赖公共契约与 module-sdk；应用实现由宿主组合。
 * 禁止在此读取环境变量、监听端口或绕过 Origin 校验。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

/**
 * 缺省允许的 Origin：网页玩家端 5173 与同源控制台 3000。
 * 配置 schema 与 createServerApp 共用这一份，直接嵌入应用而省略该选项时也不会把 /console/ 的同源请求拒成 403。
 */
export const defaultAllowedOrigins: readonly string[] = Object.freeze([
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
]);

export const transportConfigSchema = z
  .object({
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(3000),
    allowedOrigins: z.array(z.string().url()).min(1).default(() => [...defaultAllowedOrigins]),
  })
  .strict();

export type TransportConfig = z.infer<typeof transportConfigSchema>;

const definition: ModuleDefinition = {
  id: "transport.http-ws.fastify",
  realm: "server",
  kind: "adapter",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("transport.http-ws"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: transportConfigSchema,
  defaults: transportConfigSchema.parse({}),
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createTransportModule } = await import("./plugin");
    return createTransportModule(input);
  },
};

/** 经 module-sdk 校验的 HTTP/WS 传输配置定义。 */
export const transportModuleDefinition = defineModule(definition);
