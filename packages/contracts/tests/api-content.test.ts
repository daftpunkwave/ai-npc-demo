/**
 * 验证客户端内容视图的字段完整性、顶层严格性与 tick 正数约束。
 * 依赖公共契约包的内容视图 schema；不读取内容包文件或启动服务端。
 * 禁止放宽顶层或时钟刻度字段，也不在此校验内容文案。
 */
import { describe, expect, it } from "vitest";
import { clientContentViewSchema } from "../src/index";

const validContent = {
  chapterTitle: "水闸之前",
  clock: { secondsPerTick: 20, evaluationTick: 168, motionTick: 144 },
  ui: {
    noReply: "（对方暂未回应）",
    waitingReply: "等待回应",
    reconnecting: "重连中",
    serverUnavailable: "服务端不可连接",
    sessionExpired: "会话已失效，请重新登录。",
    incompleteAssembly: "组合不完整",
    moduleNotLoaded: "模块未装载",
    chapterKicker: "序章 / 第一周",
    startBriefing: "开场白",
    hudKicker: "灰港 / 序章",
    siteLabel: "灰港现场",
    sceneLabel: "灰港近城",
    consoleTitle: "灰港控制台",
  },
};

describe("客户端内容视图契约", () => {
  it("完整样例通过并保留字段", () => {
    expect(clientContentViewSchema.parse(validContent)).toEqual(validContent);
  });

  it("缺少界面文字键时拒绝", () => {
    const { sessionExpired: _removed, ...partialUi } = validContent.ui;
    const result = clientContentViewSchema.safeParse({ ...validContent, ui: partialUi });
    expect(result.success).toBe(false);
  });

  it("缺少时钟刻度时拒绝", () => {
    const { motionTick: _removed, ...partialClock } = validContent.clock;
    const result = clientContentViewSchema.safeParse({ ...validContent, clock: partialClock });
    expect(result.success).toBe(false);
  });

  it("顶层额外字段被严格拒绝，内容包额外界面键被裁剪", () => {
    expect(
      clientContentViewSchema.safeParse({ ...validContent, secret: "内部数据" }).success,
    ).toBe(false);
    // locale.ui 允许内容包继续扩展；协议只保留已声明的界面键。
    const parsed = clientContentViewSchema.parse({
      ...validContent,
      ui: { ...validContent.ui, futureHint: "后续扩展" },
    });
    expect(parsed.ui).toEqual(validContent.ui);
  });

  it("非正 tick 时拒绝", () => {
    for (const clock of [
      { ...validContent.clock, secondsPerTick: 0 },
      { ...validContent.clock, evaluationTick: -1 },
      { ...validContent.clock, motionTick: 0 },
      { ...validContent.clock, motionTick: 1.5 },
    ]) {
      expect(clientContentViewSchema.safeParse({ ...validContent, clock }).success).toBe(false);
    }
  });

  it("空字符串标题与空界面文字被拒绝", () => {
    expect(clientContentViewSchema.safeParse({ ...validContent, chapterTitle: "" }).success).toBe(
      false,
    );
    expect(
      clientContentViewSchema.safeParse({
        ...validContent,
        ui: { ...validContent.ui, hudKicker: "" },
      }).success,
    ).toBe(false);
  });
});
