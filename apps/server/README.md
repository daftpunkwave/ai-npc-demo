# @ai-npc/app-server

服务端宿主与 HTTP/WS 传输层。

## 当前范围

- `startHost`：打开 SQLite、加载内容包、解析 `config/assemblies/*.yaml` 与 `config/runs/online-default.yaml`、首次创建在线世界/分支/clock、live run 与 `world_aliases('online')`、注册 game authority、绑定游戏端口与存档服务、启动 clock/job/consumer worker。
- 会话返回装配中已解析的 server 模块集；reset 会为新在线分支创建新的 live run。
- 游戏端口工厂与规则贡献按装配 binding 选择；未实现的模块 ID 或缺失能力在启动时失败，不会退回硬编码组合。
- 首次与后续启动都把在线时钟置为 `paused`；快照接口先暂停再保存；`POST /api/v1/campaign/reset` 先存快照，再创建空在线分支、归档旧分支并切换别名。
- `createServerApp` 由 `transport.http-ws.fastify` provider 提供；应用工厂、路由、WS、CORS、Origin 与监听都在该 provider 内。
- `buildPlayerProjection`：从世界/地图端口与内容索引构建严格玩家投影；缺失指标时拒绝构建，不合成数值。
- `module-catalog`：唯一模块组合根，显式登记 15 个 server 模块定义、端口与规则贡献。
- 宿主通过 `transport.http-ws.fastify` 的 `createApp/listen` 获取应用与监听，通过 `platform.operations.standard` 的快照/恢复/重开编排调用存档。
- `pnpm dev:server`：读取 `PORT`/`HOST`/`DATA_DIR`/`CONTENT_ROOT`/`CONTENT_PACK`/`PLAYER_TOKEN`/`CONSOLE_TOKEN`，默认监听 `127.0.0.1:3000`，打印玩家与控制台登录地址。
- WS 玩家频道：订阅快照、命令后的顶层 delta、按 `fromStreamSeq` 补发最近 200 条增量；缺口回退快照。
- `config/assemblies/*.yaml`：标准与升级剧情两份 server 装配；`check:catalog` 解析 schema、校验模块与配置引用。

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
