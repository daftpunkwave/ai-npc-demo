# 工程实施与验收

说明技术选择、实施顺序与验收证据；计划和判据不等于已完成的测试结果。

[返回文档入口](../README.md) · [项目概览](../../README.md)

## 文档索引

| 文档                                                            | 负责内容                                 |
| ------------------------------------------------------------- | ------------------------------------ |
| [tech-stack.md — 技术栈与约定](tech-stack.md)                       | 版本、workspace、依赖白名单、file header 与本地命令 |
| [build-plan.md — 构建计划](build-plan.md)                         | 逐步产出、前置依赖、测试和完成判据                    |
| [roadmap-and-acceptance.md — 切片验收](roadmap-and-acceptance.md) | A/B/C/M 切片及交付证据                      |

## 阅读顺序

[tech-stack.md — 技术栈与约定](tech-stack.md) → [build-plan.md — 构建计划](build-plan.md)；执行每一步时对照 [roadmap-and-acceptance.md — 切片验收](roadmap-and-acceptance.md) 的所属切片判据。

## 当前进度

> 截至 2026-11-20，`pnpm check` 通过：795 条测试通过、1 条跳过；边界、装配目录、资产与文档检查均通过。`pnpm test:e2e` 的玩家开局与控制台关键路径通过，`pnpm check:ports` 验证开发与生产启动只监听 `5173`、`3000`。

已交付：`standard-15` 正式名册与 15 个上场身份；只开放公社席的开局内容；20 秒/tick；t168 评估后暂停时钟并保留存档；公社党魁玩家的水闸 `policy.set` 与水闸条款义务人；剧情卡署名与任务结算身份已对齐新版编制；玩家授权投影客户端、PixiJS 灰盒与首批 UI 模块；控制台宿主、运行总览、模块装配、时间线和 Agent 状态摘要；控制台静态资源与服务端只读 API；双端启动与端口检查。

未交付：部署级 15 个活动身份配额、t144 程序案、玩家公开广播、`seatId`/`actorId` 席位契约、t168 六种城市资源交接、Agent 认知管线、模型池和剩余控制台运营/研究页面。

逐步产出与状态见 [build-plan.md — 步骤总览](build-plan.md#1-步骤总览)，具体差距与迁移顺序见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。

## 与其他目录的边界

工程与 Git 工作流见 [AGENTS.md](../../AGENTS.md)，模块布局见 [代码结构](../architecture/code-structure.md)。

本页只提供导航；具体定义与验收要求以链接的主题文档为准。
