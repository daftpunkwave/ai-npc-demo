/**
 * 核心职责：验证 Agent 模型路由视图契约的构建与解析行为。
 * 交互契约：使用 module-sdk 的 bindAgentModelRoutes、resolveAgentModelRoutes 与内存假路由对象。
 * 约束与禁忌：不创建存储、网络连接或模块实例；假端口不得执行真实模型调用。
 */
import { describe, expect, it } from "vitest";
import { DomainError, type ModelCapabilities, type Purpose } from "@ai-npc/contracts";
import {
  agentRequiredModelPurposes, bindAgentModelRoutes, modelDecisionPurposeRequirements,
  resolveAgentModelRoutes, type AgentDecisionModelRoutes, type RunModelPort,
} from "@ai-npc/module-sdk";

const capabilities: ModelCapabilities = {
  toolCalling: true, strictTools: true, structuredOutput: "json_schema", assistantReplay: "verbatim",
  contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null,
};

function routeOf(purpose: Purpose, overrides: Partial<ModelCapabilities> = {}) {
  return { capabilities: { ...capabilities, ...overrides }, maxOutputTokens: 4096 };
}

function fakeRun(overrides: Partial<Record<Purpose, Partial<ModelCapabilities>>> = {}): RunModelPort {
  return {
    route: (_agentId, purpose) => routeOf(purpose, overrides[purpose]),
    call: async () => {
      throw new Error("测试假端口不执行模型调用");
    },
  };
}

function resolve(view: unknown): AgentDecisionModelRoutes {
  return resolveAgentModelRoutes({
    view, moduleId: "agent.decision.model", requirements: modelDecisionPurposeRequirements,
  });
}

describe("Agent 模型路由视图契约", () => {
  it("bindAgentModelRoutes 按权威必需用途构建完整视图", () => {
    const queried: string[] = [];
    const run: RunModelPort = {
      route: (agentId, purpose) => {
        expect(agentId).toBe("agent-a");
        queried.push(purpose);
        return routeOf(purpose);
      },
      call: fakeRun().call,
    };
    const routes = bindAgentModelRoutes(run, "agent-a");
    expect([...agentRequiredModelPurposes]).toEqual(["decision", "speech"]);
    expect(Object.keys(routes).sort()).toEqual([...agentRequiredModelPurposes].sort());
    expect(queried).toEqual([...agentRequiredModelPurposes]);
    expect(routes.decision.capabilities.toolCalling).toBe(true);
    expect(routes.speech.maxOutputTokens).toBe(4096);
  });

  it("合法路由视图通过解析并原样返回", () => {
    const view = bindAgentModelRoutes(fakeRun(), "agent-a");
    expect(resolve(view)).toBe(view);
  });

  it("缺少模型池能力注入时报装配不兼容", () => {
    expect(() => resolve(undefined)).toThrow(DomainError);
    expect(() => resolve(undefined)).toThrow(/缺少模型池能力的路由视图注入/);
  });

  it("路由视图缺失必需用途时报装配不兼容", () => {
    const view = bindAgentModelRoutes(fakeRun(), "agent-a");
    const incomplete = { decision: view.decision };
    expect(() => resolve(incomplete)).toThrow(/缺少必需的 speech 用途/);
  });

  it("决策路由不支持工具调用时报能力不匹配", () => {
    const view = bindAgentModelRoutes(fakeRun({ decision: { toolCalling: false } }), "agent-a");
    expect(() => resolve(view)).toThrow(/不满足端口能力要求/);
  });

  it("对白路由不支持结构化输出时报能力不匹配", () => {
    const view = bindAgentModelRoutes(fakeRun({ speech: { structuredOutput: "none" } }), "agent-a");
    expect(() => resolve(view)).toThrow(/不满足端口能力要求/);
  });

  it("对白路由结构化输出缺失或非法时报能力声明不合法", () => {
    const base = bindAgentModelRoutes(fakeRun(), "agent-a");
    const missing = {
      decision: base.decision,
      speech: { capabilities: { ...capabilities, structuredOutput: undefined }, maxOutputTokens: 4096 },
    };
    expect(() => resolve(missing)).toThrow(/speech 模型路由能力声明缺失或不合法/);
    const malformed = {
      decision: base.decision,
      speech: { capabilities: { ...capabilities, structuredOutput: 42 }, maxOutputTokens: 4096 },
    };
    expect(() => resolve(malformed)).toThrow(/speech 模型路由能力声明缺失或不合法/);
  });

  it("决策路由能力声明不是对象时报能力声明不合法", () => {
    const base = bindAgentModelRoutes(fakeRun(), "agent-a");
    const malformed = { decision: { capabilities: "json_schema", maxOutputTokens: 4096 }, speech: base.speech };
    expect(() => resolve(malformed)).toThrow(/decision 模型路由能力声明缺失或不合法/);
  });

  it("决策路由能力缺少必填字段时报能力声明不合法", () => {
    const base = bindAgentModelRoutes(fakeRun(), "agent-a");
    const incomplete = {
      decision: { capabilities: { toolCalling: true }, maxOutputTokens: 4096 }, speech: base.speech,
    };
    expect(() => resolve(incomplete)).toThrow(/decision 模型路由能力声明缺失或不合法/);
  });

  it("路由视图条目不是对象时报缺少必需用途", () => {
    const malformed = { decision: "decision-route", speech: { capabilities, maxOutputTokens: 4096 } };
    expect(() => resolve(malformed)).toThrow(/缺少必需的 decision 用途/);
  });
});
