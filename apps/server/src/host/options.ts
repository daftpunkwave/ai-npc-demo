/**
 * 宿主启动选项：数据目录、内容与装配引用、令牌与监听设置，以及仅供嵌入式宿主/测试注入的装配对象与模块目录。
 * 只定义参数结构与字段含义；不校验、不读取环境变量。
 * 禁止在装配已冻结的在线 run 上按这些入参重建运行规格，也禁止把它们写进模块装配配置或冻结摘要。
 */
import type { AssemblyDescriptor, ModuleDefinition } from "@world-prism/contracts";

export interface HostOptions {
  readonly dataDir: string;
  /**
   * 控制台静态产物目录；缺省按仓库根下的固定构建输出位置解析。
   * 部署参数只来自环境变量与项目根，不得按 process.cwd() 派生，否则从其它工作目录启动会挂载到空目录。
   */
  readonly consoleStaticDir?: string;
  readonly contentRoot?: string;
  /** 嵌入场景的 profile、工具集、名册和 RunSpec 配置根目录。 */
  readonly configRoot?: string;
  readonly packId?: string;
  readonly assemblyRef?: string;
  /** 已解析装配对象；仅供嵌入式宿主与测试注入，设置后再指定 assemblyRef 会失败。 */
  readonly assembly?: AssemblyDescriptor;
  /**
   * 完整模块目录；缺省使用组合根登记的全部 server 模块定义。
   * 仅供嵌入式宿主与测试注入，仍走同一解析、校验与启动路径。
   */
  readonly moduleDefinitions?: readonly ModuleDefinition[];
  readonly runSpecRef?: string;
  /** 在线世界首次启动时写入 RunSpec 的名册引用；缺省用 standard-15。 */
  readonly rosterRef?: string;
  /** 在线世界首次启动时写入 RunSpec 的模型布局引用；缺省沿用 RunSpec 模板。 */
  readonly modelLayoutRef?: string;
  /**
   * 速率限制阈值覆盖；仅供测试与压测放宽，生产不设置即使用传输层默认阈值。
   */
  readonly rateLimits?: { readonly read?: number; readonly write?: number };
  readonly playerToken: string;
  readonly consoleToken: string;
  /** 可选的单角色控制台令牌；只发放对应角色。 */
  readonly operatorToken?: string;
  readonly researcherToken?: string;
  readonly evaluatorToken?: string;
  readonly transportHost?: string;
  readonly transportPort?: number;
  /** 玩家浏览器端口；只用于健康摘要与 Origin 白名单，不启动第二个服务端监听。 */
  readonly clientPort?: number;
  readonly allowedOrigins?: readonly string[];
  /**
   * 在线 run 的冻结 manifest 无法按当前模块目录复算（能力闭包升级）时执行显式迁移：
   * 从源分支派生新分支与新 run 并切换 online 别名，源 run 与分支保持原样。
   * 缺省拒绝启动并给出迁移指引，不静默修改旧 run。
   */
  readonly migrateOnlineRun?: boolean;
  /**
   * 关闭时每级资源排空的预算（毫秒）：先停止新任务并等待提交边界，超时记录后继续释放。
   * 缺省使用与租约期限解耦的默认值，避免单个卡住的 turn 无限拖住进程退出。
   */
  readonly shutdownDrainMs?: number;
}
