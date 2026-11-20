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

> 截至 2026-11-20，`pnpm check` 通过：789 条测试通过、1 条跳过；边界、装配目录、资产与文档检查均通过。当前进度只覆盖服务端序章规则与内容，客户端、控制台页面和 Agent 认知管线尚未交付。

已交付：`standard-15` 正式名册与 15 个上场身份；只开放公社席的开局内容；20 秒/tick；t168 评估后暂停时钟并保留存档；公社党魁玩家的水闸 `policy.set` 与水闸条款义务人；剧情卡署名与任务结算身份已对齐新版编制。

未交付：部署级 15 个活动身份配额、t144 程序案、玩家公开广播、`seatId`/`actorId` 席位契约、t168 六种城市资源交接、玩家客户端、控制台页面与 Agent 认知管线。

逐步产出与状态见 [build-plan.md — 步骤总览](build-plan.md#1-步骤总览)，具体差距与迁移顺序见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。

## 与其他目录的边界

工程与 Git 工作流见 [AGENTS.md](../../AGENTS.md)，模块布局见 [代码结构](../architecture/code-structure.md)。

本页只提供导航；具体定义与验收要求以链接的主题文档为准。
