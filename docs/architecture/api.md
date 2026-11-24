# HTTP 与 WebSocket API

> 本文规定首版 HTTP 与 WebSocket 接口。接口由 `server` 在 `127.0.0.1:3000` 提供，玩家客户端经 `:5173` 的代理以相对路径访问。公共 DTO 在 `packages/contracts` 中用 Zod 定义。交付范围见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。参见 [tech-stack.md — 技术栈](../delivery/tech-stack.md#6-本地双端拓扑)、[domain-model.md — 领域模型](domain-model.md)、[contracts.md — 公共契约](contracts.md)。

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 前缀 | `/api/v1`；控制台接口在 `/api/v1/console/*`；静态控制台页面在 `/console/*` |
| 格式 | 请求与响应都是 `application/json; charset=utf-8`；字段 camelCase |
| 认证 | `Authorization: Bearer <sessionToken>`；除 `GET /api/v1/health` 与 `POST /api/v1/auth/login` 外都需要 |
| 控制台角色 | 控制台请求必须带 `X-Active-Role: operator \| researcher \| evaluator`，且该角色在会话角色内；服务端只按这个当前角色鉴权 |
| Origin | 请求带 `Origin` 头时，必须是 `http://127.0.0.1:5173` 或 `http://127.0.0.1:3000`，否则返回 403；WS 握手同样检查 |
| 跨域允许面 | 只允许 `GET`、`POST`、`OPTIONS` 与 `Authorization`、`Content-Type`、`X-Active-Role` 三个请求头；会话令牌走请求头而非 Cookie，因此不启用 `credentials` |
| 安全响应头 | 全部响应带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 与 `Referrer-Policy: same-origin`；`text/html` 文档另带 CSP（`default-src 'self'`、`frame-ancestors 'none'`，不放开内联脚本） |
| 传输上限 | `requestTimeout` 与 `handlerTimeout` 各 30 秒、socket 空闲 30 秒回收、单连接最多 1000 个请求、请求体上限 1 MiB。`handlerTimeout` 超期返回 500 `plugin-failed` 且 `retryable: true`；它只中止本次响应等待，handler 内已发起的异步工作不会被自动取消。收齐请求头的期限沿用 Node 的 `headersTimeout` 默认值，本服务不另行配置 |

| 幂等 | 世界命令用 `commandId`。时钟、快照、接管等控制操作用请求体里的 `operationId`，重复请求复用已记录的结果 |
| 并发控制 | 控制操作带 `expectedRunVersion` 或 `expectedEpoch`；不一致返回 409 |
| 分支 | 玩家接口总是作用于 `world_aliases('online')` 指向的分支；控制台运营入口可以用查询参数 `branchId` 指定分支，缺省为在线分支。当前版本只支持在线分支：`branchId` 与在线分支不一致时返回 400 `validation`，不会静默改作用分支 |
| 输入上限 | 世界命令的文本、主体名单与协议条款数量由公共契约统一限制（见 [公共契约](contracts.md) 第 1 节）；超限命令返回 200 + `commandStatus: "rejected"` 的 receipt，原因码 `invalid-params` |
| 错误 | 见第 7 节；业务拒绝不是 HTTP 错误，而是 200 + `commandStatus: "rejected"` 的 receipt |

## 2. 认证、会话与健康检查

本地 Demo 用启动令牌登录。服务端读取 `NPC_PLAYER_TOKEN`、`NPC_CONSOLE_TOKEN` 与可选的单角色控制台令牌。玩家和控制台令牌缺省时优先复用数据目录中的 `dev-tokens.json`。首次生成的令牌由 32 字节随机数据编码，保存后可跨重启复用，登录地址仅在生成当次打印。令牌文件先写入同目录暂存文件并刷新到磁盘，服务监听成功且登录地址输出后才原子改名为 `dev-tokens.json`；暂存写入失败时不进入监听，发布失败时关闭宿主并终止启动，已有令牌文件保持原样，因此不会留下截断的 JSON 文件。

```text
[ai-npc] player  login: http://127.0.0.1:5173/#token=<player token>
[ai-npc] console login: http://127.0.0.1:3000/console/#token=<console token>
```

目标浏览器宿主启动时读取 `location.hash` 里的 `token`，调用登录接口，把返回的 `sessionToken` 存进按 origin 隔离的 `sessionStorage`，再用 `history.replaceState` 清掉 hash。

| 令牌 | principalId | 角色 |
|---|---|---|
| `NPC_PLAYER_TOKEN` | `player-1` | `player` |
| `NPC_CONSOLE_TOKEN` | `console-admin` | `operator`、`researcher`、`evaluator` |
| `NPC_OPERATOR_TOKEN` 等（可选） | `console-operator` 等 | 对应单一角色 |

| 方法与路径 | 请求 | 响应 | 说明 |
|---|---|---|---|
| `GET /api/v1/health` | — | `{ status: "starting"\|"ready"\|"degraded", protocolVersion: "1" }` | 不需要认证，不返回内部细节；e2e 用它等待就绪 |
| `POST /api/v1/auth/login` | `{ token }` | `{ sessionToken, principalId, roles, expiresAt }` | 令牌错误返回 401。会话自登录起默认有效 12 小时 |
| `POST /api/v1/auth/logout` | — | `{ ok: true }` | 吊销当前会话 |
| `GET /api/v1/session` | — | `SessionDescriptor`（[公共契约](contracts.md) 第 4 节） | 当前会话、角色、分支、协议版本、server 端已解析模块集 |
| `GET /api/v1/session/assembly?realm=client\|console` | — | `ResolvedModuleSet` | 浏览器宿主启动时取本 realm 的模块清单并校验（[积木组合](composition.md) 第 3 节）；玩家会话请求 `realm=console` 返回 403 |
| `POST /api/v1/streams/ticket` | — | `{ ticket, expiresAt }` | 一次性 WS 票据，30 秒内有效 |

会话数量有上限。容量满时服务端先清理过期会话，再淘汰没有活动 WS 连接且最早过期的会话；如果剩余会话都保持活动连接，登录返回 429 `budget-exhausted`（`retryable: true`），不会驱逐活跃会话。

## 3. 玩家 API（角色 `player`）

本节是玩家自助入口：暂停、继续、存档、恢复与重新开局都由玩家会话直接作用于在线分支。控制台运营角色使用第 5.3 节的 `/api/v1/console/campaign/*` 入口；两者路径、角色与幂等主体各自独立，互不复用。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/campaign` | — | `{ campaign: CampaignView \| null, starts: StartOption[] }`（类型见第 9 节） |
| `GET /api/v1/content` | — | `{ chapterTitle, clock: { secondsPerTick, evaluationTick, motionTick }, ui: ClientUiText }`：客户端只读内容视图，章节名与界面文字取自内容包，时钟刻度取自装配配置；任何已认证会话可读 |
| `POST /api/v1/commands` | `CommandEnvelope` | `CommandReceipt` |
| `GET /api/v1/commands/{commandId}` | — | `CommandReceipt`；不存在返回 404 |
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
  operationId: string | null;
  resultingVersions: Record<string, number>;
  result: Json | null;               // 例如 task.dispatch 返回 { taskId }，agreement.propose 返回 { agreementId }
  worldTick: number;
}

interface ClockView { worldTick: number; day: number; hour: number; mode: "running" | "pausing" | "paused" | "resuming" | "stepping"; runVersion: number; }
```

### 3.1 玩家命令权限

**已实现**：`POST /api/v1/commands` 接受 `campaign.start`、`dialogue.say`、`information.share`、`agreement.propose`、`agreement.respond`、`task.dispatch`、`task.cancel` 和 `policy.set`。`policy.set` 只允许当前 campaign 的公社党魁玩家设置 `watergate.allocation`，授权按已开局 campaign 的玩家与派系裁决。

**序章目标**：同一接口承载玩家广播及程序案交互。服务端使用认证和已开局的席位记录裁决权限。广播及程序案命令的具体请求格式待定。参见 [domain-model.md — 命令目录](domain-model.md#5-命令目录)。

## 4. WebSocket：`GET /api/v1/streams?ticket=<ticket>`

连接建立后，服务端先发 `hello`。客户端订阅 `player` 后接收快照与增量。所有消息都是 JSON 文本帧。

客户端帧有 64 KiB 上限。超过上限的帧不会进入消息处理器，服务端审计该事件并以 1009 关闭连接；正常的 `subscribe`、`ack` 与 `ping` 帧远小于上限。

| 方向 | 消息 | 字段 |
|---|---|---|
| S→C | `hello` | `protocolVersion`、`principalId`、`channels`（本会话可订阅的频道） |
| C→S | `subscribe` | `channel`、`fromStreamSeq`（首次为 `null`） |
| S→C | `snapshot` | `channel`、`streamSeq`、`projectionVersion`、`worldId`、`branchId`、`data`。玩家频道使用真实投影版本；v1 控制台频道的 `projectionVersion` 仅作为兼容哨兵固定为 `0`，不代表玩家投影修订，控制台快照序号以 `streamSeq` 为准。`worldId` 与 `branchId` 是该快照所属的分支身份，客户端以帧内值为准更新本地世界与分支 |
| S→C | `delta` | `channel`、`streamSeq`、`projectionVersion`、`set`（顶层字段 → 新值的映射，例如 `{ "tasks": [...], "meters": {...} }`） |
| S→C | `append` | `channel`、`streamSeq`、`kind`、`item`。`kind` 与 `item` 按判别联合绑定：`dialogue` 的 `item` 必须满足 `ConversationLine`，`notification` 的 `item` 必须满足 `PlayerNotificationView`，且 `channel` 固定为 `player`。未实现的追加种类不在公开 schema 内，消费方无需区分“未实现”与“暂无数据” |
| C→S | `ack` | `channel`、`streamSeq` |
| C→S / S→C | `ping` / `pong` | — |
| S→C | `error` | `code`、`safeMessage` |

控制台频道按权限出现在 `hello.channels` 中，订阅时和世界变化后推送对应快照。

| 频道 | 角色 | 推送内容 | 状态 |
|---|---|---|---|
| `player` | player | `PlayerProjection` 快照与增量；新对话行、提醒用 `append` | 已实现 |
| `console.health` | operator、researcher | 每 2 秒一次健康摘要快照，结构与 [运行总览响应](#51-运行总览与模块装配) 一致 | 已实现 |
| `console.timeline` | researcher | 订阅时和世界变化后推送时间线快照 | 已实现 |
| `console.turns` | researcher | turn 状态变化（`append`） | 目标 |

连接关闭码在同一应用自定义区间内区分两类完全不同的失败，客户端必须按码分别处理：

| 关闭码 | 触发条件 | 客户端语义 |
|---|---|---|
| `4401` | 会话已被注销或过期 | 会话失效：清除本地会话令牌并停止重连，提示重新登录 |
| `4408` | 票据缺失、过期、已消费或被容量淘汰 | 票据失效：重新申请票据后重连，不清除仍然有效的会话令牌 |

两类失败共用同一个码会让可重试的握手失败被当成强制登出：票据 30 秒有效，后台标签页挂起后恢复建连即命中。票据有效但其绑定的会话已失效时归入会话失效，用 `4401`。

`error` 帧是服务端唯一的结构化失败通道，客户端必须消费：`unauthenticated` 与 `forbidden` 按会话失效处理（清除令牌并停止重连），其余错误码属于本帧或本频道的问题，客户端关闭当前连接后按既有指数退避重新申请票据与订阅。错误帧不计入「连接已可用」，否则每次失败都会重置退避，持续拒绝将退化成固定间隔的热循环。

客户端只在帧成功应用之后才推进确认游标并发送 `ack`。传输层 schema 只校验帧是合法 JSON，领域 schema 更严；若先推进游标再应用，消费侧拒绝的帧会被确认掉，重连时服务端从已前移的序号续传，该增量永久丢失。被拒绝的帧保持游标不动，由重新取快照补齐。

出现未应用的帧后，客户端必须进入「等待快照」状态：此后的增量既不应用也不确认，直到收到 `snapshot` 重建连续基线。只让被拒的那一帧不确认是不够的——后续帧一旦被确认，游标就跨过了缺口，服务端重连时从缺口之后续传，缺失的增量同样再也不会补发。玩家端在拒帧后先断开当前连接再重新取快照，避免旧连接继续推送与恢复并行。

在线分支切换（恢复存档或重新开局）后，服务端向所有 `player` 频道重新发送一次 `snapshot`，客户端丢弃旧投影。重发的快照携带新分支的 `worldId` 与 `branchId`，客户端据此更新本地会话身份：玩家端 HUD 显示的分支、控制台观测页查询 `/console/timeline` 与 `/console/agents` 使用的 `branchId` 都跟随该值，不再沿用登录时写入的常量。新分支的 `streamSeq` 从 0 重新计数，因此客户端对跨分支快照按「切换身份」处理，而不是用旧分支的序号判定迟到；只有同一分支内的旧快照才按 `streamSeq` 与 `projectionVersion` 丢弃。世界 ID 不同的快照仍被拒绝。

重连规则：服务端为每个 `(session, channel)` 保留最近 200 条增量。`fromStreamSeq` 之后的增量都还在时补发增量；否则重新发一次 `snapshot`。重连只补投影，不重放任何命令。流式模型 token 不经过任何玩家频道。

## 5. 控制台 API（`/api/v1/console/*`）

表中已交付的路由标记为“已实现”，其余路由定义首版目标契约。

### 5.1 运行总览与模块装配

`GET /api/v1/console/health` 已按运营/研究角色鉴权，返回整体健康状态、两个端口、三个 realm、服务端装配 hash、各模块状态、当前时钟和有数据来源的队列摘要。整体 `status` 与 `/api/v1/health` 使用同一 `lifecycle.healthStatus()` 来源；尚无数据来源的 `turnsRunning`、`maintenanceQueued`、`modelQueue` 与 `laggingAgents` 省略，不用固定 0 冒充。`budgets` 按用途聚合在线分支所属 run 的 `budget_ledger`，已结算条目取实际用量、未结算条目取预留量，与预算裁决口径一致；没有任何账本记录时才是空数组。传输层没有注入控制台端口时返回 503 `not-ready`，不返回伪造的 ready 摘要。

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /health`（已实现） | operator、researcher | — | `{ status: "ready"\|"degraded", ports: { client: 5173, server: 3000 }, realms, assemblyHash, modules: { moduleId, version, status }[], clock, queues: { turnsQueued, turnsRunning?, maintenanceQueued?, modelQueue? }, laggingAgents?, budgets, recentFailures }` |
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
| `GET /agents`（已实现） | `branchId` | `{ agents: { agentId, kind, active, controllerKind, location, turnStatus, watermarkLag }[] }`。`location` 取世界模块 `character` 聚合的 `nodeId`，没有该聚合时才是 `null`；`watermarkLag` 是该 Agent 已感知世界序号与分支最新世界序号之差，尚未建立感知水位时按最新序号计 |
| `GET /agents/{agentId}/inspector`（已实现） | `branchId` | 人格、位置、`AgentWorldView`、当前 memory revision 的记录摘要、关系与承诺、水位、最近 20 个 turn。未知 Agent 返回 `not-found` |
| `GET /agents/{agentId}/memory`（已实现） | `branchId`、`revision` | `{ revision, records: MemoryRecord[] }` |
| `GET /agents/{agentId}/memory/diff`（已实现） | `branchId`、`from`、`to` | `{ added, retired, changed }`，每项带来源观察 ID |
| `GET /agents/{agentId}/observations`（已实现） | `branchId`、`fromSeq`、`limit` | `{ observations: AgentObservation[] }` |
| `GET /turns`（已实现） | `runId`、`agentId`、`status`、`limit` | turn 列表 |
| `GET /turns/{turnId}`（已实现） | — | turn 详情：frontier、各阶段 requested/resolved/effective、span、context artifact 引用、全部 model attempt、tool call（原始与视图 artifact 引用）、receipt、对白 |
| `GET /artifacts/{artifactId}`（已实现） | `view=redacted\|raw` | 当前世界所属 run 的 artifact 正文。缺少可访问 run 时返回 `forbidden`。读取原文记一条审计生命周期事件 |
| `GET /traces/{traceId}`（已实现） | — | span 树 |
| `GET /branches/compare`（事件差异已实现） | `left`、`right`、`atSeq` | 两个分支在相同检查点后的事件差异摘要；指标与协议差异仍待补齐 |
| `GET /debug/queues`（已实现） | — | 调度队列、模型池队列、维护队列。模型池的排队数 `modelPool.queued` 为 `null` 表示存储无法提供该计数 |
| `POST /debug/turns/{turnId}/replay`（hash 校验已实现） | — | 校验已归档 artifact 的规范 JSON hash；不调用模型，返回 `{ requestHashMatch, differences }` |
| `POST /debug/agents/{agentId}/wake`（已实现） | `{ reason, operationId }` | 注入一个 `debug` trigger，当前 run 被标记 contaminated，审计记录包含认证会话的 `principalId` |

### 5.6 评估与导出

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `POST /runs` | researcher | `{ runSpec }`（[配置](../platform/configuration.md) 第 3 节） | `{ runId, status: "ready" \| "preflight-failed", errors }` |
| `GET /runs` | researcher、evaluator | `status`、`limit` | run 列表 |
| `GET /runs/{runId}` | researcher、evaluator | — | 状态、去密钥 manifest、manifest hash、contaminated、evidenceComplete |
| `POST /runs/{runId}/start` / `stop` | researcher | `{ operationId }` | run 状态 |
| `GET /runs/{runId}/report` | researcher、evaluator | — | 指标、分子分母、无效样本数与原因、探针结果（[评估](../platform/evaluation.md) 第 9 节） |
| `POST /experiments` | researcher | `{ experimentSpec }` 或 `{ experimentRef }`（格式见第 9 节末尾） | `{ experimentId, runIds }`：按顺序创建并排队执行 |
| `GET /experiments/{experimentId}` | researcher、evaluator | — | 各 run 状态与汇总报告 |
| `POST /exports` | researcher | `{ runId, redaction: "redacted"\|"raw" }` | `{ artifactId }`：导出包（manifest、事件、turn、artifact 索引） |

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

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation` | JSON 或 schema 不合法、未知命令类型、未知字段 |
| 401 | `unauthenticated` | 缺少或无效的会话、令牌错误 |
| 403 | `forbidden` / `realm-violation` | 角色不允许、Origin 不允许、玩家访问控制台接口、命令类型已登记但当前角色无权 |
| 404 | `not-found` | 资源不存在 |
| 409 | `idempotency-conflict` / `version-conflict` / `stale-controller` / `stale-turn` / `cancelled` / `invalid-state` | 同 ID 不同 payload、版本不符、控制权或 turn 已失效、操作已取消、当前状态不允许操作 |
| 422 | `assembly-incompatible` / `module-missing` / `capability-conflict` | 装配或 run 预检失败 |
| 429 | `budget-exhausted` | 预算或配额耗尽 |
| 503 | `not-ready` / `paused` | 服务未就绪、分支正在静默或切换 |
| 500 | `plugin-failed` / `provider-failed` | 未预期的模块或供应商故障；`safeMessage` 不含内部细节 |

业务规则拒绝（例如资源不足、路线不可用）不使用以上 HTTP 错误：命令被受理并写入 receipt，返回 200 和 `commandStatus: "rejected"`。

`traceId` 的取值分两种情况，客户端不能假定它一定对应本次请求的 span：

1. `DomainError` 显式携带 `traceId` 或 `detailsArtifactRef` 时优先返回错误自身的值。这类错误可能由其他请求、后台 worker 或延迟提交产生，其 trace 指向产生错误的那个上下文，不一定能在本次 `http.request` span 下查到。
2. 未显式携带时回落到本次请求的 trace。`onRequest` 为每个请求生成 trace，并在注入了 `recordSpan` 时登记，错误出口在构造响应时取回；该值对应本次请求写入 `trace_spans` 的 `http.request` span。

两者都没有时字段为 `null`，不用空串冒充。传输层未注入 `recordSpan` 时请求 span 不会落库，此时不登记 trace，错误响应的 `traceId` 保持 `null`，避免给出查不到的伪标识。

## 8. API 验收

- 玩家会话访问任一 `/api/v1/console/*` 返回 403；不带 `X-Active-Role` 的控制台请求返回 403。
- 同一 `commandId` 重放得到同一 receipt；换 payload 返回 409 `idempotency-conflict`。
- 断线后带 `fromStreamSeq` 重连，客户端投影与 `GET /world/view` 一致；缺口超过 200 时收到新快照。
- 来自其他 Origin 的请求与 WS 握手被拒绝。
- 任一非 2xx 响应的 `traceId` 要么能在 `trace_spans` 中查到对应的 `http.request` span（回落情形），要么是该错误自身携带的 trace（显式情形）；未注入 `recordSpan` 时为 `null`。
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
  summaryZh: string;             // 使用 observationTemplates 渲染，展示真实世界视图
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
  turnId: string; runId: string; branchId: string; agentId: string; agentTurnIndex: number;
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
  traceId: string | null; // queued turn 尚未产生 span 时为 null
}
```

`POST /api/v1/console/experiments` 的 `experimentSpec` 与 `config/runs/*.yaml` 的格式相同（[配置](../platform/configuration.md) 第 10.3 节）；也可以传 `{ experimentRef }` 引用仓库里的文件。`POST /api/v1/console/runs` 的 `runSpec` 是 [配置](../platform/configuration.md) 第 3 节的 RunSpec。
