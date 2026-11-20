# platform.observability.sqlite

使用现有 SQLite 表保存 HTTP/运行跨度，并提供控制台时间线与 Agent 状态只读查询。

该模块只依赖 `platform.storage` 端口，不改变世界事件、Agent 记忆或模型请求。证据原文与脱敏策略仍由后续 Agent 观测能力补齐。
