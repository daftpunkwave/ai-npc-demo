/**
 * 验证模块描述符相关 schema 与装配描述符的严格解析。
 * 依赖公共契约包的 modules 主题导出。
 * 禁止在此加载模块实现或解析真实装配；装配样例为手写 JSON。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CAPABILITY_ID_PATTERN,
  agentSlotSchema,
  agentSlotImplementationsSchema,
  assemblyDescriptorSchema,
  capabilityBindingSchema,
  capabilityIdSchema,
  capabilityRefSchema,
  cardinalitySchema,
  contributionRefSchema,
  emptyModuleConfigSchema,
  experimentAxisSchema,
  instanceScopeSchema,
  moduleIdSchema,
  moduleKindSchema,
  moduleRefSchema,
  realmSchema,
  resolvedModuleSetSchema,
  uiExtensionSchema,
  type StrictConfigSchema,
} from "../src/index";
import { expectInvalid, expectSchema, expectValid } from "./support";

/** 与标准装配同形的装配描述符：命名配置块、三 realm 绑定与六个 Agent 槽。 */
const assembly = {
  schemaVersion: 1,
  assemblyId: "local-slg-standard-v1",
  configs: {
    clock: { secondsPerTick: 10, maxStepTicks: 24, autoPauseAfterDisconnectMs: 60000 },
    storage: { inlineArtifactMaxBytes: 65536 },
  },
  realms: {
    server: {
      bindings: [
        { capability: "game.world", moduleId: "game.world.slg-light", configRef: null },
        { capability: "game.clock", moduleId: "game.clock.controlled", configRef: "clock" },
      ],
      agentSlots: {
        perception: ["agent.perception.local"],
        memory: ["agent.memory.none", "agent.memory.ledger"],
        context: ["agent.context.ordered-blocks"],
        compression: ["agent.compression.none"],
        toolView: ["agent.tool-view.structured"],
        decision: ["agent.decision.deterministic"],
      },
    },
    client: {
      bindings: [{ capability: "client.hud", moduleId: "client.hud.standard", configRef: null }],
    },
    console: {
      bindings: [{ capability: "console.health", moduleId: "console.health.standard", configRef: null }],
    },
  },
};

describe("模块枚举与标识", () => {
  it("realm、kind、instanceScope 与 cardinality 取值", () => {
    for (const value of ["server", "client", "console"]) {
      expect(realmSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["service", "contributor", "adapter"]) {
      expect(moduleKindSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["deployment", "run", "branch", "agent", "session"]) {
      expect(instanceScopeSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["exactly-one", "many", "optional"]) {
      expect(cardinalitySchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(realmSchema, "browser");
    expectInvalid(moduleKindSchema, "plugin");
    expectInvalid(instanceScopeSchema, "world");
    expectInvalid(cardinalitySchema, "zero");
  });

  it("Agent 槽位固定六种", () => {
    for (const value of ["perception", "memory", "context", "compression", "toolView", "decision"]) {
      expect(agentSlotSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(agentSlotSchema, "speech");
  });

  it("能力 ID 与模块 ID 校验", () => {
    expectSchema(capabilityIdSchema, "agent.model-pool", 42);
    expectInvalid(capabilityIdSchema, "");

    for (const moduleId of [
      "game.world.slg-light",
      "agent.memory.ledger",
      "platform.model-transport.openai-compatible",
      "transport.http-ws.fastify",
      "client.scene-renderer.pixi",
      "console.observability.lite",
    ]) {
      expect(moduleIdSchema.safeParse(moduleId).success).toBe(true);
    }
    for (const invalid of ["game", "game.world", "other.foo.bar", "Game.world.slg", "game.world.slg-light.extra"]) {
      expect(moduleIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("能力 ID 只接受 <group>.<family> 语法", () => {
    for (const capability of [
      "game.world",
      "agent.model-pool",
      "platform.model-transport",
      "transport.http-ws",
      "client.world-view",
      "console.model-mounts",
    ]) {
      expectValid(capabilityIdSchema, capability);
    }
    for (const invalid of [
      "game.",
      "game.WORLD",
      "game.world.extra",
      "game.world x",
      "game",
      "",
      " Game.world",
      "game.world ",
      "other.world",
      "game.world_extra",
      "game.-world",
      "game.9world",
    ]) {
      expectInvalid(capabilityIdSchema, invalid);
    }
  });

  it("能力 ID 语法与静态扫描器的判定一致", () => {
    const matches = (value: string): boolean => CAPABILITY_ID_PATTERN.test(value);
    for (const value of ["game.world", "client.hud", "agent.memory", "game.world.extra", "game.", "game.WORLD"]) {
      const accepted = capabilityIdSchema.safeParse(value).success;
      expect(matches(value)).toBe(accepted);
    }
  });
});

describe("能力引用与已解析模块集", () => {
  const capabilityRef = { capability: "game.clock", cardinality: "exactly-one", instanceScope: "deployment" };

  it("能力引用与模块引用", () => {
    expectSchema(capabilityRefSchema, capabilityRef, { ...capabilityRef, cardinality: "zero" });
    expectSchema(
      moduleRefSchema,
      {
        moduleId: "game.clock.controlled",
        version: "1.0.0",
        apiVersion: "1",
        configHash: "abc123",
      },
    );
  });

  it("解析后的模块集", () => {
    expectSchema(
      resolvedModuleSetSchema,
      {
        realm: "client",
        protocolVersion: "1",
        modules: [
          { moduleId: "client.hud.standard", version: "1.0.0", apiVersion: "1", configHash: "abc" },
        ],
        capabilities: [capabilityRef],
        assemblyHash: "hash-1",
      },
      { realm: "browser", protocolVersion: "1", modules: [], capabilities: [], assemblyHash: "h" },
    );
  });

  it("能力绑定与 Agent 槽位实现", () => {
    const binding = { capability: "game.world", moduleId: "game.world.slg-light", configRef: null };
    expectSchema(capabilityBindingSchema, binding, { ...binding, configRef: undefined });
    expectSchema(
      capabilityBindingSchema,
      {
        capability: "platform.model-transport",
        moduleId: "platform.model-transport.anthropic",
        configRef: "anthropic",
        fallbackModuleIds: [],
      },
      { ...binding, extra: true },
    );

    expectSchema(
      agentSlotImplementationsSchema,
      { memory: ["agent.memory.none"] },
      { memory: ["agent.memory.none"], unknownSlot: [] },
    );
  });
});

describe("装配描述符", () => {
  it("严格解析标准装配形状", () => {
    expectSchema(assemblyDescriptorSchema, assembly, {
      ...assembly,
      realms: { ...assembly.realms, extraRealm: { bindings: [] } },
    });
  });

  it("允许无 Agent 槽位的早期装配与空配置块", () => {
    const minimal = {
      schemaVersion: 1,
      assemblyId: "local-slg-standard-v1",
      configs: {},
      realms: {
        server: { bindings: [] },
        client: { bindings: [] },
        console: { bindings: [] },
      },
    };
    expectSchema(assemblyDescriptorSchema, minimal, {
      ...minimal,
      schemaVersion: 0,
    });
  });

  it("拒绝未知键、错误绑定结构与缺失 realm", () => {
    expectInvalid(assemblyDescriptorSchema, { ...assembly, extra: true });
    expectInvalid(assemblyDescriptorSchema, {
      ...assembly,
      realms: {
        ...assembly.realms,
        server: { bindings: [{ capability: "game.world", moduleId: "game.world.slg-light" }] },
      },
    });
    expectInvalid(assemblyDescriptorSchema, {
      ...assembly,
      realms: { server: assembly.realms.server, client: assembly.realms.client },
    });
    expectInvalid(assemblyDescriptorSchema, {
      ...assembly,
      realms: {
        ...assembly.realms,
        server: { bindings: [], agentSlots: { unknownSlot: [] } },
      },
    });
  });
});

describe("UI 贡献与实验轴", () => {
  it("贡献引用与 UI 扩展", () => {
    expectSchema(
      contributionRefSchema,
      { extensionId: "hud.compact", slot: "hud", order: 10 },
      { extensionId: "", slot: "hud", order: 10 },
    );
    expectSchema(
      uiExtensionSchema,
      {
        extensionId: "hud.compact",
        slot: "hud",
        requiredCapabilities: ["client.hud"],
        order: 10,
        viewRef: "CompactHud",
      },
      { extensionId: "hud.compact", slot: "hud", requiredCapabilities: [], order: 10 },
    );
    expectInvalid(contributionRefSchema, { extensionId: "x", slot: "hud", order: 1, allowedRoles: [""] });
  });

  it("实验轴", () => {
    expectSchema(
      experimentAxisSchema,
      { key: "memory", label: "记忆实现", values: ["m0", "m1"] },
      { key: "", label: "记忆实现" },
    );
    expectInvalid(experimentAxisSchema, { key: "memory", label: "记忆实现", values: [Number.NaN] });
  });
});

describe("严格配置 schema 的公共类型", () => {
  it("StrictConfigSchema 不引用 zod 内部命名空间", () => {
    // 公共契约只允许依赖 zod 的公开导出；z.core 的内部符号若回到类型里，这里会暴露。
    const source = readFileSync(new URL("../src/modules.ts", import.meta.url), "utf8");
    expect(source).not.toContain("z.core");
  });

  it("严格空 schema 拒绝未知键并接受空对象", () => {
    const parsed = emptyModuleConfigSchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(emptyModuleConfigSchema.safeParse({ unexpected: 1 }).success).toBe(false);
  });

  it("声明为 StrictConfigSchema 的实参可直接参与 JSON Schema 生成", () => {
    const schema: StrictConfigSchema = z.strictObject({ secondsPerTick: z.number().int().positive() });
    expect(z.toJSONSchema(schema)).toMatchObject({ type: "object", additionalProperties: false });
  });
});
