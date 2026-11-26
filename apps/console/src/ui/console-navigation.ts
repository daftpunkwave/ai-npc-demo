/**
 * 核心职责：计算控制台导航的展示顺序、角色可用状态与当前页面。
 * 交互契约：依赖宿主的页面贡献与当前角色，相同 order 保持贡献顺序。
 * 约束与禁忌：不渲染贡献，不调用服务端或替代接口授权。
 */
import { selectSlotContributions, type SlotContribution } from "@world-prism/client-sdk";
import type { ConsoleActiveRole } from "@world-prism/contracts";

export function consoleNavigation(
  contributions: readonly SlotContribution[],
  role: ConsoleActiveRole,
  active: string | null,
) {
  const pages = selectSlotContributions(contributions, "console.page").map((page) => ({
    page,
    allowed: page.allowedRoles?.includes(role) ?? false,
  }));
  const selected = pages.find(({ page, allowed }) => allowed && page.extensionId === active)
    ?? pages.find(({ allowed }) => allowed);
  return { pages, selected: selected?.page ?? null };
}
