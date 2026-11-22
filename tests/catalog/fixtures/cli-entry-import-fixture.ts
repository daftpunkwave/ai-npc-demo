/**
 * 核心职责：以普通模块方式导入三个 CLI 公开入口，供子进程测试断言导入不触发任何输出。
 * 交互契约：由测试以 tsx 启动；argv[1] 指向本文件，入口内的直接执行判定应全部不命中。
 * 约束与禁忌：禁止在本文件内打印输出、设置退出码或以其他方式触发入口的 CLI 行为。
 */
import "@ai-npc/scripts/check-boundaries";
import "@ai-npc/scripts/check-assets";
import "@ai-npc/scripts/check-catalog";
