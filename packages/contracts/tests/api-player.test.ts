/**
 * 验证认证、会话、健康检查、玩家接口与 WebSocket 消息的 DTO。
 * 依赖公共契约包的 api 主题导出与共享固定样例。
 * 禁止启动 HTTP 服务或建立真实连接；只校验请求与响应 schema。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  campaignResponseSchema,
  clientStreamMessageSchema,
  clockControlRequestSchema,
  clockResponseSchema,
  consoleActiveRoleSchema,
  consoleRequestContextSchema,
  conversationQuerySchema,
  conversationResponseSchema,
  healthResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  playerCommandRequestSchema,
  playerCommandResponseSchema,
  presetsResponseSchema,
  projectionEnvelopeSchema,
  realmQuerySchema,
  runRequestCreateResponseSchema,
  runRequestCreateSchema,
  serverStreamMessageSchema,
  sessionAssemblyQuerySchema,
  sessionAssemblyResponseSchema,
  sessionDescriptorSchema,
  sessionResponseSchema,
  snapshotCreateRequestSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
  snapshotViewSchema,
  campaignResetRequestSchema,
  campaignResetResponseSchema,
  streamAckMessageSchema,
  streamAppendMessageSchema,
  streamChannelSchema,
  streamDeltaMessageSchema,
  streamErrorMessageSchema,
  streamHelloMessageSchema,
  streamPingMessageSchema,
  streamPongMessageSchema,
  streamSnapshotMessageSchema,
  streamSubscribeMessageSchema,
  streamTicketResponseSchema,
  timelineItemSchema,
  eventPreviewSchema,
  worldViewResponseSchema,
  presetSummarySchema,
} from "../src/index";
import { commandReceiptFixture, playerProjectionFixture, resolvedModuleSetFixture } from "./fixtures";

const session = {
  principalId: "player-1",
  roles: ["player"],
  worldId: "wld-k3j9x0a1b2c3",
  branchId: "br-k3j9x0a1b2c3",
  protocolVersion: "1",
  serverAssembly: resolvedModuleSetFixture("server"),
  clientAssembly: resolvedModuleSetFixture("client"),
};

const hello = { type: "hello", protocolVersion: "1", principalId: "player-1", channels: ["player"] };
const snapshotMessage = {
  type: "snapshot",
  channel: "player",
  streamSeq: 1,
  projectionVersion: 1,
  data: { campaign: null },
};

/** 单条合法 + 非法样例的请求/响应 DTO 表。 */
const dtoRows: ReadonlyArray<readonly [string, z.ZodType, unknown, unknown]> = [
  ["健康检查", healthResponseSchema, { status: "ready", protocolVersion: "1" }, { status: "ok", protocolVersion: "1" }],
  ["登录请求", loginRequestSchema, { token: "dev-token" }, { token: "" }],
  [
    "登录响应",
    loginResponseSchema,
    {
      sessionToken: "session-token",
      principalId: "player-1",
      roles: ["player"],
      expiresAt: "2026-11-25T00:00:00.000Z",
    },
    { sessionToken: "x", principalId: "player-1", roles: ["admin"], expiresAt: "x" },
  ],
  ["登出响应", logoutResponseSchema, { ok: true }, { ok: false }],
  ["会话描述", sessionResponseSchema, session, { ...session, serverAssembly: null }],
  ["装配查询", sessionAssemblyQuerySchema, { realm: "client" }, { realm: "server" }],
  ["装配响应", sessionAssemblyResponseSchema, resolvedModuleSetFixture("client"), { realm: "server" }],
  ["WS 票据", streamTicketResponseSchema, { ticket: "ticket-1", expiresAt: "2026-11-18T00:00:30.000Z" }, { ticket: "" }],
  [
    "开局响应",
    campaignResponseSchema,
    { campaign: null, starts: [{ factionId: "human-neutral", name: "灰港公社", commission: "调停", contacts: [] }] },
    { campaign: null, starts: [{ factionId: "human-neutral" }] },
  ],
  [
    "世界视图",
    worldViewResponseSchema,
    { streamSeq: 3, projectionVersion: 2, projection: playerProjectionFixture() },
    { streamSeq: -1, projectionVersion: 2, projection: playerProjectionFixture() },
  ],
  ["对话查询", conversationQuerySchema, { beforeSeq: 10, limit: 50 }, { limit: 101 }],
  [
    "对话响应",
    conversationResponseSchema,
    {
      conversationId: "conv-k3j9x0a1b2c3",
      lines: [
        {
          seq: 0,
          dialogueId: "dlg-k3j9x0a1b2c3",
          speakerId: "npc-cenyan",
          speakerName: "岑雁",
          text: "你好",
          worldTick: 0,
          channel: "face-to-face",
        },
      ],
    },
    { conversationId: "conv-1", lines: [] },
  ],
  ["时钟控制请求", clockControlRequestSchema, { operationId: "op-k3j9x0a1b2c3", expectedRunVersion: 2 }, { operationId: "op-k3j9x0a1b2c3" }],
  ["时钟响应", clockResponseSchema, { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 }, { mode: "stopped" }],
  [
    "快照视图",
    snapshotViewSchema,
    {
      snapshotId: "snap-k3j9x0a1b2c3",
      label: "手动存档",
      worldTick: 24,
      day: 2,
      createdAt: "2026-11-18T00:00:00.000Z",
      createdBy: "player-1",
    },
    { snapshotId: "snap-1", label: "x", worldTick: 24, day: 2, createdAt: "x", createdBy: "player-1" },
  ],
  ["快照创建请求", snapshotCreateRequestSchema, { operationId: "op-k3j9x0a1b2c3", label: "手动存档" }, { label: "手动存档" }],
  ["快照创建响应", snapshotCreateResponseSchema, { snapshotId: "snap-k3j9x0a1b2c3", worldTick: 24 }, { snapshotId: "snap-1", worldTick: 24 }],
  ["快照列表", snapshotListResponseSchema, { snapshots: [] }, { snapshots: [{}] }],
  [
    "快照恢复请求",
    snapshotRestoreRequestSchema,
    { operationId: "op-k3j9x0a1b2c3", snapshotId: "snap-k3j9x0a1b2c3" },
    { operationId: "op-k3j9x0a1b2c3" },
  ],
  [
    "快照恢复响应",
    snapshotRestoreResponseSchema,
    { branchId: "br-k3j9x0a1b2c3", clock: { worldTick: 24, day: 2, hour: 0, mode: "paused", runVersion: 1 } },
    { branchId: "br-1" },
  ],
  ["重开请求", campaignResetRequestSchema, { operationId: "op-k3j9x0a1b2c3" }, {}],
  ["重开响应", campaignResetResponseSchema, { branchId: "br-k3j9x0a1b2c3" }, { branchId: "br-1" }],
  ["preset 摘要", presetSummarySchema, { presetId: "s-promise", title: "承诺", summary: "测试记忆" }, { presetId: "" }],
  ["preset 列表", presetsResponseSchema, { presets: [] }, { presets: [{}] }],
  ["run 申请请求", runRequestCreateSchema, { presetId: "s-promise", note: "" }, { presetId: "" }],
  ["run 申请响应", runRequestCreateResponseSchema, { requestId: "rr-k3j9x0a1b2c3", status: "pending" }, { requestId: "rr-k3j9x0a1b2c3", status: "approved" }],
  ["命令请求", playerCommandRequestSchema, { commandId: "cmd-k3j9x0a1b2c3", type: "campaign.start", schemaVersion: 1, payload: { factionId: "human-neutral" } }, { commandId: "cmd-1" }],
  ["命令回执", playerCommandResponseSchema, commandReceiptFixture(), { ...commandReceiptFixture(), receiptId: "rcp-1" }],
  [
    "时间线条目",
    timelineItemSchema,
    {
      kind: "domain",
      worldSeq: 3,
      worldTick: 1,
      eventId: "evt-k3j9x0a1b2c3",
      type: "CampaignStarted",
      principalId: "player-1",
      audience: [{ kind: "public" }],
      summaryZh: "战役已开始。",
      payload: {},
      correlationId: "trc-k3j9x0a1b2c3",
      createdAt: "2026-11-18T00:00:00.000Z",
    },
    { kind: "audit", worldSeq: 3 },
  ],
  [
    "事件预览",
    eventPreviewSchema,
    { type: "CampaignStarted", audience: [{ kind: "public" }], payload: {}, summaryZh: "战役已开始。" },
    { type: "CampaignStarted", audience: [] },
  ],
  ["WS hello", streamHelloMessageSchema, hello, { ...hello, channels: ["unknown"] }],
  [
    "WS subscribe",
    streamSubscribeMessageSchema,
    { type: "subscribe", channel: "player", fromStreamSeq: null },
    { type: "subscribe", channel: "player", fromStreamSeq: -1 },
  ],
  ["WS snapshot", streamSnapshotMessageSchema, snapshotMessage, { ...snapshotMessage, streamSeq: -1 }],
  [
    "WS delta",
    streamDeltaMessageSchema,
    { type: "delta", channel: "player", streamSeq: 2, projectionVersion: 1, set: { meters: { relayStability: { value: 45, level: "stable" } } } },
    { type: "delta", channel: "player", streamSeq: -1, projectionVersion: 1, set: {} },
  ],
  [
    "WS append",
    streamAppendMessageSchema,
    { type: "append", channel: "player", streamSeq: 3, kind: "dialogue", item: {} },
    { type: "append", channel: "player", streamSeq: 3, kind: "system", item: {} },
  ],
  ["WS ack", streamAckMessageSchema, { type: "ack", channel: "player", streamSeq: 3 }, { type: "ack", channel: "player" }],
  ["WS ping", streamPingMessageSchema, { type: "ping" }, { type: "ping", extra: true }],
  ["WS pong", streamPongMessageSchema, { type: "pong" }, { type: "pong", extra: true }],
  [
    "WS error",
    streamErrorMessageSchema,
    { type: "error", code: "forbidden", safeMessage: "当前角色无权访问" },
    { type: "error", code: "nope", safeMessage: "x" },
  ],
  ["服务端 WS 联合", serverStreamMessageSchema, hello, { type: "subscribe", channel: "player", fromStreamSeq: null }],
  ["客户端 WS 联合", clientStreamMessageSchema, { type: "subscribe", channel: "player", fromStreamSeq: null }, hello],
  [
    "投影信封",
    projectionEnvelopeSchema,
    {
      worldId: "wld-k3j9x0a1b2c3",
      branchId: "br-k3j9x0a1b2c3",
      streamSeq: 1,
      projectionVersion: 1,
      snapshotRef: null,
      eventRefs: [],
    },
    { worldId: "wld-k3j9x0a1b2c3", branchId: "br-k3j9x0a1b2c3", streamSeq: -1, projectionVersion: 1, snapshotRef: null, eventRefs: [] },
  ],
  [
    "控制台请求上下文",
    consoleRequestContextSchema,
    { principalId: "console-admin", roles: ["operator"], scope: { runId: "run-k3j9x0a1b2c3" } },
    { principalId: "console-admin", roles: ["operator"] },
  ],
  ["realm 查询", realmQuerySchema, { realm: "console" }, { realm: "browser" }],
];

describe("认证、会话与玩家接口 DTO", () => {
  it("会话描述与模块集", () => {
    expect(sessionDescriptorSchema.safeParse(session).success).toBe(true);
  });

  it("控制台激活角色与 WS 频道枚举", () => {
    for (const role of ["operator", "researcher", "evaluator"]) {
      expect(consoleActiveRoleSchema.safeParse(role).success).toBe(true);
    }
    expect(consoleActiveRoleSchema.safeParse("player").success).toBe(false);
    for (const channel of ["player", "console.health", "console.timeline", "console.turns"]) {
      expect(streamChannelSchema.safeParse(channel).success).toBe(true);
    }
    expect(streamChannelSchema.safeParse("console.audit").success).toBe(false);
  });

  it("玩家快照带投影版本，控制台快照显式不带该字段", () => {
    expect(streamSnapshotMessageSchema.safeParse(snapshotMessage).success).toBe(true);
    const consoleSnapshot = {
      type: "snapshot",
      channel: "console.timeline",
      streamSeq: 5,
      projectionVersion: 0,
      data: { events: [] },
    };
    expect(streamSnapshotMessageSchema.safeParse(consoleSnapshot).success).toBe(true);
    expect(
      streamSnapshotMessageSchema.safeParse({
        ...consoleSnapshot,
        projectionVersion: 1,
      }).success,
    ).toBe(false);
    const { projectionVersion: _projectionVersion, ...playerWithoutVersion } = snapshotMessage;
    expect(streamSnapshotMessageSchema.safeParse(playerWithoutVersion).success).toBe(false);
  });

  it("每类请求与响应 DTO 都有合法与非法样例", () => {
    for (const [name, schema, valid, invalid] of dtoRows) {
      expect(schema.safeParse(valid).success, `${name} 应接受合法样例`).toBe(true);
      expect(schema.safeParse(invalid).success, `${name} 应拒绝非法样例`).toBe(false);
    }
  });
});
