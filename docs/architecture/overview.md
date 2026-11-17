# 系统架构总览

> 目标设计 v0.3。首版单玩家、统一世界观、标准 20 Agent；两个本地端口：玩家客户端 `:5173` 与服务端 `:3000`（含控制台）。技术采用 TypeScript 全栈模块化单体。

## 1. 核心命题：主机保留，职能全部可插拔

基础宿主只保留“主板”能力：模块注册与能力图、生命周期、序列/版本/幂等/fencing、授权与提交关口、事件与证据协议、配置冻结、三运行域与两端口信任边界。游戏规则、地图、时钟、资源、行动、协议、剧情、存档、Agent 感知/记忆/上下文/压缩/工具视图/决策/调度、模型池、工具、客户端渲染与界面、控制台页面、存储与模型传输，全部由模块提供；替换一个职能只改该模块、装配与配置。

三层含义要分清：

- **模块化**：每个职能有明确 port、状态所有权与依赖方向，模块之间不 import 实现。
- **插件化**：模块以可信插件包交付，显式注册、校验能力、按生命周期启动/卸载；首版不支持上传任意不可信代码。
- **积木化**：assembly 把模块、内容、roster、profile、模型挂载和工具绑定组合成可运行、可冻结、可对比的组合。

严格脱耦优先于“把所有相关功能塞进一个高内聚大模块”：当内聚与可替换性冲突时，优先拆开并显式声明依赖。必要的协议依赖不能消除，但必须版本化、可检查。

## 2. 七项架构决策

| 决策 | 理由与代价 |
|---|---|
| 单世界、单权威写者 | 单玩家与所有 Agent 对同一世界有一致结果；首版牺牲横向写扩展，换取可诊断性 |
| 宿主最小化 + 全职能模块 | 防止每个功能自带存储、权限和循环，形成互不兼容的小系统；代价是更多契约与装配工作 |
| 两个本地端口、三个运行域 | 客户端/服务端边界清晰；控制台复用服务端端口，避免第三套 Web 服务与权限漂移 |
| 持久事实事件 + 受控调用管线 | 世界变化均可追踪；纯计算仍用 typed port，不把每次函数调用广播到 bus |
| authority 与 policy 分开 | 规则负责能否执行、如何结算；Agent 负责选择、表达与协商，记忆才能影响行为 |
| 知识、事实、记忆分开 | 共享世界观不等于全知；主观信念不回写世界真值 |
| run 内冻结装配与模型输入归档 | 可比较、可定位；换模块/配置需要新 run 或后继 branch，而非随意热切 |

首版不引入微服务、Kafka、Redis 或独立向量数据库。若以后容量证据要求拆进程，保持事件信封与 port，先迁移 worker 或 storage adapter，再考虑拓扑变化。

## 3. 系统边界

~~~mermaid
flowchart LR
  P["玩家浏览器 :5173<br/>client realm"] -->|"HTTP command / WS 投影"| S["server host :3000<br/>固定 guard + 模块注册"]
  C["控制台浏览器 :3000/console<br/>console realm"] -->|"同源控制台 API"| S
  S --> G["game 模块族<br/>world/map/clock/resources/actions/agreements/scenario/save"]
  S --> A["agent 模块族<br/>perception/memory/context/compression/tool-view/decision/scheduling"]
  S --> M["models / tools<br/>集中挂载与共享定义"]
  S --> X["platform 模块族<br/>access/budget/storage/observability/evaluation/operations"]
  S --> T["adapters<br/>HTTP+WS / SQLite / model transport"]
  X --> E["trace、artifact、评估与审计"]
  E --> C
  S -->|"授权投影 / WS"| P
~~~

三个运行域都只通过 contracts 通信；server 是唯一权威。组合根持有具体实现；game 规则不依赖 LLM、网络或 UI；agent-runtime 只能读取授权投影并提交候选命令；client/console 模块只能消费授权协议。

### 三种事件，不混用

| 类型 | 示例 | 约束 |
|---|---|---|
| 领域事实 | DialogueSubmitted、ActionAccepted、ConvoyArrived、TreatySigned | 持久、追加、版本化；仅权威应用服务提交 |
| 运行生命周期 | TurnQueued、MemoryCommitted、ModelAttemptFailed、ControllerChanged、ModuleStarted | 持久到运行/控制日志；驱动恢复，不伪装世界事实 |
| 观测流 | token delta、检索耗时、阶段 span、模块调用 | 高频可采样；最终请求/响应、错误和结算引用不得采样丢失 |

Command 是请求，Event 是已发生的事实。不能把模型输出“已救出村民”直接作为 RescueCompleted；它只能提交 RescueRequested，经规则校验与任务结算后才产生结果。模块调用也不等于世界事实。

## 4. 部署与传输

两个本地监听：`127.0.0.1:5173` 玩家客户端，`127.0.0.1:3000` 服务端（含 `/console/*`）。控制台是服务端提供的浏览器界面，不是第三个进程或端口。详见 [两个本地端口与三运行域](two-endpoints.md)。

以下为待实现 API 契约入口，不表示现有路由；版本统一 `/api/v1`。

| 路径 | 用途与约束 |
|---|---|
| POST /api/v1/commands | 玩家/运营标准命令；返回 receipt 与事件引用，副作用幂等 |
| GET /api/v1/world/view | 按 principal 返回投影与重连游标，不能读取原始全局日志 |
| WS /api/v1/streams | 授权投影、已提交对话、任务状态；分玩家/研究 channel |
| GET /api/v1/session 与 /session/assembly | 会话、角色、协议版本与 realm 模块清单；不含密钥与工厂 |
| POST /api/v1/console/ops/controllers/{agentId}/handover | 期望 epoch、目标模式、原因；租约与审计 |
| POST /api/v1/console/ops/scenarios/{id}/publish | 校验版本和受众后发布，不允许直接覆盖历史 |
| GET /api/v1/console/modules 与 /assemblies | 描述符、schema、兼容性与 resolved diff |
| POST /api/v1/console/runs | 选快照、assembly、profile、协议与预算；预检后创建隔离运行 |
| GET /api/v1/console/runs/{id}/trace | 完整因果链；原文需要单独研究权限 |

HTTP 命令与所有副作用工具共用 command handler。WebSocket 重连只补投影，不重新发起 action。接口错误至少区分 forbidden、validation、version-conflict、stale-controller、stale-turn、not-ready、budget-exhausted、module-missing、assembly-incompatible、plugin-failed。

一个服务端进程即可同时宿主 API、逻辑调度器、outbox worker、agent workers、控制台 API 与静态资源，但模块通过 port 交互。模型网络调用发生在数据库事务之外。client 与 console 是独立浏览器 realm，共享组件与契约，发布时分别按 player/operator/researcher/evaluator 权限隔离；服务端是唯一授权来源，隐藏按钮不是鉴权。

模型凭据只存在服务端 secret store/环境配置，run 保存 credentialRef，禁止写入前端、prompt 或导出清单。日志原文存储、脱敏与保留规则见 [观测](../platform/observability.md)。

## 5. 故障策略

| 故障 | 在线体验 | 正式实验/运营 |
|---|---|---|
| LLM 超时/拒绝/协议错误 | 有限重试；显示 NPC 暂未回应，或显式配置的规则等待/回应 | 保存全部 attempt；无法完成则 failed，不当成正常低分输出 |
| 必需模块缺失或版本不兼容 | 组合不完整，拒绝 ready；不启动半套系统 | 预检失败，不产生有效样本 |
| 可选 UI/控制台页面模块失败 | 隔离到自身区域，显示不可用原因 | 不影响世界事实；关键证据缺失时判 invalid |
| memory/perception 必需模块失败 | 隔离该 Agent 队列，显式故障或已声明 fallback；其他主体可继续 | failed/invalid，不默默切换 none |
| 世界事务失败 | 不确认成功；以同 commandId 重试 | 不存在半次成功，保存错误与恢复证据 |
| 消费积压/水位落后 | 显示处理中，控制入口流量 | 预检阻止开始/继续评分 |
| 运营接管与推理竞态 | 旧 epoch 输出拒绝，已接受任务继续 | 记录外部输入变化，按协议纳入或判污染 |
| 预算耗尽 | 停止新增模型决策，规则已接受任务继续 | budget-exhausted 单列，禁止丢弃失败样本改善均值 |
| 端口被占用 | 显式启动失败，不自动换端口 | 不产生不可文档化的第三监听 |

关键验证是故障后的世界、记忆、模块组合和调用链仍能说明发生了什么；“界面没报错”不是通过条件。实施与验收入口见 [交付计划](../delivery/roadmap-and-acceptance.md)。

## 6. 与模块专篇的关系

世界写入规则见 [事件与状态](events-and-state.md)；职责与依赖见 [模块边界](modules.md)；模块清单与默认装配见 [模块目录](module-catalog.md)；替换单元与生命周期见 [插件机制](plugins.md)；装配顺序与冻结见 [积木组合](composition.md)。模型请求先解析 [模型池挂载](../agent/model-pool.md)，工具统一走 [共享行为网关](../agent/tools.md)。客户端见 [2.5D 渲染](client-and-rendering.md)，双端部署见 [两个本地端口](two-endpoints.md)，公共协议见 [契约](contracts.md)。

LLM、工具、记忆、压缩和模块内部网络调用都必须进入同一 trace/预算宿主，不允许模块自行创建未记录的外部调用。模型共享资源不共享会话，工具共享实现不共享超出绑定的权限。
