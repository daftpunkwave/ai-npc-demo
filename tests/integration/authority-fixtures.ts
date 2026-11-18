/**
 * authority 集成测试共享的两个小模块、对白样例与带真实存储的用例包装器。
 * 依赖 authority、SQLite 测试助手与公共契约；测试文件只声明场景与断言。
 * 禁止在这里放宽断言或共享测试之间的数据库状态。
 */
import type { Json } from "@ai-npc/contracts";
import type { RuleContributor } from "@ai-npc/authority";
import type { ApprovedSpeech } from "@ai-npc/module-sdk";
import {
  createAuthorityHarness,
  type AuthorityHarness,
  type AuthorityHarnessOptions,
} from "./authority-support";

export interface TestState {
  failOnEventCount: number | null;
}

export const speechArtifactRef = "art-000000000000";

export function approvedSpeechFixture(overrides: Partial<ApprovedSpeech> = {}): ApprovedSpeech {
  return {
    text: "我会处理。",
    agentId: "npc-wenyuan",
    turnId: "turn-000000000000",
    branchId: "br-000000000000",
    audience: ["npc-cenyuan"],
    channel: "dialogue",
    approved: true,
    ...overrides,
  };
}

function incrementCounter(context: {
  readonly tx: {
    get<T>(type: string, id: string): { readonly state: T } | null;
    put(type: string, id: string, state: Json): void;
  };
}): number {
  const current = context.tx.get<{ readonly count: number }>("counter", "counter");
  const count = (current?.state.count ?? 0) + 1;
  context.tx.put("counter", "counter", { count });
  return count;
}

export function counterModule(state: TestState): RuleContributor {
  return {
    moduleId: "test.counter",
    ownsAggregates: ["counter", "consumed", "job-log"],
    commands: [
      {
        type: "task.cancel",
        handler: (context, payload) => {
          const taskId = (payload as { readonly taskId: string }).taskId;
          if (taskId === "task-000000000004") {
            return { kind: "rejected", reasonCode: "task-not-cancellable", safeMessage: "测试拒绝" };
          }
          const count = incrementCounter(context);
          context.tx.emit("TestCounterChanged", { count, taskId }, [{ kind: "public" }]);
          if (taskId === "task-000000000007") {
            context.tx.put("audit", "audit-1", { lastTaskId: taskId });
          }
          if (taskId === "task-000000000008") {
            context.tx.schedule("test.job", 5, "test-duplicate", { taskId });
            context.tx.schedule("test.job", 5, "test-duplicate", { taskId });
          } else if (taskId === "task-000000000009") {
            context.tx.schedule("test.job", 5, `test-job:${taskId}`, { taskId });
            context.tx.cancelJobs("test-job:");
          } else if (taskId === "task-000000000010") {
            context.tx.schedule("test.job", 9, `test-job:${taskId}`, { taskId });
          } else {
            context.tx.schedule("test.job", 5, `test-job:${taskId}`, { taskId });
          }
          return { kind: "accepted", result: { count } };
        },
      },
      {
        type: "campaign.start",
        handler: (context) => {
          const count = incrementCounter(context);
          context.tx.emit("TestCampaignStarted", { count }, [{ kind: "public" }]);
          return { kind: "accepted", result: { count } };
        },
      },
      {
        type: "speech.commit",
        handler: (context, payload) => {
          const input = payload as unknown as {
            readonly approvedSpeechArtifactRef: string;
            readonly audience: readonly string[];
          };
          context.tx.emit(
            "TestSpeechSubmitted",
            { artifactRef: input.approvedSpeechArtifactRef },
            [{ kind: "principals", ids: [...input.audience] }],
          );
          return { kind: "accepted" };
        },
      },
    ],
    jobs: [
      {
        kind: "test.job",
        handler: (context, job) => {
          const taskId = (job.payload as { readonly taskId: string }).taskId;
          if (taskId === "task-000000000011") {
            throw new Error("simulated job failure");
          }
          const current = context.tx.get<{ readonly order: readonly string[] }>("job-log", "job-log");
          context.tx.put("job-log", "job-log", { order: [...(current?.state.order ?? []), taskId] });
        },
      },
    ],
    consumers: [
      {
        consumerId: "counter-events",
        eventTypes: ["TestCounterChanged"],
        handler: (context, event) => {
          const payload = event.payload as { readonly count: number };
          const current = context.tx.get<{ readonly count: number }>("consumed", "consumed");
          const count = (current?.state.count ?? 0) + 1;
          context.tx.put("consumed", "consumed", { count });
          if (state.failOnEventCount === payload.count) {
            throw new Error("simulated consumer crash");
          }
        },
      },
    ],
  };
}

export function auditModule(): RuleContributor {
  return {
    moduleId: "test.audit",
    ownsAggregates: ["audit"],
    afterCommands: [
      {
        type: "task.cancel",
        hook: (context, payload) => {
          const taskId = (payload as { readonly taskId: string }).taskId;
          context.tx.put("audit", "audit-1", { lastTaskId: taskId });
          if (taskId === "task-000000000006") {
            return { kind: "rejected", reasonCode: "invalid-params", safeMessage: "后续钩子拒绝" };
          }
          return { kind: "accepted" };
        },
      },
    ],
    clockSteps: [
      {
        stepId: "audit-daily",
        when: (tick) => tick % 24 === 0,
        handler: (context, tick) => {
          context.tx.put("audit", "daily", { tick });
        },
      },
    ],
  };
}

export async function withHarness(
  run: (harness: AuthorityHarness, state: TestState) => Promise<void>,
  options: AuthorityHarnessOptions = {},
): Promise<void> {
  const harness = await createAuthorityHarness(options);
  const state: TestState = { failOnEventCount: null };
  harness.authority.registerModule(counterModule(state));
  harness.authority.registerModule(auditModule());
  try {
    await run(harness, state);
  } finally {
    await harness.dispose();
  }
}
