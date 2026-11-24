/**
 * 核心职责：构造控制台时钟控制与存档请求，包括只读恢复预检。
 * 交互契约：依赖已绑定会话的控制台请求函数，使用调用方提供的版本与 operationId；
 * 恢复端点按请求是否预检选择对应响应 schema，而不是对同一份响应做形状推断。
 * 约束与禁忌：不在客户端重试写入、不变更世界状态或推算时钟版本。
 */
import {
  clockResponseSchema,
  clockStepRequestSchema,
  restoreDryRunResponseSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  snapshotRestoreResponseSchema,
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

    consoleStepCampaign(input: z.input<typeof clockStepRequestSchema>) {
      return request(clockResponseSchema, "/api/v1/console/campaign/step", {
        method: "POST",
        body: clockStepRequestSchema.parse(input),
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

    /** 只读预检：`dryRun: true` 时服务端只做校验，返回 `{ ok, checks }`，不切换分支。 */
    consolePreviewSnapshotRestore(input: {
      readonly operationId: string;
      readonly snapshotId: string;
    }, signal?: AbortSignal) {
      return request(restoreDryRunResponseSchema, "/api/v1/console/campaign/restore", {
        method: "POST",
        body: { ...input, dryRun: true },
        signal,
      });
    },

    /** 实际恢复：成功后返回新的在线分支与恢复后的时钟。 */
    consoleRestoreSnapshot(input: {
      readonly operationId: string;
      readonly snapshotId: string;
    }, signal?: AbortSignal) {
      return request(snapshotRestoreResponseSchema, "/api/v1/console/campaign/restore", {
        method: "POST",
        body: input,
        signal,
      });
    },
  };
}
