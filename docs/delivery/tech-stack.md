# 技术栈、工程约定与本地运行

> 本文规定首版技术栈与工程约定。已经引入的依赖以 `pnpm-lock.yaml` 锁定的版本为准。本机已验证 Node v26.13.1 支持 `node:sqlite` 的 WAL、`VACUUM INTO` 和 `backup()`；`engines.node` 声明运行时下限 `>=24`，`@types/node` 按 `^26` 描述类型面，24/25 运行时未经验证，开发与运行环境按 v26 执行。参见 [code-structure.md — 代码目录](../architecture/code-structure.md)、[build-plan.md — 构建计划](build-plan.md)。

## 1. 选型一览

| 类别 | 选择 | 版本约束 | 说明 |
|---|---|---|---|
| 运行时 | Node.js | 推荐 26 LTS，最低 24 | 使用内置 `node:sqlite`，不需要原生编译 |
| 包管理 | pnpm workspaces | `pnpm@12` | Node 25 起不再自带 corepack，用 `npm install -g pnpm@12` 安装 |
| 语言 | TypeScript | `typescript@^7` | `strict: true`；只用于类型检查（`noEmit`） |
| 运行 TS | tsx | `tsx@^4` | 服务端开发、启动与 `scripts/*.ts` 都用 tsx 直接运行源码 |
| HTTP/WS | Fastify | `fastify@^5`、`@fastify/cors@^11`、`@fastify/websocket@^11`、`@fastify/static@^10`、`@fastify/rate-limit@^11` | Fastify 及插件的生产使用限于 `transport.http-ws.fastify` 适配器，依赖由该适配器包的 manifest 声明 |
| 数据库 | SQLite | Node 内置 `node:sqlite`（`DatabaseSync`） | 同步 API、WAL、单写者；只在 `platform.storage.sqlite` 适配器内出现 |
| 校验 | Zod | `zod@^4`（锁定 `4.6.7`） | 所有 DTO、配置、内容与 LLM 输出的唯一运行时校验；`z.toJSONSchema()` 生成工具与输出 schema。多数包声明下限 `^4`，`packages/experiment` 另声明 `^4.6.7` 下限，新增使用方按实现所需下限声明 |
| 配置/内容 | YAML | `yaml@^2` | `config/**`、`content/**` 都是 YAML，读入后用 Zod 校验 |
| 资产校验脚本 | fast-xml-parser | `fast-xml-parser@^5` | 解析资产包 SVG/XML，只被 `scripts/check-assets.ts` 引用，由 `scripts` 包声明 |
| 浏览器构建 | Vite | `vite@^8`、`@vitejs/plugin-react` | 客户端与控制台各一个 Vite 配置 |
| Web UI | React | `react@^19`、`react-dom@^19` | 用于 TS 控制台和现行网页灰盒 |
| 2.5D 灰盒场景 | PixiJS | `pixi.js@^8` | 现行网页适配器 `client.scene-renderer.pixi` |
| Claude 调用 | Anthropic 官方 SDK | `@anthropic-ai/sdk@^1` | 只在 `platform.model-transport.anthropic` 适配器内出现 |
| OpenAI 兼容调用 | 内置 `fetch` | — | `platform.model-transport.openai-compatible` 直接发 HTTP，不引入 SDK |
| 单元/集成测试 | Vitest | `vitest@^5` | `pnpm test` |
| 端到端测试 | Playwright | `@playwright/test@^1` | 只用 Chromium；`pnpm test:e2e` |

首版不引入：Redis、Kafka、ORM、向量数据库、状态管理库、CSS 框架、微服务、Docker。ESLint/Prettier 可选，不作为完成条件；依赖边界由 `scripts/check-boundaries.ts` 强制。

### Godot 原生玩家端目标

新玩家端交付 Windows x64 桌面包。使用最新稳定的 Godot .NET 编辑器、匹配的 .NET 导出模板和最新稳定 .NET SDK。以 2026-11-24 为核对日期，候选组合为 Godot `4.7.2-stable` 和 .NET SDK `11.0.100`，目标框架为 `net11.0`。Godot 的桌面项目生成器默认设置 `net8.0`。在目标机完成 C# 场景启动和 Windows x64 导出实测后，固定验证通过的工具链。正式迁移以目标框架的运行和导出结果为准。 [Godot 稳定发布](https://godotengine.org/download/archive/4.7.2-stable) · [.NET 11 下载](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) · [Godot 桌面项目生成器](https://github.com/godotengine/godot/blob/4.7.2-stable/modules/mono/editor/GodotTools/GodotTools.ProjectEditor/ProjectGenerator.cs)

原生工程独立于 pnpm。C# 核心与网络适配使用 .NET 标准库，Godot 入口使用锁定的 `Godot.NET.Sdk` 与随版本发布的引擎程序集。用客户端目录内的 `global.json` 固定 .NET SDK，用项目引用表达依赖，用 NuGet 锁文件验证适用项目的可重复还原。客户端级 `Directory.Build.props` 固定 `RuntimeIdentifier=win-x64`，使常规还原、验证与 Godot `ExportRelease` 使用相同 RID。通过 `RestoreLockedMode` 覆盖导出时的隐式还原。新增第三方依赖沿用仓库审批要求，并在所属适配器内声明。 [Godot 发布实现](https://github.com/godotengine/godot/blob/4.7.2-stable/modules/mono/editor/GodotTools/GodotTools/Build/BuildManager.cs) · [NuGet 锁定还原](https://learn.microsoft.com/nuget/consume-packages/package-references-in-project-files#locking-dependencies) · [code-structure.md — Godot 玩家端目录](../architecture/code-structure.md#godot-玩家端目录)

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
| 宿主应用 | `apps/<server\|client\|console>` | `@world-prism/app-<name>` | `@world-prism/app-server` |
| 共享包 | `packages/<name>` | `@world-prism/<name>` | `@world-prism/contracts` |
| server 模块 | `modules/server/<group>/<family>/<impl>` | `@world-prism/mod-<moduleId 的点换成短横>` | `agent.memory.ledger` → `modules/server/agent/memory/ledger`，包名 `@world-prism/mod-agent-memory-ledger` |
| client 模块 | `modules/client/<family>/<impl>` | 同上 | `client.hud.compact` → `modules/client/hud/compact` |
| console 模块 | `modules/console/<family>/<impl>` | 同上 | `console.observability.lite` → `modules/console/observability/lite` |

每个包都是“源码包”，不单独构建：

```json
{
  "name": "@world-prism/mod-agent-memory-ledger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@world-prism/contracts": "workspace:*",
    "@world-prism/module-sdk": "workspace:*",
    "zod": "^4"
  }
}
```

规则：

- 包之间只能 import 对方 `exports` 暴露的入口（即 `@world-prism/xxx`），禁止 `@world-prism/xxx/src/...` 深层路径。
- 一个包 import 的每个 workspace 包都必须写在自己的 `dependencies` 里；生产源码 import 的第三方库也必须写在自己的 `dependencies` 里（仅测试文件豁免，`*.config.ts` 工具入口按第 1 节由 devDependencies 供给）；根清单不声明生产依赖，运行时职责全部落在应用包与模块包。`check-boundaries` 同时检查源码 import 与 `package.json`。
- 模块生产源码及 `dependencies` 按下表的 realm/kind 白名单检查；未列出的库不因“纯工具”或 adapter 身份自动获准。测试工具仅用于测试，构建工具仅用于源码配置，不得被生产实现引用。新增依赖先评审并更新本表，不允许跨模块实现依赖。
- `modules/**/tests/**` 下的模块测试不属于生产源码，可以使用 vitest、Node 内置模块与宿主机制包的公开入口；深层导入、跨模块实现依赖与循环依赖仍照常检查。

| realm / kind | workspace 入口 | 外部依赖与环境边界 |
|---|---|---|
| server / service、contributor | `@world-prism/contracts`、`@world-prism/module-sdk` | `zod`；环境能力由 HostServices 注入 |
| server / adapter | 同上 | `zod`；另仅按第 1 节所属适配器使用 Fastify 及其插件、`node:sqlite`、Anthropic SDK 或内置 `fetch`；`platform.storage.sqlite` 另可用 `node:fs`、`node:path`、`node:url` 读取迁移与读写库文件；不因此获得任意环境访问权限 |
| client、console / service、contributor | `@world-prism/contracts`、`@world-prism/client-sdk`、`@world-prism/client-protocol` | `zod`、UI 所需 `react`；无 Node、数据库、模型 SDK 或直接后端网络访问 |
| client、console / adapter | 同上 | 同上；仅 `client.scene-renderer.pixi` 使用 `pixi.js`；仍只经 typed protocol 访问后端 |

`react-dom` 的根挂载归浏览器宿主；YAML 解析归配置/内容加载边界，不给所有模块开放。上述技术库版本见第 1 节。适配器只封装它负责的外部技术，第三方类型不泄漏到公共 port。

源码依赖包括静态 import、re-export、字面量动态 import 及相对路径跨包引用；生产模块禁止非字面量动态加载；检查脚本仅可从显式、已校验的 catalog 路径加载定义，不得扫描执行任意模块。包依赖图同时检查 `dependencies` 与实际引用，不允许借未使用的依赖声明或 devDependencies 藏入生产依赖。运行时 `requires` 是能力 port 的依赖图，浏览器 `requiresRemote` 经握手校验，不授权源码 import provider 的实现；三种检查不能互相替代。
- 每个模块包除了 `"."` 还导出 `"./definition": "./src/definition.ts"`。`definition.ts` 只含描述符数据，**不得静态 import 实现文件、React、PixiJS、Fastify 或模型 SDK**；`create` 用动态 `import("./plugin")` 加载实现。这样三个组合根的 `module-catalog.ts` 都能在 Node 中导入，供 `check-catalog` 使用。
- `tests` 与 `scripts` 两个包可为验证依赖任意 workspace 的公开入口（包括模块包），但不豁免深层导入、循环依赖或生产源码边界。这两个包的源码同样必须声明依赖：其验证用途的 workspace 与第三方依赖可写在 `devDependencies`，其余包仍要求写在 `dependencies`。测试夹具不作为生产模块加载。

### 依赖供应链与构建批准

`pnpm-workspace.yaml` 固化下述策略，使供应链约束由仓库决定，而不是由贡献者本机的 pnpm 配置决定：

| 设置 | 取值 | 约束 |
|---|---|---|
| `minimumReleaseAge` | `1440` 分钟 | 新发布版本经过 24 小时等待期后才可安装，覆盖传递依赖 |
| `minimumReleaseAgeStrict` | `true` | 请求范围内没有满足等待期的版本时安装失败，不回退到未满期版本 |
| `trustPolicy` | `no-downgrade` | 包的可信级别相对历史版本下降即拒绝安装；合法降级用 `trustPolicyExclude` 逐条豁免并注明理由 |
| `blockExoticSubdeps` | `true` | 传递依赖只能来自 registry、workspace 包或受信任的托管仓库 |
| `strictDepBuilds` | `true` | 未经裁决的构建脚本使安装失败，而不是留在待审批队列 |
| `allowBuilds` | `esbuild: true` | 仅 esbuild 可运行安装脚本；其余依赖的构建脚本保持拒绝 |
| `permissions.<pkg>.skills` | 逐包裁决 | 依赖随包发布的 agent skill 默认不链接；批准或拒绝都记录在此，不留待审批状态 |

新增依赖时按同一清单评审：是否携带安装脚本、是否携带 agent skill、是否引入非标准来源。任一项命中都必须在上表对应位置显式裁决并写明理由。


## 3. TypeScript 配置

根目录三份配置。`contracts` 与 `kernel` 同时被两个程序编译，因此不能使用 Node 或 DOM 专有 API，这条规则由编译器直接保证。

```jsonc
// 基础 TypeScript 配置
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
    "apps/server/src", "apps/server/tests", "packages/contracts/src", "packages/kernel/src",
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
    "apps/client/src", "apps/console/src", "apps/console/tests", "packages/contracts/src", "packages/kernel/src",
    "packages/client-sdk/src", "packages/client-protocol/src", "modules/client", "modules/console"
  ]
}
```

源码 import 不写扩展名（`import { x } from "./x"`），由 tsx 与 Vite 解析。不要使用 Node 原生的 type stripping 运行源码。

## 4. 根脚本

| 命令 | 状态 | 执行方式 | 结果 |
|---|---|---|---|
| `pnpm dev:server` | 已实现 | `tsx apps/server/src/main.ts` | 启动本地服务端（:3000） |
| `pnpm dev:client` | 已实现 | Vite | 启动玩家客户端（:5173） |
| `pnpm dev` | 已实现 | `tsx scripts/dev.ts` | 并行启动服务端和客户端，监听控制台源码变更并构建到 `apps/server/console-static/` |
| `pnpm build` | 已实现 | 两次 `vite build` | 客户端产物 `apps/client/dist/`，控制台产物 `apps/server/console-static/` |
| `pnpm start` | 已实现 | `tsx scripts/start.ts` | 在 `pnpm build` 后运行服务端与客户端 Vite preview |
| `pnpm typecheck` | 已实现 | `tsc -p tsconfig.server.json && tsc -p tsconfig.browser.json` | 检查服务端与浏览器的 TypeScript |
| `pnpm test` | 已实现 | `vitest run` | 单元、契约、集成、目录、场景测试 |
| `pnpm test:e2e` | 已实现 | `playwright test` | 两端口启动、玩家与控制台关键路径 |
| `pnpm check:boundaries` | 已实现 | `tsx scripts/check-boundaries.ts` | 源码与包依赖图、realm/kind 白名单、原生源码 header、中文说明与三项完整性 |
| `pnpm check:catalog` | 已实现 | `tsx scripts/check-catalog.ts` | 检查装配的 realm/kind、能力闭包、作用域、重复绑定、拓扑和配置 schema |
| `pnpm check:assets` | 已实现 | `tsx scripts/check-assets.ts` | 核对资产清单、版本与内容包覆盖 |
| `pnpm check:docs` | 已实现 | `tsx scripts/check-docs.ts` | 检查相对链接、锚点与表格列数 |
| `pnpm check:ports` | 已实现 | `tsx scripts/check-ports.ts` | 启动后核对应用只监听 :5173 与 :3000，并验证端口占用失败 |
| `pnpm measure:model-evidence` | 已实现 | `tsx scripts/measure-model-evidence.ts` | 在临时目录生成三轮模型档案实测落盘字节与清理查询计划 |
| `pnpm check` | 已实现 | 见下文 “`pnpm check` 的组成” | 每个构建步骤完成前必须通过 |

`scripts/dev.ts` 与 `scripts/start.ts` 先调用 `process.loadEnvFile()`（`.env` 不存在时跳过），再用 `node:child_process.spawn` 启动子进程并把环境变量传给它们；任一子进程退出时结束全部子进程并以非零码退出；不自动重启、不改端口。

`dev` 启动 server/client 与控制台 watch 构建，`build` 构建 client/console，服务端挂载控制台静态资源。`check:catalog` 扫描 `config/assemblies/*.yaml` 并加载三 realm 组合根登记的模块；主装配的 client/console 绑定均已非空。

每个脚本在实现它的那一步加入 `package.json`（见 [构建计划](build-plan.md) 第 0.2 节），不提前写占位脚本。`pnpm check` 的组成随步骤增长：S00 为 `pnpm typecheck && pnpm test && pnpm check:docs`；S03 起加入 `pnpm check:boundaries`；S09 起加入 `pnpm check:catalog`；资产包入仓后加入 `pnpm check:assets`。它始终不包含 `test:e2e` 与 `check:ports`（这两项在要求它们的步骤里单独运行）。

### 远端质量门禁

`.github/workflows/check.yml` 在 `main` 的每次 push 与每个 pull request 上以 `pnpm install --frozen-lockfile` 安装依赖并运行 `pnpm check`，因此上表的检查在远端强制执行，而不只依赖本地执行。工作流固定 Node `26.13.1`（与本机验证一致，满足 `engines.node >= 24` 下限），由 `pnpm/action-setup` 读取 `packageManager` 字段确定 pnpm 版本，并对同一分支的新推送取消上一轮未完成的运行。

`.codacy.yml` 只声明分析范围（排除测试、夹具、锁文件与已发布迁移），与工作流不重复；工作流负责仓库自有的六项检查，Codacy 负责外部静态分析。新增检查项时加入 `pnpm check` 脚本链即可同时进入本地与远端门禁，无需改工作流。


## 5. 环境变量

本地启动时，将仓库根目录的环境变量示例复制为 `.env`（已在 `.gitignore`）。服务端读取配置前调用 `process.loadEnvFile()`，没有该文件时继续使用进程环境。浏览器侧不读取密钥，API 使用相对路径 `/api/v1/...`。[.env.example — 当前环境变量示例](../../.env.example)

服务端默认名册为 `standard-15`，序章开放公社开局。单份名册最多 15 个身份，开局和恢复事务校验部署级活动身份配额。参见 [IMPLEMENTATION-STATUS.md — 身份配额](../IMPLEMENTATION-STATUS.md#31-身份配额)。

部署参数只有这一个来源：主机、两个端口、数据目录、控制台静态产物目录、日志级别只从这些环境变量读取，由宿主在启动时并入 `transport.http-ws.fastify` 与 `platform.storage.sqlite` 的配置（存储适配器的 `dataDir` 取自 `NPC_DATA_DIR`，控制台静态目录取自 `NPC_CONSOLE_STATIC_DIR`，缺省 `apps/server/console-static`），装配文件里不写这些值；两个 Vite 配置也从同一组环境变量读取端口。相对路径一律按仓库根解析，不按进程工作目录派生，因此从任意工作目录启动服务端都挂载到同一份构建产物。时钟速度等游戏参数只在装配的 `configs` 里配置。密钥只经 `platform.secrets.env` 按 `credentialRef` 解析，详见 [模型传输](../agent/model-transport.md)。数据目录结构：`data/world-prism.db`（主库）、`data/artifacts/`（大于 64 KB 的 artifact 正文）、`data/backups/`（`VACUUM INTO` 备份）、`data/dev-tokens.json`（自动生成的登录令牌）。

开发数据的重置方式见 [operations.md — 重置开发数据](../platform/operations.md#101-重置开发数据)；旧在线 run 的能力闭包升级迁移开关 `NPC_MIGRATE_ONLINE_RUN` 见 [operations.md — 能力闭包升级迁移](../platform/operations.md#102-能力闭包升级迁移)。

## 6. 本地双端拓扑

现行网页模式监听 `127.0.0.1:5173` 与 `127.0.0.1:3000`。Godot 目标拓扑见 [two-endpoints.md — 原生 Demo 部署目标](../architecture/two-endpoints.md#原生-demo-部署目标)。以下配置适用于迁移切换前的网页模式。

```ts
// 客户端 Vite 配置（关键部分）；环境变量由 dev/start 脚本提供
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
// 控制台 Vite 配置（关键部分）
export default defineConfig({
  plugins: [react()],
  base: "/console/",
  build: { outDir: "../server/console-static", emptyOutDir: true },
});
```

- 客户端通过 :5173 内部的代理访问 `/api`，浏览器视角是同源，不需要 CORS 预检；Vite 的 HMR 复用 :5173。
- 控制台不跑 Vite dev server，只用 `vite build --watch` 生成静态文件，由服务端 `@fastify/static` 以 wildcard 模式挂到 `/console/`；每个请求按请求路径直接读盘，因此构建后新增的 hash 资产无需重启服务端即可访问，修改后刷新页面即可，没有 HMR。控制台是单页应用，但回退有边界：只有 GET/HEAD、路径以 `/console/` 开头、末段（URL 解码后）无扩展名、且 `index.html` 实际存在时，找不到静态文件才返回 `index.html` 交给前端路由；带扩展名的资产请求缺失时返回 404 统一错误，绝不以 200 `text/html` 冒充 JS/CSS（否则浏览器会把 HTML 当脚本执行并白屏，且状态码掩盖故障）；入口文件缺失期间同样直接 404，不重复回退。`/api/*` 不做这种回退。
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
- 面向玩家的中文文本放在 `content/` 内容包或模板里；代码注释默认中文并保留英文专有名词，标识符遵循语言与生态命名惯例。
- 单个源文件建议不超过 500 行；超过时按职责拆文件，不拆模块边界。

### 7.1 手写源码文件头

每个手写源码文件（含测试、脚本、迁移与源码配置）使用语言原生的中文注释 header（保留英文专有名词），至少分别说明该文件的功能职责、依赖契约及禁止事项。按实际文件编写，不套用与实现无关的口号；所有代码注释与 header 均只解释代码本身，不引用开发文档路径、链接或构建阶段编号；脱离开发文档也应能理解职责和约束。

```ts
/**
 * 在分发到已绑定的 authority port 前校验命令信封。
 * 依赖命令 schema 与注入的授权契约。
 * 禁止执行游戏规则或持久化世界状态。
 */
```

TypeScript/JavaScript 用 JSDoc/TSDoc 块注释（`/** ... */`），Python 用 PEP 257 模块 docstring（位于可选 shebang/编码声明之后），shell 用 `#`，SQL 用 `--`，CSS 用块注释，HTML 用原生注释；有 shebang 时保留首行，header 紧随其后。JSON、锁文件、二进制、第三方代码与生成产物不插入注释；数据配置不伪装成源码。Markdown 用标题与范围说明，不强塞代码式 header。函数仅在非直观约束或原因需要解释时注释，不机械重复签名。

`pnpm check:boundaries` 已检查 header 的存在性、原生格式、说明性注释的中文内容，以及开发文档或阶段引用。使用规范类别标签的 header 还必须同时包含职责、交互契约与约束禁忌三类标签；未带类别标签的旧 header 只通过至少三条不同说明做结构检查，语义完整性仍由人工复核。已发布 SQLite 迁移受 `schema_migrations` 校验和保护，不得为补写注释而修改原文；这些历史文件保留发布时文本，新增迁移仍须遵循本节。

## 8. 测试放置

| 位置 | 内容 | 运行 |
|---|---|---|
| `apps/*/tests/*.test.ts` | 应用内部的宿主端口与界面行为 | `pnpm test` |
| `modules/**/tests/*.test.ts` | 模块自身行为、参数边界 | `pnpm test` |
| `packages/*/tests/*.test.ts` | 宿主机制单元测试 | `pnpm test` |
| `tests/contract`、`tests/integration`、`tests/catalog`、`tests/scenarios` | 跨模块契约、事务/恢复、装配、多轮玩法 | `pnpm test` |
| `tests/e2e/*.spec.ts` | Playwright；`webServer` 先执行 `pnpm build` 再用 `pnpm start` 起两端（环境变量见下） | `pnpm test:e2e` |
| `tests/fixtures/` | 确定性模型脚本、场景输入脚本、期望快照 | 被以上测试读取 |

`vitest.config.ts` 放在根目录，`include` 为 `["apps/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts", "modules/**/tests/**/*.test.ts", "tests/{contract,integration,catalog,scenarios}/**/*.test.ts"]`。需要真实模型的测试不进入 `pnpm test`，单独放在 `tests/live/`，只在设置了相应 API key 时手动运行。

`playwright.config.ts` 的 `webServer` 固定使用测试环境：`NPC_ASSEMBLY=local-slg-test-v1`、`NPC_MODEL_LAYOUT=deterministic-model-layout-v1`、`NPC_ROSTER=core-3`、`NPC_DATA_DIR=./data-e2e/run-<pid>`、`NPC_SERVER_HOST=127.0.0.1`、`NPC_SERVER_PORT=3000`、`NPC_CLIENT_PORT=5173`、`NPC_PLAYER_TOKEN=e2e-player`、`NPC_CONSOLE_TOKEN=e2e-console`、`NPC_OPERATOR_TOKEN=e2e-operator`、`NPC_RESEARCHER_TOKEN=e2e-researcher`、`NPC_EVALUATOR_TOKEN=e2e-evaluator`；命令为 `pnpm build && pnpm start`，每次运行使用独立的 `data-e2e/run-<pid>` 目录（以进程号隔离，Playwright 在 webServer 启动前清空该目录，保证全新世界），并以 `GET http://127.0.0.1:3000/api/v1/health` 返回 ready 作为就绪判据。`data-e2e/` 也加入 `.gitignore`。
