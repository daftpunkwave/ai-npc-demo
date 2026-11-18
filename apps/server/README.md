# @ai-npc/app-server

服务端 HTTP/WS 传输层与宿主入口。

## 当前范围

- `createServerApp`：Fastify 应用工厂，提供登录、会话、命令、回执查询、世界视图、暂停/继续、快照、恢复、流票据与玩家 WS 快照。
- Origin 白名单、Bearer 会话、玩家命令白名单与控制台 403。
- `buildPlayerProjection`：从世界/地图端口与内容索引构建严格玩家投影；未接入的集合保持为空，不伪造私有数据。
- 依赖由调用方注入：`Authority`、`StoragePort`、投影/时钟/存档回调与身份令牌。

## 尚未包含

- `main.ts` bootstrap、首次世界创建、模块 catalog、装配解析、worker 启动、投影增量推送与 200 条重放缓冲。
- 操作编排（静默、切换在线别名、投影重推）。
- 玩家/控制台前端与 Playwright e2e。

这些属于 S09 宿主集成步骤，将在独立 PR 中完成；当前 PR 只交付可注入、可测试的传输层。
