/**
 * 验证浏览器运行时按声明收窄模块端口：创建输入与视图只含宿主固定端口和模块声明的能力，宿主固定端口受 realm 契约约束。
 * 依赖 client-sdk 的模块启动入口、描述符工厂、宿主上下文与 React 服务端渲染；不创建真实网络或浏览器实例。
 * 禁止把未声明的能力端口交给模块，或让契约外的宿主端口进入模块作用域。
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import type { ContributionRef, Json, ModuleCreateInput, ModuleDefinition, ResolvedModuleSet } from "@world-prism/contracts";
import { defineBrowserModuleDefinition, startBrowserModules, usePort } from "../src/index";
import { expectDomainError, hostValue, renderWithHost } from "./support";

/** 空对象规范 JSON 的 SHA-256，与服务端 configHash 的口径一致。 */
const EMPTY_CONFIG_HASH = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

interface ModuleSpec {
  readonly id: string;
  readonly provides: string;
  readonly requires?: readonly string[];
  readonly contributions?: readonly ContributionRef[];
  readonly port: unknown;
  readonly created?: ModuleCreateInput[];
}

function browserModule(spec: ModuleSpec): ModuleDefinition {
  return defineBrowserModuleDefinition({
    id: spec.id,
    kind: spec.contributions === undefined ? "service" : "contributor",
    provides: spec.provides,
    ...(spec.requires === undefined ? {} : { requires: spec.requires }),
    ...(spec.contributions === undefined ? {} : { contributions: spec.contributions }),
    create: async (input) => {
      spec.created?.push(input);
      return {
        moduleId: input.moduleId,
        start: async () => undefined,
        drain: async () => undefined,
        dispose: async () => undefined,
        port: spec.port,
      };
    },
  });
}

function resolvedSet(realm: "client" | "console", moduleIds: readonly string[]): ResolvedModuleSet {
  const emptyConfig: Json = {};
  return {
    realm,
    protocolVersion: "1",
    modules: moduleIds.map((moduleId) => ({
      moduleId,
      version: "1.0.0",
      apiVersion: "1",
      configHash: EMPTY_CONFIG_HASH,
      config: emptyConfig,
    })),
    capabilities: [],
    remoteCapabilities: [],
    assemblyHash: "hash",
  };
}

const cameraPort = { name: "camera" };
const worldViewPort = { name: "world-view" };
const apiPort = { name: "api" };

function viewPort(view: () => ReactNode): { renderContribution(): ReactNode } {
  return { renderContribution: () => createElement(view) };
}

const settingsSection: readonly ContributionRef[] = [
  { extensionId: "client.settings.standard.section", slot: "settings.section", order: 10 },
];

describe("模块创建输入的端口收窄", () => {
  it("模块只拿到本 realm 宿主固定端口与 requires 声明的能力端口", async () => {
    const created: ModuleCreateInput[] = [];
    const started = await startBrowserModules({
      definitions: [
        browserModule({ id: "client.camera.standard", provides: "client.camera", port: cameraPort }),
        browserModule({ id: "client.world-view.standard", provides: "client.world-view", port: worldViewPort }),
        browserModule({
          id: "client.settings.standard",
          provides: "client.settings",
          requires: ["client.camera"],
          port: {},
          created,
        }),
      ],
      resolved: resolvedSet("client", ["client.camera.standard", "client.world-view.standard", "client.settings.standard"]),
      fixedPorts: { "host.api": apiPort },
    });
    try {
      expect(created).toHaveLength(1);
      expect(created[0]?.ports).toEqual({ "host.api": apiPort, "client.camera": cameraPort });
      // 宿主外壳仍拿到全部端口，用于布局与启动流程。
      expect(Object.keys(started.ports).sort()).toEqual(["client.camera", "client.settings", "client.world-view", "host.api"]);
    } finally {
      await started.dispose();
    }
  });

  it("宿主注入本 realm 固定端口契约之外的端口时拒绝启动", async () => {
    await expect(
      startBrowserModules({
        definitions: [],
        resolved: resolvedSet("console", []),
        fixedPorts: { "host.console": {}, "host.api": apiPort },
      }),
    ).rejects.toMatchObject({
      code: "assembly-incompatible",
      details: { realm: "console", port: "host.api", allowed: ["host.console"] },
    });
  });
});

describe("模块视图的端口收窄", () => {
  async function startSettings(view: () => ReactNode) {
    return startBrowserModules({
      definitions: [
        browserModule({ id: "client.camera.standard", provides: "client.camera", port: cameraPort }),
        browserModule({ id: "client.world-view.standard", provides: "client.world-view", port: worldViewPort }),
        browserModule({
          id: "client.settings.standard",
          provides: "client.settings",
          requires: ["client.camera"],
          contributions: settingsSection,
          port: viewPort(view),
        }),
      ],
      resolved: resolvedSet("client", ["client.camera.standard", "client.world-view.standard", "client.settings.standard"]),
      fixedPorts: { "host.api": apiPort },
    });
  }

  it("视图取用未声明的能力时抛 assembly-incompatible 并指出模块与能力", async () => {
    const started = await startSettings(() => usePort<{ readonly name: string }>("client.world-view").name);
    try {
      const section = started.contributions[0];
      expect(section?.extensionId).toBe("client.settings.standard.section");
      const error = expectDomainError(
        () => renderWithHost(hostValue({ ports: started.ports, contributions: started.contributions }), section?.render()),
        "assembly-incompatible",
      );
      expect(error.details).toEqual({ moduleId: "client.settings.standard", capability: "client.world-view" });
    } finally {
      await started.dispose();
    }
  });

  it("视图可取用 requires、自身 provides 与宿主固定端口，宿主外壳仍可取用全部端口", async () => {
    const started = await startSettings(() =>
      [
        usePort<{ readonly name: string }>("client.camera").name,
        usePort<{ readonly renderContribution: unknown }>("client.settings") === undefined ? "missing" : "self",
        usePort<{ readonly name: string }>("host.api").name,
      ].join("|"),
    );
    try {
      const value = hostValue({ ports: started.ports, contributions: started.contributions });
      expect(renderWithHost(value, started.contributions[0]?.render())).toBe("camera|self|api");
      // 宿主外壳不在模块作用域内：沿用宿主根 Provider 的全部端口。
      const ShellView = (): ReactNode => usePort<{ readonly name: string }>("client.world-view").name;
      expect(renderWithHost(value, createElement(ShellView))).toBe("world-view");
    } finally {
      await started.dispose();
    }
  });
});
