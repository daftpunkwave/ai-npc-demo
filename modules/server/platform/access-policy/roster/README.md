# platform.access-policy.roster

按角色名册裁决玩家入口、命令、控制台接口、控制台会话与 WS 频道。

## 配置

```yaml
playerCommands:
  - campaign.start
  - dialogue.say
consoleRoles: [operator, researcher]
```

## 行为

- `player`：只允许玩家角色进入玩家路由。
- `command`：玩家只允许 `playerCommands`；operator 允许；其他角色拒绝。
- `console`：只允许 `consoleRoles` 中的角色（默认 operator 与 researcher）。
- `console-session`：控制台装配握手对 operator、researcher、evaluator 开放。
- `channel`：按 API 第 4 节的角色映射放行 `player`、`console.health`、`console.timeline`、`console.turns`。
- 返回值只含 `allowed` 与 `reason`，不泄漏策略细节。

## 限制

- 名册来自部署配置，不读取数据库；席位租约、epoch 与工具级授权由后续模块负责。
- 端口由宿主从装配运行时取出后注入传输层，传输层不维护自己的角色白名单。
