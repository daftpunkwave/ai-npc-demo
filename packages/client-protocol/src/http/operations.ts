/**
 * 核心职责：构造控制台时钟控制与存档请求，包括只读恢复预检。
 * 交互契约：依赖已绑定会话的控制台请求函数，使用调用方提供的版本与 operationId。
 * 约束与禁忌：不在客户端重试写入、不变更世界状态或推算时钟版本。
 */
import {
  campaignStepRequestSchema,
  clockResponseSchema,
  consoleSnapshotRestoreResponseSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  type ClockControlRequest,
  type SnapshotCreateRequest,
} from "@ai-npc/contracts";
import type { z } from "zod";
import type { ConsoleRequest } from "./request";

export function createOperationsHttp(request: ConsoleRequest) {
  return {
    consolePauseCampaign(input: ClockControlRequest) {
      return request(clockResponseSchema, "/api/v1/console/campaign/pause", { method: "POST", body: input });
    },

    consoleResumeCampaign(input: ClockControlRequest) {
      return request(clockResponseSchema, "/api/v1/console/campaign/resume", { method: "POST", body: input });
    },

    consoleStepCampaign(input: z.input<typeof campaignStepRequestSchema>) {
      return request(clockResponseSchema, "/api/v1/console/campaign/step", {
        method: "POST",
        body: campaignStepRequestSchema.parse(input),
      });
    },

    consoleSnapshots(signal?: AbortSignal) {
      return request(snapshotListResponseSchema, "/api/v1/console/campaign/snapshots", { signal });
    },

    consoleCreateSnapshot(input: SnapshotCreateRequest) {
      return request(snapshotCreateResponseSchema, "/api/v1/console/campaign/snapshots", {
        method: "POST", body: input,
      });
    },

    consoleRestoreSnapshot(input: {
      readonly operationId: string;
      readonly snapshotId: string;
      readonly dryRun?: boolean;
    }, signal?: AbortSignal) {
      return request(consoleSnapshotRestoreResponseSchema, "/api/v1/console/campaign/restore", {
        method: "POST",
        body: { ...input, dryRun: input.dryRun ?? false },
        signal,
      });
    },
  };
}
