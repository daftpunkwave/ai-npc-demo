# Agent 认知与行为

说明观察如何进入角色认知，并形成受约束的行为与对白；不定义世界规则或数据库表结构。

[返回文档入口](../README.md) · [项目概览](../../README.md)

## 文档索引

| 文档 | 负责内容 |
|---|---|
| [runtime.md — 运行时](runtime.md) | 先了解 turn 管线、调度、冻结输入与 fencing |
| [perception.md — 感知](perception.md) | 接收资格、渠道、延迟及观察生成 |
| [memory.md — 记忆](memory.md) | 摄入、整理、检索与四种策略 |
| [context.md — 上下文](context.md) | 合法材料的选择、顺序和预算 |
| [compression-and-tool-view.md — 压缩与工具视图](compression-and-tool-view.md) | 历史压缩及工具结果呈现 |
| [tools.md — 工具](tools.md) | 定义、绑定、授权与命令转换 |
| [prompts.md — Prompt 与对白](prompts.md) | 输入输出模板及 decision/speech 隔离 |
| [model-pool.md — 模型池](model-pool.md) | 挂载、队列、重试与预算 |
| [model-transport.md — 模型传输](model-transport.md) | 统一 ModelPort 与供应商适配 |

## 阅读顺序

[runtime.md — 运行时](runtime.md) → [perception.md — 感知](perception.md) → [memory.md — 记忆](memory.md) → [context.md — 上下文](context.md) → [compression-and-tool-view.md — 压缩与工具视图](compression-and-tool-view.md)；实现工具与模型调用时再读 [tools.md — 工具](tools.md)、[prompts.md — Prompt 与对白](prompts.md)、[model-pool.md — 模型池](model-pool.md)、[model-transport.md — 模型传输](model-transport.md)。

## 与其他目录的边界

世界命令与受众见 [领域模型](../architecture/domain-model.md)，实验口径见 [评估](../platform/evaluation.md)。

本页只提供导航；具体定义与验收要求以链接的主题文档为准。
