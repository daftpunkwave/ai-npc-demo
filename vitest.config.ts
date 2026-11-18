/**
 * Vitest 运行配置：收集各包、各模块与跨模块测试目录下的测试文件。
 * 测试共享同一进程内实现，不启动真实模型、网络或数据库适配器。
 * 禁止在此开启依赖顺序敏感的全局状态；测试之间必须可独立重跑。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "modules/**/tests/**/*.test.ts",
      "tests/{contract,integration,catalog,scenarios}/**/*.test.ts",
    ],
  },
});
