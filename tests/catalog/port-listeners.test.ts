/**
 * 校验 macOS lsof 监听输出解析与固定参数。
 * 只依赖脚本包公开的纯解析函数；不要求测试机安装 lsof。
 */
import { describe, expect, it } from "vitest";
import {
  macOSListenerArgs,
  parseMacOSListeners,
} from "@ai-npc/scripts/port-listeners";

describe("macOS 端口监听解析", () => {
  it("请求并读取网络名称字段", () => {
    expect(macOSListenerArgs).toEqual([
      "-nP",
      "-iTCP",
      "-sTCP:LISTEN",
      "-F",
      "pcn",
    ]);
    expect(
      parseMacOSListeners([
        "p123",
        "cnode",
        "n127.0.0.1:5173",
        "p456",
        "cnode",
        "n[::1]:3000",
      ].join("\n")),
    ).toEqual([
      { pid: 123, port: 5173 },
      { pid: 456, port: 3000 },
    ]);
  });

  it("没有网络名称字段时不伪造监听记录", () => {
    expect(parseMacOSListeners("p123\ncnode")).toEqual([]);
  });
});
