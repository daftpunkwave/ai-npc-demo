/**
 * 边界检查使用的固定白名单、扩展名映射与规则编号。
 * 白名单只在此维护，规则实现按 realm/kind 组合取用，不得就地增补。
 * 禁止在此引入文件系统访问、包清单解析或具体违规判定。
 */
import type { BoundaryRule, HeaderLanguage } from "./types";

// 规则编号与检查项固定对应，供 CLI 与测试断言逐条覆盖：
// 1 包公开入口与依赖声明，2 模块 realm/kind 白名单，3 浏览器 realm，4 kernel/contracts 限制，
// 5 宿主应用组合根，6 依赖图、动态加载与未使用声明，7 手写源码文件头。
export const RULE_IMPORT_BOUNDARY: BoundaryRule = 1;
export const RULE_MODULE_REALM: BoundaryRule = 2;
export const RULE_BROWSER_REALM: BoundaryRule = 3;
export const RULE_HOST_MECHANISM: BoundaryRule = 4;
export const RULE_COMPOSITION_ROOT: BoundaryRule = 5;
export const RULE_DEPENDENCY_GRAPH: BoundaryRule = 6;
export const RULE_SOURCE_HEADER: BoundaryRule = 7;

export const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
  "data",
  "data-e2e",
  "console-static",
  "pnpm-store",
  "vite",
  "vitest-cache",
]);

export const HEADER_LANGUAGE_BY_EXTENSION: Readonly<Record<string, HeaderLanguage>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".sql": "sql",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".sh": "shell",
  ".bash": "shell",
  ".py": "python",
};

export const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export const BROWSER_REALM_DIRECTORY_PREFIXES = [
  "modules/client/",
  "modules/console/",
  "apps/client/",
  "apps/console/",
  "packages/client-sdk/",
  "packages/client-protocol/",
];

export const HOST_MECHANISM_DIRECTORY_PREFIXES = ["packages/kernel/", "packages/contracts/"];

export const SERVER_MODULE_WORKSPACE_DEPENDENCIES = ["@ai-npc/contracts", "@ai-npc/module-sdk"] as const;

export const BROWSER_MODULE_WORKSPACE_DEPENDENCIES = [
  "@ai-npc/contracts",
  "@ai-npc/client-sdk",
  "@ai-npc/client-protocol",
] as const;

export const SERVER_ONLY_WORKSPACE_PACKAGES = new Set([
  "@ai-npc/authority",
  "@ai-npc/agent-runtime",
  "@ai-npc/module-sdk",
  "@ai-npc/experiment",
  "@ai-npc/observability",
  "@ai-npc/app-server",
]);

export const BROWSER_FORBIDDEN_EXTERNALS = new Set([
  "fastify",
  "@anthropic-ai/sdk",
  "better-sqlite3",
  "sqlite3",
]);

export const BROWSER_FORBIDDEN_EXTERNAL_PREFIXES = ["@fastify/", "@anthropic-ai/"];

export const HOST_MECHANISM_FORBIDDEN_EXTERNALS = new Set(["react", "react-dom", "pixi.js", "fastify"]);

export const HOST_MECHANISM_FORBIDDEN_EXTERNAL_PREFIXES = ["@fastify/"];

export const DEFINITION_FORBIDDEN_EXTERNALS = new Set([
  "react",
  "react-dom",
  "pixi.js",
  "fastify",
  "@anthropic-ai/sdk",
]);

export const DEFINITION_FORBIDDEN_EXTERNAL_PREFIXES = ["@fastify/", "@anthropic-ai/"];

export const NODE_BUILTIN_NAMES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "sqlite",
  "stream",
  "string_decoder",
  "test",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);
