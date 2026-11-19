/**
 * 宿主启动选项：数据目录、内容与装配引用、令牌与监听设置，以及仅供嵌入式宿主/测试注入的装配对象与模块目录。
 * 只定义参数结构与字段含义；不校验、不读取环境变量。
 * 禁止在装配已冻结的在线 run 上按这些入参重建运行规格，也禁止把它们写进模块装配配置或冻结摘要。
 */
import type { AssemblyDescriptor, ModuleDefinition } from "@ai-npc/contracts";

export interface HostOptions {
  readonly dataDir: string;
  readonly contentRoot?: string;
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
  /** 在线世界首次启动时写入 RunSpec 的名册引用；缺省用 standard-20。 */
  readonly rosterRef?: string;
  /** 在线世界首次启动时写入 RunSpec 的模型布局引用；缺省沿用 RunSpec 模板。 */
  readonly modelLayoutRef?: string;
  readonly playerToken: string;
  readonly consoleToken: string;
  /** 可选的单角色控制台令牌；只发放对应角色。 */
  readonly operatorToken?: string;
  readonly researcherToken?: string;
  readonly evaluatorToken?: string;
  readonly transportHost?: string;
  readonly transportPort?: number;
  readonly allowedOrigins?: readonly string[];
}
