/**
 * 规则 7 的注释引用禁忌表：开发文档、外部链接与构建阶段编号不得出现在注释中。
 * 只维护模式与中文说明，注释扫描与行号定位由 header 模块负责。
 * 禁止把允许引用写进本表，或让模式匹配执行被检查文件的内容。
 */
import type { ForbiddenCommentPattern } from "./types";

export const FORBIDDEN_COMMENT_PATTERNS: readonly ForbiddenCommentPattern[] = [
  { code: "header-doc-path-reference", label: "开发文档目录", pattern: /docs\// },
  { code: "header-markdown-link-reference", label: "Markdown 链接", pattern: /\]\(/ },
  { code: "header-markdown-file-reference", label: "Markdown 文件名", pattern: /[A-Za-z0-9_-]\.md\b/ },
  { code: "header-url-reference", label: "URL", pattern: /(?:https?:\/\/|www\.)/i },
  {
    code: "header-stage-reference",
    label: "构建阶段编号",
    pattern: /(?:^|[^A-Za-z0-9])S(?:0\d|1\d|2[0-5])(?![0-9])/,
  },
];
