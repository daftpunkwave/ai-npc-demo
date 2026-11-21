/**
 * 验证浏览器宿主在握手装配时拒绝不支持的协议版本。
 * 依赖 client-sdk 的模块启动入口与公共契约的装配描述；不创建真实网络或模块实例。
 * 禁止在协议版本不匹配时静默继续启动。
 */
import { describe, expect, it } from "vitest";
import type { ResolvedModuleSet } from "@ai-npc/contracts";
import { startBrowserModules } from "../src/index";

function resolved(protocolVersion: string): ResolvedModuleSet {
  return {
    realm: "client",
    protocolVersion,
    modules: [],
    capabilities: [],
    assemblyHash: "hash",
  };
}

describe("浏览器装配握手的协议版本", () => {
  it("拒绝服务端不支持的协议版本", async () => {
    await expect(
      startBrowserModules({ definitions: [], resolved: resolved("2") }),
    ).rejects.toMatchObject({
      code: "assembly-incompatible",
    });
  });

  it("协议版本一致时正常启动并可释放", async () => {
    const started = await startBrowserModules({ definitions: [], resolved: resolved("1") });
    expect(started.instances).toEqual([]);
    await started.dispose();
  });
});
