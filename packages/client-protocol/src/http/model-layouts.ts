/**
 * 核心职责：构造控制台模型布局列表、详情、解析路由与草稿预检请求。
 * 交互契约：依赖已绑定会话的控制台请求函数与公共 DTO。
 * 约束与禁忌：不解析配置文件、不请求模型供应商、不处理凭据正文。
 */
import {
  modelLayoutRoutesResponseSchema,
  modelLayoutValidateRequestSchema,
  modelLayoutValidateResponseSchema,
  modelLayoutViewSchema,
  modelLayoutsResponseSchema,
} from "@world-prism/contracts";
import type { ConsoleRequest } from "./request";

export function createModelLayoutHttp(request: ConsoleRequest) {
  return {
    consoleModelLayouts() {
      return request(modelLayoutsResponseSchema, "/api/v1/console/model-layouts");
    },

    consoleModelLayout(layoutId: string, signal?: AbortSignal) {
      return request(
        modelLayoutViewSchema,
        `/api/v1/console/model-layouts/${encodeURIComponent(layoutId)}`,
        { signal },
      );
    },

    consoleModelRoutes(layoutId: string, signal?: AbortSignal) {
      return request(
        modelLayoutRoutesResponseSchema,
        `/api/v1/console/model-layouts/${encodeURIComponent(layoutId)}/routes`,
        { signal },
      );
    },

    validateModelLayout(layout: unknown) {
      return request(modelLayoutValidateResponseSchema, "/api/v1/console/model-layouts/validate", {
        method: "POST",
        body: modelLayoutValidateRequestSchema.parse({ layout }),
      });
    },
  };
}
