# platform.access-policy.roster

按角色名册裁决玩家命令与控制台访问。

## 配置

```yaml
playerCommands:
  - campaign.start
  - dialogue.say
consoleRoles: [operator, researcher, evaluator]
```

## 行为

- `command`：玩家只允许 `playerCommands`；operator 允许；其他角色拒绝。
- `console`：只允许 `consoleRoles` 中的角色。
- 返回值只含 `allowed` 与 `reason`，不泄漏策略细节。

## 限制

- 名册来自部署配置，不读取数据库；席位租约、epoch 与工具级授权由后续模块负责。
- 未接入 `transport.http-ws.fastify` 的鉴权钩子，当前宿主仍使用内置玩家命令白名单。
