# 来源、借鉴边界与关键决策

> 核验记录：2026-11-17/18。参考项目只能证明其被读到的机制，不能证明本仓库已具备相同能力。所有正式范围以 [首版基线](../00-scope-and-invariants.md) 为准。

## 1. 实际依据

以下是实际查阅的来源与采用方式，不将参考工程的能力等同于本项目已实现能力。

### 项目现有记忆资料

父项目的 [记忆设计资料](../../../../design/memory/) 和 [研究汇编](../../../../research/agent-memory.md) 目前属于设计资料，没有运行中的 memory 模块。本方案继承其“规则写事实、LLM 写理解”、L0–L6 分类、来源链、知情边界和后台整理。

本轮做了场景适配：隔离键从玩家/王国/居民改为 world/branch/agent；世界合同与主观承诺分开；规则只保留 authority，memory 对 policy 的输入显式可调；审计历史不随角色遗忘删除。旧稿的价格、容量、成本结论和商业化内容不作为本 demo 的事实。

父项目资料位于当前独立仓库之外；若单独分发本仓库，应附相应来源或保留来源清单，不把外链缺失误报为运行依赖。

### agent-prism

本地参考仓库为 `D:/daftpunkwav/04-MyProjects/agent-prism`；检视时 HEAD 为 945541b973430996cd216b9a672b76eac3dbb092，以实际读取的工作区源码为证据。

| 已核实机制 | 采用方式与边界 |
|---|---|
| [唯一组合根](D:/daftpunkwav/04-MyProjects/agent-prism/apps/server/src/assemble.ts) | 借鉴显式装配与依赖方向；新增 branch/agent scoped 实例，不能照搬全 arena 共享 memory 文件。该文件同时混合装配与热更新细节，本项目把装配、guards 与业务配置分开 |
| [自定义维度描述符](D:/daftpunkwav/04-MyProjects/agent-prism/packages/contracts/contracts/src/custom-dimension.ts) | 借鉴描述符驱动参数、UI 与实验轴；本项目扩展为 ModuleDefinition：realm/能力/实例作用域/状态迁移/远端依赖/两端口声明，不只有 Agent 维度 |
| [memory port](D:/daftpunkwav/04-MyProjects/agent-prism/packages/contracts/contracts/src/memory-port.ts) | 借鉴实现中立接口；本 demo 扩展观察来源、scope、水位、revision 和迁移约束 |
| [边界检查](D:/daftpunkwav/04-MyProjects/agent-prism/scripts/check-boundaries.mjs) | 同时约束源码 imports 与包依赖，阻止反向依赖及深层 import；本项目需额外增加 realm 边界与“新模块目录不能绕过守门”的目录生成规则 |

该参考的 memory-store 当前是分词/词频匹配，不是 embedding 检索；memory-top-n 只能裁剪已召回集合；部分 driver 不经过全部 context hooks。这些限制促使本设计要求候选池/入模数量分开记录、所有实验能力预检。其 best-effort memory 失败处理也不能作为严格实验的有效样本策略。

### deepseek-harness

远程源码核验固定到 39163dd30f703a79079e2d2446545cff3c453738（提交时间 2026-11-13T07:37:50Z），避免未来主分支变化影响依据。本地安装的 DSH 文档位于其 app.asar 包内，曾按只读方式核对 `architecture.md`、`cordis-primer.md`、`capability-seams.md`、`subsystems/scope.md` 与 `app-boot` README 的目录与关键段落。

| 已核实机制与来源 | 本 demo 的落点 |
|---|---|
| [Service/Provider/Consumer 与按价值拆包](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/cookbook/adding-a-package.md) | 能力 port 与实现分离；只拆真实变化边界；本项目要求每个模块交代“定义/实现/消费方” |
| [profile、bundle patch 和事件分域](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/architecture.md) | 显式有序组合、整段替换、解析冻结；领域事实/生命周期/观测分开 |
| [工具注册 disposer 与最终 guard](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts) | 可撤销注册；不可绕过的权限/资源/版本最终校验；本项目把 disposer 扩展到 UI slot、订阅与模块注册 |
| [可重建 session log](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/session/README.md) | 原始输入输出追加归档，失败/取消/重试均可定位 |
| [独立工具结果裁剪](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/compaction/compaction-tool-result-pruner/src/index.ts) | 原始工具结果与模型视图分离，压缩保留来源引用 |
| Cordis 的 `inject`/`plugin`、注册即可逆 effect、`createScope` 生命周期 | 借鉴声明依赖、自动求解顺序、卸载按逆序回卷；但本项目不引入整套 Cordis/DSH 桌面宿主，scope 也不是安全沙箱 |
| dsh-app-boot 的 profile→patch 层序与整块 config 替换 | 借鉴“装配=有序覆盖、用 dump 预览最终值”；本项目用 assembly 文件 + resolved manifest 表达，不复制 CLI/多发行版体系 |

其 manifest 使用 package.json.dsh / engines.dsh，并非统一 plugin.json；[scope 只约束主动使用 scope-aware API 的状态](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/scope/README.md)，不构成安全沙箱。本 demo 先实现小型显式 registry 与可信内置插件，不复制整个插件市场、热更新或桌面宿主体系；接口仍保留适配空间。

### 外部可插拔模式

2026-11-18 用 web_fetch 逐个核实下列页面可访问；只把实际读到的内容作为依据，未逐篇复核全部正文。微内核模式的独立权威专页未找到可稳定引用的链接，因此只通过 Eclipse 文章中的对比段落间接使用该概念。

| 来源 | URL | 可借鉴点 |
|---|---|---|
| Alistair Cockburn《Hexagonal Architecture, the original 2005 article》 | https://alistair.cockburn.us/hexagonal-architecture/ | 端口按用途而非技术命名，适配器可替换；文中“很多应用只有两个端口”说的是应用能力端口，不是网络监听端口。本项目借鉴“按用途设 port”的思想；两个本地监听端口是部署边界，两者不能混为一谈 |
| Azad Bolour《Notes on the Eclipse Plug-in Architecture》(Eclipse Corner, 2003) | https://www.eclipse.org/articles/Article-Plug-in-architecture/plugin_architecture.html | host 发布 extension-point 与 schema，扩展方声明 extension，回调对象懒实例化；文章把 Eclipse 模型与 microkernel 模式对比，支持“任何模块都可成为宿主”的思路 |
| Visual Studio Code《Extension API》 | https://code.visualstudio.com/api | 同一套扩展 API 既支撑官方功能也支撑第三方；manifest + contribution points + activation events + 独立扩展宿主进程 |
| Home Assistant《The integration manifest》 | https://contributors.home-assistant.io/core/integrations/manifest/ | 集成以清单声明 domain、dependencies/requirements/after_dependencies、config_flow、quality_scale、disabled 等；声明式元数据与质量分级 |
| OSGi《OSGi Specifications》索引 | https://docs.osgi.org/specification/ | bundle + 服务注册表 + 版本化依赖的模块化范本；本次只核实索引页，具体规范条款未逐条阅读 |
| Official Factorio Wiki《Modding》 | https://wiki.factorio.com/Modding | mod 以目录/zip 即插即用；依赖分必需/可选/不兼容三类；startup 与 data 阶段分离，启示“装配阶段 vs 运行阶段” |

借鉴边界：这些来源支持“宿主 + 声明式模块 + 生命周期 + 版本依赖”的总体方向，不证明本项目的游戏规则、双端口控制台或 20 Agent 配额设计；本项目还新增模块实例作用域、realm 隔离、requested/resolved/effective 与视频/评估证据要求。

### 场景渲染

PixiJS 官方将其定义为 Web 2D 渲染器，支持 WebGL 与可选 WebGPU。本方案据此选择等距精灵场景作为 2.5D 的实现起点；不宣称它直接提供 SLG 规则、服务器寻路或 Agent 系统。[官方介绍](https://pixijs.com/8.x/guides/getting-started/intro)

## 2. 本项目关键决策

| 决策 | 依据与取舍 |
|---|---|
| 单玩家首版、统一世界观 | 用户最新范围；保留服务端权威与协议边界，玩家多人联机不进入首版验收 |
| 宿主保留 + 全职能模块可插拔 | 用户明确要求“像主机插 USB”；不只 memory，游戏规则、UI、控制台页面、存储与模型传输都可替换 |
| 严格脱耦优先于内聚 | 当“高内聚大模块”会阻碍替换时拆开；模块内部仍按单一职责组织，必要协议依赖显式声明 |
| 两个本地端口、三个运行域 | 客户端 `:5173`、服务端 `:3000`（含 `/console`）；避免第三套 Web 服务与权限漂移，控制台同源但仍需鉴权 |
| 20身份=8战略+12角色 | 用户要求增加 NPC；在一个 runtime 中表达不同主体，不用额外导演 Agent 补位；玩家不是第 21 个 Agent |
| 三个非人类势力运营席位 | 巡裔、根庭、泊星者可 agent/human 控制，经控制台与标准 command；不影响 20 身份计数 |
| 集中模型池、Agent 挂载 | 复用连接、模型参数和资源预算；按 (agent,purpose) 严格解析，避免逐角色复制配置 |
| ToolDefinition一次、ToolBinding多处 | 复用行为逻辑，主体差异由授权/目标约束表达；执行处仍校验当前权限 |
| 模块/插件/组合各有专篇 | 分别约束职责与依赖、打包注册与生命周期、装配与生效；术语不混用 |
| module catalog + assembly + profile 三层 | 货架、装机清单、Agent 子配方分开；换模块必须新 run/后继 branch，客户端/控制台装配 hash 也进入 manifest |
| authority/policy分离 | 避免世界规则决定所有意愿，使 memory 只剩台词装饰 |
| 不可变输入与原始档案 | 对比需要可定位的观察、记忆 revision、最终请求和真实世界结果；换模块不能删证据 |
| SQLite 模块化单体 | demo 规模下优先一致性和维护性；保留 storage/transport 适配空间；不引入微服务/Kafka/Redis |
| 首版先 memory，其余槽预留基线 | 完整架构不等于立即实现所有算法；但 M 验收要求游戏/UI/控制台模块至少各替换一次 |

以上为设计决定而非实测结论。用户需求更新优先于参考工程的组织方式；源码能力不够时标明差异，不把术语相似当作可直接复用。

## 3. 未核实与边界

- 微内核模式的独立权威页面未找到稳定链接；Eclipse 文章的对比段落只能作为间接依据，不能声称本项目“按某规范实现微内核”。
- OSGi 只核实规范索引页，未逐条阅读 Core/Compendium；不能引用具体条款号。
- Home Assistant 只核实 manifest 页面；未验证其运行时行为。
- agent-prism 的 `assemble.ts` 只读了部分区间（约 L1–499/725），不能据此描述未读部分；本项目不复制其 725 行单文件结构。
- 所有模块目录、双端页面与控制台能力均为目标设计，尚无实现、无模型连接、无性能或行为实测数据。任何“已可插拔/已可观测”的表述都必须有运行证据支撑。
