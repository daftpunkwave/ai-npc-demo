/**
 * client-sdk 测试共享的宿主上下文、slot 贡献、偏好端口假实现与错误断言助手。
 * 依赖本包公开类型与 React 服务端渲染工具；不访问浏览器 DOM、网络或本地存储。
 * 禁止把假实现当作生产宿主，或让测试依赖渲染顺序之外的真实副作用。
 */
import { expect } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DomainError, type ErrorCode } from "@world-prism/contracts";
import {
  ModuleHostProvider,
  type ModuleHostValue,
  type PreferenceKey,
  type PreferencePort,
  type PreferenceValues,
  type SlotContribution,
} from "../src/index";

/** 构造一个 slot 贡献；render 返回固定内容，便于断言排序与隔离。 */
export function contribution(
  slot: string,
  extensionId: string,
  order: number,
  content: ReactNode,
): SlotContribution {
  return { slot, extensionId, order, render: () => content };
}

/** 内存版偏好端口：仅测试使用，行为等价于宿主本地存储的读写。 */
export function fakePreferences(): PreferencePort {
  const store = new Map<PreferenceKey, unknown>();
  return {
    get: <K extends PreferenceKey>(key: K): PreferenceValues[K] | null =>
      store.has(key) ? (store.get(key) as PreferenceValues[K]) : null,
    set: <K extends PreferenceKey>(key: K, value: PreferenceValues[K]): void => {
      store.set(key, value);
    },
  };
}

/** 构造宿主上下文值；未覆盖的端口与贡献为空，偏好使用内存假实现。 */
export function hostValue(overrides: Partial<ModuleHostValue> = {}): ModuleHostValue {
  return { ports: {}, contributions: [], preferences: fakePreferences(), ...overrides };
}

/** 在宿主 Provider 内做服务端字符串渲染，用于验证 slot 与 hook 的可见输出。 */
export function renderWithHost(value: ModuleHostValue, children: ReactNode): string {
  return renderToStaticMarkup(createElement(ModuleHostProvider, { value }, children));
}

/** 断言同步动作抛出指定错误码的 DomainError。 */
export function expectDomainError(action: () => unknown, code: ErrorCode): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    if (!(error instanceof DomainError)) {
      throw new Error("期望 DomainError");
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error("期望抛出 DomainError，实际没有抛错");
}
