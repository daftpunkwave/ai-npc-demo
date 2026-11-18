# 技术栈、工程约定与本地运行

> 状态：实现规范，首版照此搭建，不再二选一。版本约束取自 2026-11 npm 上的最新主版本，实际版本以 `pnpm-lock.yaml` 锁定为准；本机已验证 Node v26.13.1 的 `node:sqlite` 无需参数即可使用（WAL、`VACUUM INTO`、`backup()` 正常）。目录职责见 [代码目录](../architecture/code-structure.md)，实施顺序见 [构建计划](build-plan.md)。

## 1. 选型一览

| 类别 | 选择 | 版本约束 | 说明 |
|---|---|---|---|
| 运行时 | Node.js | 推荐 26 LTS，最低 24 | 使用内置 `node:sqlite`，不需要原生编译 |
| 包管理 | pnpm workspaces | `pnpm@12` | Node 25 起不再自带 corepack，用 `npm install -g pnpm@12` 安装 |
| 语言 | TypeScript | `typescript@^7` | `strict: true`；只用于类型检查（`noEmit`） |
| 运行 TS | tsx | `tsx@^4` | 服务端开发、启动与 `scripts/*.ts` 都用 tsx 直接运行源码 |
| HTTP/WS | Fastify | `fastify@^5`、`@fastify/websocket@^11`、`@fastify/static@^10` | 只在 `transport.http-ws.fastify` 适配器内出现 |
| 数据库 | SQLite | Node 内置 `node:sqlite`（`DatabaseSync`） | 同步 API、WAL、单写者；只在 `platform.storage.sqlite` 适配器内出现 |
| 校验 | Zod | `zod@^4` | 所有 DTO、配置、内容与 LLM 输出的唯一运行时校验；`z.toJSONSchema()` 生成工具与输出 schema |
| 配置/内容 | YAML | `yaml@^2` | `config/**`、`content/**` 都是 YAML，读入后用 Zod 校验 |
| 浏览器构建 | Vite | `vite@^8`、`@vitejs/plugin-react` | 客户端与控制台各一个 Vite 配置 |
| UI | React | `react@^19`、`react-dom@^19` | 不引入状态管理库与 CSS 框架 |
| 2.5D 场景 | PixiJS | `pixi.js@^8` | 只在 `client.scene-renderer.pixi` 适配器内出现 |
| Claude 调用 | Anthropic 官方 SDK | `@anthropic-ai/sdk@^1` | 只在 `platform.model-transport.anthropic` 适配器内出现 |
| OpenAI 兼容调用 | 内置 `fetch` | — | `platform.model-transport.openai-compatible` 直接发 HTTP，不引入 SDK |
| 单元/集成测试 | Vitest | `vitest@^5` | `pnpm test` |
| 端到端测试 | Playwright | `@playwright/test@^1` | 只用 Chromium；`pnpm test:e2e` |

首版不引入：Redis、Kafka、ORM、向量数据库、状态管理库、CSS 框架、微服务、Docker。ESLint/Prettier 可选，不作为完成条件；依赖边界由 `scripts/check-boundaries.ts` 强制。

## 2. Workspace 与包命名

根目录 `pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "modules/server/*/*/*"
  - "modules/client/*/*"
  - "modules/console/*/*"
  - "tests"
  - "scripts"
```

| 种类 | 目录规则 | 包名规则 | 例子 |
|---|---|---|---|
| 宿主应用 | `apps/<server\|client\|console>` | `@ai-npc/app-<name>` | `@ai-npc/app-server` |
| 共享包 | `packages/<name>` | `@ai-npc/<name>` | `@ai-npc/contracts` |
| server 模块 | `modules/server/<group>/<family>/<impl>` | `@ai-npc/mod-<moduleId 的点换成短横>` | `agent.memory.ledger` → `modules/server/agent/memory/ledger`，包名 `@ai-npc/mod-agent-memory-ledger` |
| client 模块 | `modules/client/<family>/<impl>` | 同上 | `client.hud.compact` → `modules/client/hud/compact` |
| console 模块 | `modules/console/<family>/<impl>` | 同上 | `console.observability.lite` → `modules/console/observability/lite` |

每个包都是“源码包”，不单独构建：

```json
{
  "name": "@ai-npc/mod-agent-memory-ledger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@ai-npc/contracts": "workspace:*",
    "@ai-npc/module-sdk": "workspace:*",
    "zod": "^4"
  }
}
```

规则：

- 包之间只能 import 对方 `exports` 暴露的入口（即 `@ai-npc/xxx`），禁止 `@ai-npc/xxx/src/...` 深层路径。
- 一个包 import 的每个 workspace 包都必须写在自己的 `dependencies` 里；`check-boundaries` 同时检查源码 import 与 `package.json`。
- 模块包只能依赖 `@ai-npc/contracts`、`@ai-npc/module-sdk`（server），或 `@ai-npc/contracts`、`@ai-npc/client-sdk`、`@ai-npc/client-protocol`（client/console），以及第三方库；不能依赖其他模块包。
- 每个模块包除了 `"."` 还导出 `"./definition": "./src/definition.ts"`。`definition.ts` 只含描述符数据，**不得静态 import 实现文件、React、PixiJS、Fastify 或模型 SDK**；`create` 用动态 `import("./plugin")` 加载实现。这样三个组合根的 `module-catalog.ts` 都能在 Node 中导入，供 `check-catalog` 使用。
- `tests` 与 `scripts` 两个包可以依赖任何 workspace 包（包括模块包），不受上面的限制。

## 3. TypeScript 配置

根目录三份配置。`contracts` 与 `kernel` 同时被两个程序编译，因此不能使用 Node 或 DOM 专有 API，这条规则由编译器直接保证。

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx"
  }
}
```

```jsonc
// tsconfig.server.json：Node 侧
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["node"] },
  "include": [
    "apps/server/src", "packages/contracts/src", "packages/kernel/src",
    "packages/module-sdk/src", "packages/authority/src", "packages/agent-runtime/src",
    "packages/experiment/src", "packages/observability/src",
    "modules/server", "scripts", "tests"
  ]
}
```

```jsonc
// tsconfig.browser.json：浏览器侧
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": [] },
  "include": [
    "apps/client/src", "apps/console/src", "packages/contracts/src", "packages/kernel/src",
    "packages/client-sdk/src", "packages/client-protocol/src", "modules/client", "modules/console"
  ]
}
```

源码 import 不写扩展名（`import { x } from "./x"`），由 tsx 与 Vite 解析。不要使用 Node 原生的 type stripping 运行源码。

## 4. 根脚本

| 命令 | 实际执行 | 结果 |
|---|---|---|
| `pnpm dev` | `tsx scripts/dev.ts` | 并行启动：服务端 `tsx watch apps/server/src/main.ts`（:3000）、客户端 `vite --config apps/client/vite.config.ts`（:5173）、控制台 `vite build --watch --config apps/console/vite.config.ts`（不监听端口，产物写入 `apps/server/console-static/`） |
| `pnpm dev:server` / `pnpm dev:client` | 只启动单侧 | 另一侧不可用时页面显示“服务端不可连接”，不新开端口 |
| `pnpm build` | 两次 `vite build` | 客户端产物 `apps/client/dist/`，控制台产物 `apps/server/console-static/` |
| `pnpm start` | `tsx scripts/start.ts` | 服务端 `tsx apps/server/src/main.ts` + 客户端 `vite preview --config apps/client/vite.config.ts`；先执行过 `pnpm build` |
| `pnpm typecheck` | `tsc -p tsconfig.server.json && tsc -p tsconfig.browser.json` | 两个程序都零错误 |
| `pnpm test` | `vitest run` | 单元、契约、集成、目录、场景测试 |
| `pnpm test:e2e` | `playwright test` | 两端口启动、玩家与控制台关键路径 |
| `pnpm check:boundaries` | `tsx scripts/check-boundaries.ts` | import 与依赖方向、realm 边界 |
| `pnpm check:catalog` | `tsx scripts/check-catalog.ts` | 模块 ID、能力闭包、`config/assemblies/*.yaml` 全部可解析 |
| `pnpm check:docs` | `tsx scripts/check-docs.ts` | 文档相对链接与锚点存在 |
| `pnpm check:ports` | `tsx scripts/check-ports.ts` | 启动 `pnpm start` 后只发现 :5173 与 :3000 两个本应用监听 |
| `pnpm check` | 见下文“`pnpm check` 的组成” | 每个构建步骤完成前必须通过 |
| `pnpm db:reset` | 删除 `NPC_DATA_DIR` 目录 | 下次启动重新建库并装载内容包 |

`scripts/dev.ts` 与 `scripts/start.ts` 先调用 `process.loadEnvFile()`（`.env` 不存在时跳过），再用 `node:child_process.spawn` 启动子进程并把环境变量传给它们；任一子进程退出时结束全部子进程并以非零码退出；不自动重启、不改端口。

上表是最终形态：S10 的 `dev` 仅启动 server/client，`build` 仅构建 client；S11 才加入 console 的 watch 构建、普通构建与静态资源挂载，S10 不引用 console 的 Vite 配置。`check:catalog` 按 realm 加载已存在的 catalog；某 realm 的 catalog 尚不存在时，只有全部待校验装配在该 realm 的 bindings 均为空才跳过加载，非空即失败，不得捕获其他加载错误后跳过。

每个脚本在实现它的那一步加入 `package.json`（见 [构建计划](build-plan.md) 第 0.2 节），不提前写占位脚本。`pnpm check` 的组成随步骤增长：S00 为 `pnpm typecheck && pnpm test && pnpm check:docs`；S03 起加入 `pnpm check:boundaries`；S09 起加入 `pnpm check:catalog`。它始终不包含 `test:e2e` 与 `check:ports`（这两项在要求它们的步骤里单独运行）。

## 5. 环境变量

根目录提交 `.env.example`，开发者复制为 `.env`（已在 `.gitignore`）。服务端入口在读取配置前调用 `process.loadEnvFile()`（文件不存在时跳过）。浏览器侧不读取任何密钥，API 一律用相对路径 `/api/v1/...`。

```dotenv
# deployment (two listeners only)
NPC_SERVER_HOST=127.0.0.1
NPC_SERVER_PORT=3000
NPC_CLIENT_PORT=5173
NPC_DATA_DIR=./data
NPC_LOG_LEVEL=info

# runtime selection for the online world (operations.md §10)
NPC_ASSEMBLY=local-slg-standard-v1
NPC_MODEL_LAYOUT=shared-model-layout-v1
NPC_ROSTER=standard-20

# local login tokens; generated and printed once when empty
NPC_PLAYER_TOKEN=
NPC_CONSOLE_TOKEN=
# optional single-role console tokens
NPC_OPERATOR_TOKEN=
NPC_RESEARCHER_TOKEN=
NPC_EVALUATOR_TOKEN=

# OpenAI-compatible provider (DeepSeek, Kimi, Qwen, Ollama, vLLM ...)
NPC_OPENAI_COMPAT_BASE_URL=https://provider.example/v1
NPC_OPENAI_COMPAT_API_KEY=
NPC_OPENAI_COMPAT_MODEL=

# Anthropic Claude (read by credentialRef env:ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=
```

部署参数只有这一个来源：主机、两个端口、数据目录、日志级别只从这些环境变量读取，由宿主在启动时并入 `transport.http-ws.fastify` 与 `platform.storage.sqlite` 的配置，装配文件里不写这些值；两个 Vite 配置也从同一组环境变量读取端口。时钟速度等游戏参数只在装配的 `configs` 里配置。密钥只经 `platform.secrets.env` 按 `credentialRef` 解析，详见 [模型传输](../agent/model-transport.md)。数据目录结构：`data/ai-npc.db`（主库）、`data/artifacts/`（大于 64 KB 的 artifact 正文）、`data/backups/`（`VACUUM INTO` 备份）、`data/dev-tokens.json`（自动生成的登录令牌）。

## 6. 本地双端拓扑

只有两个监听：`127.0.0.1:5173`（客户端）与 `127.0.0.1:3000`（服务端 + `/console`）。实现方式固定如下：

```ts
// apps/client/vite.config.ts (essential parts); env comes from scripts/dev.ts or scripts/start.ts
const host = process.env.NPC_SERVER_HOST ?? "127.0.0.1";
const clientPort = Number(process.env.NPC_CLIENT_PORT ?? 5173);
const api = { target: `http://${host}:${process.env.NPC_SERVER_PORT ?? 3000}`, ws: true, changeOrigin: false };
export default defineConfig({
  plugins: [react()],
  server: { host, port: clientPort, strictPort: true, proxy: { "/api": api } },
  preview: { host, port: clientPort, strictPort: true, proxy: { "/api": api } },
});
```

```ts
// apps/console/vite.config.ts (essential parts)
export default defineConfig({
  plugins: [react()],
  base: "/console/",
  build: { outDir: "../server/console-static", emptyOutDir: true },
});
```

- 客户端通过 :5173 内部的代理访问 `/api`，浏览器视角是同源，不需要 CORS 预检；Vite 的 HMR 复用 :5173。
- 控制台不跑 Vite dev server，只用 `vite build --watch` 生成静态文件，由服务端 `@fastify/static` 挂到 `/console/`；修改后刷新页面即可，没有 HMR。控制台是单页应用：`/console/*` 下找不到对应静态文件的 GET 请求一律返回 `index.html`，由前端路由处理；`/api/*` 不做这种回退。
- `strictPort: true` 与 Fastify 的 `listen` 失败即退出，端口被占用时启动失败，不会自动换成 5174 或 3001。
- 服务端对带 `Origin` 头的请求和 WS 握手校验 Origin 必须是 `http://<NPC_SERVER_HOST>:<NPC_CLIENT_PORT>` 或 `http://<NPC_SERVER_HOST>:<NPC_SERVER_PORT>`（默认即 `http://127.0.0.1:5173` 与 `http://127.0.0.1:3000`）。

## 7. 编码约定

模块 manifest 的 `requires` 声明实际消费的本 realm 能力，非 game 模块也必须填写并参与能力闭包与拓扑排序，不仅检查宿主固定必需能力或 `agentSlots`。例如 `agent.decision.model` 需要 `agent.model-pool`，模型池需要其使用的 `platform.model-transport`、`platform.budget`、`platform.observability` 与 `platform.secrets`；不得把这些依赖默认为宿主总会提供。声明按已实现职责填写，不提前要求未来步骤的可选功能；浏览器对服务端能力使用 `requiresRemote`，不能当成本地 `requires`。

- 只用 ESM 与命名导出；类型用 `import type`。
- 模块代码禁止直接调用 `Date.now()`、`Math.random()`、`crypto.randomUUID()`、`setTimeout`/`setInterval`、`process.env`、`fs`、网络。时间、等待（`host.sleep`）、随机源、ID、存储、模型与日志都从宿主注入的 `HostServices` 获得（见 [公共契约](../architecture/contracts.md) 第 3 节），测试因此能注入确定性实现。例外：`kind = adapter` 的模块可以通过它封装的第三方库做网络与文件 I/O（Fastify 监听端口、SQLite 读写文件、模型 SDK 或 `fetch` 发请求）；宿主代码（`apps/*`、`packages/*`）中的 worker 可以使用计时器。
- ID 统一为 `<前缀>-<12 位小写 base32>`，例如 `evt-k3j9x0a1b2c3`；前缀表见 [领域模型](../architecture/domain-model.md) 第 1 节。测试使用按序递增的 ID 生成器。
- 哈希统一为“规范 JSON（键按字典序、无空白）的 SHA-256 十六进制”；服务端用 `node:crypto`，浏览器用 `crypto.subtle`，由宿主注入 `hash` 函数。
- 领域错误统一抛 `DomainError(code, safeMessage, details?)`，`code` 只能取 [公共契约](../architecture/contracts.md) 第 6 节的错误码。
- 日志为 JSON 行，经宿主 logger 输出；模块内不写 `console.log`。
- 面向玩家的中文文本放在 `content/` 内容包或模板里；代码注释与标识符用英文。
- 单个源文件建议不超过 400 行；超过时按职责拆文件，不拆模块边界。

## 8. 测试放置

| 位置 | 内容 | 运行 |
|---|---|---|
| `modules/**/tests/*.test.ts` | 模块自身行为、参数边界 | `pnpm test` |
| `packages/*/tests/*.test.ts` | 宿主机制单元测试 | `pnpm test` |
| `tests/contract`、`tests/integration`、`tests/catalog`、`tests/scenarios` | 跨模块契约、事务/恢复、装配、多轮玩法 | `pnpm test` |
| `tests/e2e/*.spec.ts` | Playwright；`webServer` 先执行 `pnpm build` 再用 `pnpm start` 起两端（环境变量见下） | `pnpm test:e2e` |
| `tests/fixtures/` | 确定性模型脚本、场景输入脚本、期望快照 | 被以上测试读取 |

`vitest.config.ts` 放在根目录，`include` 为 `["packages/*/tests/**/*.test.ts", "modules/**/tests/**/*.test.ts", "tests/{contract,integration,catalog,scenarios}/**/*.test.ts"]`。需要真实模型的测试不进入 `pnpm test`，单独放在 `tests/live/`，只在设置了相应 API key 时手动运行。

`playwright.config.ts` 的 `webServer` 固定使用测试环境：`NPC_ASSEMBLY=local-slg-test-v1`、`NPC_MODEL_LAYOUT=deterministic-model-layout-v1`、`NPC_ROSTER=core-3`、`NPC_DATA_DIR=./data-e2e`、`NPC_PLAYER_TOKEN=e2e-player`、`NPC_CONSOLE_TOKEN=e2e-console`；命令为 `pnpm build && pnpm start`，启动前删除 `data-e2e/`，并以 `GET http://127.0.0.1:3000/api/v1/health` 返回 ready 作为就绪判据。`data-e2e/` 也加入 `.gitignore`。
