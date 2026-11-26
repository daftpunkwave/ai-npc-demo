/**
 * Playwright 配置：构建两端后以固定测试装配启动双端口，串行运行玩家与控制台关键路径。
 * 依赖 Playwright、测试环境变量与固定 Vite/Fastify 拓扑；不访问真实模型。
 * 禁止复用未知本地服务、自动改端口或把数据写入常规开发目录。
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dataDir = resolve(process.cwd(), "data-e2e", `run-${process.pid}`);
// 操作系统可能复用先前 e2e 运行的 PID，残留目录会让服务端重新打开旧数据库；
// 在 webServer 启动前清空本运行目录，保证每次 e2e 都从全新世界开始。
rmSync(dataDir, { recursive: true, force: true });

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://127.0.0.1:3000/api/v1/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WORLD_PRISM_SERVER_HOST: "127.0.0.1",
      WORLD_PRISM_SERVER_PORT: "3000",
      WORLD_PRISM_CLIENT_PORT: "5173",
      WORLD_PRISM_DATA_DIR: dataDir,
      WORLD_PRISM_ASSEMBLY: "local-slg-test-v1",
      WORLD_PRISM_MODEL_LAYOUT: "deterministic-model-layout-v1",
      WORLD_PRISM_ROSTER: "core-3",
      WORLD_PRISM_PLAYER_TOKEN: "e2e-player",
      WORLD_PRISM_CONSOLE_TOKEN: "e2e-console",
      WORLD_PRISM_OPERATOR_TOKEN: "e2e-operator",
      WORLD_PRISM_RESEARCHER_TOKEN: "e2e-researcher",
      WORLD_PRISM_EVALUATOR_TOKEN: "e2e-evaluator",
    },
  },
});
