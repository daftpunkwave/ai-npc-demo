/**
 * 实现协议查询端口：协议视图与截至指定 tick 的履约/违约计数。
 * 依赖协议聚合、scoped WorldTx，以及行动/通信/世界聚合的只读事实视图。
 * 禁止在查询中改写协议、执行条款校验或触发履约事件。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将泛型查询结果误判为 any。 */
import { taskTypeSchema, watergateAllocationSchema, type WatergateAllocation } from "@ai-npc/contracts";
import {
  gameModuleIds,
  type AgreementCounts,
  type AgreementView,
  type GameAgreementsPort,
  type ScopedWorldTxFactory,
  type ShareQuery,
  type TaskView,
} from "@ai-npc/module-sdk";
import { z } from "zod";
import { isAgreementSatisfied, type FulfillmentFacts } from "./fulfillment";
import { readAgreementState, type AgreementState } from "./state";

/**
 * 查询端口只能拿到按模块划分的事务，没有其他模块的 typed port；
 * 因此按通信→世界读取角色位置的同一方式，以最小 schema 读取他人已提交的聚合字段，
 * 只读不写，也不复制对方的完整状态定义。
 */
const committedTaskSchema = z.object({
  taskId: z.string().min(1),
  taskType: taskTypeSchema,
  teamId: z.string().min(1),
  dispatcherId: z.string().min(1),
  participants: z.array(z.string().min(1)),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  params: z.unknown(),
  completedAtTick: z.number().int().nonnegative().nullable(),
});

const committedShareSchema = z.object({
  shareId: z.string().min(1),
  fromId: z.string().min(1),
  evidenceId: z.string().min(1),
  audience: z.array(z.string().min(1)),
  sharedAtTick: z.number().int().nonnegative(),
});

const teamOwnerSchema = z.object({
  teamId: z.string().min(1),
  ownerFactionId: z.string().min(1),
});

const watergateMetersSchema = z.object({
  "watergate.allocation": watergateAllocationSchema,
});

const roadStateSchema = z.object({
  roadId: z.string().min(1),
  status: z.enum(["open", "restricted", "closed"]),
});

/** 水闸指标聚合的固定 ID；没有该记录时按「世界尚未初始化」处理。 */
const METERS_AGGREGATE_ID = "meters";

function toView(state: AgreementState): AgreementView {
  return {
    agreementId: state.agreementId,
    status: state.status,
    parties: state.parties,
  };
}

/** 协议查询实现；统计时只读取当前事务内已提交的事实。 */
class StandardAgreementsPort implements GameAgreementsPort {
  private readonly txFor: ScopedWorldTxFactory;

  constructor(txFor: ScopedWorldTxFactory) {
    this.txFor = txFor;
  }

  private tx() {
    return this.txFor(gameModuleIds.agreements);
  }

  agreement(agreementId: string): AgreementView | null {
    const state = readAgreementState(this.tx(), agreementId);
    return state === null ? null : toView(state);
  }

  agreementsOf(principalId: string): readonly AgreementView[] {
    return this.tx()
      .list<AgreementState>("agreement")
      .map((entry) => entry.state)
      .filter((state) => state.parties.includes(principalId))
      .map(toView);
  }

  activeAgreements(): readonly AgreementView[] {
    return this.tx()
      .list<AgreementState>("agreement")
      .map((entry) => entry.state)
      .filter((state) => state.status === "active")
      .map(toView);
  }

  /**
   * 截至 `tick` 的同步统计：有违约记录或义务期内已违反持续义务的协议计一次违约；
   * 其余按生效后的已提交事实复核全部条款，全部满足才计为履约；
   * 未生效、仍有未满足条款或已关闭的提案不计。不读取消费进度，因此消费者滞后也能得到正确结果。
   */
  countsAsOf(tick: number): AgreementCounts {
    const facts = this.fulfillmentFacts();
    let fulfilled = 0;
    let breached = 0;
    for (const entry of this.tx().list<AgreementState>("agreement")) {
      const state = entry.state;
      if (state.activatedAtTick === null || state.activatedAtTick > tick) {
        continue;
      }
      // 政策事件尚未被消费者处理时，义务期内的水闸/道路状态也要在同一 tick 计入违约。
      if (state.breachedTerms.length > 0 || this.sustainedObligationViolated(state, tick)) {
        breached += 1;
        continue;
      }
      if (isAgreementSatisfied(state, facts, tick)) {
        fulfilled += 1;
      }
    }
    return { fulfilled, breached };
  }

  /**
   * 仍处于义务期的通行/水闸条款按当前世界状态复核：水闸分配不等于条款值或道路关闭即为违约。
   * 章节评估先于政策消费者运行时，这里直接给出已提交状态对应的违约，不依赖异步事件累计。
   */
  private sustainedObligationViolated(state: AgreementState, tick: number): boolean {
    const openTerms = state.terms.filter(
      (term) => (term.kind === "water-allocation" || term.kind === "grant-passage") && term.untilTick >= tick,
    );
    if (openTerms.length === 0) {
      return false;
    }
    const allocation = this.watergateAllocation();
    return openTerms.some((term) => {
      if (term.kind === "water-allocation") {
        return allocation !== null && allocation !== term.policy;
      }
      return term.kind === "grant-passage" && this.roadClosed(term.roadId);
    });
  }

  /** 当前水闸分配；世界聚合尚未初始化时返回 null，按「无法判定违约」处理。 */
  private watergateAllocation(): WatergateAllocation | null {
    const record = this.txFor(gameModuleIds.world).get<unknown>("meters", METERS_AGGREGATE_ID);
    if (record === null) {
      return null;
    }
    const parsed = watergateMetersSchema.safeParse(record.state);
    return parsed.success ? parsed.data["watergate.allocation"] : null;
  }

  /** 道路是否已关闭；没有状态记录时沿用内容包初始状态，按「未关闭」处理。 */
  private roadClosed(roadId: string): boolean {
    const record = this.txFor(gameModuleIds.map).get<unknown>("road", roadId);
    if (record === null) {
      return false;
    }
    const parsed = roadStateSchema.safeParse(record.state);
    return parsed.success && parsed.data.status === "closed";
  }

  /** 已完成任务视图；只取 status 为 completed 且带完成 tick 的记录，字段无法解析的按「不是已提交事实」跳过。 */
  private committedTasks(): readonly TaskView[] {
    const tasks: TaskView[] = [];
    for (const entry of this.txFor(gameModuleIds.actions).list<unknown>("task")) {
      const parsed = committedTaskSchema.safeParse(entry.state);
      if (parsed.success && parsed.data.status === "completed") {
        tasks.push(parsed.data);
      }
    }
    return tasks;
  }

  /** 已提交的证据分享；字段无法解析的记录按「不是已提交事实」跳过。 */
  private committedShares(): readonly z.infer<typeof committedShareSchema>[] {
    const shares: z.infer<typeof committedShareSchema>[] = [];
    for (const entry of this.txFor(gameModuleIds.comms).list<unknown>("share")) {
      const parsed = committedShareSchema.safeParse(entry.state);
      if (parsed.success) {
        shares.push(parsed.data);
      }
    }
    return shares;
  }

  /** 队伍所属派系；世界聚合里没有该队伍时返回 null。 */
  private teamOwners(): ReadonlyMap<string, string> {
    const owners = new Map<string, string>();
    for (const entry of this.txFor(gameModuleIds.world).list<unknown>("team")) {
      const parsed = teamOwnerSchema.safeParse(entry.state);
      if (parsed.success) {
        owners.set(parsed.data.teamId, parsed.data.ownerFactionId);
      }
    }
    return owners;
  }

  private fulfillmentFacts(): FulfillmentFacts {
    const shares = this.committedShares();
    const teams = this.teamOwners();
    return {
      completedTasks: this.committedTasks(),
      hasShare: (query: ShareQuery) =>
        shares.some(
          (share) =>
            share.fromId === query.fromId &&
            share.evidenceId === query.evidenceId &&
            share.audience.includes(query.toPrincipalId) &&
            share.sharedAtTick >= query.sinceTick &&
            share.sharedAtTick <= query.byTick,
        ),
      factionOfTeam: (teamId) => teams.get(teamId) ?? null,
    };
  }
}

/** 构造绑定到当前事务的协议端口。 */
export function createAgreementsPort(txFor: ScopedWorldTxFactory): GameAgreementsPort {
  return new StandardAgreementsPort(txFor);
}
