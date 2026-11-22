/**
 * 核对游戏规格中的派系与上场身份对照表。
 * 由公共加载器解析真实内容包与正式名册，按 ID 比较显示名。
 * 禁止根据叙事正文推断术语含义或把未上场人物视为运行身份。
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { loadContentPack, loadRoster, validateRoster } from "@ai-npc/experiment";

const content = loadContentPack("content", "earth-2964-v1");

function readIdentityRows(file: URL, title: string): string[][] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^### (?:\d+(?:\.\d+)* )?(.+)$/.exec(line)?.[1] === title);
  if (headingIndex < 0) {
    throw new Error(`${file.pathname} 缺少“${title}”小节`);
  }

  const section = lines.slice(headingIndex + 1);
  const nextHeading = section.findIndex((line) => /^#{1,6} /.test(line));
  const sectionLines = nextHeading < 0 ? section : section.slice(0, nextHeading);
  const tableRows = sectionLines.filter((line) => line.startsWith("|"));
  return tableRows.slice(2).map((row) =>
    row.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`(.+)`$/, "$1")),
  );
}

it("设定速查表的派系 ID 与显示名对应内容包", () => {
  const canon = new URL("../../docs/design/world/canon.md", import.meta.url);
  const documented = readIdentityRows(canon, "派系与席位").map(([name, , factionId]) => [factionId, name]);
  const expected = content.factions.factions.map(({ factionId, name }) => [factionId, name]);

  expect(documented).toHaveLength(expected.length);
  expect(documented).toEqual(expect.arrayContaining(expected));
});

it("序章规格的上场身份和显示名对应正式运行名册", () => {
  const scope = new URL("../../docs/00-scope-and-invariants.md", import.meta.url);
  const documented = readIdentityRows(scope, "15 个上场身份").map(([, agentId, name]) => [agentId, name]);
  const roster = loadRoster("standard-15", { configDir: "config" }).value;
  validateRoster(roster, content);
  const expected = roster.agents.map(({ agentId, kind }) => {
    const characterName = content.index.characters.get(agentId)?.name;
    const faction = content.index.factions.get(agentId);
    if (faction?.kind === "species") {
      expect(characterName, `${agentId} 须在角色表中提供与派系领袖一致的显示名`).toBe(faction.leaderName);
    }
    return [agentId, kind === "character" ? characterName : faction?.leaderName];
  });

  expect(documented).toHaveLength(expected.length);
  expect(documented).toEqual(expect.arrayContaining(expected));
});
