# transport.http-ws.fastify

Fastify HTTP/WS 传输 provider。

## 范围

- `TransportPort.createApp(options)`：创建 Fastify 应用，包含认证/会话/内容/玩家命令与回执/世界视图/时钟/存档/流票据、控制台接口（健康、模块目录、装配、模型布局、研究观测、评估导出、时钟与存档运营）、`/console/*` 静态托管与 SPA 回退、WS（`player`、`console.health`、`console.timeline`）、CORS、Origin 校验、限流、安全响应头与统一错误格式。
- `TransportPort.listen(app)`：按 provider 配置监听回环地址。
- `TransportPort` 暴露 `host`、`port`、`allowedOrigins`，Origin 白名单由 provider 固化，调用方不能覆盖。

## 配置

```yaml
host: 127.0.0.1
port: 3000
allowedOrigins:
  - http://127.0.0.1:5173
  - http://127.0.0.1:3000
```

## 依赖

`createApp` 接收 `AuthorityPort`、`StoragePort`、投影/时钟/存档/运营回调、身份令牌与 ID 生成器；不依赖 authority 实现包。

## 限制

- WebSocket 的 `player` 频道已实现 `snapshot`、`delta` 与 `append`（`dialogue`、`notification`）帧；`console.health` 与 `console.timeline` 推送快照，`console.turns` 当前订阅返回 `not-ready`。
- 命令回执查询通过注入的 `receipts.read(...)` 端口读取，不直接执行表查询。
