/**
 * 收集需要真实模型凭据的手动传输连通性用例。
 * 从项目根 .env 加载本地部署的变量，默认测试配置继续排除此目录。
 * 禁止输出凭据或把外部供应商流量纳入常规检查。
 */
import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({ test: { include: ["tests/live/*.live.test.ts"], testTimeout: 180_000 } });
