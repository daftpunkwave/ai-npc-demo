# 积木组合与配置生效

> 本文规定装配、profile、冻结清单与运行期绑定的语义。交付进度见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。参见 [module-catalog.md — 模块目录](module-catalog.md)、[plugins.md — 插件机制](plugins.md)、[configuration.md — 配置格式](../platform/configuration.md#10-完整配置文件首版)。

## 1. 五类对象分开

| 对象 | 表达什么 | 不应包含 |
|---|---|---|
| module catalog | 可用模块的定义、能力、版本与配置 schema | 某次运行的选择与参数 |
| module assembly | 三 realm 的模块选择、能力绑定、配置引用与运行模式 | roster 人格、逐 Agent 模型参数 |
| roster 记录 | identity、role、faction、profileRef、toolsetRef；identity 含稳定 agentId | provider、endpoint、model 名称或密钥 |
| profile | 选择 Agent 认知策略、参数、上下文结构、预算与失败策略 | 世界规则、客户端渲染器、provider 凭据 |
| models/mounts、toolsets/bindings | 集中模型池与共享工具定义、按主体授权的调用边界 | 每个 Agent 一份复制的 provider/model 或工具实现 |

同一个 profile 可挂到多个身份；同一个模型池条目可服务多个 Agent；同一个工具定义可绑定给多个主体。可复用定义与主体可写状态是不同层次：复用配置不等于共享记忆、会话、权限或预算。

标准 roster 为 8 名公社支持者、4 名 AI 党魁、3 名外域 Agent，总计 15。首版一个玩家、一个在线权威世界；党魁、外域与支持者是同一 runtime 的可组合主体类型，不是两套 runtime。

装配覆盖游戏、认知、平台、传输与 UI 的全部职能，不以 profile 的记忆选项代替全局模块选择。宿主只执行固定守卫及唯一管线协调；替换 provider 不得复制 runtime 或绕过安全/事务边界。源码与包依赖按 [技术栈](../delivery/tech-stack.md) 第 2 节检查，运行时 `requires` / `requiresRemote` 由能力图和握手校验，二者不能互相代替。

## 2. 组合的五个层次

| 层次 | 作用 | 示例变化 | 生效边界 |
|---|---|---|---|
| 模块目录 | 仓库/部署可用的全部可信模块 | 新增 `memory.stream-reflection` | 构建时快照，注册后不可静默改 |
| 平台装配 | 三 realm 的必需/默认模块、能力绑定与适配器 | 换 `game.clock`、换 PixiJS renderer、换 SQLite | 新宿主启动或新 run |
| 内容包 | lore、地图、角色、事件卡、UI/音频资源 | 新序章、新地图 | 内容版本 + 新 run |
| roster/profile | 激活身份与 Agent 策略子配方 | 换 memory、context、decision | 新 run/后继 branch |
| 实验 variant patch | 只改变声明的比较轴 | 只替换 memory 或 recallTopK | 新 run；冻结 manifest |

覆盖采用显式替换：指定槽位时替换该槽位的完整配置块，数组整体替换；不隐式深合并旧对象。未覆盖项沿父级继承，模块自己的 defaults 仅填补 schema 允许的省略值。模块和参数的增删都进入 resolved diff；删去字段不能让旧值潜伏在本地缓存。

身份个性和派系倾向来自 roster/content，不借助 profile 覆盖身份权限。玩家/运营权限、正式合同和世界规则也不是可由 memory 开关关闭的策略参数。

## 3. 三 realm 装配与握手

本节描述 TypeScript 装配及浏览器握手。Godot 玩家进程使用随程序发布的本地装配，仅以公共协议与服务端握手。见 [client-and-rendering.md — Godot 原生玩家端](client-and-rendering.md#9-godot-原生玩家端)。

assembly 同时声明 `server`、`client`、`console` 三段。服务端在启动或创建 run 时解析 server 段，并校验需要 remote 能力的浏览器段。浏览器宿主连接后通过 `GET /api/v1/session/assembly`（`realm=client` 或 `console`）取得本域已解析模块清单、协议版本与远端能力描述。模块清单可以为空。本地内置 catalog 的验证结果决定模块能否加载。

- 满足：加载模块并进入 ready，记录 client/console assembly hash。
- 缺必需模块或 apiVersion 不兼容：显示组合不完整，不加载旧实现、不静默降级。
- 缺可选模块：对应 slot/页面显示不可用原因，服务端能力仍按权限工作。

玩家设置不是 assembly：显示、语言、镜头、声音、图形质量属于 preference/settings 模块，即时生效且不改变运行组合。测试 preset 不是偏好，它只能提交新 run 或后继 branch 的申请，由服务端预检并记录 assembly diff。

## 4. profile 的层级与覆盖

| 层级 | 作用 | 示例变化 |
|---|---|---|
| 平台基线 | 完整绑定必需槽位与公共预算起点 | 默认 context、模型调用上限、严格失败策略 |
| 场景 profile | 在基线内固定当前场景的策略条件 | 当前投影范围、会话窗口和感知规则 |
| Agent profile | 形成可复用的战略/角色策略配方 | memory 机制、召回规则、决策方式 |
| 实验 variant patch | 改变声明的比较轴 | 只替换 memory 或修改 recallTopK |

roster 通过 `profileRef` 引用明确的 Agent profile，后者引用其父级。层级关系必须构成无环图；不能由文件加载顺序决定优先级。

Agent profile 只选择 Agent 作用域的认知策略（perception/memory/context/compression/tool-view/decision）与参数，不能暗中决定整个世界的地图、时钟、持久化或 UI 实现。调度属于 run 作用域，由场景 profile 与实验 variant 配置。若实验要改变游戏规则或界面，必须改 assembly 并作为独立实验条件。

## 5. 模型池的组合方式

模型配置集中在 `models`；挂载列表为 `mounts`，每条包含 `modelId + agentIds + purposes`。启动解析后形成只读索引：由 `(agentId, purpose)` 解析出唯一 `modelId`。配置一个条目后选择多个 Agent 挂载，不要求逐人复制连接配置。

gameplay mounts 的 purpose 统一为 `decision`、`speech`、`memory-maintenance`、`compression`、`embedding`。仅实际启用的能力必须有对应挂载；memory.none 不因为存在该 purpose 就自动调用反思模型。`evaluation` 由独立 evaluator 主体配置引用 modelId，不进入 gameplay mounts 或 15 个身份 roster，也没有游戏行动权限。

同一 Agent 可以让 decision 和 speech 使用同一条目，让 memory-maintenance 使用另一条目。embedding 是独立能力：文本生成 endpoint 可用，不代表它能生成向量。模型池先校验条目的 provider adapter 与能力，再校验挂载覆盖；未知 Agent、未知 modelId、purpose 不支持、同一索引键冲突或必需 purpose 缺失均拒绝启动；不能默默使用“默认第一个模型”。

Agent、profile 和运行请求不能直接覆盖 endpoint、provider 参数或 credentialRef。研究员调整集中模型条目生成新配置版本；已冻结 run 仍指向原 resolved 条目和去密钥快照。详细参数与故障策略见 [模型池](../agent/model-pool.md)。

## 6. 工具的组合方式

共享 ToolDefinition 注册一次，包含工具 ID、版本、参数/结果 schema、行为和所需能力。工具集引用这些定义，roster 的 `toolsetRef` 选择工具集；宿主按当前 Agent、branch、控制权和策略生成 ToolBinding。

ToolBinding 允许进一步限制可作用对象、行动种类、调用预算和可见字段，但不能授予该主体原本没有的世界权限。模型收到的工具 schema 可以按 binding 收窄；执行时仍重新鉴权。

例如多个角色共用“读取已知区域”工具，只改变主体上下文与授权视图；多个战略主体共用“提出派遣”工具，行动是否接受统一交给世界规则。不能通过新建十个名字相近的函数表达十个身份。

只读工具返回授权数据；副作用工具使用稳定 operationId 提交标准 command，结果保留 receipt。turn 终态返回已执行引用，不能再把同一操作重复提交一次。完整流程见 [工具](../agent/tools.md)。

## 7. 一次装配的操作流程

1. 加载带版本的 lore、地图、角色与场景；校验内容引用及 roster 身份唯一性。
2. 组合根建立实例级 Registry、共享工具 catalog 和集中模型池；拒绝重复定义和不兼容实现。
3. 解析 assembly 的三 realm 选择：能力闭包、实例作用域、realm 兼容、必需 provider 唯一、扩展点/slot 冲突。
4. 解析 profile 继承与实验 patch；形成完整槽位配置和每项来源，禁止未知键和静默强制类型转换。
5. 解析 `models/mounts` 与 `toolsetRef`，验证每个主体所需 purpose、工具能力、受众与模式支持。
6. 生成阶段依赖图及上下文显式顺序；检查 hook 环、工具协议、模型窗口和预算约束。
7. 解析快照、起始记忆与控制模式；每个实验 run 分配独占 branch，不复用活动分支。
8. 校验全平台活动 Agent 配额和模型/工具并发，预留资源；未获配额只能等待或拒绝，不能创建后再补记账。
9. 创建 scoped state 与模块实例，按依赖顺序启动，确认必需水位和资源就绪；浏览器 realm 完成握手并加载本域模块。
10. 冻结 resolved manifest、内容/模块版本、模型挂载、工具 binding、client/console assembly hash 与 catalog 快照 hash；分支进入 ready。
11. 运行中记录各阶段实际生效值；停止时先 fencing 和 drain，再逆序释放实例及配额。

dry-run 只执行解析与校验，展示将创建什么、还缺什么，不创建活动 Agent、调用模型或修改在线状态。需要连通性探测时，作为明确有预算的测试操作单独记录。

全平台活动 gameplay Agent 总数上限为 15，在线和实验共同计数。满员在线运行时可以编辑实验草稿和预检；完整 15 个 Agent 闭环实验需要暂停在线运行并释放实例，按变体顺序激活与释放。不得为并行对比扩大 Agent 配额上限。

## 8. 一次 memory 实验怎样组合

先选择同一快照、同一输入脚本、相同模型池版本及挂载、相同工具集和预算，建立四个 variant：M0 无长期记忆、M1 结构化经历账本、M2 观察流与反思、M3 分层混合。它们复用 runtime 和游戏规则，差异集中在 memory 槽及其明确声明的子参数。

每个 variant 使用独占 branch 和独立记忆/索引。比较起点必须说明冷启动、共同历史重建或兼容状态导入；不能直接把账本状态复制给另一个不兼容记忆算法后声称条件相同。

无长期记忆组仍有身份、当前合法观察和固定会话窗口。关系账本、公共历史或承诺摘要不能从 context/工具偷偷补回；否则“关闭 memory”的处理并未真正隔离变量。

改变 recallTopK 时，候选池、权限过滤、排序、注入条数与 token 预算分别记录。把渲染上限从 3 改成 10，不能扩大底层只返回 3 条的召回集合。

固定对手用于开环/局部因果实验；完整世界闭环允许角色互相影响，但之后输入会分叉，报告必须按系统结果比较，不能逐句当成相同刺激。评估协议见 [评估](../platform/evaluation.md)。

## 9. 组合不等于任意排列

有些步骤属于宿主固定阶段：权限过滤先于 perception；memory 就绪检查先于读取；tool-view 只能处理已授权的真实工具结果；压缩后再检查协议和预算；最终行动与对白必须经过权威裁决。

context 可以实验片段顺序，compression 可以实验阈值和算法，decision 可以替换策略，但不能以 profile 自定义任意执行脚本，不能通过不调用后续 hook 跳过 guard。模块存在不等于本次生效；自带 loop 的 decision adapter 若无法暴露 context/model/tool 拦截点，必须声明 unsupported，相关实验预检失败，不能挂上开关后保持空操作。

决策与对白的 phase 字段分别为 decision/speech，policy 仅指决策策略职责。决策可在本主体权限内利用秘密，公开对白请求只能包含目标受众合法素材和已裁决 receipt；不复用携密会话、自由文本理由或缓存前缀。两次请求计入同一 turn，不算新增 Agent。

## 10. requested、resolved 与 effective

| 层 | 要回答的问题 | 例子 |
|---|---|---|
| requested | 用户/装配文件选择了什么？ | memory.topK=10、压缩阈值 70% |
| resolved | 继承、默认值和挂载解析后是什么？ | 用哪个模块版本、模型条目、工具 binding |
| effective | 本阶段实际使用了什么？ | 10 个候选中 4 条入模，阈值未到未执行压缩 |

每个阶段记录 applied/skipped/failed、原因、输入输出 artifact/hash、来源变化、耗时及调用成本。未达到阈值属于有原因的 skipped，不应标为“压缩成功”；必需阶段缺失不能进入有效样本。

模型适配器还需报告最终序列化请求；context 的估算 token 不等于 provider 实报 usage。所有模型重试、反思、embedding 和评估请求计入成本，不能只算最后一次成功的 decision。

完整 resolved manifest 随 run 保留并脱敏，包含三 realm 模块、内容/规则版本、模型池去密钥快照、工具绑定与 client/console assembly hash。只存 profileId 不足以重建实验，因为父级、模型池、内容、模块代码和浏览器端模块都可能改变。

## 11. 修改配置的语义

控制台保存的是草稿。运行分支的 assembly、profile、挂载和状态契约冻结；修改生效需要新 run/后继 branch，不能悄悄热切在途 turn。纯展示偏好可即时生效；客户端/控制台模块替换只在该浏览器会话空闲边界生效，且必须与当前 server assembly 兼容。

在线配置切换发生在明确暂停点：停止新变更、fence 在途输出、取得一致快照、准备新分支与状态，验证后切换在线别名；失败保留原分支。维护流程见 [运营控制](../platform/operations.md)。

模型连接凭据轮换可以由安全存储更新，但应记录 credentialRef 的修订，不把密钥写入 manifest。若改变实际 provider、模型或解码配置，则形成新的实验条件和 resolved hash。

## 12. 组合验收

- 一次集中配置模型后可选择多个 Agent 挂载，roster 中不存在复制的 provider/model 参数。
- 同一个工具定义绑定多个主体，越权对象仍被执行网关拒绝，日志能定位各自 binding。
- 改变一个实验轴时 resolved diff 只出现预期差异；其他变更必须显式列为混杂因素。
- 缺模型 purpose、未知参数、能力不兼容、状态不兼容、realm 冲突和配额不足都在运行前给出可定位错误。
- 只换客户端 HUD/renderer 或控制台页面时，server 世界结果与 trace 证据不变；只换游戏规则模块时，客户端无需改实现。
- 从冻结 manifest 可重建同一组合；重新推理作为新 run，不能承诺远程模型输出逐 token 相同。

扩展接入和交付顺序见 [代码结构](code-structure.md) 与 [路线与验收](../delivery/roadmap-and-acceptance.md)。
