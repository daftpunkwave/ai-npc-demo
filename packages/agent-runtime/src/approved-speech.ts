/**
 * 保存本进程内已批准对白，供 authority 在同一事务内同步读取。
 * 对白正文已经先持久化为 artifact；本索引只作事务内校验入口。
 * 禁止持久化凭据、跨 run 复用或让未批准文本进入索引。
 */
import type { ApprovedSpeech, ApprovedSpeechReader } from "@ai-npc/module-sdk";

export class ApprovedSpeechStore implements ApprovedSpeechReader {
  private readonly values = new Map<string, ApprovedSpeech>();

  read(ref: string): ApprovedSpeech | null {
    return this.values.get(ref) ?? null;
  }

  put(ref: string, speech: ApprovedSpeech): void {
    this.values.set(ref, speech);
  }

  delete(ref: string): void {
    this.values.delete(ref);
  }
}
