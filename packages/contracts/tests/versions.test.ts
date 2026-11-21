/**
 * 验证契约版本登记：模块 apiVersion、命令/事件信封 schemaVersion 与协议版本的支持集合。
 * 依赖公共契约的 versions 导出；不依赖具体模块或宿主。
 * 禁止在测试中重复写死版本字面量以外的新版本语义。
 */
import { describe, expect, it } from "vitest";
import {
  commandEnvelopeSchemaVersion,
  domainEventSchemaVersion,
  isSupportedCommandEnvelopeSchemaVersion,
  isSupportedModuleApiVersion,
  isSupportedProtocolVersion,
  moduleApiVersion,
  protocolVersion,
  supportedCommandEnvelopeSchemaVersions,
  supportedDomainEventSchemaVersions,
  supportedModuleApiVersions,
  supportedProtocolVersions,
} from "../src/index";

describe("契约版本登记", () => {
  it("模块 apiVersion 有唯一当前值并拒绝未登记版本", () => {
    expect(moduleApiVersion).toBe("1");
    expect([...supportedModuleApiVersions]).toEqual(["1"]);
    expect(isSupportedModuleApiVersion("1")).toBe(true);
    expect(isSupportedModuleApiVersion("2")).toBe(false);
  });

  it("命令与事件 schemaVersion 有唯一当前值并拒绝未登记版本", () => {
    expect(commandEnvelopeSchemaVersion).toBe(1);
    expect([...supportedCommandEnvelopeSchemaVersions]).toEqual([1]);
    expect(isSupportedCommandEnvelopeSchemaVersion(1)).toBe(true);
    expect(isSupportedCommandEnvelopeSchemaVersion(2)).toBe(false);

    expect(domainEventSchemaVersion).toBe(1);
    expect([...supportedDomainEventSchemaVersions]).toEqual([1]);
  });

  it("协议版本有唯一当前值并拒绝未登记版本", () => {
    expect(protocolVersion).toBe("1");
    expect([...supportedProtocolVersions]).toEqual(["1"]);
    expect(isSupportedProtocolVersion("1")).toBe(true);
    expect(isSupportedProtocolVersion("2")).toBe(false);
  });
});
