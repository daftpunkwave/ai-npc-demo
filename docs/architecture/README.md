# 架构与模块契约

说明固定宿主、可替换职能、依赖方向、世界权威和双端协议；本目录是架构导航，不复制详细契约。

[返回文档入口](../README.md) · [项目概览](../../README.md)

## 文档索引

| 文档 | 负责内容 |
|---|---|
| [overview.md — 系统总览](overview.md) | 系统边界与核心取舍 |
| [modules.md — 模块边界](modules.md) | 职责、依赖和状态所有权 |
| [plugins.md — 插件机制](plugins.md) | 描述符、注册与生命周期 |
| [composition.md — 组合与冻结](composition.md) | 装配、profile 与配置生效 |
| [module-catalog.md — 模块目录](module-catalog.md) | 能力、实现、默认组合及替换矩阵 |
| [code-structure.md — 代码结构](code-structure.md) | 目标目录、公开入口与扩展流程 |
| [contracts.md — 公共契约](contracts.md) | 共享信封、DTO 与错误语义 |
| [domain-model.md — 领域模型](domain-model.md) | 命令、事件、聚合、受众与投影 |
| [events-and-state.md — 事件与状态](events-and-state.md) | 事务、消费、水位和恢复语义 |
| [storage.md — 存储](storage.md) | 表结构与分支复制 |
| [two-endpoints.md — 双端部署](two-endpoints.md) | 现行浏览器部署、原生单监听目标与三域权限 |
| [api.md — 接口](api.md) | HTTP 与 WebSocket 清单 |
| [client-and-rendering.md — 玩家客户端](client-and-rendering.md) | UI slot、渲染、交互及 Godot 原生宿主 |

## 阅读顺序

[overview.md — 系统总览](overview.md) → [modules.md — 模块边界](modules.md) → [plugins.md — 插件机制](plugins.md) → [composition.md — 组合与冻结](composition.md) → [module-catalog.md — 模块目录](module-catalog.md) → [code-structure.md — 代码结构](code-structure.md)；随后按任务阅读契约、持久化或双端协议。

## 与其他目录的边界

具体游戏数值见 [游戏目录](../game/README.md)，认知策略见 [Agent 目录](../agent/README.md)，工程检查见 [交付目录](../delivery/README.md)。

本页只提供导航；具体定义与验收要求以链接的主题文档为准。
