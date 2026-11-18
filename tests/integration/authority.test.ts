/**
 * authority 集成测试：幂等 receipt、保存点回滚、版本冲突、暂停、job 顺序、消费者恢复与 fencing。
 * 依赖真实 SQLite 测试助手、两个测试模块与公共契约命令；不依赖游戏内容或真实模型。
 * 禁止放宽断言来掩盖未回滚的写入、重复处理或错误的原因码。
 */
import { describe, expect, it } from "vitest";
import type { Json } from "@ai-npc/contracts";
import type { RuleContributor } from "@ai-npc/authority";
import type { ApprovedSpeech } from "@ai-npc/module-sdk";
import {
  agentAuth,
  commandEnvelope,
  countBranchRows,
  createAuthorityHarness,
  deleteConsumerOffset,
  expectDomainCode,
  playerAuth,
  readAggregate,
  setClock,
  seedAgentController,
  seedTurnRun,
  taskCancelEnvelope,
  campaignStartEnvelope,
  type AuthorityHarness,
  type AuthorityHarnessOptions,
} from "./authority-support";

interface TestState {
  failOnEventCount: number | null;
}

const speechArtifactRef = "art-000000000000";

function approvedSpeechFixture(overrides: Partial<ApprovedSpeech> = {}): ApprovedSpeech {
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

function counterModule(state: TestState): RuleContributor {
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

function auditModule(): RuleContributor {
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

async function withHarness(
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

describe("authority command gateway", () => {
  it("returns the stored receipt for the same command and applies it once", async () => {
    await withHarness(async (harness) => {
      const envelope = taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000001");
      const first = harness.authority.commands.execute(playerAuth(harness), envelope);
      expect(first.commandStatus).toBe("accepted");
      expect(first.acceptedEventIds).toHaveLength(1);
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });

      const second = harness.authority.commands.execute(playerAuth(harness), envelope);
      expect(second).toEqual(first);
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });
      expect(countBranchRows(harness, "command_receipts")).toBe(1);
      expect(countBranchRows(harness, "domain_events")).toBe(1);
    });
  });

  it("rejects a reused commandId with a different payload", async () => {
    await withHarness(async (harness) => {
      const commandId = "cmd-000000000002";
      const first = harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", commandId),
      );
      expect(first.commandStatus).toBe("accepted");
      const conflict = harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000002", commandId),
      );
      expect(conflict.commandStatus).toBe("rejected");
      expect(conflict.reasonCode).toBe("idempotency-conflict");
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });
      expect(countBranchRows(harness, "command_receipts")).toBe(1);
    });
  });

  it("writes only a rejected receipt when the handler rejects", async () => {
    await withHarness(async (harness) => {
      const receipt = harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000004", "cmd-000000000003"),
      );
      expect(receipt.commandStatus).toBe("rejected");
      expect(receipt.reasonCode).toBe("task-not-cancellable");
      expect(receipt.acceptedEventIds).toEqual([]);
      expect(readAggregate(harness, "counter", "counter")).toBeNull();
      expect(countBranchRows(harness, "domain_events")).toBe(0);
      expect(countBranchRows(harness, "jobs")).toBe(0);
      expect(countBranchRows(harness, "command_receipts")).toBe(1);
    });
  });

  it("rolls back all writes and leaves no receipt when a handler throws", async () => {
    await withHarness(async (harness) => {
      expectDomainCode(
        () =>
          harness.authority.commands.execute(
            playerAuth(harness),
            taskCancelEnvelope(harness, "task-000000000007", "cmd-000000000004"),
          ),
        "forbidden",
      );
      expect(readAggregate(harness, "counter", "counter")).toBeNull();
      expect(countBranchRows(harness, "domain_events")).toBe(0);
      expect(countBranchRows(harness, "jobs")).toBe(0);
      expect(countBranchRows(harness, "command_receipts")).toBe(0);
    });
  });

  it("rejects expectedVersions mismatches and reports resulting versions on success", async () => {
    await withHarness(async (harness) => {
      harness.storage.transact((tx) => {
        tx.branch(harness.branchId)
          .table("aggregate_state")
          .put({ aggregate_type: "counter", aggregate_id: "counter", version: 2, state_json: { count: 5 } });
      });
      const conflict = harness.authority.commands.execute(
        playerAuth(harness),
        commandEnvelope("task.cancel", { taskId: "task-000000000001" }, "cmd-000000000005", {
          "counter:counter": 1,
        }),
      );
      expect(conflict.commandStatus).toBe("rejected");
      expect(conflict.reasonCode).toBe("version-conflict");
      expect(readAggregate(harness, "counter", "counter")).toEqual({ version: 2, state: { count: 5 } });

      const accepted = harness.authority.commands.execute(
        playerAuth(harness),
        commandEnvelope("task.cancel", { taskId: "task-000000000002" }, "cmd-000000000006", {
          "counter:counter": 2,
        }),
      );
      expect(accepted.commandStatus).toBe("accepted");
      expect(accepted.resultingVersions).toEqual({ "counter:counter": 3, "audit:audit-1": 1 });
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 6 });
    });
  });

  it("rolls back the handler and after-command writes when a hook rejects", async () => {
    await withHarness(async (harness) => {
      const receipt = harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000006", "cmd-000000000007"),
      );
      expect(receipt.commandStatus).toBe("rejected");
      expect(receipt.reasonCode).toBe("invalid-params");
      expect(readAggregate(harness, "counter", "counter")).toBeNull();
      expect(readAggregate(harness, "audit", "audit-1")).toBeNull();
      expect(countBranchRows(harness, "domain_events")).toBe(0);
      expect(countBranchRows(harness, "jobs")).toBe(0);
    });
  });

  it("rejects ordinary commands while paused but accepts campaign.start", async () => {
    await withHarness(async (harness) => {
      setClock(harness, { worldTick: 3, mode: "paused" });
      const rejected = harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000008"),
      );
      expect(rejected.commandStatus).toBe("rejected");
      expect(rejected.reasonCode).toBe("paused");
      expect(rejected.worldTick).toBe(3);
      expect(readAggregate(harness, "counter", "counter")).toBeNull();

      const accepted = harness.authority.commands.execute(
        playerAuth(harness),
        campaignStartEnvelope(harness, "cmd-000000000009"),
      );
      expect(accepted.commandStatus).toBe("accepted");
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });
    });
  });

  it("rejects agent commands without fencing unless the test switch is on", async () => {
    await withHarness(async (harness) => {
      const rejected = harness.authority.commands.execute(
        agentAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000010"),
      );
      expect(rejected.commandStatus).toBe("rejected");
      expect(rejected.reasonCode).toBe("stale-controller");
      expect(readAggregate(harness, "counter", "counter")).toBeNull();
    });
    await withHarness(
      async (harness) => {
        const accepted = harness.authority.commands.execute(
          agentAuth(harness),
          taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000011"),
        );
        expect(accepted.commandStatus).toBe("accepted");
        expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });
      },
      { allowDirectAgentCommands: true },
    );
  });

  it("consumes each approved speech artifact at most once", async () => {
    await withHarness(
      async (harness) => {
        const payload = {
          channel: "dialogue" as const,
          conversationId: null,
          audience: ["npc-cenyuan"],
          approvedSpeechArtifactRef: speechArtifactRef,
          intentKind: "none" as const,
          replyToId: null,
        };
        const first = harness.authority.commands.execute(
          agentAuth(harness),
          commandEnvelope("speech.commit", payload, "cmd-000000000012"),
        );
        expect(first.commandStatus).toBe("accepted");
        expect(countBranchRows(harness, "speech_commits")).toBe(1);
        expect(countBranchRows(harness, "domain_events")).toBe(1);

        const duplicate = harness.authority.commands.execute(
          agentAuth(harness),
          commandEnvelope("speech.commit", payload, "cmd-000000000013"),
        );
        expect(duplicate.commandStatus).toBe("rejected");
        expect(duplicate.reasonCode).toBe("speech-not-approved");
        expect(countBranchRows(harness, "speech_commits")).toBe(1);
        expect(countBranchRows(harness, "domain_events")).toBe(1);
      },
      {
        allowDirectAgentCommands: true,
        approvedSpeech: { read: () => approvedSpeechFixture() },
      },
    );
  });

  it("rejects an unapproved speech artifact before any world write", async () => {
    await withHarness(
      async (harness) => {
        const payload = {
          channel: "dialogue" as const,
          conversationId: null,
          audience: ["npc-cenyuan"],
          approvedSpeechArtifactRef: speechArtifactRef,
          intentKind: "none" as const,
          replyToId: null,
        };
        const receipt = harness.authority.commands.execute(
          agentAuth(harness),
          commandEnvelope("speech.commit", payload, "cmd-000000000017"),
        );
        expect(receipt.commandStatus).toBe("rejected");
        expect(receipt.reasonCode).toBe("speech-not-approved");
        expect(countBranchRows(harness, "speech_commits")).toBe(0);
        expect(countBranchRows(harness, "domain_events")).toBe(0);
      },
      {
        allowDirectAgentCommands: true,
        approvedSpeech: { read: () => approvedSpeechFixture({ approved: false }) },
      },
    );
  });

  it("runs host after-command hooks after module hooks", async () => {
    await withHarness(async (harness) => {
      const order: string[] = [];
      harness.authority.afterCommand("test.counter", "task.cancel", () => {
        order.push("module");
        return { kind: "accepted" };
      });
      harness.authority.hostAfterCommand("host.test", "task.cancel", () => {
        order.push("host");
        return { kind: "accepted" };
      });
      const receipt = harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000016"),
      );
      expect(receipt.commandStatus).toBe("accepted");
      expect(order).toEqual(["module", "host"]);
    });
  });

  it("accepts a live turn lease and rejects a terminal turn", async () => {
    await withHarness(async (harness) => {
      seedAgentController(harness, "npc-wenyuan", 2, "agent");
      seedTurnRun(harness, "turn-000000000001", "npc-wenyuan", 2, 2, "executing");
      const auth = agentAuth(harness, {
        controllerEpoch: 2,
        turnLeaseEpoch: 2,
        turnId: "turn-000000000001",
      });
      const accepted = harness.authority.commands.execute(
        auth,
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000014"),
      );
      expect(accepted.commandStatus).toBe("accepted");
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });

      seedTurnRun(harness, "turn-000000000001", "npc-wenyuan", 2, 2, "completed");
      const rejected = harness.authority.commands.execute(
        auth,
        taskCancelEnvelope(harness, "task-000000000002", "cmd-000000000015"),
      );
      expect(rejected.commandStatus).toBe("rejected");
      expect(rejected.reasonCode).toBe("stale-turn");
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });
    });
  });

  it("rejects expired controller and turn leases", async () => {
    await withHarness(async (harness) => {
      const expiredAt = "2025-01-01T00:00:00.000Z";
      seedAgentController(harness, "npc-wenyuan", 2, "agent", expiredAt);
      const auth = agentAuth(harness, {
        controllerEpoch: 2,
        turnLeaseEpoch: 2,
        turnId: "turn-000000000002",
      });
      const expiredController = harness.authority.commands.execute(
        auth,
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000018"),
      );
      expect(expiredController.commandStatus).toBe("rejected");
      expect(expiredController.reasonCode).toBe("stale-controller");

      seedAgentController(harness, "npc-wenyuan", 2, "agent");
      seedTurnRun(harness, "turn-000000000002", "npc-wenyuan", 2, 2, "executing", expiredAt);
      const expiredTurn = harness.authority.commands.execute(
        auth,
        taskCancelEnvelope(harness, "task-000000000002", "cmd-000000000019"),
      );
      expect(expiredTurn.commandStatus).toBe("rejected");
      expect(expiredTurn.reasonCode).toBe("stale-turn");
      expect(readAggregate(harness, "counter", "counter")).toBeNull();
    });
  });

  it("rejects duplicate module and command registrations", async () => {
    await withHarness(async (harness) => {
      expectDomainCode(
        () => harness.authority.registerModule({ moduleId: "test.counter", ownsAggregates: [] }),
        "assembly-incompatible",
      );
      expectDomainCode(
        () =>
          harness.authority.registerModule({
            moduleId: "test.extra",
            ownsAggregates: [],
            commands: [{ type: "task.cancel", handler: () => ({ kind: "accepted" }) }],
          }),
        "assembly-incompatible",
      );
    });
  });
});

describe("authority job runner", () => {
  it("runs due jobs by (dueTick, seq) and is idempotent", async () => {
    await withHarness(async (harness) => {
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000020"),
      );
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000002", "cmd-000000000021"),
      );
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000010", "cmd-000000000022"),
      );
      setClock(harness, { worldTick: 5, mode: "running" });
      expect(harness.authority.jobs.runDue(harness.branchId, 5)).toBe(2);
      expect(readAggregate(harness, "job-log", "job-log")?.state).toEqual({
        order: ["task-000000000001", "task-000000000002"],
      });
      expect(harness.authority.jobs.runDue(harness.branchId, 5)).toBe(0);
      setClock(harness, { worldTick: 9, mode: "running" });
      expect(harness.authority.jobs.runDue(harness.branchId, 9)).toBe(1);
      expect(readAggregate(harness, "job-log", "job-log")?.state).toEqual({
        order: ["task-000000000001", "task-000000000002", "task-000000000010"],
      });
    });
  });

  it("deduplicates schedule keys and honors cancellation", async () => {
    await withHarness(async (harness) => {
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000008", "cmd-000000000023"),
      );
      expect(countBranchRows(harness, "jobs", { status: "scheduled" })).toBe(1);
      setClock(harness, { worldTick: 5, mode: "running" });
      expect(harness.authority.jobs.runDue(harness.branchId, 5)).toBe(1);

      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000009", "cmd-000000000024"),
      );
      expect(countBranchRows(harness, "jobs", { status: "cancelled" })).toBe(1);
      expect(harness.authority.jobs.runDue(harness.branchId, 5)).toBe(0);
    });
  });

  it("rolls back a failed job and keeps it scheduled", async () => {
    await withHarness(async (harness) => {
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000011", "cmd-000000000025"),
      );
      setClock(harness, { worldTick: 5, mode: "running" });
      expect(() => harness.authority.jobs.runDue(harness.branchId, 5)).toThrow("simulated job failure");
      expect(countBranchRows(harness, "jobs", { status: "scheduled" })).toBe(1);
      expect(readAggregate(harness, "job-log", "job-log")).toBeNull();
    });
  });
});

describe("authority event consumers", () => {
  it("resumes after a handler crash without duplicating committed events", async () => {
    await withHarness(async (harness, state) => {
      state.failOnEventCount = 2;
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000030"),
      );
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000002", "cmd-000000000031"),
      );
      expect(() => harness.authority.consumers.run(harness.branchId)).toThrow("simulated consumer crash");
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 1 });

      state.failOnEventCount = null;
      const resumed = harness.authority.consumers.run(harness.branchId);
      expect(resumed.processed).toBe(1);
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 2 });
      expect(harness.authority.consumers.run(harness.branchId)).toEqual({ processed: 0, scanned: 0 });
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 2 });
    });
  });

  it("uses the inbox to avoid reprocessing when the offset is lost", async () => {
    await withHarness(async (harness) => {
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000032"),
      );
      expect(harness.authority.consumers.run(harness.branchId).processed).toBe(1);
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 1 });
      deleteConsumerOffset(harness, "counter-events");
      const replay = harness.authority.consumers.run(harness.branchId);
      expect(replay.processed).toBe(0);
      expect(replay.scanned).toBe(1);
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 1 });
    });
  });

  it("continues from the next existing worldSeq when the log has a gap", async () => {
    await withHarness(async (harness) => {
      harness.authority.commands.execute(
        playerAuth(harness),
        taskCancelEnvelope(harness, "task-000000000001", "cmd-000000000033"),
      );
      expect(harness.authority.consumers.run(harness.branchId).processed).toBe(1);
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 1 });

      harness.storage.transact((tx) => {
        tx.branch(harness.branchId)
          .table("domain_events")
          .put({
            world_seq: 3,
            event_id: "evt-000000000003",
            world_tick: 0,
            type: "TestCounterChanged",
            schema_version: 1,
            principal_id: "player-1",
            causation_ids_json: [],
            correlation_id: "test-gap",
            audience_json: [{ kind: "public" }],
            payload_json: { count: 3, taskId: "task-000000000003" },
            committed_at: harness.host.nowIso(),
          });
      });
      const resumed = harness.authority.consumers.run(harness.branchId);
      expect(resumed.processed).toBe(1);
      expect(resumed.scanned).toBe(1);
      expect(readAggregate(harness, "consumed", "consumed")?.state).toEqual({ count: 2 });
    });
  });
});

describe("authority clock steps", () => {
  it("runs registered clock steps only on matching ticks", async () => {
    await withHarness(async (harness) => {
      setClock(harness, { worldTick: 24, mode: "running" });
      expect(harness.authority.clock.run(harness.branchId)).toBe(1);
      expect(readAggregate(harness, "audit", "daily")?.state).toEqual({ tick: 24 });
      setClock(harness, { worldTick: 25, mode: "running" });
      expect(harness.authority.clock.run(harness.branchId)).toBe(0);
    });
  });
});
