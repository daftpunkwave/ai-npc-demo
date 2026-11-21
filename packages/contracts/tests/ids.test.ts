/**
 * 验证运行中 ID 前缀全集与格式、内容 ID 与主体 ID 校验。
 * 依赖公共契约包的 ids 主题导出。
 * 禁止在此生成真实随机 ID 或依赖时间；样例为固定字符串。
 */
import { describe, expect, it } from "vitest";
import {
  contentIdSchema,
  contentIdSchemas,
  contentTokenIdSchema,
  factionIdSchema,
  idPrefixSchema,
  idPrefixes,
  isRuntimeId,
  isRuntimeIdFor,
  principalIdSchema,
  runtimeIdSchema,
  runtimeIdSchemaFor,
} from "../src/index";
import { expectInvalid, expectValid } from "./support";

/** 运行中 ID 的 37 个前缀，按用途分组固定，用于目录完整性断言。 */
const expectedPrefixes = [
  "wld",
  "br",
  "run",
  "cmp",
  "cmd",
  "rcp",
  "evt",
  "job",
  "op",
  "task",
  "inv",
  "agr",
  "conv",
  "dlg",
  "msg",
  "shr",
  "del",
  "pg",
  "kg",
  "obs",
  "mem",
  "turn",
  "att",
  "llm",
  "tc",
  "art",
  "trc",
  "spn",
  "snap",
  "ses",
  "prb",
  "rr",
  "mnt",
  "trg",
  "exp",
  "rum",
  "fact",
] as const;

const body = "k3j9x0a1b2c3";

describe("运行中 ID 前缀", () => {
  it("前缀集合与固定目录一致且无重复", () => {
    expect([...idPrefixes]).toEqual([...expectedPrefixes]);
    expect(new Set(idPrefixes).size).toBe(expectedPrefixes.length);
    idPrefixSchema.parse("evt");
    expectInvalid(idPrefixSchema, "event");
  });

  it("每个前缀都能校验本前缀 ID 并拒绝其他前缀", () => {
    for (const prefix of expectedPrefixes) {
      const schema = runtimeIdSchemaFor(prefix);
      const id = `${prefix}-${body}`;
      const otherPrefix = prefix === "wld" ? "br" : "wld";
      expectValid(schema, id);
      expect(isRuntimeIdFor(prefix, id)).toBe(true);
      expectInvalid(schema, `${otherPrefix}-${body}`);
      expectInvalid(schema, `${prefix}-${body.slice(0, 11)}`);
      expectInvalid(schema, `${prefix}-${body.toUpperCase()}`);
      expectInvalid(schema, `${prefix}-${body}0`);
      expectInvalid(schema, `${prefix}_${body}`);
    }
  });

  it("通用 ID schema 接受全部前缀并拒绝未知前缀", () => {
    for (const prefix of expectedPrefixes) {
      expectValid(runtimeIdSchema, `${prefix}-${body}`);
      expect(isRuntimeId(`${prefix}-${body}`)).toBe(true);
    }
    expectInvalid(runtimeIdSchema, `event-${body}`);
    expectInvalid(runtimeIdSchema, `evt-${body}i`);
    expect(isRuntimeId("not-an-id")).toBe(false);
  });
});

describe("内容 ID", () => {
  it.each([
    ["node", "grayharbor"],
    ["node", "watergate"],
    ["r", "r-gh-wg"],
    ["sp", "sp-commons"],
    ["team", "team-star"],
    ["grp", "grp-injured-migrants"],
    ["ev", "ev-flood-log"],
    ["sec", "sec-flora-evacuation"],
    ["card", "card-relay-alarm"],
    ["src", "src-trader"],
  ] as const)("内容 ID %s 接受 %s", (kind, id) => {
    expectValid(contentIdSchemas[kind], id);
    expectValid(contentIdSchema, id);
  });

  it("内容 ID 拒绝大写、缺前缀与空后缀", () => {
    expectInvalid(contentIdSchemas.node, "Grayharbor");
    expectInvalid(contentIdSchemas.r, "gh-wg");
    expectInvalid(contentIdSchemas.sp, "sp-");
    expectInvalid(contentIdSchemas.card, "card-");
    expectInvalid(contentIdSchema, "Unknown-ID");
  });

  it("内容 token 与派系 ID 约束", () => {
    expectValid(contentTokenIdSchema, "human-neutral");
    expectValid(factionIdSchema, "species-fauna");
    expectInvalid(contentTokenIdSchema, "Human-neutral");
    expectInvalid(contentTokenIdSchema, "9human");
    expectInvalid(factionIdSchema, "human neutral");
  });
});

describe("主体 ID", () => {
  it("接受玩家、Agent 与系统主体，拒绝空串与非字符串", () => {
    expectValid(principalIdSchema, "player-1");
    expectValid(principalIdSchema, "npc-cenyan");
    expectValid(principalIdSchema, "system:world");
    expectInvalid(principalIdSchema, "");
    expectInvalid(principalIdSchema, 1);
  });
});
