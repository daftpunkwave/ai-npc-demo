# console.observability.standard

研究员的只读观测页面，提供世界时间线、Agent 状态与检查器、turn 证据、trace 树及脱敏/原文 Artifact 查看。

页面通过授权控制台 API 读取数据，不把真值下发给玩家席位，也不修改事件、记忆或世界状态。

离开页面、切换在线分支或改选 Agent 与 turn 时，页面中止对应的在途读取；每次读取同样受 `ApiClient` 请求期限约束，服务端挂起时以超时错误结束而不是一直加载。
