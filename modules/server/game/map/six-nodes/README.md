# game.map.six-nodes

六节点地图服务。道路静态属性来自内容包，模块只拥有道路状态与通行许可两类聚合。

## 边界

- 提供能力：`game.map`（`exactly-one`，run 作用域）。
- 拥有聚合：`road`、`passage-grant`。
- 依赖：无游戏模块依赖；内容索引由宿主编排注入。
- 写入入口：`setRoadStatus`、`grantPassage`，由 `policy.set`、协议生效或调试覆盖经端口调用。

## 规则

- 道路无向；状态为 `open`、`restricted`、`closed`。
- `restricted` 只允许控制方或持有未过期通行许可的派系通过；`closed` 一律不可通过。
- 路径使用 Dijkstra，按总行程、道路数、道路 ID 序列依次比较；有货物时每条道路额外加 1 tick。
- 道路状态变化发布 `PolicyChanged`，通行许可发布 `PassageGranted`。

## 参数与限制

- 配置仅限制节点规模上限，当前默认 64；六节点内容不使用该上限。
- 地图模块不写库存、角色或任务状态；路径结果不包含风险抽样。
- 已出发任务不重新计算路径；道路在途变化只影响后续任务。
