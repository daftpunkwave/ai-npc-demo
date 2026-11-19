# @ai-npc/app-server

服务端宿主与 HTTP/WS 传输层。

## 当前范围

- `startHost`：先按 kernel 解析计划预检装配（缺失依赖、重复绑定、realm、配置 schema），再打开 SQLite、加载内容包与 `config/runs/online-default.yaml`、首次创建在线世界/分支/clock、live run 与 `world_aliases('online')`、按计划启动模块、注册 game authority、绑定存档服务、启动 clock/job/consumer worker。
- 会话返回装配中已解析的 server 模块集；reset 会为新在线分支创建新的 live run。
- 游戏端口与规则贡献从已启动模块的公开端口取得；部署参数（数据目录、监听配置）由宿主并入启动计划，不参与冻结摘要，不再有固定实现表或手工端口工厂。
- 首次与后续启动都把在线时钟置为 `paused`；快照接口先暂停再保存；`POST /api/v1/campaign/reset` 先存快照，再创建空在线分支、归档旧分支并切换别名。
- `createServerApp` 由 `transport.http-ws.fastify` provider 提供；应用工厂、路由、WS、CORS、Origin 与监听都在该 provider 内。
- `buildPlayerProjection`：从世界/地图端口与内容索引构建严格玩家投影；缺失指标时拒绝构建，不合成数值。
- `module-catalog`：唯一模块组合根，显式登记 15 个 server 模块定义，并从解析计划实例化后的公开端口取运行期端口与规则贡献。
- 宿主通过 `transport.http-ws.fastify` 的 `createApp/listen` 获取应用与监听，通过 `platform.operations.standard` 的快照/恢复/重开编排调用存档。
- `pnpm dev:server`：先加载项目根 `.env`（进程环境中的同名变量优先），再读取 `NPC_SERVER_HOST`、`NPC_SERVER_PORT`、`NPC_CLIENT_PORT`、`NPC_DATA_DIR`、`NPC_ASSEMBLY`、`NPC_MODEL_LAYOUT`、`NPC_ROSTER` 与角色令牌；只监听 `127.0.0.1:3000`，玩家登录地址使用 `5173`，控制台登录地址使用 `3000/console/`。缺省的玩家与控制台令牌生成后写入 `<NPC_DATA_DIR>/dev-tokens.json`，只在生成当次打印带令牌的登录地址。
- WS 玩家频道：订阅快照、命令后的顶层 delta、按 `fromStreamSeq` 补发最近 200 条增量；缺口回退快照。
- `config/assemblies/*.yaml`：标准、测试与升级剧情三份 server 装配；`check:catalog` 扫描目录并对每份装配执行能力闭包、作用域、重复绑定、拓扑与配置 schema 预检。

## 尚未包含

- Agent 认知、客户端与控制台模块目录；会话握手对绑定为空的浏览器 realm 返回空模块集。
- 玩家/控制台前端与 Playwright e2e。

## 实现说明

- 宿主是组合根：除 `src/host/module-catalog.ts` 外不直接 import 游戏模块。
- 宿主事务的 module scope 临时拥有全部游戏聚合，只为投影/时钟读端口提供事务上下文；命令写入仍由 authority 的模块 ownership 校验。
- 首次启动检测到已有 online 分支时直接复用；不覆盖已有世界。重启沿用已冻结的装配与 run，不按当前入参重建。
- worker 按时钟模块有效配置的 `secondsPerTick` 推进，运行 due job/clock step/consumer；时钟读写只经模块端口，宿主不重复实现时钟状态。
