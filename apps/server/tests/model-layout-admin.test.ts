/**
 * 核心职责：验证控制台模型布局端口的文件错误和安全端点往返。
 * 交互契约：使用独立配置目录与真实布局加载器，检查调用方可见的领域错误和布局视图。
 * 约束与禁忌：不读取部署配置、不连接供应商、不提供真实凭据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelLayoutAdminPort } from "../src/host/model-layout-admin";

const layoutId = "proxy-layout";
const providerId = "platform.model-transport.openai-compatible";

describe("模型布局管理端口", () => {
  let root: string;
  let directory: string;
  let port: ModelLayoutAdminPort;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ai-npc-layout-admin-"));
    directory = join(root, "model-layouts");
    port = new ModelLayoutAdminPort({ configDir: root }, new Set(), () => ({ routes: [] }), () => null);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeLayout(endpoint: string): void {
    mkdirSync(directory);
    writeFileSync(join(directory, `${layoutId}.yaml`), JSON.stringify({
      schemaVersion: 1,
      layoutId,
      connections: { proxy: { adapterId: providerId, endpoint, credentialRef: "env:MODEL_TEST_KEY" } },
      models: {},
      mounts: [],
    }), "utf8");
  }

  it("在配置目录缺失时返回可识别的 not-ready", () => {
    expect(() => port.list()).toThrow(expect.objectContaining({
      code: "not-ready",
      safeMessage: "无法读取模型布局配置目录",
    }));
  });

  it.each(["connections: [", "schemaVersion: 2"])("拒绝损坏的布局配置 %s", (text) => {
    mkdirSync(directory);
    writeFileSync(join(directory, `${layoutId}.yaml`), text, "utf8");
    expect(port.list()).toEqual({ layouts: [{ layoutId, source: "repo" }] });
    for (const read of [() => port.layout(layoutId), () => port.routes(layoutId)]) {
      expect(read).toThrow(expect.objectContaining({
        code: "invalid-state",
        safeMessage: `无法加载模型布局 ${layoutId} 的配置`,
      }));
    }
  });

  it("把空目录与指定布局不存在区分开", () => {
    mkdirSync(directory);
    expect(port.list()).toEqual({ layouts: [] });
    for (const read of [() => port.layout(layoutId), () => port.routes(layoutId)]) {
      expect(read).toThrow(expect.objectContaining({
        code: "not-found",
        safeMessage: `模型布局 ${layoutId} 不存在`,
      }));
    }
  });

  it("让带路径前缀的端点从仓库布局往返到草稿预检", () => {
    const endpoint = "https://models.example.test/gateway/openai/v1";
    writeLayout(endpoint);
    const layout = port.layout(layoutId);
    const proxy = layout.connections["proxy"];
    expect(proxy).toEqual({
      adapterId: providerId, endpointRef: endpoint, endpointHost: "models.example.test",
      credentialRef: "MODEL_TEST_KEY", rateLimitKey: null,
    });
    expect(port.validate({
      schemaVersion: layout.schemaVersion,
      layoutId: layout.layoutId,
      connections: { proxy: {
        adapterId: proxy?.adapterId,
        endpoint: proxy?.endpointRef,
        credentialRef: proxy?.credentialRef,
      } },
      models: layout.models,
      mounts: layout.mounts,
    })).toEqual({ ok: true, errors: [] });
  });

  it.each([
    "https://fixture-user@models.example.test/gateway",
    "https://models.example.test/gateway?options=fixture",
    "https://models.example.test/gateway#fixture",
  ])("从布局视图省去带凭据、查询或片段的端点 %s", (endpoint) => {
    writeLayout(endpoint);
    expect(port.layout(layoutId).connections["proxy"]).toMatchObject({
      endpointRef: null, endpointHost: "models.example.test",
    });
  });

  it.each([
    ["env:NPC_OPENAI_COMPAT_BASE_URL", "env:NPC_OPENAI_COMPAT_BASE_URL"],
    ["env:MODEL_TEST_KEY", null],
    ["env:NPC_OPENAI_COMPAT_BASE_URL?value=fixture", null],
  ])("仅公开允许的端点环境引用 %s", (endpoint, expected) => {
    writeLayout(endpoint);
    expect(port.layout(layoutId).connections["proxy"]).toMatchObject({
      endpointRef: expected, endpointHost: null,
    });
  });
});
