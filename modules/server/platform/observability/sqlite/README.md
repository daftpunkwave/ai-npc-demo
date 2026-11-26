# platform.observability.sqlite

使用 SQLite 表保存 HTTP 与 Agent turn 阶段跨度，并提供控制台时间线、Agent 检查器、记忆/观察、turn 详情、Artifact（含 `raw` 访问审计）、trace 树、分支事件对比与调试队列/唤醒查询接口。

该模块只依赖 `platform.storage` 端口，不改变世界事件、Agent 记忆或模型请求；Artifact 脱敏策略由宿主查询组装层执行。
