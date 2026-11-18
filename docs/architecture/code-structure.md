# 目标代码目录与扩展工作流

> 状态：目标代码结构，不代表这些运行模块已经存在。当前交付仍是设计文档；依赖版本、构建命令和性能指标在实现时验证并锁定。模块职责见 [模块边界](modules.md)，目录清单见 [模块目录](module-catalog.md)，装配语义见 [积木组合](composition.md)。

## 1. 目录树

```text
ai-npc-demo/
  apps/
    server/                      # server host（Node，:3000）
      src/
        main.ts
        host/
          bootstrap.ts           # 启动、装配解析、ready 判定
          guards/                # 固定顺序的权限/预算/提交/证据关口
          module-catalog.ts      # 显式 import 全部 server 模块定义
          sessions/              # 玩家/运营/研究会话与角色
        console-static/          # console 构建产物挂载到 /console/*
        platform-services/       # 仅 server host 使用的框架服务
    client/                      # client host（浏览器，:5173）
      index.html
      src/
        main.tsx
        host/
          bootstrap.tsx        # 模块装载、slot 容器、错误边界
          module-catalog.ts    # 显式 import 全部 client 模块定义
          transport.ts
        styles/
    console/                     # console host（浏览器，由 server :3000 提供）
      src/
        main.tsx
        host/
          bootstrap.tsx
          module-catalog.ts    # 显式 import 全部 console 页面模块
          transport.ts
  packages/
    contracts/                   # 跨域 schema、DTO、port、能力与模块描述符
    kernel/                      # realm 无关宿主机制：registry、能力图、生命周期、slot、hook 排序
    module-sdk/                  # 模块作者辅助：定义、scoped state、贡献与 disposer
    client-sdk/                  # 浏览器宿主辅助：slot、偏好、projection 订阅
    client-protocol/             # 类型化 HTTP/WS 客户端与投影 reducer 协议
    authority/                   # 服务端命令网关、事务、幂等、fencing、outbox 协调
    agent-runtime/               # 固定 turn 管线、调度 job、预算/租约协调
    experiment/                  # run、branch、manifest、评估调度
    observability/               # trace/evidence 协议与 span 辅助
  modules/
    server/
      game/
        world/                   # game.world.slg-light
        map/                     # game.map.six-nodes
        clock/                   # game.clock.controlled
        resources/               # game.resources.light
        actions/                 # game.actions.standard
        agreements/              # game.agreements.standard
        scenario/                # game.scenario.watergate
        save/                    # game.save.sqlite
      agent/
        perception/              # local / briefing / attention
        memory/                  # none / ledger / stream-reflection / layered-hybrid
        context/                 # ordered-blocks / task-centered
        compression/             # none / window / structured / summary
        tool-view/               # full / structured / brief
        decision/                # model / deterministic
        scheduling/              # fair / priority-cooldown
        model-pool/              # shared；connections/models/mounts 解析
        tools/                   # 共享 ToolDefinition、toolset、binding 贡献
      platform/
        access-policy/           # roster 驱动的授权策略
        budget/                  # 预算与用量账本
        storage/                 # SQLite adapter
        observability/           # trace/artifact 存储与查询
        evaluation/              # 评估协议与运行器
        operations/              # 暂停/快照/席位/内容发布
        module-admin/            # catalog 快照、装配预检与 diff
        secrets/                 # credentialRef 解析，仅 server
      adapters/
        transport-http-ws/       # HTTP/WS 适配器
        model-http/              # 兼容 HTTP 的模型传输
        model-deterministic/     # CI 确定性响应
    client/
      world-view/                # 投影 reducer
      scene-renderer-pixi/       # 2.5D adapter；另有 null renderer 供测试
      camera/
      screen-projection/
      input/
      hud/
      dialogue/
      characters/
      faction-start/
      settings/
      notifications/
      audio/
      debug-overlay/
    console/
      health/
      module-admin/
      model-mounts/
      faction-ops/
      scenario-editor/
      observability/
      evaluation/
      debug/
      audit/
  config/
    assemblies/                  # 三 realm 模块选择、能力绑定与配置引用
    profiles/                    # Agent 策略子配方与实验 variant patch
    rosters/                     # 身份、profileRef、toolsetRef
    models/                      # connections + models
    mounts/                      # modelId + agentIds + purposes
    toolsets/                    # 工具集与 binding 模板
    settings-presets/            # 展示偏好与 preset 申请入口
  content/
    lore/                        # 版本化世界观
    maps/                        # 节点、道路与通行数据
    characters/                  # 人格、主张、初始关系与已知来源
    scenarios/                   # 首章事件卡、初态与测试刺激
    ui/                          # 图标、字体、本地化
    audio/                       # 声音资源与清单
  tests/
    contract/                    # 跨域 schema、port、模块一致性
    integration/                 # 事务、outbox、模型池、工具、生命周期
    catalog/                     # 模块目录与装配解析/冲突
    scenarios/                   # 多轮玩法与对比场景
    e2e/                         # 两端口启动、玩家/控制台关键路径
  scripts/
    check-boundaries.ts          # import/依赖/realm 边界
    check-catalog.ts             # 模块 ID、能力闭包、实例作用域
    check-docs.ts                # 文档链接、术语与示例语法
    dev.ts                       # 只启动两个端口的开发编排
  artifacts/                     # 本地输出，排除 Git
  docs/
```

这是职责边界，不要求每个目录马上变成 workspace 包。具备真实独立依赖、测试或替换价值的模块再成为包；内部零逻辑转发层不形成新包。

## 2. 三个宿主，三个组合根

| 入口 | 组合根 | 允许依赖 | 禁止 |
|---|---|---|---|
| `apps/server` | `host/module-catalog.ts` + `host/bootstrap.ts` | server 模块、contracts/kernel/module-sdk、server 适配器 | 浏览器模块、DOM/PixiJS；console 页面代码 |
| `apps/client` | `host/module-catalog.ts` + `host/bootstrap.tsx` | client 模块、contracts/kernel/client-sdk/client-protocol | Node 内置模块、数据库、密钥、server 模块实现 |
| `apps/console` | `host/module-catalog.ts` + `host/bootstrap.tsx` | console 模块、contracts/kernel/client-sdk/client-protocol | 服务端对象、直接数据库/模型连接；玩家域私有投影 |

每个宿主只有一个实例级 registry；模块通过显式 import 清单登记，禁止文件系统扫描自动执行，也禁止模块在 import 时向全局 Map 自注册。三个组合根共享解析算法，但不共享进程内对象。

`apps/server` 对 console 静态资源只做挂载以及权限和缓存策略；console 前端仍然是独立的构建产物，由 server 的 HTTP 路由提供，不把 React 组件编译进 server 业务代码。

## 3. 模块目录约定

一个模块目录（或包）至少包含：

```text
modules/server/agent/memory/ledger/
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
- 模块不得在 import 阶段启动后台循环、读环境变量、创建数据库连接或注册全局单例；这些动作只能放在 `create/start`，由宿主注入。
- 有状态模块声明 `stateSchemaVersion`、scope、导出/导入与迁移路径；无状态模块明确声明无状态。
- 模块的 configSchema 随模块维护，跨模块 DTO/port 归 `contracts`；禁止模块自建近似的共享类型。
- 模块的 UI 贡献记录在 ModuleDefinition 里（slot、requiredCapabilities、order），不再另设一套注册系统。

## 4. 包与文件规则

`contracts` 是事件信封、命令、receipt、观察、记忆、context、模型请求、ToolDefinition/ToolBinding、模块描述符、装配和双端协议的唯一定义处。各模块不能定义字段略有差别的“内部公共 DTO”。

`kernel` 只放 realm 无关的宿主机制：注册表、能力图、生命周期、slot、hook 排序、配置解析、manifest 摘要。它不得 import 任何 `modules/*`、`apps/*`、游戏内容、供应商 SDK 或具体 UI。

`authority` 放服务端固定的命令网关、事务/outbox 协调、幂等与 fencing 机制；`world` 规则本身是模块，`authority` 不包含水闸、资源或协议结算。

`agent-runtime` 保留唯一的 turn 管线与调度协调。memory、context、compression、decision 等模块只实现阶段策略；不能在另一个目录里复制一份 loop，再让配置在两套不一致的系统之间选。

`observability` 提供 trace/evidence 协议与 span 辅助；具体存储/查询由 `platform.observability.sqlite` 模块提供，控制台页面由 `console.observability.standard` 模块贡献。三者不能互相 import 实现。

`client-protocol` 只含类型化传输与投影 reducer 协议；场景/UI 模块只消费授权投影，不拼装第二份世界。

## 5. 显式装配与配置

`config/assemblies` 只存数据：每个文件描述 server/client/console 三个 realm 的模块选择、能力绑定、配置块引用与可替换项。装配解析器由 `platform.module-admin` 与宿主共同提供，在启动或创建 run 时生成 resolved manifest。

`config/profiles` 只描述 Agent 策略子配方（perception/memory/context/compression/tool-view/decision 等），不选择游戏规则、客户端渲染器或控制台页面；调度参数属 run 作用域，放在场景 profile 与实验 variant 中。`config/rosters` 只引用 profile/toolset 与身份数据，不复制 provider/model 参数。

`config/models` 与 `config/mounts` 一起定义集中模型池；`config/toolsets` 引用共享 ToolDefinition 与 binding 模板。三者分别由 [模型池](../agent/model-pool.md) 与 [工具](../agent/tools.md) 维护。

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

目标脚本（尚未实现）同时读取源码 import 与各包 manifest，拒绝：

- 循环依赖、跨包深层引用、模块 import 时自动注册或执行副作用；
- client/console 模块 import `node:*`、SQLite、模型 SDK、server 模块或密钥路径；
- server 业务代码 import 浏览器/PixiJS/React DOM 组件；
- 一个模块 import 另一个模块的实现（只能依赖 contracts 的 port 与公共定义）；
- 普通策略自行创建数据库连接、模型 client、随机源或未登记网络调用；
- 模块 ID/能力/版本重复、能力闭包缺口、实例作用域非法、slot 冲突。

检查失败时优先修正 owning module 和依赖方向，不加宽泛的 allowlist、不导出整个内部目录、不关闭 schema 校验。这些脚本是待实现的交付项，不能把本文的目录当成已有的 CI。

## 8. 测试放置与验收证据

| 位置 | 覆盖行为 |
|---|---|
| 模块自己的 tests | 算法、状态变更、错误、来源与参数边界；行为测试不绑定内部拆函数方式 |
| `tests/contract` | 跨域 schema、port、生命周期、scope、迁移、effective 参数 |
| `tests/integration` | 事务/outbox/inbox、模型池、工具绑定、fencing、恢复与取消竞态 |
| `tests/catalog` | 模块目录快照、能力闭包、冲突、realm 兼容、装配 diff |
| `tests/scenarios` | 单玩家多轮交涉、承诺后果、20 个 Agent 运行与隔离变体对比 |
| `tests/e2e` | 两个端口启动、玩家关键路径、控制台页面权限与模型挂载 |

一次扩展的验收包包含源码 revision、锁文件、内容版本、冻结 manifest、输入脚本、断言结果、授权 artifact、失败记录和实测限制。每个实验 run 独占 branch；在线与实验的活动身份合计不超过 20。

完整交付顺序见 [路线与验收](../delivery/roadmap-and-acceptance.md)；观测字段与查询权限见 [可观测性](../platform/observability.md)。
