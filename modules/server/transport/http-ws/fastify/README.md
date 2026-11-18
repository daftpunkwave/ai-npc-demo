# transport.http-ws.fastify

Fastify HTTP/WS 传输 provider。

## 范围

- `TransportPort.createApp(options)`：创建 Fastify 应用，包含登录/会话/命令/回执/世界视图/时钟/存档/流票据/WS 玩家流、CORS、Origin 校验与错误格式。
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

- WebSocket 只实现 snapshot/delta；append 帧尚未实现。
- 命令回执查询直接读 `command_receipts` 表，未抽出 receipt 查询端口。
