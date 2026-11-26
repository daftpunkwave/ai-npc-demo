/**
 * 验证扩展领域事件的显式登记、冲突检测与消费者订阅校验。
 * 依赖 authority 的规则注册表与公共契约 schema；不使用存储、事务或真实模块。
 * 禁止让未登记事件或拼错的事件名在注册阶段静默通过。
 */
import { describe, expect, it } from "vitest";
import { DomainError, campaignStartedPayloadSchema, type EventPayloadSchema } from "@world-prism/contracts";
import { RuleRegistry } from "../src/rule-registry";

function expectAssemblyFailure(run: () => void, messagePart: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe("assembly-incompatible");
  expect((caught as DomainError).safeMessage).toContain(messagePart);
}

describe("扩展领域事件登记", () => {
  it("登记后可被消费者订阅并出现在事件 schema 表", () => {
    const registry = new RuleRegistry();
    registry.registerModule({
      moduleId: "test.extending",
      ownsAggregates: ["counter"],
      events: [{ type: "TestCounterChanged", payloadSchema: campaignStartedPayloadSchema }],
      consumers: [
        {
          consumerId: "counter-events",
          eventTypes: ["TestCounterChanged"],
          handler: () => undefined,
        },
      ],
    });

    expect(registry.eventSchemas().has("TestCounterChanged")).toBe(true);
    expect(registry.eventSchemas().has("CampaignStarted")).toBe(true);
    expect(registry.consumerList()).toHaveLength(1);
  });

  it("与公共契约事件同名时拒绝登记", () => {
    const registry = new RuleRegistry();
    expectAssemblyFailure(
      () =>
        registry.registerModule({
          moduleId: "test.conflict",
          ownsAggregates: [],
          events: [{ type: "CampaignStarted", payloadSchema: campaignStartedPayloadSchema }],
        }),
      "冲突",
    );
  });

  it("重复登记同一事件类型时拒绝", () => {
    const registry = new RuleRegistry();
    registry.registerModule({
      moduleId: "test.first",
      ownsAggregates: [],
      events: [{ type: "TestSharedEvent", payloadSchema: campaignStartedPayloadSchema }],
    });
    expectAssemblyFailure(
      () =>
        registry.registerModule({
          moduleId: "test.second",
          ownsAggregates: [],
          events: [{ type: "TestSharedEvent", payloadSchema: campaignStartedPayloadSchema }],
        }),
      "已登记",
    );
  });

  it("消费者可以先于事件提供者注册，消费启动前统一校验订阅", () => {
    const registry = new RuleRegistry();
    registry.registerModule({
      moduleId: "test.consumer",
      ownsAggregates: [],
      consumers: [
        {
          consumerId: "late-consumer",
          eventTypes: ["TestLateEvent"],
          handler: () => undefined,
        },
      ],
    });
    registry.registerModule({
      moduleId: "test.producer",
      ownsAggregates: [],
      events: [{ type: "TestLateEvent", payloadSchema: campaignStartedPayloadSchema }],
    });

    expect(() => registry.consumerList()).not.toThrow();
    expect(registry.consumerList()).toHaveLength(1);
  });

  it("相互订阅的模块不受注册顺序影响", () => {
    const registry = new RuleRegistry();
    registry.registerModule({
      moduleId: "test.first",
      ownsAggregates: [],
      events: [{ type: "TestFirstEvent", payloadSchema: campaignStartedPayloadSchema }],
      consumers: [
        {
          consumerId: "first-consumer",
          eventTypes: ["TestSecondEvent"],
          handler: () => undefined,
        },
      ],
    });
    registry.registerModule({
      moduleId: "test.second",
      ownsAggregates: [],
      events: [{ type: "TestSecondEvent", payloadSchema: campaignStartedPayloadSchema }],
      consumers: [
        {
          consumerId: "second-consumer",
          eventTypes: ["TestFirstEvent"],
          handler: () => undefined,
        },
      ],
    });

    expect(() => registry.consumerList()).not.toThrow();
    expect(registry.consumerList()).toHaveLength(2);
  });

  it("消费者订阅未登记事件时在消费启动前拒绝", () => {
    const registry = new RuleRegistry();
    registry.registerModule({
      moduleId: "test.typo",
      ownsAggregates: [],
      consumers: [
        {
          consumerId: "typo-consumer",
          eventTypes: ["TaskCompletedd"],
          handler: () => undefined,
        },
      ],
    });
    expectAssemblyFailure(() => registry.consumerList(), "未登记的事件类型");
  });

  it("payloadSchema 不是可校验 schema 时拒绝", () => {
    const registry = new RuleRegistry();
    expectAssemblyFailure(
      () =>
        registry.registerModule({
          moduleId: "test.invalid-schema",
          ownsAggregates: [],
          events: [{ type: "TestInvalidSchema", payloadSchema: {} as EventPayloadSchema }],
        }),
      "payloadSchema",
    );
  });
});
