# @ai-npc/app-server

服务端宿主与 HTTP/WS 传输层。

## 当前范围

- `startHost`：打开 SQLite、加载内容包、首次创建在线世界/分支/clock、注册 game authority、绑定游戏端口与存档服务、启动 clock/job/consumer worker。
- `createServerApp`：Fastify 应用工厂，提供登录、会话、命令、回执查询、世界视图、暂停/继续、快照、恢复、流票据与玩家 WS 快照。
- `buildPlayerProjection`：从世界/地图端口与内容索引构建严格玩家投影；缺失指标时拒绝构建，不合成数值。
- `module-catalog`：唯一模块组合根，显式登记 11 个 server 模块定义、端口与规则贡献。
- `pnpm dev:server`：读取 `PORT`/`HOST`/`DATA_DIR`/`CONTENT_ROOT`/`CONTENT_PACK`/`PLAYER_TOKEN`/`CONSOLE_TOKEN`，默认监听 `127.0.0.1:3000`，打印玩家与控制台登录地址。
- `pnpm check:catalog`：运行时加载组合根，校验模块 ID 唯一。

## 尚未包含

- `platform.access-policy.roster`、`platform.secrets.env`、`platform.operations.standard` 的独立模块与配置。
- 两份主装配 YAML 与完整装配解析。
- 投影增量推送、200 条重放缓冲、真实端口 WS 重连测试。
- 玩家/控制台前端与 Playwright e2e。

## 实现说明

- 宿主是组合根：除 `src/host/module-catalog.ts` 外不直接 import 游戏模块。
- 宿主事务的 module scope 临时拥有全部游戏聚合，只为投影/时钟读端口提供事务上下文；命令写入仍由 authority 的模块 ownership 校验。
- 首次启动检测到已有 online 分支时直接复用；不覆盖已有世界。
- worker 每秒推进一个 world tick 并运行 due job/consumer；仅用于首版联调，后续由完整时钟步骤替换。
