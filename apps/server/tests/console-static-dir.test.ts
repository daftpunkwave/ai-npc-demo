/**
 * 核心职责：验证控制台静态目录的宿主级缺省值指向仓库内真实构建输出位置，而不是拼错的重复层级。
 * 交互契约：以最小输入图驱动 createTransportApp，断言它交给传输工厂的 consoleStaticDir；
 *   不提供 consoleStaticDir 时走宿主缺省值，提供时以调用方为准。
 * 约束与禁忌：不监听端口、不连存储、不创建或读取真实构建产物。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { GameContent } from "@world-prism/module-sdk";
import type { ServerApp } from "../src/host/module-catalog";
import { createTransportApp, type TransportAppInput } from "../src/host/transport-app";

/** 仓库根：本测试文件位于 apps/server/tests/，上溯即仓库根。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 用最小输入图驱动 createTransportApp，返回传输工厂实际收到的 consoleStaticDir。
 * stub 的 createApp 只记录入参，不注册路由、不监听端口。
 */
async function capturedConsoleStaticDir(override: string | undefined): Promise<string | undefined> {
  let captured: string | undefined;
  const input = {
    host: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
    options: {},
    runtime: {
      transport: {
        createApp: async (appOptions: { readonly consoleStaticDir?: string }) => {
          captured = appOptions.consoleStaticDir;
          return { listen: async () => {}, close: async () => {}, inject: async () => undefined } as unknown as ServerApp;
        },
      },
      accessPolicy: {},
    },
    active: { worldId: "world-1", branchId: "branch-1" },
    reads: {},
    gameContent: { secrets: new Map() } as unknown as GameContent,
    ...(override === undefined ? {} : { consoleStaticDir: override }),
    disposeOnFailure: async () => {},
  } as unknown as TransportAppInput;
  await createTransportApp(input);
  return captured;
}

describe("控制台静态目录的宿主缺省值", () => {
  it("未显式配置时解析到仓库内的 apps/server/console-static", async () => {
    const directory = await capturedConsoleStaticDir(undefined);
    // 上溯层级写错会拼成 apps/apps/server/console-static 之类的重复层级，这里逐段锁定。
    expect(directory).toBe(join(repoRoot, "apps/server/console-static"));
    expect(directory).not.toContain("apps/apps");
    // 缺省目录必须落在仓库内，且其父目录真实存在于源码树中。
    expect(existsSync(dirname(directory ?? ""))).toBe(true);
    expect(directory?.startsWith(repoRoot)).toBe(true);
  });

  it("调用方显式配置时以调用方为准，缺省值被覆盖", async () => {
    const directory = mkdtempSync(join(tmpdir(), "world-prism-console-static-"));
    createdDirs.push(directory);
    expect(await capturedConsoleStaticDir(directory)).toBe(resolve(directory));
  });
});
