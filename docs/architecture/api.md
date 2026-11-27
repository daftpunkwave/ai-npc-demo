# HTTP 与 WebSocket API

> 本文规定首版 HTTP 与 WebSocket 接口。接口由 `server` 在 `127.0.0.1:3000` 提供。现行浏览器玩家端经 `:5173` 代理访问，原生玩家端直接消费相同的版本化接口。公共 DTO 在 `packages/contracts` 中用 Zod 定义。交付范围见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。参见 [tech-stack.md — 技术栈](../delivery/tech-stack.md#6-本地双端拓扑)、[domain-model.md — 领域模型](domain-model.md)、[contracts.md — 公共契约](contracts.md)。

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 前缀 | `/api/v1`；控制台接口在 `/api/v1/console/*`；静态控制台页面在 `/console/*` |
| 格式 | 请求与响应都是 `application/json; charset=utf-8`；字段 camelCase |
| 认证 | `Authorization: Bearer <sessionToken>`；除 `GET /api/v1/health` 与 `POST /api/v1/auth/login` 外都需要 |
| 限流 | 除 `GET /api/v1/health` 与 `GET /api/v1/streams` 外，全部 `/api/v1/*` 路由按会话主体（未认证时按客户端 IP）与 10 秒窗口限流（默认读接口 60 次、写接口 10 次，可通过传输配置覆盖），超限返回 `429 budget-exhausted` |
| 控制台角色 | 控制台请求必须带 `X-Active-Role: operator \| researcher \| evaluator`，且该角色在会话角色内；服务端只按这个当前角色鉴权 |
| Origin | HTTP 请求与 WS 握手带 `Origin` 时必须匹配部署的来源白名单，否则返回 403。原生连接可省略此头，仍按 Bearer 会话或一次性票据认证 |
| 跨域允许面 | 只允许 `GET`、`POST`、`OPTIONS` 与 `Authorization`、`Content-Type`、`X-Active-Role` 三个请求头；会话令牌走请求头而非 Cookie，因此不启用 `credentials` |
| 安全响应头 | 全部响应带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 与 `Referrer-Policy: same-origin`；`text/html` 文档另带 CSP（`default-src 'self'`、`frame-ancestors 'none'`，不放开内联脚本） |
| 传输上限 | `requestTimeout` 与 `handlerTimeout` 各 30 秒、socket 空闲 30 秒回收、单连接最多 1000 个请求、请求体上限 1 MiB。`handlerTimeout` 超期返回 500 `plugin-failed` 且 `retryable: true`；它只中止本次响应等待，handler 内已发起的异步工作不会被自动取消。收齐请求头的期限（`headersTimeout`）同为 30 秒：它长于请求期限时 Node 会按它中断仍在接收的请求，`requestTimeout` 随之失效，因此不沿用 Node 默认的 60 秒。Node 每 30 秒扫描一次在途请求，实际中断落在期限之后的一个扫描周期内 |

| 幂等 | 世界命令用 `commandId`。时钟、快照、接管等控制操作用请求体里的 `operationId`，重复请求复用已记录的结果 |
| 并发控制 | 控制操作带 `expectedRunVersion` 或 `expectedEpoch`；不一致返回 409 |
| 分支 | 玩家接口总是作用于 `world_aliases('online')` 指向的分支；控制台运营入口可以用查询参数 `branchId` 指定分支，缺省为在线分支。当前版本只支持在线分支：`branchId` 与在线分支不一致时返回 400 `validation`，不会静默改作用分支 |
| 输入上限 | 世界命令的文本、主体名单与协议条款数量由公共契约统一限制（见 [公共契约](contracts.md) 第 1 节）；超限命令返回 200 + `commandStatus: "rejected"` 的 receipt，原因码 `invalid-params` |
| 错误 | 见第 7 节；业务拒绝不是 HTTP 错误，而是 200 + `commandStatus: "rejected"` 的 receipt |

## 2. 认证、会话与健康检查

本地 Demo 用启动令牌登录。服务端读取 `WORLD_PRISM_PLAYER_TOKEN`、`WORLD_PRISM_CONSOLE_TOKEN` 与可选的单角色控制台令牌。玩家和控制台令牌缺省时优先复用数据目录中的 `dev-tokens.json`。首次生成的令牌由 32 字节随机数据编码，保存后可跨重启复用，登录地址仅在生成当次打印。令牌文件先写入同目录暂存文件并刷新到磁盘，服务监听成功且登录地址输出后才原子改名为 `dev-tokens.json`；暂存写入失败时不进入监听，发布失败时关闭宿主并终止启动，已有令牌文件保持原样，因此不会留下截断的 JSON 文件。

```text
[world-prism] player  login: http://127.0.0.1:5173/#token=<player token>
[world-prism] console login: http://127.0.0.1:3000/console/#token=<console token>
```

现行浏览器宿主从 URL 片段取得登录令牌，将会话令牌存入按 origin 隔离的 `sessionStorage` 后清除片段。原生玩家端目标使用本机部署提供的玩家令牌，在进程内保存登录返回的会话令牌。

| 令牌 | principalId | 角色 |
|---|---|---|
| `WORLD_PRISM_PLAYER_TOKEN` | `player-1` | `player` |
| `WORLD_PRISM_CONSOLE_TOKEN` | `console-admin` | `operator`、`researcher`、`evaluator` |
| `WORLD_PRISM_OPERATOR_TOKEN` 等（可选） | `console-operator` 等 | 对应单一角色 |

| 方法与路径 | 请求 | 响应 | 说明 |
|---|---|---|---|
| `GET /api/v1/health` | — | `{ status: "starting"\|"ready"\|"degraded", protocolVersion: "1" }` | 不需要认证，不返回内部细节；e2e 用它等待就绪 |
| `POST /api/v1/auth/login` | `{ token }` | `{ sessionToken, principalId, roles, expiresAt }` | 令牌错误返回 401。会话自登录起默认有效 12 小时 |
| `POST /api/v1/auth/logout` | — | `{ ok: true }` | 吊销当前会话 |
| `GET /api/v1/session` | — | `SessionDescriptor`（[公共契约](contracts.md) 第 4 节） | 当前会话、角色、分支、协议版本、server 端已解析模块集 |
| `GET /api/v1/session/assembly?realm=client\|console` | — | `ResolvedModuleSet` | 浏览器宿主启动时取本 realm 的模块清单并校验（[积木组合](composition.md) 第 3 节）；玩家会话请求 `realm=console` 返回 403 `realm-violation` |
| `POST /api/v1/streams/ticket` | — | `{ ticket, expiresAt }` | 一次性 WS 票据，30 秒内有效 |

会话数量有上限。容量满时服务端先清理过期会话，再淘汰没有活动 WS 连接且最早过期的会话；如果剩余会话都保持活动连接，登录返回 429 `budget-exhausted`（`retryable: true`），不会驱逐活跃会话。

### 2.1 请求配额

除 `GET /api/v1/health` 与 WebSocket 升级 `GET /api/v1/streams` 外，全部 `/api/v1/` 路由按会话主体计配额：读入口（`GET`/`HEAD`）默认 60 次每 10 秒，写入口默认 10 次每 10 秒。超限返回 429 `budget-exhausted`，并带 `Retry-After` 秒数。

配额按路由声明在传输层的统一钩子里，不分散到各路由注册器：用豁免清单而不是白名单，新增路由默认受保护。豁免项各有依据——健康检查无鉴权且供探活高频调用，限流会让探活本身变成故障源；WebSocket 升级是长连接，请求次数不代表资源占用，连接期内由心跳与连接上限约束。

写入口阈值显著低于读入口，因为这些路径会推进世界状态或消耗会话资源：`POST /api/v1/commands` 与 `POST /api/v1/streams/ticket` 都是写入口。被限流的请求在业务处理之前被拒绝，不写回执、不产生事件、不推进世界状态。

## 3. 玩家 API（角色 `player`）

本节是玩家自助入口：暂停、继续、存档、恢复与重新开局都由玩家会话直接作用于在线分支。控制台运营角色使用第 5.3 节的 `/api/v1/console/campaign/*` 入口；两者路径、角色与幂等主体各自独立，互不复用。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/campaign` | — | `{ campaign: CampaignView \| null, starts: StartOption[] }`（类型见第 9 节） |
| `GET /api/v1/content` | — | `{ chapterTitle, clock: { secondsPerTick, evaluationTick, motionTick }, ui: ClientUiText }`：客户端只读内容视图，章节名与界面文字取自内容包，时钟刻度取自装配配置；任何已认证会话可读 |
| `POST /api/v1/commands` | `CommandEnvelope` | `CommandReceipt` |
| `GET /api/v1/commands/{commandId}` | — | 当前在线分支中该会话主体的 `CommandReceipt`。未找到返回 404 |
| `GET /api/v1/world/view` | — | `{ streamSeq, projectionVersion, projection: PlayerProjection }`（[领域模型](domain-model.md) 第 8.1 节） |
| `GET /api/v1/conversations/{agentId}?beforeSeq=&limit=` | — | `{ conversationId, lines: ConversationLine[] }`，最多 100 条 |
| `POST /api/v1/campaign/pause` | `{ operationId, expectedRunVersion }` | `ClockView` |
| `POST /api/v1/campaign/resume` | `{ operationId, expectedRunVersion }` | `ClockView` |
| `POST /api/v1/campaign/snapshots` | `{ operationId, label }` | `{ snapshotId, worldTick }`；会先暂停并静默，见 [运营](../platform/operations.md) 第 3 节 |
| `GET /api/v1/campaign/snapshots` | — | `{ snapshots: SnapshotView[] }`（只列本 campaign 的存档） |
| `POST /api/v1/campaign/restore` | `{ operationId, snapshotId }` | `{ branchId, clock: ClockView }`；创建后继在线分支，旧分支保留 |
| `POST /api/v1/campaign/reset` | `{ operationId }` | `{ branchId }`：先存快照，再创建新的空在线分支（重新开局，见 [运营](../platform/operations.md) 第 10 节） |
| `GET /api/v1/presets`（目标） | — | `{ presets: { presetId, title, summary }[] }`：玩家可以申请的测试 preset |
| `POST /api/v1/run-requests`（目标） | `{ presetId, note }` | `{ requestId, status: "pending" }`；只登记申请，由控制台批准后才创建 run |

```ts
interface CommandEnvelope {
  commandId: string;                 // 客户端生成，格式为 "cmd-..."；重试时复用同一 ID
  type: string;                      // 玩家命令权限见下一节
  schemaVersion: 1;
  expectedVersions?: Record<string, number>; // "aggregateType:aggregateId" 到 version 的映射
  payload: Json;
}

interface CommandReceipt {
  receiptId: string;
  commandId: string;
  commandStatus: "accepted" | "rejected";
  reasonCode: string | null;         // 见领域模型 §9；受理时为 null
  safeMessage: string | null;
  acceptedEventIds: string[];
  operationId: string | null;        // 经副作用操作提交时为该操作 ID（如 Agent 工具调用）；玩家直接提交为 null
  resultingVersions: Record<string, number>;
  result: Json | null;               // 例如 task.dispatch 返回 { taskId }，agreement.propose 返回 { agreementId }
  worldTick: number;
}

interface ClockView { worldTick: number; day: number; hour: number; mode: "running" | "pausing" | "paused" | "resuming" | "stepping"; runVersion: number; }
```

玩家命令按认证主体、受理时的在线分支和 `commandId` 去重。运营类 `operationId` 在世界与认证主体内跨分支保存。玩家写入口以请求处理时的在线分支为作用域，客户端无法指定目标分支。

原生客户端收到响应前断线或超时时，先重新取得授权快照，再核对回执或运营结果。同一 `commandId` 在切换分支后可能失去原回执，客户端把无法确认的结果保留为待核对状态。写请求交给传输层后禁止自动补发。

### 3.1 玩家命令权限

**已实现**：`POST /api/v1/commands` 接受 `campaign.start`、`dialogue.say`、`broadcast.say`、`information.share`、`agreement.propose`、`agreement.respond`、`task.dispatch`、`task.cancel` 和 `policy.set`。`policy.set` 只允许当前 campaign 的公社党魁玩家设置 `watergate.allocation`，授权按已开局 campaign 的玩家与派系裁决。`broadcast.say` 只允许同一玩家发布公开广播，发布位置取玩家所在节点。

**序章目标**：同一接口承载程序案交互。服务端使用认证和已开局的席位记录裁决权限。程序案命令的具体请求格式待定。参见 [domain-model.md — 命令目录](domain-model.md#5-命令目录)。

## 4. WebSocket：`GET /api/v1/streams?ticket=<ticket>`

连接建立后，服务端先发 `hello`。客户端订阅 `player` 后接收快照与增量。所有消息都是 JSON 文本帧。

客户端帧有 64 KiB 上限。超过上限的帧不会进入消息处理器，服务端以 1009 关闭连接，并写入一条可查询的结构化审计（`ws.frame.over-limit`，只记录上限与关闭码，不含帧内容与票据）；正常的 `subscribe`、`ack` 与 `ping` 帧远小于上限。

`ping`、`ack` 与 `subscribe` 都在会话校验之后处理：会话已失效时一律以 4401 关闭，不会回 `pong`，也不会因 `ack` 触发补发。

心跳是双向的，因为单向心跳只能证明一方仍能写出帧，证明不了对端仍在收。服务端按 `heartbeatIntervalMs` 发 `ping`，客户端须回 `pong`；客户端同样发 `ping`，服务端回 `pong`。两端都以「最近一次收到任意帧」判定连接存活：服务端超过 `heartbeatTimeoutMs` 未收到该连接的任何帧即 `terminate` 并按正常断开清理，客户端超过活跃窗口未收到任何帧即关闭当前连接并进入既有退避重连。

这一判定不能省略。半开连接（客户端进程被杀、网络中断、休眠唤醒后的失效 socket）不会产生 `close` 事件，服务端会一直保留该连接与玩家连接计数，导致「全部玩家断开后经宽限自动暂停」永不触发；客户端则停在「已连接」却永远收不到增量。

| 方向 | 消息 | 字段 |
|---|---|---|
| S→C | `hello` | `protocolVersion`、`principalId`、`channels`（本会话可订阅的频道） |
| C→S | `subscribe` | `channel`、`fromStreamSeq`（首次为 `null`） |
| S→C | `snapshot` | `channel`、`streamSeq`、`projectionVersion`、`worldId`、`branchId`、`data`。玩家频道使用真实投影版本；v1 控制台频道的 `projectionVersion` 仅作为兼容哨兵固定为 `0`，不代表玩家投影修订，控制台快照序号以 `streamSeq` 为准。`worldId` 与 `branchId` 是该快照所属的分支身份，客户端以帧内值为准更新本地世界与分支 |
| S→C | `delta` | `channel`、`streamSeq`、`projectionVersion`、`set`（顶层字段 → 新值的映射，例如 `{ "tasks": [...], "meters": {...} }`） |
| S→C | `append` | `channel`、`streamSeq`、`kind`、`item`。`kind` 与 `item` 按判别联合绑定：`dialogue` 的 `item` 必须满足 `ConversationLine`，`notification` 的 `item` 必须满足 `PlayerNotificationView`，且 `channel` 固定为 `player`。未实现的追加种类不在公开 schema 内，消费方无需区分“未实现”与“暂无数据” |
| C→S | `ack` | `channel`、`streamSeq`；只能确认已订阅的频道，未订阅频道回 `forbidden` |
| C→S | `ping` | 客户端心跳；服务端回 `pong` |
| S→C | `ping` | 服务端心跳；客户端须回 `pong` |
| C→S / S→C | `pong` | 对端心跳的回执；收到任意帧都证明该连接仍在 |
| S→C | `error` | `code`、`safeMessage`。`not-ready` 表示授权通过但该频道当前没有生产者 |

控制台频道按权限出现在 `hello.channels` 中，订阅时和世界变化后推送对应快照。已授权但尚未实现生产者的频道在订阅时回 `not-ready`，不进入推送集合，客户端据此区分“未实现”与“暂无数据”。

| 频道 | 角色 | 推送内容 | 状态 |
|---|---|---|---|
| `player` | player | `PlayerProjection` 快照与增量；新对话行、提醒用 `append` | 已实现 |
| `console.health` | operator、researcher | 每 2 秒一次健康摘要快照，结构与 [运行总览响应](#51-运行总览与模块装配) 一致。仅在存在订阅者时构造并推送 | 已实现 |
| `console.timeline` | researcher | 订阅时和世界变化后推送时间线快照。世界变化时仅在存在订阅者时构造 | 已实现 |
| `console.turns` | researcher | turn 状态变化（`append`） | 目标；当前订阅回 `not-ready` |

因背压丢弃增量时，待补快照按频道分别记录：同一连接订阅多个频道时，某个频道补发成功不会清掉其他频道的补发请求。

连接关闭码在同一应用自定义区间内区分两类完全不同的失败，客户端必须按码分别处理：

| 关闭码 | 触发条件 | 客户端语义 |
|---|---|---|
| `4401` | 会话已被注销或过期 | 会话失效：清除本地会话令牌并停止重连，提示重新登录 |
| `4408` | 票据缺失、过期、已消费或被容量淘汰 | 票据失效：重新申请票据后重连，不清除仍然有效的会话令牌 |

两类失败共用同一个码会让可重试的握手失败被当成强制登出：票据 30 秒有效，后台标签页挂起后恢复建连即命中。票据有效但其绑定的会话已失效时归入会话失效，用 `4401`。

`error` 帧是服务端唯一的结构化失败通道，客户端必须消费：`forbidden` 按会话失效处理（清除令牌并停止重连；传输层当前 `error` 帧仅发送 `validation`、`forbidden`、`not-ready`，会话失效与 `unauthenticated` 直接以 `4401` 关闭连接），其余错误码属于本帧或本频道的问题，客户端关闭当前连接后按既有指数退避重新申请票据与订阅。错误帧不计入「连接已可用」，否则每次失败都会重置退避，持续拒绝将退化成固定间隔的热循环。

### 玩家投影与恢复

客户端只在帧成功应用之后才推进确认游标并发送 `ack`。帧结构校验之后还须校验投影载荷与本地基线。提前确认未应用的增量会使重连跳过该增量。被拒绝的帧保持游标不动，由重新取快照补齐。

出现未应用的帧后，客户端必须进入「等待快照」状态：此后的增量既不应用也不确认，直到收到 `snapshot` 重建连续基线。只让被拒的那一帧不确认是不够的——后续帧一旦被确认，游标就跨过了缺口，服务端重连时从缺口之后续传，缺失的增量同样再也不会补发。玩家端在拒帧后先断开当前连接再重新取快照，避免旧连接继续推送与恢复并行。

在线分支切换（恢复存档或重新开局）后，服务端向所有 `player` 频道重新发送一次 `snapshot`，客户端丢弃旧投影。重发的快照携带新分支的 `worldId` 与 `branchId`，客户端据此更新本地会话身份：玩家端 HUD 显示的分支、控制台观测页查询 `/console/timeline` 与 `/console/agents` 使用的 `branchId` 都跟随该值，不再沿用登录时写入的常量。跨分支快照用于切换身份与投影基线。序号和投影版本只用于同一分支内的快照顺序判定。世界 ID 不同的快照仍被拒绝。

`append` 可与对应 `delta` 共用同一 `streamSeq`。对白按 `dialogueId` 识别，派生提醒按 `playerNotificationKey` 的 `kind` 与 `text` 识别。`worldTick` 会随 tick 更新。

服务端为每个 `(session, channel)` 保留最近 200 条增量，收到可连续重放的 `fromStreamSeq` 后补发，否则返回完整快照。投影发布失败后，服务端会按当前数据重建基线，补发的快照可能沿用当前序号和投影版本。原生端在当前连接上应用通过校验的同序号替换快照，每次建立新连接都以 `fromStreamSeq: null` 获取新基线。重连只恢复投影，命令由各自的 HTTP 回执和幂等键处理。流式模型 token 不经过任何玩家频道。

## 5. 控制台 API（`/api/v1/console/*`）

表中已交付的路由标记为“已实现”，其余路由定义首版目标契约。

### 5.1 运行总览与模块装配

`GET /api/v1/console/health` 已按运营/研究角色鉴权，返回整体健康状态、现行网页部署的端口配置、三个 realm、服务端装配 hash、各模块状态、当前时钟和有数据来源的队列摘要。原生部署切换后，v1 的 `ports.client` 保留为网页版本兼容元数据。实际监听按 [部署规格](two-endpoints.md#原生-demo-部署目标) 验收，原生模式的控制台只展示服务端监听。整体 `status` 与 `/api/v1/health` 使用同一 `lifecycle.healthStatus()` 来源；`queues` 给出 `turnsQueued` 与记忆维护的 `maintenanceQueued`、`maintenanceExhausted`；尚无数据来源的 `turnsRunning`、`modelQueue` 与 `laggingAgents` 省略，不用固定 0 冒充。`storage` 是可选的存储占用测量（主库页面与空闲页字节、内联与文件 artifact 正文字节、只追加表的行数、生效的保留天数与测量时刻），由存储适配器缓存 5 分钟，2 秒一次的轮询不会每次统计行数；存储实现不提供测量时省略，字段口径见 [存储 — 占用测量](storage.md#66-占用测量)。`recentFailures` 最多 10 条。`budgets` 按用途聚合在线分支所属 run 的 `budget_ledger`，已结算条目取实际用量、未结算条目取预留量，与预算裁决口径一致；没有任何账本记录时才是空数组。`hotPaths` 给出宿主在进程内按 span 名称汇总的热路径耗时，目前包括玩家投影构建 `player-projection.build` 与投影发布 `player-stream.publish`（发布包含其中的投影构建、增量比对与推送）。`count`、`errors` 自进程启动累计；`lastMs`、`p50Ms`、`p95Ms`、`maxMs` 只统计最近 `samples` 个样本（每个名称最多 256 个），单位毫秒。这些数据不写库，进程重启后清零；宿主未接入耗时汇总时省略该字段。传输层没有注入控制台端口时返回 503 `not-ready`，不返回伪造的 ready 摘要。

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /health`（已实现） | operator、researcher | — | `{ status: "ready"\|"degraded", ports: { client: 5173, server: 3000 }, realms, assemblyHash, modules: { moduleId, version, status }[], clock, queues: { turnsQueued, turnsRunning?, maintenanceQueued?, maintenanceExhausted?, modelQueue? }, storage?: { measuredAt, databaseBytes, freeBytes, artifactBytes: { inline, file }, tables: { table, rows }[], retention: { table, days }[] }, laggingAgents?, budgets, recentFailures, hotPaths?: { name, count, errors, samples, lastMs, p50Ms, p95Ms, maxMs }[] }` |
| `GET /modules?realm=`（已实现） | operator、researcher | — | `{ catalogHash, modules: ModuleDescriptorView[] }`（id、realm、kind、version、apiVersion、provides、requires、`configJsonSchema`、experimentAxes；不含工厂） |
| `GET /assemblies`（已实现） | operator、researcher | — | `{ assemblies: { assemblyId, source: "repo"\|"draft" }[] }` |
| `GET /assemblies/{assemblyId}`（已实现） | operator、researcher | — | `{ descriptor, resolved: Record<Realm, ResolvedModuleSet> }` |
| `POST /assemblies/preflight` | operator、researcher | `{ assembly: AssemblyDescriptor }` 或 `{ assemblyRef }` | `{ ok, errors: { code, moduleId?, capability?, message }[], resolved, diffAgainstCurrent }` |
| `POST /assemblies/drafts` | operator | `{ assembly: AssemblyDescriptor }` | `{ assemblyId, version }`；保存到 `config_drafts`，只对新 run 生效 |

### 5.2 模型池

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /model-layouts`（已实现） | operator、researcher | — | `{ layouts: { layoutId, source }[] }` |
| `GET /model-layouts/{layoutId}`（已实现） | operator、researcher | — | 去密钥的 layout（connections 显示 `adapterId`、`endpointRef`、端点主机名与 `credentialRef` 名称） |
| `GET /model-layouts/{layoutId}/routes`（已实现） | operator、researcher | — | `{ routes: { agentId, purpose, modelId, connectionId, adapterId, externalModel }[] }`：按角色看的已解析路由 |
| `POST /model-layouts/validate`（已实现） | operator | `{ layout }`，其中 `layout` 可以是任意 JSON 值 | `{ ok, errors }`。布局结构问题以 `schema` 错误项返回。请求缺少 `layout` 时返回 400 |
| `POST /model-layouts/drafts` | operator | `{ layout }` | `{ layoutId, version }`：保存为草稿，只对新 run 生效 |
| `POST /model-layouts/{layoutId}/probe` | operator | `{ modelId, operationId }` | `{ ok, latencyMs, servedModel, error? }`：一次计费的连通性测试，记录为 attempt |

模型布局目录无法读取时返回 `not-ready`，指定布局不存在时返回 `not-found`，布局配置损坏时返回 `invalid-state`。

`endpointRef` 公开允许的环境变量引用，其他已配置端点以 `layout:<layoutId>` 表示。控制台将仓库引用放回草稿的 `endpoint` 字段。服务端静态预检按同一布局、连接 ID 和适配器读取原端点，端点路径只在服务端使用。

### 5.3 三势力席位与世界运营

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /ops/seats` | operator | — | `{ seats: { agentId, controllerKind, controllerPrincipalId, controllerEpoch, leaseExpiresAt }[] }`，只包含 `species-fauna`、`species-flora`、`species-extraterrestrial` |
| `POST /ops/controllers/{agentId}/handover` | operator | `{ operationId, mode: "human"\|"agent", expectedEpoch, reason }` | `{ controllerEpoch, controllerKind, leaseExpiresAt }` |
| `POST /ops/controllers/{agentId}/renew` | operator | `{ controllerEpoch }` | `{ leaseExpiresAt }`（续期 10 分钟） |
| `GET /ops/seats/{agentId}/view` | operator（须持有该席位租约） | — | `{ worldView: AgentWorldView, inbox, agreements, invitations }`：只有该身份合法获知的内容 |
| `POST /ops/seats/{agentId}/commands` | operator（须持有该席位租约） | `CommandEnvelope` | `CommandReceipt`；以该 agentId 身份、当前 epoch 提交 |
| `POST /campaign/pause` / `resume`（已实现） | operator | `{ operationId, expectedRunVersion }` | `ClockView` |
| `POST /campaign/step`（已实现） | operator | `{ operationId, expectedRunVersion, ticks }`（1–24） | `ClockView`：进入 `stepping` 模式，宿主按 tick 间隔逐 tick 推进到目标后回到 `paused`；推进失败或章节终点时按 [运营](../platform/operations.md) 第 2 节退出 |
| `POST /campaign/snapshots`（已实现） | operator | `{ operationId, label }` | `{ snapshotId, worldTick }` |
| `GET /campaign/snapshots`（已实现） | operator、researcher | — | `{ snapshots: SnapshotView[] }` |
| `POST /campaign/restore`（已实现） | operator | `{ operationId, snapshotId, dryRun? }` | `dryRun: true` 返回 `{ ok, checks }` 只读预检，校验失败的检查项带原因。实际恢复成功后返回 `{ branchId, clock }`，并创建后继在线分支、保留旧分支 |
| `GET /run-requests` | operator | — | 玩家的 run 申请列表 |
| `POST /run-requests/{requestId}/approve` / `reject` | operator | `{ note }` | approve 返回 `{ runId }` |

已实现的运营入口位于 `/api/v1/console/campaign/*`，与第 3 节玩家自助入口路径独立。查询参数 `branchId` 可省略，省略时作用于在线分支；当前版本只支持在线分支，显式传入与在线分支不同的值返回 400 `validation`。快照列表与玩家入口一致，只列当前 campaign 的存档。

时钟单步、快照创建与快照恢复的请求/响应 DTO 在 `packages/contracts/src/api.ts` 中各只有一份定义，`packages/contracts/src/api-operations.ts` 只做再导出。恢复端点按请求是否带 `dryRun: true` 返回两种互斥形状：预检返回 `{ ok, checks }`，实际恢复返回 `{ branchId, clock }`；两者没有共享的判别字段，因此客户端按自己发出的请求选择校验哪一份 schema，而不是对响应做形状推断。预检能力只由控制台运营入口（`/api/v1/console/campaign/restore`）提供；玩家自助入口（`/api/v1/campaign/restore`）收到 `dryRun: true` 返回 400 `validation`，不会退化成真正执行恢复。以旧契约（恢复请求必填 `dryRun`）构造的调用会被 `.strict()` 拒绝，这正是不允许多份端点契约并存的原因。

### 5.4 剧情卡

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /scenarios/cards?branchId=` | operator | — | 内置卡与草稿卡，以及在该分支中的状态（draft/published/triggered/withdrawn） |
| `POST /scenarios/drafts` | operator | `{ card }`（与 [内容包](../game/content-pack.md) 第 9 节同结构） | `{ cardId, version }`；schema、引用、效果白名单校验失败返回 400 |
| `POST /scenarios/drafts/{cardId}/preview` | operator | `{ version, atTick }` | `{ events: EventPreview[] }`：在沙盒分支中试算，不影响在线世界 |
| `POST /scenarios/drafts/{cardId}/publish` | operator | `{ version, triggerAtTick, operationId }` | `CommandReceipt`（命令 `scenario.publish`） |
| `POST /scenarios/cards/{cardId}/withdraw` | operator | `{ operationId }` | `CommandReceipt` |
| `POST /scenarios/cards/{cardId}/compensate` | operator | `{ effects, note, operationId }` | `CommandReceipt` |
| `POST /scenarios/override` | operator、researcher | `{ effects, note, operationId }` | `CommandReceipt`；当前 run 被标记 contaminated |

### 5.5 可观测与调试（角色 `researcher`）

| 方法与路径 | 请求参数 | 响应 |
|---|---|---|
| `GET /timeline`（已实现） | `branchId`、`fromSeq`（缺省 0）、`limit`（缺省 100，≤ 200）、`order`（`asc`/`desc`）、`types`（≤ 20 个，每个 ≤ 64 字符）、`agentId`、`nodeId` | `{ events: TimelineItem[] }`：真值视角的领域事件，附生命周期事件；筛选在存储查询中执行，`desc` 用于读取最新事件。查询参数的取值范围以公共 `timelineQuerySchema` 为唯一基准，路由只做类型规范化 |
| `GET /agents`（已实现） | `branchId`（必填） | `{ agents: { agentId, kind, active, controllerKind, location, turnStatus, watermarkLag }[] }`。`location` 取世界模块 `character` 聚合的 `nodeId`，没有该聚合时才是 `null`；`watermarkLag` 是该 Agent 已感知世界序号与分支最新世界序号之差，尚未建立感知水位时按最新序号计 |
| `GET /agents/{agentId}/inspector`（已实现） | `branchId`（必填） | 人格、位置、`AgentWorldView`、当前 memory revision 的记录摘要、关系与承诺、水位、最近 20 个 turn。未知 Agent 返回 `not-found` |
| `GET /agents/{agentId}/memory`（已实现） | `branchId`（必填）、`revision`（可选，缺省为当前最新） | `{ revision, records: MemoryRecord[] }` |
| `GET /agents/{agentId}/memory/diff`（已实现） | `branchId`（必填）、`from`、`to` | `{ added, retired, changed }`，每项带来源观察 ID |
| `GET /agents/{agentId}/observations`（已实现） | `branchId`（必填）、`fromSeq`（缺省 0）、`limit`（缺省 100，范围 1–200） | `{ observations: AgentObservation[] }` |
| `GET /turns`（已实现） | `runId`、`branchId`、`agentId`、`status`、`limit`（缺省 50，范围 1–200） | turn 列表 |
| `GET /turns/{turnId}`（已实现） | — | turn 详情：frontier、各阶段 requested/resolved/effective、span、context artifact 引用、全部 model attempt、tool call（原始与视图 artifact 引用）、receipt、对白 |
| `GET /artifacts/{artifactId}`（已实现） | `view=redacted\|raw` | 当前世界所属 run 的 artifact 正文。缺少可访问 run 时返回 `forbidden`。读取原文记一条审计生命周期事件 |
| `GET /traces/{traceId}`（已实现） | — | span 树；跨度已按保留期全部删除的 trace 返回 `not-found`（[存储 — 数据保留与轮转](storage.md#6-数据保留与轮转)） |
| `GET /branches/compare`（事件差异已实现） | `left`、`right`、`atSeq` | 两个分支在相同检查点后的事件差异摘要；指标与协议差异仍待补齐 |
| `GET /debug/queues`（已实现） | — | 调度队列、模型池队列、维护队列。模型池的排队数 `modelPool.queued` 为 `null` 表示存储无法提供该计数 |
| `POST /debug/turns/{turnId}/replay`（hash 校验已实现） | — | 校验已归档 artifact 的规范 JSON hash；不调用模型，返回 `{ requestHashMatch, differences }` |
| `POST /debug/agents/{agentId}/wake`（已实现） | `{ reason, operationId }` | 注入一个 `debug` trigger，当前 run 被标记 contaminated，审计记录包含认证会话的 `principalId` |

### 5.6 评估与导出

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `POST /runs`（已实现） | researcher | `{ runSpec }`（[配置](../platform/configuration.md) 第 3 节） | `{ runId, status: "ready" \| "preflight-failed", errors }` |
| `GET /runs`（已实现） | researcher、evaluator | `status`、`limit` | run 列表 |
| `GET /runs/{runId}`（已实现） | researcher、evaluator | — | 状态、去密钥 manifest、manifest hash、contaminated、evidenceComplete |
| `POST /runs/{runId}/start` / `stop`（已实现） | researcher | `{ operationId }` | `{ runId, status: "running" \| "paused" }` |
| `GET /runs/{runId}/report`（已实现） | researcher、evaluator | — | 指标、分子分母、无效样本数与原因、探针结果（[评估](../platform/evaluation.md) 第 9 节） |
| `GET /experiments`（已实现） | researcher、evaluator | — | `{ experiments: { experimentId, runCount }[] }` |
| `POST /experiments`（已实现） | researcher | `{ experimentSpec }` 或 `{ experimentRef }`（格式见第 9 节末尾） | `{ experimentId, runIds, runs: { runId, status, errors }[], failedRunCount }` |
| `GET /experiments/{experimentId}`（已实现） | researcher、evaluator | — | 各 run 状态与汇总报告 |
| `POST /exports`（已实现） | researcher | `{ runId, redaction: "redacted"\|"raw" }` | `{ artifactId }`：导出包（manifest、事件、turn、artifact 索引） |

## 6. 角色权限矩阵

| 接口组 | player | operator | researcher | evaluator |
|---|---|---|---|---|
| `/auth/*`、`/session`、`/streams/ticket` | ✓ | ✓ | ✓ | ✓ |
| `/content` | ✓ | ✓ | ✓ | ✓ |
| `/session/assembly?realm=client` | ✓ | ✓ | ✓ | ✓ |
| `/session/assembly?realm=console` | ✗ | ✓ | ✓ | ✓ |
| 第 3 节其余玩家接口 | ✓ | ✗ | ✗ | ✗ |
| 5.1 总览与装配 | ✗ | ✓ | ✓（只读） | ✗ |
| 5.2 模型池 | ✗ | ✓ | ✓（只读） | ✗ |
| 5.3 席位与运营 | ✗ | ✓（时钟、单步、存档、恢复） | 只读快照列表 | ✗ |
| 5.4 剧情卡 | ✗ | ✓ | 只能 override | ✗ |
| 5.5 可观测与调试 | ✗ | ✗ | ✓ | ✗ |
| 5.6 评估与导出 | ✗ | ✗ | ✓ | 只读 run 与报告 |

服务端在路由层按本表鉴权，再在处理器里校验资源 scope（例如席位命令必须持有该席位的有效租约）。前端隐藏按钮只是体验，不是鉴权。

## 7. 错误响应

非 2xx 响应的统一格式：

```json
{ "error": { "code": "forbidden", "retryable": false, "safeMessage": "当前角色无权访问该接口", "traceId": "trc-...", "detailsArtifactRef": null } }
```

下表只列 HTTP 接口实际会产生的 `error.code`：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation` | JSON 或 schema 不合法、未知命令类型、未知字段 |
| 401 | `unauthenticated` | 缺少或无效的会话、令牌错误 |
| 403 | `forbidden` / `realm-violation` | 角色不允许、Origin 不允许、玩家访问控制台接口、命令类型已登记但当前角色无权 |
| 404 | `not-found` | 资源不存在 |
| 409 | `idempotency-conflict` / `version-conflict` / `invalid-state` | 同 ID 不同 payload、版本不符、当前状态不允许操作 |
| 422 | `assembly-incompatible` / `module-missing` / `capability-conflict` | 装配或 run 预检失败 |
| 429 | `budget-exhausted` | 预算或配额耗尽 |
| 503 | `not-ready` | 服务未就绪、分支正在静默或切换 |
| 500 | `plugin-failed` / `provider-failed` | 未预期的模块或供应商故障；`safeMessage` 不含内部细节 |

业务规则拒绝（例如资源不足、路线不可用）不使用以上 HTTP 错误：命令被受理并写入 receipt，返回 200 和 `commandStatus: "rejected"`，原因放在 `receipt.reasonCode`。下列值容易与错误码混淆，它们只以这种方式出现，客户端不要在 `error.code` 中等待它们：

| `receipt.reasonCode` | 场景 |
|---|---|
| `paused` | 世界时钟不在 running 或 stepping，命令不豁免暂停 |
| `stale-controller` | Agent 命令缺少或携带过期的控制权 epoch、控制租约已过期，或角色已由非 Agent 控制者接管 |
| `stale-turn` | Agent 命令缺少 turn 租约，或 turn 不存在、已结束、租约过期、租约代次与归属不符 |

传输层的状态码映射覆盖登记表中的全部错误码，以保证任何 `DomainError` 都有确定的 HTTP 状态；其中 `cancelled` 只用于模型池工作租约失效与存储启动取消等进程内流程，`paused`、`stale-controller`、`stale-turn` 只作为上表的回执原因码出现，三者都没有 HTTP 接口的产生路径。

`traceId` 的取值分两种情况，客户端不能假定它一定对应本次请求的 span：

1. `DomainError` 显式携带 `traceId` 或 `detailsArtifactRef` 时优先返回错误自身的值。这类错误可能由其他请求、后台 worker 或延迟提交产生，其 trace 指向产生错误的那个上下文，不一定能在本次 `http.request` span 下查到。
2. 未显式携带时回落到本次请求的 trace。`onRequest` 为每个请求生成 trace，并在注入了 `recordSpan` 时登记，错误出口在构造响应时取回；该值对应本次请求写入 `trace_spans` 的 `http.request` span。部署配置了 `trace_spans` 保留期时，该 span 超过保留期后被删除，之后按该 `traceId` 查不到 span。

两者都没有时字段为 `null`，不用空串冒充。传输层未注入 `recordSpan` 时请求 span 不会落库，此时不登记 trace，错误响应的 `traceId` 保持 `null`，避免给出查不到的伪标识。

## 8. API 验收

- 玩家会话访问任一 `/api/v1/console/*` 返回 403；不带 `X-Active-Role` 的控制台请求返回 403。
- 同一 `commandId` 重放得到同一 receipt；换 payload 返回 409 `idempotency-conflict`。
- 断线后带 `fromStreamSeq` 重连，客户端投影与 `GET /world/view` 一致；缺口超过 200 时收到新快照。
- 来自其他 Origin 的请求与 WS 握手被拒绝。
- 任一非 2xx 响应的 `traceId` 要么能在 `trace_spans` 中查到对应的 `http.request` span（回落情形；配置了保留期时限于保留期内），要么是该错误自身携带的 trace（显式情形）；未注入 `recordSpan` 时为 `null`。
- `GET /console/timeline` 的查询边界与 `timelineQuerySchema` 一致：缺省 `fromSeq`/`limit` 使用默认值，`types` 超过 20 个返回 400。
- `GET /console/agents` 对已开局角色返回真实 `location` 与 `watermarkLag`，不用固定 `null` 与 `0` 冒充。
- 所有接口的响应里都找不到 API 密钥、`credentialRef` 的解析值或任何 Agent 的私密记忆（玩家接口）。

## 9. 响应类型

下列类型与第 3–5 节的接口配套，在 `packages/contracts/src/api.ts` 中用 Zod 定义。

```ts
interface StartOption { factionId: string; name: string; commission: string; contacts: { agentId: string; name: string }[] }

interface CampaignView {
  campaignId: string;
  factionId: string;
  factionName: string;
  commission: string;
  status: "running" | "evaluated";
  outcome: "equilibrium" | "strained" | null;   // ChapterStageEvaluated 后设置
  startTick: number;
}

interface SnapshotView { snapshotId: string; label: string; worldTick: number; day: number; createdAt: string; createdBy: string }

interface ClientUiText {
  noReply: string; waitingReply: string; reconnecting: string; serverUnavailable: string;
  sessionExpired: string; incompleteAssembly: string; moduleNotLoaded: string;
  chapterKicker: string; startBriefing: string; hudKicker: string; siteLabel: string;
  sceneLabel: string; consoleTitle: string;
}

interface ClientContentView {
  chapterTitle: string;
  clock: { secondsPerTick: number; evaluationTick: number; motionTick: number };
  ui: ClientUiText;
}

interface ConversationLine {
  seq: number;
  dialogueId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  worldTick: number;
  channel: "face-to-face" | "relay";
}

interface TimelineItem {
  kind: "domain" | "lifecycle";
  worldSeq: number | null;       // 仅领域事件有值
  worldTick: number | null;
  eventId: string | null;
  type: string;
  principalId: string | null;
  audience: AudienceSpec[] | null;
  summaryZh: string;             // 领域事件为「事件类型 · 发出主体 ID」，生命周期事件为「事件类型 · 主体 ID」（无主体时为「系统」）；不经 observationTemplates 渲染
  payload: Json;
  correlationId: string | null;
  createdAt: string;
}

interface EventPreview { type: string; audience: AudienceSpec[]; payload: Json; summaryZh: string }

interface ModuleDescriptorView {
  moduleId: string; realm: Realm; kind: ModuleKind; version: string; apiVersion: string;
  provides: CapabilityRef[]; requires: CapabilityRef[]; ownsAggregates: string[];
  configJsonSchema: Json;        // 由 z.toJSONSchema(configSchema) 生成
  experimentAxes: { key: string; label: string; values?: Json[] }[];
}

interface TurnSummary {
  turnId: string; runId: string; branchId: string; agentId: string;
  agentTurnIndex: number;        // 同一分支内该 Agent 的第几个 turn，从 1 起计，与 turn 记录同一口径
  status: string; triggerKinds: string[]; terminalReason: string | null;
  createdAt: string; endedAt: string | null; modelCalls: number; toolCalls: number; tokens: { input: number | null; output: number | null };
}

interface TurnDetail extends TurnSummary {
  inputFrontier: InputFrontier | null;
  memoryRevision: number | null;
  stages: { stage: string; status: "applied" | "skipped" | "failed"; reason: string | null;
            requested: Json; resolved: Json; effective: Json; spanId: string }[];
  contextArtifactIds: string[];
  attempts: { attemptId: string; purpose: string; modelId: string; status: string; isEffective: boolean;
              requestArtifactId: string | null; responseArtifactId: string | null; usage: Json; error: Json | null }[];
  toolCalls: { toolCallId: string; toolId: string; executionStatus: string | null; commandStatus: string | null;
               rawArtifactId: string | null; viewArtifactId: string | null; operationId: string | null }[];
  decision: Json | null;          // 通过校验的 decision_submit 参数
  speech: { speechArtifactId: string; text: string; fallback: boolean } | null;
  traceId: string | null; // queued turn 尚未产生 span，或其 span 已按保留期删除时为 null
}
```

`POST /api/v1/console/experiments` 的 `experimentSpec` 与 `config/experiments/*.yaml` 的格式相同（[配置](../platform/configuration.md) 第 10.3 节），宿主按同一份实验规格 schema 校验，空对象或含未知字段时返回 400 `validation`；也可以传 `{ experimentRef }` 引用仓库里的规格文件，引用写文件基名（如 `exp-memory-promise-v1`），不接受路径或扩展名。`POST /api/v1/console/runs` 的 `runSpec` 是 [配置](../platform/configuration.md) 第 3 节的 RunSpec。
