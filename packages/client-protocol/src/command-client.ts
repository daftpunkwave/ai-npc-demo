/**
 * 生成幂等命令 ID，并在网络瞬断或显式可重试错误下复用同一 ID 重试。
 * 依赖类型化 API 客户端的命令入口；不解释业务拒绝，也不重放成功后产生的新命令。
 * 禁止每次重试重新生成 commandId，或把 rejected receipt 当作网络失败改写状态。
 */
import { DomainError, commandEnvelopeSchemaVersion, type CommandEnvelope, type CommandReceipt, type Json } from "@world-prism/contracts";
import type { ApiClient } from "./http";

export interface CommandClientOptions {
  readonly api: Pick<ApiClient, "sendCommand">;
  readonly newCommandId?: () => string;
  readonly maxRetries?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function randomCommandId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += alphabet[byte % alphabet.length];
  }
  return `cmd-${id}`;
}

function retryable(error: unknown): boolean {
  return error instanceof DomainError
    ? error.retryable
    : error instanceof TypeError;
}

/** 命令客户端只负责幂等重试，不判断游戏规则结果。 */
export class CommandClient {
  private readonly api: Pick<ApiClient, "sendCommand">;
  private readonly newCommandId: () => string;
  private readonly maxRetries: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(options: CommandClientOptions) {
    this.api = options.api;
    this.newCommandId = options.newCommandId ?? randomCommandId;
    this.maxRetries = options.maxRetries ?? 3;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async send(
    type: string,
    payload: Json,
    expectedVersions?: Readonly<Record<string, number>>,
  ): Promise<CommandReceipt> {
    const envelope: CommandEnvelope = {
      commandId: this.newCommandId(),
      type,
      schemaVersion: commandEnvelopeSchemaVersion,
      payload,
      ...(expectedVersions === undefined ? {} : { expectedVersions: { ...expectedVersions } }),
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.api.sendCommand(envelope);
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === this.maxRetries) {
          throw error;
        }
        await this.wait(200 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}

export { randomCommandId };
