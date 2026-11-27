/**
 * 核心职责：固定容量的重放帧环形缓冲；写满后覆盖最旧帧，按写入顺序读出游标之后的帧。
 * 交互契约：帧只需带递增的 streamSeq；容量在构造时确定，写入与清空都是 O(1)，读取按需复制。
 * 约束与禁忌：不判断分支、代次或缺口，这些由重放缓冲的调用方负责；禁止在读出的数组上回写缓冲内容。
 */

/** 用写指针代替数组首部删除：每次发布写入一帧不再搬移其余已缓存的帧。 */
export class ReplayRing<Frame extends { readonly streamSeq: number }> {
  private readonly slots: (Frame | undefined)[];
  private start = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("重放缓冲容量必须是正整数");
    }
    this.slots = Array.from<Frame | undefined>({ length: capacity });
  }

  get length(): number {
    return this.size;
  }

  /** 追加一帧；已满时覆盖最旧帧。 */
  push(frame: Frame): void {
    this.slots[(this.start + this.size) % this.capacity] = frame;
    if (this.size < this.capacity) {
      this.size += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** 丢弃全部帧并释放引用。 */
  clear(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.size = 0;
  }

  /** 按写入顺序返回 streamSeq 大于 afterSeq 的帧。 */
  after(afterSeq: number): Frame[] {
    const frames: Frame[] = [];
    for (let offset = 0; offset < this.size; offset += 1) {
      const frame = this.slots[(this.start + offset) % this.capacity];
      if (frame !== undefined && frame.streamSeq > afterSeq) {
        frames.push(frame);
      }
    }
    return frames;
  }
}
