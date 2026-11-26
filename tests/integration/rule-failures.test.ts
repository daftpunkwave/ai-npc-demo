/**
 * 验证规则执行器的有界重试与死信隔离：job、事件消费者与时钟步骤失败后不永久阻塞后续工作。
 * 依赖真实 SQLite 存储、authority 执行器与测试宿主；每个用例使用独立数据目录。
 * 禁止用内存夹具替代事务回滚，也禁止跳过失败记录直接断言队列继续推进。
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_RULE_ATTEMPTS, listRuleFailures } from "@ai-npc/authority";
import {
  createAuthorityHarness,
  readAggregate,
  type AuthorityHarness,
} from "./authority-support";

const harnesses: AuthorityHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.dispose()));
});

async function createHarness(): Promise<AuthorityHarness> {
  const harness = await createAuthorityHarness();
  harnesses.push(harness);
  return harness;
}

/** 读取分支 job 的关键列，按 jobId 排序便于断言。 */
interface JobRow {
  readonly jobId: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

function readJobs(harness: AuthorityHarness): readonly JobRow[] {
  return harness.storage.transact((tx) =>
    tx
      .branch(harness.branchId)
      .table("jobs")
      .list({}, { orderBy: [{ column: "job_id" }] })
      .map((row) => ({
        jobId: String(row["job_id"]),
        status: String(row["status"]),
        attempts: Number(row["attempts"]),
        lastError: typeof row["last_error"] === "string" ? row["last_error"] : null,
      })),
  );
}

/** 写入一条最小的领域事件，供消费者失败用例驱动 offset。 */
function seedDomainEvent(
  harness: AuthorityHarness,
  worldSeq: number,
  eventId: string,
  type: string,
): void {
  harness.storage.transact((tx) => {
    tx.branch(harness.branchId)
      .table("domain_events")
      .put({
        world_seq: worldSeq,
        event_id: eventId,
        world_tick: 0,
        type,
        schema_version: 1,
        principal_id: "system:world",
        causation_ids_json: [],
        correlation_id: "corr-000000000001",
        audience_json: [{ kind: "principals", ids: ["player-1"] }],
        payload_json: {},
        committed_at: "2026-01-01T00:00:00.000Z",
      });
  });
}

/** 注册一个持续失败的 job 处理器与一个正常 job，验证毒丸不阻塞后续队列。 */
describe("job 失败隔离", () => {
  it("达到重试上限后标记 failed，后续 job 仍在同一轮执行", async () => {
    const harness = await createHarness();
    const executed: string[] = [];
    harness.authority.registerModule({
      moduleId: "test.rule-failure-jobs",
      ownsAggregates: [],
      jobs: [
        {
          kind: "test.poison-job",
          handler: () => {
            throw new Error("注入毒丸 job");
          },
        },
        {
          kind: "test.follow-job",
          handler: (_context, job) => {
            executed.push(job.jobId);
          },
        },
      ],
    });
    harness.storage.transact((tx) => {
      const table = tx.branch(harness.branchId).table("jobs");
      table.put({
        job_id: "job-poison",
        seq: 1,
        kind: "test.poison-job",
        due_tick: 0,
        status: "scheduled",
        idempotency_key: "test-poison-key",
        payload_json: {},
        attempts: 0,
        last_error: null,
      });
      table.put({
        job_id: "job-follow",
        seq: 2,
        kind: "test.follow-job",
        due_tick: 0,
        status: "scheduled",
        idempotency_key: "test-follow-key",
        payload_json: {},
        attempts: 0,
        last_error: null,
      });
    });

    // 未达上限时向宿主传播原始错误并停止推进，与“失败即停止”的既有语义一致。
    for (let attempt = 1; attempt < MAX_RULE_ATTEMPTS; attempt += 1) {
      expect(() => harness.authority.jobs.runDue(harness.branchId, 0)).toThrow("注入毒丸 job");
      const poison = readJobs(harness).find((job) => job.jobId === "job-poison");
      expect(poison).toMatchObject({ status: "scheduled", attempts: attempt });
    }

    const settled = harness.authority.jobs.runDue(harness.branchId, 0);
    expect(settled).toBe(2);
    expect(executed).toEqual(["job-follow"]);
    const jobs = readJobs(harness);
    expect(jobs.find((job) => job.jobId === "job-poison")).toMatchObject({
      status: "failed",
      attempts: MAX_RULE_ATTEMPTS,
    });
    expect(jobs.find((job) => job.jobId === "job-poison")?.lastError).toContain(
      "注入毒丸 job",
    );
    expect(jobs.find((job) => job.jobId === "job-follow")).toMatchObject({ status: "done" });

    const failures = listRuleFailures(harness.storage, harness.branchId);
    expect(failures).toEqual([
      expect.objectContaining({
        phase: "job",
        subjectId: "job-poison",
        attempts: MAX_RULE_ATTEMPTS,
        reasonCode: "plugin-failed",
        status: "failed",
      }),
    ]);
  });

  it("处理器恢复后清除失败记录，job 只执行一次", async () => {
    const harness = await createHarness();
    let remainingFailures = 1;
    let executions = 0;
    harness.authority.registerModule({
      moduleId: "test.rule-failure-recovery",
      ownsAggregates: [],
      jobs: [
        {
          kind: "test.recovering-job",
          handler: () => {
            executions += 1;
            if (remainingFailures > 0) {
              remainingFailures -= 1;
              throw new Error("首次执行失败");
            }
          },
        },
      ],
    });
    harness.storage.transact((tx) => {
      tx.branch(harness.branchId).table("jobs").put({
        job_id: "job-recovering",
        seq: 1,
        kind: "test.recovering-job",
        due_tick: 0,
        status: "scheduled",
        idempotency_key: "test-recovering-key",
        payload_json: {},
        attempts: 0,
        last_error: null,
      });
    });

    expect(() => harness.authority.jobs.runDue(harness.branchId, 0)).toThrow("首次执行失败");
    expect(listRuleFailures(harness.storage, harness.branchId)).toEqual([
      expect.objectContaining({ phase: "job", status: "retrying" }),
    ]);

    expect(harness.authority.jobs.runDue(harness.branchId, 0)).toBe(1);
    expect(executions).toBe(2);
    expect(readJobs(harness).find((job) => job.jobId === "job-recovering")).toMatchObject({
      status: "done",
      attempts: 2,
      lastError: null,
    });
    expect(listRuleFailures(harness.storage, harness.branchId)).toEqual([]);
  });
});

/** 事件消费者失败后写 inbox、推进 offset，后续事件继续处理。 */
describe("事件消费者失败隔离", () => {
  it("达到重试上限后跳过毒丸事件，后续事件继续处理", async () => {
    const harness = await createHarness();
    const processed: string[] = [];
    harness.authority.registerModule({
      moduleId: "test.rule-failure-consumer",
      ownsAggregates: [],
      events: [{ type: "TestRuleEvent", payloadSchema: z.unknown() }],
      consumers: [
        {
          consumerId: "test.consumer",
          eventTypes: ["TestRuleEvent"],
          handler: (_context, event) => {
            if (event.eventId === "evt-0123456789ab") {
              throw new Error("注入毒丸事件");
            }
            processed.push(event.eventId);
          },
        },
      ],
    });
    seedDomainEvent(harness, 1, "evt-0123456789ab", "TestRuleEvent");
    seedDomainEvent(harness, 2, "evt-0123456789ac", "TestRuleEvent");

    for (let attempt = 1; attempt < MAX_RULE_ATTEMPTS; attempt += 1) {
      expect(() => harness.authority.consumers.run(harness.branchId)).toThrow("注入毒丸事件");
    }
    const result = harness.authority.consumers.run(harness.branchId);
    expect(result.processed).toBe(1);
    expect(processed).toEqual(["evt-0123456789ac"]);

    const offsets = harness.storage.transact((tx) =>
      tx.branch(harness.branchId).table("consumer_offsets").get({ consumer_id: "test.consumer" }),
    );
    expect(offsets).toMatchObject({ last_world_seq: 2 });
    const inbox = harness.storage.transact((tx) =>
      tx.branch(harness.branchId).table("consumer_inbox").list({ consumer_id: "test.consumer" }),
    );
    expect(inbox.map((row) => row["event_id"]).sort()).toEqual([
      "evt-0123456789ab",
      "evt-0123456789ac",
    ]);
    expect(listRuleFailures(harness.storage, harness.branchId)).toEqual([
      expect.objectContaining({
        phase: "event",
        subjectId: "test.consumer",
        detail: "evt-0123456789ab",
        status: "failed",
      }),
    ]);
  });

  it("处理器恢复后清除失败记录，事件只处理一次", async () => {
    const harness = await createHarness();
    let remainingFailures = 1;
    const processed: string[] = [];
    harness.authority.registerModule({
      moduleId: "test.rule-failure-consumer-recovery",
      ownsAggregates: [],
      events: [{ type: "TestRuleEvent", payloadSchema: z.unknown() }],
      consumers: [
        {
          consumerId: "test.recovering-consumer",
          eventTypes: ["TestRuleEvent"],
          handler: (_context, event) => {
            if (remainingFailures > 0) {
              remainingFailures -= 1;
              throw new Error("首次消费失败");
            }
            processed.push(event.eventId);
          },
        },
      ],
    });
    seedDomainEvent(harness, 1, "evt-0123456789ad", "TestRuleEvent");

    expect(() => harness.authority.consumers.run(harness.branchId)).toThrow("首次消费失败");
    expect(harness.authority.consumers.run(harness.branchId)).toMatchObject({ processed: 1 });
    expect(processed).toEqual(["evt-0123456789ad"]);
    expect(listRuleFailures(harness.storage, harness.branchId)).toEqual([]);
    expect(
      harness.storage.transact((tx) =>
        tx.branch(harness.branchId).table("consumer_offsets").get({ consumer_id: "test.recovering-consumer" }),
      ),
    ).toMatchObject({ last_world_seq: 1 });
  });
});

/** 消费者跳过不相关事件时不写游标：过滤下推到 SQL 后，游标只随真正处理的事件推进。 */
describe("消费者游标推进范围", () => {
  it("只订阅单一事件类型的消费者不因无关事件写入 offset", async () => {
    const harness = await createHarness();
    const processed: string[] = [];
    harness.authority.registerModule({
      moduleId: "test.filtered-consumer",
      ownsAggregates: [],
      events: [
        { type: "TestFilteredEvent", payloadSchema: z.unknown() },
        { type: "TestIgnoredEvent", payloadSchema: z.unknown() },
      ],
      consumers: [
        {
          consumerId: "test.filtered",
          eventTypes: ["TestFilteredEvent"],
          handler: (_context, event) => {
            processed.push(event.eventId);
          },
        },
      ],
    });
    seedDomainEvent(harness, 1, "evt-0123456789ae", "TestIgnoredEvent");
    seedDomainEvent(harness, 2, "evt-0123456789af", "TestIgnoredEvent");

    expect(harness.authority.consumers.run(harness.branchId)).toEqual({ processed: 0, scanned: 0 });
    expect(processed).toEqual([]);
    const offset = (): unknown =>
      harness.storage.transact((tx) =>
        tx.branch(harness.branchId).table("consumer_offsets").get({ consumer_id: "test.filtered" }),
      );
    expect(offset()).toBeNull();

    seedDomainEvent(harness, 3, "evt-0123456789ag", "TestFilteredEvent");
    expect(harness.authority.consumers.run(harness.branchId)).toEqual({ processed: 1, scanned: 1 });
    expect(processed).toEqual(["evt-0123456789ag"]);
    expect(offset()).toMatchObject({ last_world_seq: 3 });
  });
});

/** 时钟步骤失败达到上限后只跳过该 tick 的毒丸步骤，其他步骤继续执行。 */
describe("时钟步骤失败隔离", () => {
  it("达到重试上限后跳过毒丸步骤，同一 tick 的后续步骤仍执行", async () => {
    const harness = await createHarness();
    const executed: string[] = [];
    harness.authority.registerModule({
      moduleId: "test.rule-failure-clock",
      ownsAggregates: [],
      clockSteps: [
        {
          stepId: "test.poison-step",
          when: (tick) => tick === 0,
          handler: () => {
            throw new Error("注入毒丸时钟步骤");
          },
        },
        {
          stepId: "test.follow-step",
          when: (tick) => tick === 0,
          handler: () => {
            executed.push("test.follow-step");
          },
        },
      ],
    });

    for (let attempt = 1; attempt < MAX_RULE_ATTEMPTS; attempt += 1) {
      expect(() => harness.authority.clock.runDetailed(harness.branchId)).toThrow("注入毒丸时钟步骤");
      expect(executed).toEqual([]);
    }
    const settled = harness.authority.clock.runDetailed(harness.branchId);
    // 第三次尝试把毒丸步骤标记为死信，同一轮的后续步骤仍执行。
    expect(settled).toEqual({ executed: 2, stopRequested: false });
    expect(executed).toEqual(["test.follow-step"]);

    expect(listRuleFailures(harness.storage, harness.branchId)).toEqual([
      expect.objectContaining({
        phase: "clock-step",
        subjectId: "test.poison-step",
        detail: "0",
        status: "failed",
      }),
    ]);
    // 死信只作用于失败的 tick：后续 tick 不命中该步骤，不会影响正常推进。
    expect(harness.authority.clock.runDetailed(harness.branchId)).toEqual({
      executed: 1,
      stopRequested: false,
    });
  });
});

/** 规则执行失败不改变聚合状态：上一条 job 回滚后不留下半次结算。 */
describe("失败回滚", () => {
  it("job 处理器失败不提交任何聚合或事件", async () => {
    const harness = await createHarness();
    harness.authority.registerModule({
      moduleId: "test.rule-failure-rollback",
      ownsAggregates: ["testAggregate"],
      jobs: [
        {
          kind: "test.rollback-job",
          handler: (context) => {
            context.tx.put("testAggregate", "agg-1", { value: 1 });
            throw new Error("写入后失败");
          },
        },
      ],
    });
    harness.storage.transact((tx) => {
      tx.branch(harness.branchId).table("jobs").put({
        job_id: "job-rollback",
        seq: 1,
        kind: "test.rollback-job",
        due_tick: 0,
        status: "scheduled",
        idempotency_key: "test-rollback-key",
        payload_json: {},
        attempts: 0,
        last_error: null,
      });
    });

    expect(() => harness.authority.jobs.runDue(harness.branchId, 0)).toThrow("写入后失败");
    expect(readAggregate(harness, "testAggregate", "agg-1")).toBeNull();
    expect(harness.storage.transact((tx) => tx.branch(harness.branchId).table("domain_events").count())).toBe(0);
    expect(readJobs(harness).find((job) => job.jobId === "job-rollback")).toMatchObject({
      status: "scheduled",
      attempts: 1,
    });
  });
});
