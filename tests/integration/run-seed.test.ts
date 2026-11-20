/**
 * 验证规则随机源由 authority 注入：宿主收到的第一个参数是当前 run 的 seed，
 * 后续参数只含 teamId、departTick、roadId 等语义字段，不含 taskId。
 * 依赖真实 SQLite、游戏模块与 authority；不启动网络。
 * 禁止用规则模块读取全局 seed，或把随机生成的 ID 放进随机输入。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createGameHarness, disposeTrackedGameHarnesses, startNeutralCampaign, type GameHarness } from "./game-support";
import { acceptTaskInvitation, advanceTo, dispatchTask, strategicAuth } from "./game-agreement-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

describe("规则处理器的 runSeed 注入", () => {
  it("随机输入以 runSeed 开头且不含任务 ID", async () => {
    const recorded: string[][] = [];
    const value = await createGameHarness({
      runSeed: "seed-rule-1",
      onRng: (parts) => recorded.push([...parts]),
    });
    active.push(value);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const taskId = dispatchTask(value, strategicAuth(value, "species-extraterrestrial"), {
      taskType: "transport",
      teamId: "team-star",
      departAfterTicks: 4,
      invitees: ["species-extraterrestrial"],
      params: {
        fromStockpileId: "sp-star",
        toStockpileId: "sp-flora",
        cargo: { supply: 0, energy: 1, medical: 0 },
      },
    });
    acceptTaskInvitation(value, "species-extraterrestrial", taskId);
    advanceTo(value, 4);

    expect(recorded.length).toBeGreaterThan(0);
    for (const parts of recorded) {
      expect(parts[0]).toBe("seed-rule-1");
      expect(parts[1]).toBe("risk");
      expect(parts).not.toContain(taskId);
    }
    expect(recorded[0]).toContain("team-star");
    expect(recorded[0]).toContain("4");
    expect(recorded[0]?.some((part) => part.startsWith("r-"))).toBe(true);
  });
});
