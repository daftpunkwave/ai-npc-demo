# 目标代码目录与扩展工作流

> 状态：部分实现。`apps/server`、`apps/client`、`apps/console`、服务端、客户端和控制台首批模块与共享包已按此结构交付。Agent 认知 provider 与三种模型传输已进入装配。剩余控制台职能仍为目标。参见 [modules.md — 模块边界](modules.md)、[module-catalog.md — 模块目录](module-catalog.md)、[composition.md — 装配](composition.md)。

## 1. 目录树

下列目录树记录 TypeScript 工程。原生玩家端的目标目录见 [Godot 玩家端目录](#godot-玩家端目录)。

模块目录与包名的映射规则见 [技术栈](../delivery/tech-stack.md) 第 2 节：server 模块在 `modules/server/<group>/<family>/<impl>/`，浏览器模块在 `modules/<client|console>/<family>/<impl>/`，每个目录是一个 workspace 源码包。

```text
world-prism/
  AGENTS.md  CLAUDE.md            # shared rules and reference entry
  AGENTS.local.md  CLAUDE.local.md # optional local supplements (git-ignored)
  package.json  pnpm-workspace.yaml  tsconfig.base.json  tsconfig.server.json  tsconfig.browser.json
  vitest.config.ts  playwright.config.ts  .env.example
  apps/
    server/                      # server host (Node, :3000)
      src/
        main.ts                  # load env -> open storage -> load content/config -> startHost -> listen
        host.ts  startup.ts  projection.ts  tick.ts  shutdown.ts  host-services.ts  config.ts  process-faults.ts
        projection/              # pure read-side projection builders (campaign, comms, meters, resources, tasks, agreements, notifications)
        host/                    # host orchestration: assembly, catalog-check, dispose, operations, console-research, evaluation-read, run/branch/manifest lifecycle (experiment/run writes, manifest freezing, run control), online-agents
      console-static/            # built console assets served at /console/* (generated, git-ignored)
    client/                      # client host (browser, :5173)
      index.html
      vite.config.ts
      src/
        main.tsx
        host/
          bootstrap.tsx          # login from #token, handshake, module loading, slots, error boundaries
          module-catalog.ts      # explicit imports of every client module definition
    console/                     # console host (browser, served by :3000/console)
      index.html
      vite.config.ts
      src/
        main.tsx
        host/
          bootstrap.tsx          # login, active role switch, handshake, route/panel slots
          module-catalog.ts      # explicit imports of every console page module
  packages/
    contracts/                   # zod schemas + types: envelopes, commands, events, DTOs, ports, descriptors, API, content-pack/roster/resolved-profile shapes
    kernel/                      # realm-agnostic host mechanics: descriptor validation, registry, capability graph, lifecycle, slots, hook order, config resolution, hashing
    module-sdk/                  # server module authoring helpers: defineModule, scoped ports, disposers
    client-sdk/                  # browser module helpers: slot components, preference port, projection hooks
    client-protocol/             # typed HTTP/WS client and projection reducer protocol
    authority/                   # command gateway, transactions, idempotency, fencing, job runner, consumers
    agent-runtime/               # trigger store, scheduler host, turn state machine, tool gateway, speech pipeline
    experiment/                  # experiment environment loading: content packs, rosters, RunSpecs, profiles, toolsets, model layouts, experiment specs (YAML + cross-checks); no run lifecycle or scoring
    observability/               # reserved package, exports only its name; trace/span schemas live in contracts
  modules/
    server/
      game/
        world/slg-light/         # game.world.slg-light
        map/six-nodes/           # game.map.six-nodes
        clock/controlled/        # game.clock.controlled
        resources/light/         # game.resources.light
        actions/standard/        # game.actions.standard
        agreements/standard/     # game.agreements.standard
        comms/standard/          # game.comms.standard
        scenario/watergate/      # game.scenario.watergate 及 watergate-escalating
        save/sqlite/             # game.save.sqlite
      agent/
        perception/local/
        memory/none/  memory/ledger/   # memory/ledger 同时提供 ledger、stream-reflection 与 layered-hybrid
        context/ordered-blocks/
        compression/none/  compression/window/
        tool-view/structured/
        decision/model/  decision/deterministic/
        scheduling/fair/
        model-pool/shared/
        tools/game-tools/
      platform/
        access-policy/roster/  budget/standard/  storage/sqlite/  observability/sqlite/
        evaluation/standard/  operations/standard/  module-admin/standard/  secrets/env/
        model-transport/openai-compatible/  model-transport/anthropic/  model-transport/deterministic/
      transport/
        http-ws/fastify/
    client/
      world-view/standard/  scene-renderer/pixi/  scene-renderer/null/  camera/standard/
      screen-projection/isometric/  input/standard/  hud/standard/
      dialogue/standard/  faction-start/standard/  characters/standard/  settings/standard/
      notifications/standard/    # hud/compact/ 为 S24 替换目标，尚未创建
    console/
      health/standard/  module-admin/standard/  model-mounts/standard/  faction-ops/standard/
      observability/standard/  evaluation/standard/  debug/standard/
      # scenario-editor/standard/、observability/lite/、audit/standard/ 为后续目标，尚未创建
  config/
    assemblies/                  # standard, test and escalating are present; HUD and console swaps arrive in S24
    profiles/                    # platform baseline, scene profile, agent profiles, memory variant patches
    rosters/                     # standard-15, core-3
    model-layouts/               # shared-, claude-, deterministic-model-layout-v1
    toolsets/                    # character-default, character-broadcaster, strategic-default
    # presets/                   # 玩家测试申请预设目录为后续目标，尚未创建
    runs/                        # online RunSpec templates
    experiments/                 # experiment specs (variants × script branches × repetitions)
    pricing.yaml  pricing-live.yaml
  content/
    world-packs/earth-2964-v1/   # see docs/game/content-pack.md
  tests/
    contract/  integration/  catalog/  scenarios/  e2e/  live/  fixtures/
  scripts/
    dev.ts  start.ts  check-boundaries.ts  check-catalog.ts  check-docs.ts  check-ports.ts  check-assets.ts  measure-model-evidence.ts
  data/                          # runtime database, artifacts, backups, dev tokens (git-ignored)
  docs/
```

首版的场景渲染不需要美术资源：节点、道路、角色、队伍都用 PixiJS 的矢量图元绘制（见 [客户端](client-and-rendering.md) 第 8 节）。

每个模块目录都是一个 workspace 源码包（不单独构建），包内按职责拆文件；不为零逻辑的转发层新建包。应用组合根只装配，packages 只提供机制，modules 按 realm/能力/实现承载职能，config 选择组合，content 保存内容，tests 提供验证。routes/workers/sessions 不能成为隐藏业务规则、认知策略或平台功能的容器。

## 2. 三个宿主，三个组合根

| 入口 | 组合根 | 允许依赖 | 禁止 |
|---|---|---|---|
| `apps/server` | `src/host.ts` 与 `src/host/module-catalog.ts` | server 实现、contracts/kernel/module-sdk、浏览器模块定义 | 浏览器实现、DOM/PixiJS、console 页面代码 |
| `apps/client` | `host/module-catalog.ts` + `host/bootstrap.tsx` | client 模块、contracts/kernel/client-sdk/client-protocol | Node 内置模块、数据库、密钥、server 模块实现 |
| `apps/console` | `host/module-catalog.ts` + `host/bootstrap.tsx` | console 模块、contracts/kernel/client-sdk/client-protocol | 服务端对象、直接数据库/模型连接；玩家域私有投影 |

每个宿主只有一个实例级 registry；模块通过显式 import 清单登记，禁止文件系统扫描自动执行，也禁止模块在 import 时向全局 Map 自注册。TypeScript 服务端负责解析装配。两个浏览器宿主使用同一客户端 SDK 校验并加载握手返回的本域模块。Godot 的目录与依赖见 [Godot 玩家端目录](#godot-玩家端目录)。

`apps/server` 对 console 静态资源只做挂载以及权限和缓存策略；console 前端仍然是独立的构建产物，由 server 的 HTTP 路由提供，不把 React 组件编译进 server 业务代码。

## 3. 模块目录约定

一个模块目录（或包）至少包含：

```text
modules/server/agent/memory/ledger/
  package.json        # @world-prism/mod-agent-memory-ledger, exports ./src/index.ts
  src/
    index.ts          # 只导出 moduleDefinition 与公开类型
    definition.ts     # ModuleDefinition：id/kind/version/apiVersion/scope/state
    plugin.ts         # MemoryPort 实现与生命周期
    config.ts         # 严格 configSchema 与 defaults
  state/
    v1.ts             # 状态 schema/编码/迁移（无可写状态则显式为空）
  tests/
    behavior.test.ts
  README.md           # 边界、参数、实验轴与已知限制
```

- `src/index.ts` 的公开导出只有模块定义、port 实现工厂与公开配置类型；不 deep export 内部文件。
- `src/definition.ts` 只含描述符数据（另以 `"./definition"` 导出），不得静态 import 实现文件、React、PixiJS、Fastify 或模型 SDK；`create` 用动态 `import("./plugin")` 加载实现。这样三个组合根的 `module-catalog.ts` 都能在 Node 中导入，`check-catalog` 才能校验浏览器 realm 的模块。
- 模块不得在 import 阶段启动后台循环、读环境变量、创建数据库连接或注册全局单例；这些动作只能放在 `create/start`，由宿主注入。
- 有状态模块声明 `stateSchemaVersion`、scope、导出/导入与迁移路径；无状态模块明确声明无状态。
- 模块的 configSchema 随模块维护，跨模块 DTO/port 归 `contracts`；禁止模块自建近似的共享类型。
- 模块的 UI 贡献记录在 ModuleDefinition 里（slot、requiredCapabilities、order），不再另设一套注册系统。

## 4. 包与文件规则

目录、文件与导出按职责命名，避免万能 manager/utils/core 容器；适配器的 sqlite、fastify、pixi 等真实实现名保留。冻结的模块/能力 ID 不因措辞调整而更名。源码 header 的唯一详细规范见 [技术栈](../delivery/tech-stack.md) 第 7 节。

`contracts` 是事件信封、命令、receipt、观察、记忆、context、模型请求、ToolDefinition/ToolBinding、模块描述符、装配和双端协议的唯一定义处。各模块不能定义字段略有差别的“内部公共 DTO”。

`kernel` 只放 realm 无关的宿主机制：模块描述符校验、注册表、能力图、生命周期、slot、hook 排序、配置解析、manifest 摘要。它不得 import 任何 `modules/*`、`apps/*`、游戏内容、供应商 SDK 或具体 UI。

`authority` 放服务端固定的命令网关、事务/outbox 协调、幂等与 fencing 机制；`world` 规则本身是模块，`authority` 不包含水闸、资源或协议结算。

`agent-runtime` 保留唯一的 turn 管线与调度协调。memory、context、compression、decision 等模块只实现阶段策略；不能在另一个目录里复制一份 loop，再让配置在两套不一致的系统之间选。

`observability` 包目前只导出包名，为服务端观测机制保留入口；trace、span 与证据信封的 schema 定义在 contracts 的 `api-observe.ts`，具体存储/查询由 `platform.observability.sqlite` 模块提供，控制台页面由 `console.observability.standard` 模块贡献。三者不能互相 import 实现。

`client-protocol` 只含类型化传输与投影 reducer 协议；场景/UI 模块只消费授权投影，不拼装第二份世界。

控制台 HTTP 请求按模型布局、研究证据、调试和运营分文件实现。`ApiClient` 装配这些方法，统一处理会话令牌、角色请求头、响应校验与错误映射。

## 5. 显式装配与配置

`config/assemblies` 只存数据：每个文件描述 server/client/console 三个 realm 的模块选择、能力绑定、配置块引用与可替换项。装配解析器由 `platform.module-admin` 与宿主共同提供，在启动或创建 run 时生成 resolved manifest。

`config/profiles` 只描述 Agent 策略子配方（perception/memory/context/compression/tool-view/decision 等），不选择游戏规则、客户端渲染器或控制台页面；调度参数属 run 作用域，放在场景 profile 与实验 variant 中。`config/rosters` 只引用 profile/toolset 与身份数据，不复制 provider/model 参数。

`config/model-layouts` 定义集中模型池（connections、models、mounts 在同一个文件里，由 RunSpec 的 `modelLayoutRef` 选择）；`config/toolsets` 引用共享 ToolDefinition 与 binding 模板。两者分别由 [模型池](../agent/model-pool.md) 与 [工具](../agent/tools.md) 维护。各配置文件的完整格式见 [配置](../platform/configuration.md) 第 10 节。

`content` 与 `config` 都由 schema 校验；世界背景、地图、角色与事件卡是内容版本，不能藏在 module 源码里。新增内容不应该要求改宿主。

## 6. 新增模块的工作流

### 6.1 新增 Agent 认知模块（以 memory 为例）

1. 查现有实现能否仅加参数；能加参数就不新建模块。
2. 在 `modules/server/agent/memory/<impl>/` 建立定义、port 实现、configSchema、状态版本与测试。
3. 在 `apps/server/src/host/module-catalog.ts` 增加一次显式 import；不扫描目录、不改 runtime。
4. 若需要模型，声明 purpose（memory-maintenance/embedding），由集中模型池解析，不自建 SDK client。
5. 在 `config/profiles` 增加 profile/variant 草稿，在隔离 branch 跑同输入对照。
6. 跑契约测试、scope/隔离测试与场景对照；记录 requested/resolved/effective 差异。

### 6.2 新增游戏职能模块

1. 在 `contracts` 声明 port 输入/输出、错误语义、状态 schema 与提交边界；先确认现有 port 是否已足够。
2. 在 `modules/server/game/<family>/` 实现计划/查询，不直接写世界库，不 import 其他游戏模块实现。
3. 由 `authority` 的命令网关和当前 `game.world` 协调提交；副作用走标准 command。
4. 在 assembly 中替换或新增选择；给客户端/Agent 的只是能力 port，不暴露模块内部对象。
5. 用同一受控 tick 脚本重放，验证结果与依赖版本可解释。

### 6.3 新增客户端/控制台页面模块

1. 定义 UI extension：扩展 ID、slot、requiredCapabilities、视图工厂、排序与权限标签。
2. 通过 `client-protocol` 的 typed client 读取授权投影或控制台 API，不直接 fetch 未声明后端。
3. 在对应宿主的 `module-catalog.ts` 显式登记；host 校验 slot、重复 ID 与能力。
4. 验证玩家/控制台权限隔离、卸载无残余订阅、可选模块失败隔离。

### 6.4 新增适配器

1. 实现 contracts 中的 port，把第三方类型关在模块内部。
2. 在 definition 中声明能力、配置与失败语义；不支持的能力显式报错。
3. 在 assembly 中作为 provider 选择；不得改变业务模块的语义。
4. 存储/模型适配器需验证迁移、重试、未知结果与证据归档。

正常新增模块不修改世界规则、HTTP 路由、Agent loop 或其他模块实现。若必须修改无关消费者，说明契约不足，先评审 port 升级与影响面，不用 `any` 或万能 `WorldContext` 绕过边界。

## 7. 依赖守门与自动检查

已实现的 `pnpm check:boundaries` 检查源码引用、各包 manifest 和 header。运行时能力闭包由装配解析验证。检查规则见 [tech-stack.md — 技术栈](../delivery/tech-stack.md) 第 2、7 节。依赖检查拒绝以下情形。

- 循环依赖、跨包深层引用、模块 import 时自动注册或执行副作用；
- client/console 模块 import `node:*`、SQLite、模型 SDK、server 模块或密钥路径；
- server 业务代码 import 浏览器/PixiJS/React DOM 组件；
- 一个模块 import 另一个模块的实现（只能依赖 contracts 的 port 与公共定义）；
- 普通策略自行创建数据库连接、模型 client、随机源或未登记网络调用；
- 模块 ID/能力/版本重复、能力闭包缺口、实例作用域非法、slot 冲突。

检查失败时优先修正 owning module 和依赖方向，不加宽泛的 allowlist、不导出整个内部目录、不关闭 schema 校验。上述边界、目录、资产与文档检查脚本已接入 `pnpm check` 门禁。

## 8. 测试放置与验收证据

| 位置 | 覆盖行为 |
|---|---|
| `apps/*/tests` | 应用内部的宿主端口与界面行为 |
| 模块自己的 tests | 算法、状态变更、错误、来源与参数边界；行为测试不绑定内部拆函数方式 |
| `tests/contract` | 跨域 schema、port、生命周期、scope、迁移、effective 参数 |
| `tests/integration` | 事务/outbox/inbox、模型池、工具绑定、fencing、恢复与取消竞态 |
| `tests/catalog` | 模块目录快照、能力闭包、冲突、realm 兼容、装配 diff |
| `tests/scenarios` | 单玩家多轮交涉、承诺后果、15 个 Agent 运行与隔离变体对比 |
| `tests/e2e` | 两个端口启动、玩家关键路径、控制台页面权限与模型挂载 |

一次扩展的验收包包含源码 revision、锁文件、内容版本、冻结 manifest、输入脚本、断言结果、授权 artifact、失败记录和实测限制。每个实验 run 独占 branch；在线与实验的活动身份合计不超过 15。

完整交付顺序见 [路线与验收](../delivery/roadmap-and-acceptance.md)；观测字段与查询权限见 [可观测性](../platform/observability.md)。

## Godot 玩家端目录

目标工程独立落在 `apps/player-godot/`。现有 TypeScript workspace 继续承载服务端与控制台。客户端的入口、测试和资产在独立目录构建。

```text
apps/player-godot/
  global.json          .NET SDK pin
  Directory.Build.props   locked restore policy for client and export
  Player.Core/         public wire DTOs, projection state, intent ports
  Player.Transport/    loopback HTTP and WebSocket adapters
  Player.Godot/        project.godot, composition root, UI and 3D providers
  Player.Verification/ contract and lifecycle checks
```

`Player.Transport` 依赖 `Player.Core`。Godot 功能模块通过 `Player.Core` 的端口交互，只有 Godot 组合根持有网络适配器的具体实现。核心和网络适配可在无引擎的 .NET 进程里验证。场景和资源引用属于 Godot 工程。TypeScript 侧的公开 Zod schema 与经验证的 JSON 样本用于跨语言契约，构建时保持单向输入。

浏览器玩家端退役时，逐个清理玩家专用依赖、装配绑定、测试与脚本。以实际引用为准保留 TS 控制台的 SDK、协议和构建工具。切换时仅将浏览器玩家装配改为空绑定，服务端和控制台继续执行各自的校验。现行会话装配解析会对 client 注入浏览器必需能力，须由 TS 宿主明确处理原生模式，改动范围限定在浏览器玩家能力及目录预检。先证明已有冻结运行和快照仍可被 TS 宿主打开，再清理浏览器生产入口。
