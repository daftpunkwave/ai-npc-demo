/**
 * 边界检查使用的固定白名单、扩展名映射与规则编号。
 * 白名单只在此维护，规则实现按 realm/kind 组合取用，不得就地增补。
 * 禁止在此引入文件系统访问、包清单解析或具体违规判定。
 */
import type { BoundaryRule, HeaderLanguage } from "./types";

// 规则编号与检查项固定对应，供 CLI 与测试断言逐条覆盖：
// 1 包公开入口与依赖声明，2 模块 realm/kind 白名单，3 浏览器 realm，4 kernel/contracts 限制，
// 5 宿主应用组合根，6 依赖图、动态加载与未使用声明，7 手写源码文件头，8 共享契约唯一定义。
export const RULE_IMPORT_BOUNDARY: BoundaryRule = 1;
export const RULE_MODULE_REALM: BoundaryRule = 2;
export const RULE_BROWSER_REALM: BoundaryRule = 3;
export const RULE_HOST_MECHANISM: BoundaryRule = 4;
export const RULE_COMPOSITION_ROOT: BoundaryRule = 5;
export const RULE_DEPENDENCY_GRAPH: BoundaryRule = 6;
export const RULE_SOURCE_HEADER: BoundaryRule = 7;
export const RULE_SHARED_CONTRACT: BoundaryRule = 8;

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

export const SERVER_MODULE_WORKSPACE_DEPENDENCIES = ["@world-prism/contracts", "@world-prism/module-sdk"] as const;

export const BROWSER_MODULE_WORKSPACE_DEPENDENCIES = [
  "@world-prism/contracts",
  "@world-prism/client-sdk",
  "@world-prism/client-protocol",
] as const;

export const SERVER_ONLY_WORKSPACE_PACKAGES = new Set([
  "@world-prism/authority",
  "@world-prism/agent-runtime",
  "@world-prism/module-sdk",
  "@world-prism/experiment",
  "@world-prism/observability",
  "@world-prism/app-server",
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

/**
 * 跨包共享契约名到唯一所有者包的映射。名单内的名字只能由所有者包的生产源码声明，
 * 其他包须从所有者导入；同名再声明一份即使结构相同，也会在后续修改中各自漂移。
 * 只列出当前确有声明的名字：所有者包有源码参与扫描时，检查会核对名单没有过期。
 */
export const SHARED_CONTRACT_OWNERS: ReadonlyMap<string, string> = new Map([
  // 访问裁决端口：传输层与名册 provider 各写一份时，拒绝原因的类型已经出现分歧。
  ["AccessAction", "@world-prism/module-sdk"],
  ["AccessRequest", "@world-prism/module-sdk"],
  ["AccessDecisionReason", "@world-prism/module-sdk"],
  ["AccessDecision", "@world-prism/module-sdk"],
  ["AccessPolicy", "@world-prism/module-sdk"],
  // 上下文段名与段预算：请求契约与上下文模块配置必须按同一份段名校验。
  ["ContextUserSegmentKind", "@world-prism/contracts"],
  ["ContextSegmentKind", "@world-prism/contracts"],
  ["contextSegmentBudgetsSchema", "@world-prism/contracts"],
  // 宿主注入面与存储端口：模块只经这些契约取得时间、随机数、I/O 与存储事务。
  ["HostServices", "@world-prism/contracts"],
  ["StoragePort", "@world-prism/contracts"],
  ["StorageTransaction", "@world-prism/contracts"],
  // 宿主绑定给模块的 typed port：内容视图、存档与观测数据源。
  ["GameContent", "@world-prism/module-sdk"],
  ["SavePort", "@world-prism/module-sdk"],
  ["ObservabilitySources", "@world-prism/module-sdk"],
]);

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
