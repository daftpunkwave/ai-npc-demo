/**
 * Playwright 配置：构建两端后以固定测试装配启动双端口，串行运行玩家与控制台关键路径。
 * 依赖 Playwright、测试环境变量与固定 Vite/Fastify 拓扑；不访问真实模型。
 * 禁止复用未知本地服务、自动改端口或把数据写入常规开发目录。
 */
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dataDir = resolve(process.cwd(), "data-e2e", `run-${process.pid}`);

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
      NPC_SERVER_HOST: "127.0.0.1",
      NPC_SERVER_PORT: "3000",
      NPC_CLIENT_PORT: "5173",
      NPC_DATA_DIR: dataDir,
      NPC_ASSEMBLY: "local-slg-test-v1",
      NPC_ROSTER: "core-3",
      NPC_PLAYER_TOKEN: "e2e-player",
      NPC_CONSOLE_TOKEN: "e2e-console",
      NPC_OPERATOR_TOKEN: "e2e-operator",
      NPC_RESEARCHER_TOKEN: "e2e-researcher",
      NPC_EVALUATOR_TOKEN: "e2e-evaluator",
    },
  },
});
