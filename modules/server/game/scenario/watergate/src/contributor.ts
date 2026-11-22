/**
 * 注册剧情卡草稿、调度、触发、发布、撤回、补偿与覆盖，以及升级版剧情压力。
 * 依赖内容剧情、卡片状态、效果白名单、世界/行动端口与 authority 事务上下文。
 * 禁止调用角色模型、修改指标（覆盖除外）或重复触发同一卡片。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents, security/detect-object-injection -- Codacy 缺少 workspace 类型解析；卡片与指标键来自受限内容枚举。 */
import type { EventEnvelope, Json, OverrideEffect } from "@ai-npc/contracts";
import { commandPayloadOf } from "@ai-npc/contracts";
import {
  gameModuleIds,
  requireGameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import { applyCardEffects, applyOverrideEffects, invalidEffectReferences } from "./effects";
import {
  readCardState,
  readRunState,
  type ScenarioCardState,
  type ScenarioContamination,
  type ScenarioRunState,
} from "./state";

type ScenarioContext = HandlerContext<GameModulePorts, unknown>;

/** 发布窗口：触发 tick 必须晚于当前 tick，且不超过 168 tick 之后。 */
function isTriggerTickInWindow(triggerAtTick: number, worldTick: number): boolean {
  return triggerAtTick > worldTick && triggerAtTick <= worldTick + 168;
}

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

function scaledTick(cardTrigger: number, escalating: boolean): number {
  return escalating ? Math.floor(cardTrigger * 0.75) : cardTrigger;
}

function scenarioIdOf(context: ScenarioContext): string {
  return requireGameContent(context.content).defaultScenario;
}

function ensureRunState(context: ScenarioContext): ScenarioRunState {
  const scenarioId = scenarioIdOf(context);
  const existing = readRunState(context.tx, scenarioId);
  if (existing !== null) {
    return existing;
  }
  const created: ScenarioRunState = {
    scenarioId,
    repairCompleted: false,
    alarmTriggered: false,
    contaminated: false,
    contaminations: [],
  };
  context.tx.put("scenario-run", scenarioId, created);
  return created;
}

/** 在同一事务记录一次调试覆盖造成的污染；调用方负责效果先于记录写入。 */
function recordContamination(
  context: ScenarioContext,
  note: string,
  effects: readonly OverrideEffect[],
): void {
  const run = ensureRunState(context);
  const contamination: ScenarioContamination = {
    source: "scenario.override",
    note,
    tick: context.tx.worldTick,
    effects: [...effects],
  };
  context.tx.put("scenario-run", run.scenarioId, {
    ...run,
    contaminated: true,
    contaminations: [...run.contaminations, contamination],
  });
}

function scheduleCard(context: ScenarioContext, state: ScenarioCardState): void {
  context.tx.schedule("scenario.card", state.triggerAtTick, `scenario-card:${state.cardId}@${state.version}`, {
    cardId: state.cardId,
    version: state.version,
  });
}

function scheduleContentCards(context: ScenarioContext, escalating: boolean): void {
  const content = requireGameContent(context.content);
  const scenario = content.scenarios.get(content.defaultScenario);
  if (scenario === undefined) {
    return;
  }
  ensureRunState(context);
  for (const card of scenario.cards) {
    const existing = readCardState(context.tx, card.cardId);
    if (existing !== null) {
      continue;
    }
    const triggerAtTick = scaledTick(card.trigger.atTick, escalating);
    const state: ScenarioCardState = {
      cardId: card.cardId,
      version: card.version,
      status: "published",
      triggerAtTick,
      effects: [...card.effects],
      note: "content",
    };
    context.tx.put("scenario-card", card.cardId, state);
    scheduleCard(context, state);
  }
}

function triggerCard(context: ScenarioContext, cardId: string, version: number, escalating: boolean): void {
  const content = requireGameContent(context.content);
  const scenario = content.scenarios.get(content.defaultScenario);
  const card = scenario?.cards.find((candidate) => candidate.cardId === cardId && candidate.version === version);
  const state = readCardState(context.tx, cardId);
  if (state === null || state.status !== "published" || state.version !== version) {
    return;
  }
  const triggered: ScenarioCardState = { ...state, status: "triggered" };
  context.tx.put("scenario-card", cardId, triggered);
  context.tx.emit("ScenarioCardTriggered", { cardId, version, note: "triggered" }, [{ kind: "system" }]);
  applyCardEffects(context, cardId, state.effects.length > 0 ? state.effects : (card?.effects ?? []));
  // 压力卡由剧情内容声明：触发后启用每日剧情压力，规则层不写具体卡片 ID。
  if (scenario?.pressureCardId !== undefined && cardId === scenario.pressureCardId) {
    const run = ensureRunState(context);
    context.tx.put("scenario-run", run.scenarioId, { ...run, alarmTriggered: true });
  }
  void escalating;
}

function draft(context: ScenarioContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("scenario.draft", payload);
  if (readCardState(context.tx, input.cardId) !== null) {
    return {
      kind: "rejected",
      reasonCode: "version-conflict",
      safeMessage: "该卡片已登记，不能重复创建草稿",
    };
  }
  if (!isTriggerTickInWindow(input.triggerAtTick, context.tx.worldTick)) {
    return { kind: "rejected", reasonCode: "deadline-out-of-range", safeMessage: "触发 tick 超出发布窗口" };
  }
  const invalidEffect = invalidEffectReferences(requireGameContent(context.content), input.effects);
  if (invalidEffect !== null) {
    return {
      kind: "rejected",
      reasonCode: "invalid-effect",
      safeMessage: `草稿效果引用的内容对象不存在：${invalidEffect}`,
    };
  }
  const state: ScenarioCardState = {
    cardId: input.cardId,
    version: input.version,
    status: "draft",
    triggerAtTick: input.triggerAtTick,
    effects: [...input.effects],
    note: input.note,
  };
  context.tx.put("scenario-card", input.cardId, state);
  return { kind: "accepted" };
}

function publish(context: ScenarioContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("scenario.publish", payload);
  const state = readCardState(context.tx, input.cardId);
  if (state === null || state.status !== "draft") {
    return { kind: "rejected", reasonCode: "card-not-draft", safeMessage: "卡片不是可发布草稿" };
  }
  if (state.version !== input.version) {
    return { kind: "rejected", reasonCode: "version-conflict", safeMessage: "草稿版本与命令不一致" };
  }
  if (!isTriggerTickInWindow(input.triggerAtTick, context.tx.worldTick)) {
    return { kind: "rejected", reasonCode: "deadline-out-of-range", safeMessage: "触发 tick 超出发布窗口" };
  }
  const published: ScenarioCardState = { ...state, status: "published", triggerAtTick: input.triggerAtTick };
  context.tx.put("scenario-card", input.cardId, published);
  context.tx.emit("ScenarioCardPublished", { cardId: input.cardId, version: input.version, note: "published" }, [{ kind: "system" }]);
  scheduleCard(context, published);
  return { kind: "accepted" };
}

function withdraw(context: ScenarioContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("scenario.withdraw", payload);
  const state = readCardState(context.tx, input.cardId);
  if (state === null) {
    return { kind: "rejected", reasonCode: "card-not-draft", safeMessage: "卡片不存在" };
  }
  if (state.status === "triggered") {
    return { kind: "rejected", reasonCode: "card-already-triggered", safeMessage: "卡片已经触发" };
  }
  if (state.status === "withdrawn") {
    return { kind: "rejected", reasonCode: "card-not-draft", safeMessage: "卡片已经撤回" };
  }
  context.tx.put("scenario-card", input.cardId, { ...state, status: "withdrawn" });
  context.tx.cancelJobs(`scenario-card:${input.cardId}@`);
  context.tx.emit(
    "ScenarioCardWithdrawn",
    { cardId: input.cardId, version: state.version, note: "withdrawn" },
    [{ kind: "system" }],
  );
  return { kind: "accepted" };
}

function compensate(context: ScenarioContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("scenario.compensate", payload);
  const state = readCardState(context.tx, input.cardId);
  if (state === null) {
    return { kind: "rejected", reasonCode: "card-not-found", safeMessage: "补偿来源卡片不存在" };
  }
  if (state.status !== "triggered") {
    return { kind: "rejected", reasonCode: "card-not-triggered", safeMessage: "补偿来源卡片尚未触发" };
  }
  const invalidEffect = invalidEffectReferences(requireGameContent(context.content), input.effects);
  if (invalidEffect !== null) {
    return {
      kind: "rejected",
      reasonCode: "invalid-effect",
      safeMessage: `补偿效果引用的内容对象不存在：${invalidEffect}`,
    };
  }
  // 来源卡片与版本取自触发时写入的聚合状态，不采用调用方自报值。
  context.tx.emit(
    "ScenarioCompensationApplied",
    { cardId: state.cardId, version: state.version, note: input.note },
    [{ kind: "system" }],
  );
  applyCardEffects(context, state.cardId, input.effects);
  return { kind: "accepted" };
}

function override(context: ScenarioContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("scenario.override", payload);
  applyOverrideEffects(context, input.effects);
  recordContamination(context, input.note, input.effects);
  context.tx.emit(
    "ScenarioOverrideApplied",
    { cardId: null, version: null, note: input.note },
    [{ kind: "system" }],
  );
  return { kind: "accepted" };
}

function onTaskCompleted(context: ScenarioContext, event: EventEnvelope): void {
  const payload = event.payload as { readonly taskType?: string };
  if (payload.taskType !== "repair") {
    return;
  }
  const run = ensureRunState(context);
  context.tx.put("scenario-run", run.scenarioId, { ...run, repairCompleted: true });
}

function onDayPassed(context: ScenarioContext): void {
  const run = ensureRunState(context);
  if (!run.alarmTriggered || run.repairCompleted) {
    return;
  }
  asPorts(context)["game.world"].changeMeter("relay.stability", -2, "scenario-pressure");
}

/** 剧情模块规则贡献；escalating 选择节奏与 DayPassed 压力。 */
export function createScenarioContributor(options: { readonly escalating: boolean }): GameRuleContributor<GameModulePorts, unknown> {
  const consumers = options.escalating
    ? [
        {
          consumerId: "scenario-escalating-repair",
          eventTypes: ["TaskCompleted"],
          handler: (context: ScenarioContext, event: EventEnvelope) => {
            onTaskCompleted(context, event);
          },
        },
        {
          consumerId: "scenario-escalating-day",
          eventTypes: ["DayPassed"],
          handler: (context: ScenarioContext) => {
            onDayPassed(context);
          },
        },
      ]
    : [];
  return {
    moduleId: options.escalating ? gameModuleIds.scenarioEscalating : gameModuleIds.scenario,
    ownsAggregates: ["scenario-card", "scenario-run"],
    commands: [
      { type: "scenario.draft", handler: (context, payload) => draft(context as ScenarioContext, payload) },
      { type: "scenario.publish", handler: (context, payload) => publish(context as ScenarioContext, payload) },
      { type: "scenario.withdraw", handler: (context, payload) => withdraw(context as ScenarioContext, payload) },
      { type: "scenario.compensate", handler: (context, payload) => compensate(context as ScenarioContext, payload) },
      { type: "scenario.override", handler: (context, payload) => override(context as ScenarioContext, payload) },
    ],
    jobs: [
      {
        kind: "scenario.card",
        handler: (context, job) => {
          const input = job.payload as { readonly cardId: string; readonly version: number };
          triggerCard(context as ScenarioContext, input.cardId, input.version, options.escalating);
        },
      },
    ],
    afterCommands: [
      {
        type: "campaign.start",
        hook: (context) => {
          scheduleContentCards(context as ScenarioContext, options.escalating);
          return { kind: "accepted" };
        },
      },
    ],
    consumers,
  };
}
