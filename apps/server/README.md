# @world-prism/app-server

服务端宿主与 HTTP/WS 传输层。

## 当前范围

- `startHost` 按 kernel 解析计划预检装配，打开 SQLite，再按运行规格创建或恢复在线世界。标准装配使用 `online-default`，测试装配使用 `online-model-test`。宿主按计划启动模块、注册 game authority、绑定存档服务并启动 clock、job 和 consumer worker。
- 会话返回装配中已解析的 server 模块集；reset 会为新在线分支创建新的 live run。
- 游戏端口与规则贡献从已启动模块的公开端口取得；部署参数（数据目录、监听配置）由宿主并入启动计划，不参与冻结摘要，不再有固定实现表或手工端口工厂。
- 首次与后续启动都把在线时钟置为 `paused`；快照接口先暂停再保存；`POST /api/v1/campaign/reset` 先存快照，再创建空在线分支、归档旧分支并切换别名。
- `createServerApp` 由 `transport.http-ws.fastify` provider 提供；应用工厂、路由、WS、CORS、Origin 与监听都在该 provider 内。
- `buildPlayerProjection`：从世界/地图端口与内容索引构建严格玩家投影；缺失指标时拒绝构建，不合成数值。
- `module-catalog` 显式登记服务端模块与浏览器描述符，宿主按解析计划启动 provider 并取得公开端口与规则贡献。
- 宿主通过 `transport.http-ws.fastify` 的 `createApp/listen` 获取应用与监听，通过 `platform.operations.standard` 的快照/恢复/重开编排调用存档。
- `pnpm dev:server`：先加载项目根 `.env`（进程环境中的同名变量优先），再读取 `WORLD_PRISM_SERVER_HOST`、`WORLD_PRISM_SERVER_PORT`、`WORLD_PRISM_CLIENT_PORT`、`WORLD_PRISM_DATA_DIR`、`WORLD_PRISM_ASSEMBLY`、`WORLD_PRISM_MODEL_LAYOUT`、`WORLD_PRISM_ROSTER` 与角色令牌；只监听 `127.0.0.1:3000`，玩家登录地址使用 `5173`，控制台登录地址使用 `3000/console/`。缺省的玩家与控制台令牌生成后写入 `<WORLD_PRISM_DATA_DIR>/dev-tokens.json`，只在生成当次打印带令牌的登录地址。
- WS 玩家频道：订阅快照、命令后的顶层 delta、按 `fromStreamSeq` 补发最近 200 条增量；缺口回退快照。
- 控制台研究与评估接口：健康总览、模块目录、仓库装配详情、模型布局只读与静态校验、世界时间线、Agent 检查器、记忆/观察、turn 证据、artifact、trace、分支事件对比、调试（队列、turn 摘要校验、调试唤醒）、run/实验列表与创建、run 启停/报告及脱敏导出；`/console/*` 静态资源由同一服务端监听提供。
- `console.health` 每 2 秒推送快照，`console.timeline` 在世界变化后推送，二者使用独立频道序号。
- HTTP 请求和 Agent turn 阶段写入 `trace_spans`。turn 记录有效配置、冻结输入、决定与对白 artifact 引用。
- `config/assemblies/*.yaml`：标准、测试与升级剧情三份装配，均包含 server、client 与 console 绑定；`check:catalog` 对三个 realm 执行能力闭包、作用域、重复绑定、拓扑与配置 schema 预检。
- 标准与测试装配预检并冻结名册的 profile、工具集、模型挂载、提示词版本和价目。开局事务激活名册，恢复事务在切换分支时重新校验活动身份配额。标准装配支持 OpenAI 兼容和 Anthropic 传输，测试装配通过本地夹具运行模型决策、工具循环与独立对白。

- 实验执行器：`POST /api/v1/console/runs/{runId}/start` 启动带脚本的闭环 run 后，宿主按启动先后逐个驱动：受控时钟推进到脚本检查点、在沙盒分支执行探针、写入 `probe_results` 与 `experiment_results`，进度经 `GET /api/v1/console/runs/{runId}/progress` 读取。语义见 [评估 — 执行器](../../docs/platform/evaluation.md#81-执行器的触发顺序与终态)。

## 尚未包含

- 实验执行器的开环、审计重放与快照起步路径，以及脚本 `setup` 预置知识。
- 释放在线世界名额的运营接口。
- 席位契约、t144 程序案与控制台运营页面（三势力席位接管、剧情卡编辑与导出页面）。

## 运行一次实验

实验在宿主进程内执行，宿主必须以与实验相同的装配启动；在线世界已开局并占满 15 个名额时实验会在开局前暂停（`quota-unavailable`），因此建议使用独立数据目录且不开启在线世界。以标准装配和 OpenAI 兼容模型为例，在 `.env` 中设置：

```dotenv
WORLD_PRISM_DATA_DIR=./data/experiments
WORLD_PRISM_ASSEMBLY=local-slg-standard-v1
WORLD_PRISM_OPENAI_COMPAT_BASE_URL=https://api.deepseek.com/v1
WORLD_PRISM_OPENAI_COMPAT_MODEL=deepseek-flash
WORLD_PRISM_OPENAI_COMPAT_API_KEY=<密钥>
```

运行 `pnpm dev:server` 后，用控制台令牌登录并以研究员角色调用接口（`X-Active-Role: researcher`）：

1. `POST /api/v1/auth/login`，请求体 `{ "token": "<控制台令牌>" }`，取得 `sessionToken`。
2. `POST /api/v1/console/experiments`，请求体 `{ "experimentRef": "exp-memory-promise-v1" }`，返回 24 个 run；模型布局引用的环境变量在这一步解析并冻结。也可以提交内联 `experimentSpec`（与 `config/experiments/*.yaml` 同格式），例如把 `repetitions` 改为 1，或把 `base.modelLayoutRef` 改为 `claude-model-layout-v1`（还需 `ANTHROPIC_API_KEY`，对白与记忆整理仍走 OpenAI 兼容端点）。
3. 对需要执行的每个 run 调用 `POST /api/v1/console/runs/{runId}/start`，请求体 `{ "operationId": "op-<12 位小写 base32>" }`；run 按启动先后排队执行。
4. 用 `GET /api/v1/console/runs/{runId}/progress` 查看当前 tick、探针计数与最近事件；`status` 变为 `completed` 后读取 `GET /api/v1/console/runs/{runId}/report` 与 `GET /api/v1/console/experiments/exp-memory-promise-v1`。失败时 `lastEvent.payload.code` 给出原因码；run 被暂停时 `lastEvent.payload.reason` 说明是研究员停止还是配额不足。

## 运行标准装配

首次启动前，复制 `.env.example` 为 `.env`，填写 `WORLD_PRISM_OPENAI_COMPAT_BASE_URL`、`WORLD_PRISM_OPENAI_COMPAT_MODEL` 和 `WORLD_PRISM_OPENAI_COMPAT_API_KEY`，然后运行 `pnpm dev`。回环 OpenAI 兼容端点的密钥可以留空。示例配置使用 DeepSeek Flash，更换兼容供应商或型号时需核对布局能力、限流和价目。参见 [模型传输](../../docs/agent/model-transport.md#3-openai-兼容适配器)、[模型池价目](../../docs/agent/model-pool.md#124-预算与费用)。

将 `WORLD_PRISM_MODEL_LAYOUT` 设为 `claude-model-layout-v1` 并设置 `ANTHROPIC_API_KEY`，可以把决策交给 Claude Opus 5.5。对白仍由兼容端点生成。已有存档按冻结布局重启。希望新建使用不同布局的运行时，请指定独立的 `WORLD_PRISM_DATA_DIR`。

配置好真实凭据后，可以运行 `pnpm exec vitest run --config tests/live/vitest.config.ts`，用合成数据验证两个供应商的工具往返与结构化输出。缺少各自密钥的用例会跳过。

## 运行确定性模型测试装配

要观察岑雁的两轮模型决策，可使用测试装配启动双端。向岑雁发送含“护送”的话，夹具先查询局势，下一轮提交决定，随后由独立的对白模型调用生成回复。使用专用数据目录可以保留其他运行的冻结装配及存档。

```powershell
$env:WORLD_PRISM_ASSEMBLY = "local-slg-test-v1"
$env:WORLD_PRISM_MODEL_LAYOUT = "deterministic-model-layout-v1"
$env:WORLD_PRISM_ROSTER = "core-3"
$env:WORLD_PRISM_DATA_DIR = "./data/model-test"
pnpm dev
```

## 实现说明

- 宿主是组合根：除 `src/host/module-catalog.ts` 外不直接 import 游戏模块。
- 宿主事务的 module scope 临时拥有全部游戏聚合，只为投影/时钟读端口提供事务上下文；命令写入仍由 authority 的模块 ownership 校验。
- 首次启动检测到已有 online 分支时直接复用；不覆盖已有世界。重启沿用已冻结的装配与 run，不按当前入参重建。
- 已冻结的纯世界、确定性策略和夹具模型运行在复算原摘要通过后重启。新建运行按装配和布局选择传输。
- worker 按时钟模块有效配置的 `secondsPerTick` 推进，运行 due job/clock step/consumer；时钟读写只经模块端口，宿主不重复实现时钟状态。

开发期间遇到 `contentVersion` 不匹配时，重置开发数据后重新开局。参见 [operations.md — 重置开发数据](../../docs/platform/operations.md#101-重置开发数据)。
