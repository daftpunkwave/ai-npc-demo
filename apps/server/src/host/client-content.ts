/**
 * 核心职责：把已校验内容包与生效时钟配置组装成客户端只读内容视图。
 * 交互契约：依赖内容包的 lore/locale 与公共契约的 clientContentViewSchema；时钟刻度由宿主解析装配后传入。
 * 约束与禁忌：不读取文件、不缓存、不用默认文案兜底；缺必需界面文字时解析失败由宿主启动终止。
 */
import { clientContentViewSchema, type ClientContentView, type ContentPack } from "@world-prism/contracts";

/** 组装客户端内容视图；界面文字只取自内容包，缺失即失败而不是伪造。 */
export function createClientContent(
  content: ContentPack,
  clock: { readonly secondsPerTick: number; readonly evaluationTick: number },
): ClientContentView {
  return clientContentViewSchema.parse({
    chapterTitle: content.lore.chapter.title,
    clock: {
      secondsPerTick: clock.secondsPerTick,
      evaluationTick: clock.evaluationTick,
      motionTick: content.lore.chapter.motionTick,
    },
    ui: content.locale.ui,
  });
}
