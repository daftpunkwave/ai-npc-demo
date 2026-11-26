/**
 * 核心职责：登记启动流程按取得顺序获得的资源，并在失败或关闭时一次性按逆序释放。
 * 交互契约：各启动步骤在取得资源后立刻登记标签与释放回调；宿主只调用 `releaseAll`，
 * 由本模块保证「后取得的先释放」，单步失败继续其余步骤并汇总为 `AggregateError`。
 * 约束与禁忌：不判断何时该释放，不持有或重建资源，也不吞掉释放错误；调用方只负责记录日志。
 */
import { disposeInReverse, type DisposalStep } from "./dispose";

/**
 * 启动期资源登记表。
 *
 * 只登记启动流程**拥有**的资源：存储实例、活跃模块实例、Agent 运行模块。
 * 借用来的对象（配置、内容包、模块定义）不登记，它们的生命周期由调用方管理。
 */
export class StartupResources {
  private readonly steps: DisposalStep[] = [];

  /** 登记一个刚取得的资源；同一资源只登记一次，重复登记会让释放顺序失真。 */
  track(label: string, dispose: () => Promise<void>): void {
    this.steps.push({ label, dispose });
  }

  /** 已登记的标签，按取得顺序；用于失败路径测试核对整条链。 */
  labels(): readonly string[] {
    return this.steps.map((step) => step.label);
  }

  /** 按逆序释放全部已登记资源；任一步失败都继续，最后汇总抛出。 */
  releaseAll(): Promise<void> {
    return disposeInReverse([...this.steps]);
  }
}
