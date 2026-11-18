# transport.http-ws.fastify

HTTP/WS 传输模块的配置定义与端口。

## 配置

```yaml
host: 127.0.0.1
port: 3000
allowedOrigins:
  - http://127.0.0.1:5173
  - http://127.0.0.1:3000
```

## 端口

`TransportPort` 暴露 `host`、`port`、`allowedOrigins`。Fastify 路由、错误格式、Origin 校验与 WebSocket 由 `apps/server` 的 `createServerApp` 实现，宿主把该端口配置传入应用。

## 限制

- 模块本身不创建 Fastify 实例，也不监听端口；端口绑定由宿主完成。
- 未来若把路由迁入模块，需要把 `createServerApp` 移动为 transport adapter 的实现。
