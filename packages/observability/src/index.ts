/**
 * 核心职责：为服务端观测机制保留的包入口，当前只导出包名，供边界检查与冒烟测试确认入口存在。
 * 交互契约：trace、span 与证据信封的 schema 定义在 contracts 的 api-observe.ts，观测数据的存储与查询由
 * platform.observability.sqlite 模块提供；本包不重复定义这些协议。
 * 约束与禁忌：禁止写入世界事实、绑定具体存储，或在此复制 contracts 已有的观测协议。
 */
export const packageName = "@world-prism/observability";
