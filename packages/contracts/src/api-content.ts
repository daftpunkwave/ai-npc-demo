/**
 * 定义客户端只需读取的静态内容视图：章节标题、时钟刻度与界面文字。
 * 依赖 Zod 校验；只描述服务端从内容包与装配配置组装出的对外形状。
 * 禁止在此读取内容文件或解析装配计划；界面文字允许内容包扩展，未知键在裁剪时丢弃。
 */
import { z } from "zod";

/** 客户端界面文字：必需键由服务端启动校验保证，内容包的额外键不影响协议。 */
export const clientUiTextSchema = z.object({
  noReply: z.string().min(1),
  waitingReply: z.string().min(1),
  reconnecting: z.string().min(1),
  serverUnavailable: z.string().min(1),
  sessionExpired: z.string().min(1),
  incompleteAssembly: z.string().min(1),
  moduleNotLoaded: z.string().min(1),
  chapterKicker: z.string().min(1),
  startBriefing: z.string().min(1),
  hudKicker: z.string().min(1),
  siteLabel: z.string().min(1),
  sceneLabel: z.string().min(1),
  consoleTitle: z.string().min(1),
});

/** 客户端时钟刻度：每游戏小时的现实秒数、章节评估 tick 与议事 tick。 */
export const clientClockConfigViewSchema = z
  .object({
    secondsPerTick: z.number().int().positive(),
    evaluationTick: z.number().int().positive(),
    motionTick: z.number().int().positive(),
  })
  .strict();

/** 客户端内容视图：章节名、时钟刻度与界面文字，全部来自内容包与装配配置。 */
export const clientContentViewSchema = z
  .object({
    chapterTitle: z.string().min(1),
    clock: clientClockConfigViewSchema,
    ui: clientUiTextSchema,
  })
  .strict();

export type ClientContentView = z.infer<typeof clientContentViewSchema>;
