# platform.observability.sqlite

使用 SQLite 表 `trace_spans` 保存 HTTP 与 Agent turn 阶段跨度，并提供控制台时间线、Agent 检查器、记忆/观察、turn 详情、Artifact（含 `raw` 访问审计）、trace 树、分支事件对比与调试队列/唤醒查询接口。

该模块经 `platform.storage` 端口只读写自己拥有的 `trace_spans`，并经 module-sdk 写生命周期审计。领域事件、turn 证据、Agent 状态、记忆、观察、审计时间线与 artifact 正文等他人数据，经宿主启动后用 `bind` 注入的 `ObservabilitySources` 数据源端口读取，记录由各表所有者解码；调试唤醒也经该端口交给宿主登记。未绑定数据源时这些查询返回 `not-ready`。

模块不改变世界事件、Agent 记忆或模型请求；Artifact 脱敏策略由宿主查询组装层执行。
