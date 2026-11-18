/**
 * 渲染一个 slot 的全部贡献：按 order 稳定排序，未知或空 slot 返回 null，单个贡献失败由 error boundary 隔离。
 * 依赖宿主 context 的贡献列表、React 组件模型与本包的 slot 解析；不执行服务端规则或读取世界权威。
 * 禁止把未注册 slot 降级成假内容，也禁止让单个视图异常中断整页渲染。
 */
import { Component, type ReactNode } from "react";
import { useModuleHost } from "./context";
import { selectSlotContributions, type SlotContribution } from "./slots";

export interface ContributionBoundaryProps {
  readonly extensionId: string;
  readonly children?: ReactNode;
  readonly onError?: (error: unknown, extensionId: string) => void;
}

export interface ContributionBoundaryState {
  readonly failed: boolean;
}

/**
 * 单个贡献的错误边界：失败时只移除该贡献，不渲染替代假内容。
 * 选择 React error boundary 而不是渲染函数里的 try/catch：React 渲染是惰性的，
 * 只有边界能捕获子组件渲染阶段抛出的异常并把失败限制在单个贡献内；
 * 事件处理与异步回调不在此范围内，由宿主或模块自行上报。
 */
export class ContributionBoundary extends Component<ContributionBoundaryProps, ContributionBoundaryState> {
  override state: ContributionBoundaryState = { failed: false };

  static getDerivedStateFromError(): ContributionBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError?.(error, this.props.extensionId);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return null;
    }
    return this.props.children ?? null;
  }
}

function SlotContributionView({ contribution }: { readonly contribution: SlotContribution }): ReactNode {
  return contribution.render();
}

export interface SlotProps {
  /** 宿主定义的 slot 名称，例如 hud、dialogue、settings.section。 */
  readonly name: string;
}

/**
 * 渲染指定 slot：无贡献时返回 null；每个贡献包在独立错误边界内，失败不影响同一 slot 的其他贡献和整页。
 */
export function Slot({ name }: SlotProps): ReactNode {
  const { contributions, reportContributionError } = useModuleHost();
  const selected = selectSlotContributions(contributions, name);
  if (selected.length === 0) {
    return null;
  }
  return selected.map((contribution) => (
    <ContributionBoundary
      key={contribution.extensionId}
      extensionId={contribution.extensionId}
      onError={
        reportContributionError === undefined
          ? undefined
          : (error: unknown) => reportContributionError(error, contribution)
      }
    >
      <SlotContributionView contribution={contribution} />
    </ContributionBoundary>
  ));
}
