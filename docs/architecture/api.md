# HTTP 与 WebSocket API

> 状态：部分实现。本文是首版的完整接口规格。所有接口由 `server` 在 `127.0.0.1:3000` 提供，目标客户端经 `:5173` 的代理以相对路径访问。公共 DTO 在 `packages/contracts` 中用 Zod 定义。参见 [tech-stack.md — 技术栈](../delivery/tech-stack.md#6-本地双端拓扑)、[domain-model.md — 领域模型](domain-model.md)、[contracts.md — 公共契约](contracts.md)。

## 1. 通用约定

当前已实现第 2 节的 HTTP 路由、第 3 节未标记为“目标”的玩家路由、第 4 节的玩家数据推送与控制台健康/时间线推送、第 5.1 节的健康、模块目录、装配列表与装配详情，以及第 5.3 节的暂停、继续、快照创建/列表与恢复控制台入口（单步仍为目标）。预检、草稿、席位接管、其他控制台页面和各实验接口仍按目标状态后续交付。

| 项 | 约定 |
|---|---|
| 前缀 | `/api/v1`；控制台接口在 `/api/v1/console/*`；静态控制台页面在 `/console/*` |
| 格式 | 请求与响应都是 `application/json; charset=utf-8`；字段 camelCase |
| 认证 | `Authorization: Bearer <sessionToken>`；除 `GET /api/v1/health` 与 `POST /api/v1/auth/login` 外都需要 |
| 控制台角色 | 控制台请求必须带 `X-Active-Role: operator \| researcher \| evaluator`，且该角色在会话角色内；服务端只按这个当前角色鉴权 |
| Origin | 请求带 `Origin` 头时，必须是 `http://127.0.0.1:5173` 或 `http://127.0.0.1:3000`，否则返回 403；WS 握手同样检查 |
| 幂等 | 世界命令用 `commandId`。时钟、快照、接管等控制操作用请求体里的 `operationId`，重复请求复用已记录的结果 |
| 并发控制 | 控制操作带 `expectedRunVersion` 或 `expectedEpoch`；不一致返回 409 |
| 分支 | 玩家接口总是作用于 `world_aliases('online')` 指向的分支；控制台运营入口可以用查询参数 `branchId` 指定分支，缺省为在线分支。当前版本只支持在线分支：`branchId` 与在线分支不一致时返回 400 `validation`，不会静默改作用分支 |
| 错误 | 见第 7 节；业务拒绝不是 HTTP 错误，而是 200 + `commandStatus: "rejected"` 的 receipt |

## 2. 认证、会话与健康检查

本地 Demo 用启动令牌登录。服务端读取 `NPC_PLAYER_TOKEN`、`NPC_CONSOLE_TOKEN` 与可选的单角色控制台令牌。玩家和控制台令牌缺省时优先复用数据目录中的 `dev-tokens.json`。首次生成的令牌由 32 字节随机数据编码，保存后可跨重启复用，登录地址仅在生成当次打印。

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

## 3. 玩家 API（角色 `player`）

本节是玩家自助入口：暂停、继续、存档、恢复与重新开局都由玩家会话直接作用于在线分支。控制台运营角色使用第 5.3 节的 `/api/v1/console/campaign/*` 入口；两者路径、角色与幂等主体各自独立，互不复用。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/campaign` | — | `{ campaign: CampaignView \| null, starts: StartOption[] }`（类型见第 9 节） |
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
  commandId: string;                 // client generated, "cmd-..." ; reuse it when retrying
  type: string;                      // for player command permissions, see the next section
  schemaVersion: 1;
  expectedVersions?: Record<string, number>; // "aggregateType:aggregateId" -> version
  payload: Json;
}

interface CommandReceipt {
  receiptId: string;
  commandId: string;
  commandStatus: "accepted" | "rejected";
  reasonCode: string | null;         // domain-model §9; null when accepted
  safeMessage: string | null;
  acceptedEventIds: string[];
  operationId: string | null;
  resultingVersions: Record<string, number>;
  result: Json | null;               // e.g. { taskId } for task.dispatch, { agreementId } for agreement.propose
  worldTick: number;
}

interface ClockView { worldTick: number; day: number; hour: number; mode: "running" | "pausing" | "paused" | "resuming" | "stepping"; runVersion: number; }
```

### 3.1 玩家命令权限

**已实现**：`POST /api/v1/commands` 接受 `campaign.start`、`dialogue.say`、`information.share`、`agreement.propose`、`agreement.respond`、`task.dispatch`、`task.cancel` 和 `policy.set`。`policy.set` 只允许当前 campaign 的公社党魁玩家设置 `watergate.allocation`，授权按已开局 campaign 的玩家与派系裁决。

**序章目标**：同一接口承载玩家广播及程序案交互。服务端使用认证和已开局的席位记录裁决权限。广播及程序案命令的具体请求格式待定。参见 [domain-model.md — 命令目录](domain-model.md#5-命令目录)。

## 4. WebSocket：`GET /api/v1/streams?ticket=<ticket>`

连接建立后，服务端先发 `hello`。客户端订阅 `player` 后接收快照与增量。所有消息都是 JSON 文本帧。

| 方向 | 消息 | 字段 |
|---|---|---|
| S→C | `hello` | `protocolVersion`、`principalId`、`channels`（本会话可订阅的频道） |
| C→S | `subscribe` | `channel`、`fromStreamSeq`（首次为 `null`） |
| S→C | `snapshot` | `channel`、`streamSeq`、`projectionVersion`、`data`。玩家频道使用真实投影版本；v1 控制台频道的 `projectionVersion` 仅作为兼容哨兵固定为 `0`，不代表玩家投影修订，控制台快照序号以 `streamSeq` 为准 |
| S→C | `delta` | `channel`、`streamSeq`、`projectionVersion`、`set`（顶层字段 → 新值的映射，例如 `{ "tasks": [...], "meters": {...} }`） |
| S→C | `append` | `channel`、`streamSeq`、`kind`、`item`。已实现 `dialogue` 和 `notification`，`timeline` 为目标 |
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

在线分支切换（恢复存档或重新开局）后，服务端向所有 `player` 频道重新发送一次 `snapshot`，客户端丢弃旧投影。

重连规则：服务端为每个 `(session, channel)` 保留最近 200 条增量。`fromStreamSeq` 之后的增量都还在时补发增量；否则重新发一次 `snapshot`。重连只补投影，不重放任何命令。流式模型 token 不经过任何玩家频道。

## 5. 控制台 API（`/api/v1/console/*`）

本节已实现的接口包括第 5.1 节的健康、模块目录、装配列表/详情，第 5.3 节的暂停、继续、快照创建/列表与恢复，以及第 5.5 节的时间线与 Agent 状态摘要。预检、草稿、模型池、席位接管与运行申请、剧情和调试接口仍为目标。

### 5.1 运行总览与模块装配

`GET /api/v1/console/health` 已按运营/研究角色鉴权，返回两个端口、三个 realm、服务端装配 hash、各模块 ready 状态、当前时钟和无 Agent 运行时的队列摘要。

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /health`（已实现） | operator、researcher | — | `{ ports: { client: 5173, server: 3000 }, realms, assemblyHash, modules: { moduleId, version, status }[], clock, queues: { turnsQueued, turnsRunning, maintenanceQueued, modelQueue }, laggingAgents, budgets, recentFailures }` |
| `GET /modules?realm=`（已实现） | operator、researcher | — | `{ catalogHash, modules: ModuleDescriptorView[] }`（id、realm、kind、version、apiVersion、provides、requires、`configJsonSchema`、experimentAxes；不含工厂） |
| `GET /assemblies`（已实现） | operator、researcher | — | `{ assemblies: { assemblyId, source: "repo"\|"draft" }[] }` |
| `GET /assemblies/{assemblyId}`（已实现） | operator、researcher | — | `{ descriptor, resolved: Record<Realm, ResolvedModuleSet> }` |
| `POST /assemblies/preflight` | operator、researcher | `{ assembly: AssemblyDescriptor }` 或 `{ assemblyRef }` | `{ ok, errors: { code, moduleId?, capability?, message }[], resolved, diffAgainstCurrent }` |
| `POST /assemblies/drafts` | operator | `{ assembly: AssemblyDescriptor }` | `{ assemblyId, version }`；保存到 `config_drafts`，只对新 run 生效 |

### 5.2 模型池

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /model-layouts` | operator、researcher | — | `{ layouts: { layoutId, source }[] }` |
| `GET /model-layouts/{layoutId}` | operator、researcher | — | 去密钥的 layout（connections 只显示 `adapterId`、`endpoint` 主机名与 `credentialRef` 名称） |
| `GET /model-layouts/{layoutId}/routes` | operator、researcher | — | `{ routes: { agentId, purpose, modelId, connectionId, adapterId, externalModel }[] }`：按角色看的已解析路由 |
| `POST /model-layouts/validate` | operator | `{ layout }` | `{ ok, errors }`：只做静态预检，不发网络请求 |
| `POST /model-layouts/drafts` | operator | `{ layout }` | `{ layoutId, version }`：保存为草稿，只对新 run 生效 |
| `POST /model-layouts/{layoutId}/probe` | operator | `{ modelId, operationId }` | `{ ok, latencyMs, servedModel, error? }`：一次计费的连通性测试，记录为 attempt |

### 5.3 三势力席位与世界运营

| 方法与路径 | 角色 | 请求 | 响应 |
|---|---|---|---|
| `GET /ops/seats` | operator | — | `{ seats: { agentId, controllerKind, controllerPrincipalId, controllerEpoch, leaseExpiresAt }[] }`，只包含 `species-fauna`、`species-flora`、`species-extraterrestrial` |
| `POST /ops/controllers/{agentId}/handover` | operator | `{ operationId, mode: "human"\|"agent", expectedEpoch, reason }` | `{ controllerEpoch, controllerKind, leaseExpiresAt }` |
| `POST /ops/controllers/{agentId}/renew` | operator | `{ controllerEpoch }` | `{ leaseExpiresAt }`（续期 10 分钟） |
| `GET /ops/seats/{agentId}/view` | operator（须持有该席位租约） | — | `{ worldView: AgentWorldView, inbox, agreements, invitations }`：只有该身份合法获知的内容 |
| `POST /ops/seats/{agentId}/commands` | operator（须持有该席位租约） | `CommandEnvelope` | `CommandReceipt`；以该 agentId 身份、当前 epoch 提交 |
| `POST /campaign/pause` / `resume`（已实现） | operator | `{ operationId, expectedRunVersion }` | `ClockView` |
| `POST /campaign/step` | operator | `{ operationId, expectedRunVersion, ticks }`（1–24） | `ClockView`（mode 为 stepping，结束后回到 paused） |
| `POST /campaign/snapshots`（已实现） | operator | `{ operationId, label }` | `{ snapshotId, worldTick }` |
| `GET /campaign/snapshots`（已实现） | operator、researcher | — | `{ snapshots: SnapshotView[] }` |
| `POST /campaign/restore`（已实现） | operator | `{ operationId, snapshotId }` | `{ branchId, clock }`；创建后继在线分支，旧分支保留。`dryRun` 只读预检尚未实现，恢复前由服务端执行内部一致性校验 |
| `GET /run-requests` | operator | — | 玩家的 run 申请列表 |
| `POST /run-requests/{requestId}/approve` / `reject` | operator | `{ note }` | approve 返回 `{ runId }` |

已实现的运营入口位于 `/api/v1/console/campaign/*`，与第 3 节玩家自助入口路径独立。查询参数 `branchId` 可省略，省略时作用于在线分支；当前版本只支持在线分支，显式传入与在线分支不同的值返回 400 `validation`。快照列表与玩家入口一致，只列当前 campaign 的存档。

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
| `GET /timeline` | `branchId`、`fromSeq`、`limit`（≤ 200）、`order`（`asc`/`desc`）、`types`、`agentId`、`nodeId` | `{ events: TimelineItem[] }`：真值视角的领域事件，附生命周期事件；筛选在存储查询中执行，`desc` 用于读取最新事件 |
| `GET /agents` | `branchId` | `{ agents: { agentId, kind, active, controllerKind, location, turnStatus, watermarkLag }[] }` |
| `GET /agents/{agentId}/inspector` | `branchId` | 人格、位置、`AgentWorldView`、当前 memory revision 的记录摘要、关系与承诺、水位、最近 20 个 turn |
| `GET /agents/{agentId}/memory` | `branchId`、`revision` | `{ revision, records: MemoryRecord[] }` |
| `GET /agents/{agentId}/memory/diff` | `branchId`、`from`、`to` | `{ added, retired, changed }`，每项带来源观察 ID |
| `GET /agents/{agentId}/observations` | `branchId`、`fromSeq`、`limit` | `{ observations: AgentObservation[] }` |
| `GET /turns` | `runId`、`agentId`、`status`、`limit` | turn 列表 |
| `GET /turns/{turnId}` | — | turn 详情：frontier、各阶段 requested/resolved/effective、span、context artifact 引用、全部 model attempt、tool call（原始与视图 artifact 引用）、receipt、对白 |
| `GET /artifacts/{artifactId}` | `view=redacted\|raw` | artifact 正文；`raw` 需要 researcher 角色，并记一条审计生命周期事件 |
| `GET /traces/{traceId}` | — | span 树 |
| `GET /branches/compare` | `left`、`right`、`atSeq` | 两个分支在相同检查点后的事件、指标与协议差异摘要 |
| `GET /debug/queues` | — | 调度队列、模型池队列、维护队列 |
| `POST /debug/turns/{turnId}/replay` | — | 审计重放：用已归档的 artifact 重建最终请求并比较 hash，不调用模型；返回 `{ requestHashMatch, differences }` |
| `POST /debug/agents/{agentId}/wake` | `{ reason, operationId }` | 注入一个 `debug` trigger；当前 run 被标记 contaminated |

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
| `POST /exports` | researcher | `{ runId, redaction: "redacted"\|"raw", operationId }` | `{ artifactId }`：导出包（manifest、事件、turn、artifact 索引） |

## 6. 角色权限矩阵

| 接口组 | player | operator | researcher | evaluator |
|---|---|---|---|---|
| `/auth/*`、`/session`、`/streams/ticket` | ✓ | ✓ | ✓ | ✓ |
| `/session/assembly?realm=client` | ✓ | ✓ | ✓ | ✓ |
| `/session/assembly?realm=console` | ✗ | ✓ | ✓ | ✓ |
| 第 3 节玩家接口 | ✓ | ✗ | ✗ | ✗ |
| 5.1 总览与装配 | ✗ | ✓ | ✓（只读） | ✗ |
| 5.2 模型池 | ✗ | ✓ | ✓（只读） | ✗ |
| 5.3 席位与运营 | ✗ | ✓（时钟、存档、恢复） | 只读快照列表 | ✗ |
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
| 403 | `forbidden` / `realm-violation` | 角色不允许、Origin 不允许、玩家访问控制台接口 |
| 404 | `not-found` | 资源不存在 |
| 409 | `idempotency-conflict` / `version-conflict` / `stale-controller` / `stale-turn` / `cancelled` / `invalid-state` | 同 ID 不同 payload、版本不符、控制权或 turn 已失效、操作已取消、当前状态不允许操作 |
| 422 | `assembly-incompatible` / `module-missing` / `capability-conflict` | 装配或 run 预检失败 |
| 429 | `budget-exhausted` | 预算或配额耗尽 |
| 503 | `not-ready` / `paused` | 服务未就绪、分支正在静默或切换 |
| 500 | `plugin-failed` / `provider-failed` | 未预期的模块或供应商故障；`safeMessage` 不含内部细节 |

业务规则拒绝（例如资源不足、路线不可用）不使用以上 HTTP 错误：命令被受理并写入 receipt，返回 200 和 `commandStatus: "rejected"`。

## 8. API 验收

- 玩家会话访问任一 `/api/v1/console/*` 返回 403；不带 `X-Active-Role` 的控制台请求返回 403。
- 同一 `commandId` 重放得到同一 receipt；换 payload 返回 409 `idempotency-conflict`。
- 断线后带 `fromStreamSeq` 重连，客户端投影与 `GET /world/view` 一致；缺口超过 200 时收到新快照。
- 来自其他 Origin 的请求与 WS 握手被拒绝。
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
  outcome: "equilibrium" | "strained" | null;   // set after ChapterStageEvaluated
  startTick: number;
}

interface SnapshotView { snapshotId: string; label: string; worldTick: number; day: number; createdAt: string; createdBy: string }

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
  worldSeq: number | null;       // domain events only
  worldTick: number | null;
  eventId: string | null;
  type: string;
  principalId: string | null;
  audience: AudienceSpec[] | null;
  summaryZh: string;             // rendered with observationTemplates, true-world view
  payload: Json;
  correlationId: string | null;
  createdAt: string;
}

interface EventPreview { type: string; audience: AudienceSpec[]; payload: Json; summaryZh: string }

interface ModuleDescriptorView {
  moduleId: string; realm: Realm; kind: ModuleKind; version: string; apiVersion: string;
  provides: CapabilityRef[]; requires: CapabilityRef[]; ownsAggregates: string[];
  configJsonSchema: Json;        // z.toJSONSchema(configSchema)
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
  decision: Json | null;          // the validated decision_submit arguments
  speech: { speechArtifactId: string; text: string; fallback: boolean } | null;
  traceId: string;
}
```

`POST /api/v1/console/experiments` 的 `experimentSpec` 与 `config/runs/*.yaml` 的格式相同（[配置](../platform/configuration.md) 第 10.3 节）；也可以传 `{ experimentRef }` 引用仓库里的文件。`POST /api/v1/console/runs` 的 `runSpec` 是 [配置](../platform/configuration.md) 第 3 节的 RunSpec。
