# platform.secrets.env

从进程环境按 `credentialRef` 解析密钥，只允许显式 allowlist。

## 配置

```yaml
allowlist: [NPC_OPENAI_COMPAT_API_KEY, ANTHROPIC_API_KEY]
```

## 行为

- `resolve(ref)`：ref 必须在 allowlist 中且环境变量非空，否则返回 `null`。
- 不缓存明文，不记录日志，不返回给浏览器。

## 限制

- 只支持环境变量；文件/密钥库适配器后续实现。
- 当前由 `agent.model-pool.shared` 消费该端口解析模型连接的 `credentialRef`。
