/**
 * Vitest 运行配置：收集各包、各模块与跨模块测试目录下的测试文件。
 * 契约测试与模块端口测试使用进程内实现；集成与场景测试中包含启动真实 SQLite、
 * 本地 HTTP/WS 宿主并读写临时目录的用例。
 * 因此显式放宽用例与钩子超时：默认 5 秒只适合纯内存断言，慢机器或高并发下会把正在启动、
 * 关闭宿主的用例误判为超时；多数用例耗时远低于该上限，放宽只影响失败判定时间。
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
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
