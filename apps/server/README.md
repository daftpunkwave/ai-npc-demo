# @ai-npc/app-server

服务端宿主与 HTTP/WS 传输层。

## 当前范围

- `startHost`：先按 kernel 解析计划预检装配（缺失依赖、重复绑定、realm、配置 schema），再打开 SQLite、加载内容包与 `config/runs/online-default.yaml`、首次创建在线世界/分支/clock、live run 与 `world_aliases('online')`、按计划启动模块、注册 game authority、绑定存档服务、启动 clock/job/consumer worker。
- 会话返回装配中已解析的 server 模块集；reset 会为新在线分支创建新的 live run。
- 游戏端口与规则贡献从已启动模块的公开端口取得；部署参数（数据目录、监听配置）由宿主并入启动计划，不参与冻结摘要，不再有固定实现表或手工端口工厂。
- 首次与后续启动都把在线时钟置为 `paused`；快照接口先暂停再保存；`POST /api/v1/campaign/reset` 先存快照，再创建空在线分支、归档旧分支并切换别名。
- `createServerApp` 由 `transport.http-ws.fastify` provider 提供；应用工厂、路由、WS、CORS、Origin 与监听都在该 provider 内。
- `buildPlayerProjection`：从世界/地图端口与内容索引构建严格玩家投影；缺失指标时拒绝构建，不合成数值。
- `module-catalog` 显式登记服务端模块与浏览器描述符，宿主按解析计划启动 provider 并取得公开端口与规则贡献。
- 宿主通过 `transport.http-ws.fastify` 的 `createApp/listen` 获取应用与监听，通过 `platform.operations.standard` 的快照/恢复/重开编排调用存档。
- `pnpm dev:server`：先加载项目根 `.env`（进程环境中的同名变量优先），再读取 `NPC_SERVER_HOST`、`NPC_SERVER_PORT`、`NPC_CLIENT_PORT`、`NPC_DATA_DIR`、`NPC_ASSEMBLY`、`NPC_MODEL_LAYOUT`、`NPC_ROSTER` 与角色令牌；只监听 `127.0.0.1:3000`，玩家登录地址使用 `5173`，控制台登录地址使用 `3000/console/`。缺省的玩家与控制台令牌生成后写入 `<NPC_DATA_DIR>/dev-tokens.json`，只在生成当次打印带令牌的登录地址。
- WS 玩家频道：订阅快照、命令后的顶层 delta、按 `fromStreamSeq` 补发最近 200 条增量；缺口回退快照。
- 控制台首批只读接口：健康总览、模块目录、仓库装配详情、世界时间线与 Agent 状态摘要；`/console/*` 静态资源由同一服务端监听提供。
- `console.health` 每 2 秒推送快照，`console.timeline` 在世界变化后推送，二者使用独立频道序号。
- HTTP 请求和 Agent turn 阶段写入 `trace_spans`。turn 记录有效配置、冻结输入、决定与对白 artifact 引用。
- `config/assemblies/*.yaml`：标准、测试与升级剧情三份装配，均包含 server、client 与 console 绑定；`check:catalog` 对三个 realm 执行能力闭包、作用域、重复绑定、拓扑与配置 schema 预检。
- 标准与测试装配解析并冻结名册的 profile 与工具集。开局事务激活名册，恢复事务在切换分支时重新校验活动身份配额。Agent 使用确定性策略，玩家从授权会话接收已提交的模板对白。

## 尚未包含

- 真实模型调用与实验评估。
- 席位契约、t144 程序案、公开广播和六资源交接。

## 实现说明

- 宿主是组合根：除 `src/host/module-catalog.ts` 外不直接 import 游戏模块。
- 宿主事务的 module scope 临时拥有全部游戏聚合，只为投影/时钟读端口提供事务上下文；命令写入仍由 authority 的模块 ownership 校验。
- 首次启动检测到已有 online 分支时直接复用；不覆盖已有世界。重启沿用已冻结的装配与 run，不按当前入参重建。
- 已冻结纯世界装配的在线 run 在复算原摘要通过时按原样重启。新建在线 run 可以通过标准或测试装配启用 Agent。
- worker 按时钟模块有效配置的 `secondsPerTick` 推进，运行 due job/clock step/consumer；时钟读写只经模块端口，宿主不重复实现时钟状态。

开发期间遇到 `contentVersion` 不匹配时，重置开发数据后重新开局。参见 [operations.md — 重置开发数据](../../docs/platform/operations.md#101-重置开发数据)。
