/**
 * Vitest 运行配置：收集各应用、各包、各模块与跨模块测试目录下的测试文件。
 * 契约测试与模块端口测试使用进程内实现；集成与场景测试中包含启动真实 SQLite、
 * 本地 HTTP/WS 宿主并读写临时目录的用例。
 * 因此显式放宽用例与钩子超时：默认 5 秒只适合纯内存断言，慢机器或高并发下会把正在启动、
 * 关闭宿主的用例误判为超时；多数用例耗时远低于该上限，放宽只影响失败判定时间。
 *
 * 两个 project 共用同一批测试目录，差别只在隔离级别：
 * - `shared` 关闭每文件隔离（isolate: false），测试文件共享 worker，省去每文件一份的运行时
 *   启动与模块加载。代价是文件间共享进程状态，因此每个测试文件必须自行清理全局副作用：
 *   临时目录、进程环境变量、计时器与 `vi.mock`/`vi.stubGlobal` 注入的实现都要在用例内复原。
 * - `isolated` 保留每文件隔离，只收无法自清理的文件，不要整体回到全隔离。
 * 禁止在此开启依赖顺序敏感的全局状态；测试之间必须能独立重跑。
 */
import { defineConfig } from "vitest/config";

/** 参与测试的仓库目录；两个 project 共用。 */
const include = [
  "apps/*/tests/**/*.test.ts",
  "packages/*/tests/**/*.test.ts",
  "modules/**/tests/**/*.test.ts",
  "tests/{contract,integration,catalog,scenarios}/**/*.test.ts",
];

/**
 * 必须排除的目录。project 不继承根配置的默认排除项，依赖目录里的第三方测试
 * （如 `zod/src/v4/classic/tests`）会命中 `modules/**` 的收集模式，因此显式写出。
 */
const exclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**",
  "**/console-static/**",
];

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        test: {
          name: "shared",
          include,
          exclude: [...exclude, "tests/integration/server-config.test.ts"],
          pool: "threads",
          isolate: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "isolated",
          include: ["tests/integration/server-config.test.ts"],
          exclude,
          pool: "threads",
          // 该文件用 `vi.mock("node:fs", { spy: true })` 替换整个 fs 模块；共享 worker 时
          // 进程级模块注册会泄漏到后续文件，使真实的凭据写入不再失败。这里保留独立隔离。
          isolate: true,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
