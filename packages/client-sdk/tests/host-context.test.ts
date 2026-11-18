/**
 * 覆盖宿主上下文 hook：port 绑定查找、缺失 port 的明确报错、偏好端口读取与偏好键识别。
 * 依赖本包 context 与偏好实现、React 元素与服务端字符串渲染；不访问 DOM、网络或真实后端。
 * 禁止为未注册 port 返回假实现，或把偏好读取混成世界状态查询。
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isPreferenceKey,
  usePort,
  usePreferencePort,
  type PreferencePort,
} from "../src/index";
import { expectDomainError, fakePreferences, hostValue, renderWithHost } from "./support";

interface CameraPort {
  readonly zoom: number;
}

function CameraProbe(): ReactNode {
  const camera = usePort<CameraPort>("client.camera");
  return createElement("span", null, `zoom=${camera.zoom}`);
}

function LanguageProbe(): ReactNode {
  const preferences = usePreferencePort();
  return createElement("span", null, preferences.get("language") ?? "unset");
}

describe("usePort", () => {
  it("返回宿主已绑定的 port", () => {
    const markup = renderWithHost(
      hostValue({ ports: { "client.camera": { zoom: 2 } } }),
      createElement(CameraProbe),
    );
    expect(markup).toBe("<span>zoom=2</span>");
  });

  it("未注册时抛装配错误且不返回假实现", () => {
    const error = expectDomainError(
      () => renderWithHost(hostValue(), createElement(CameraProbe)),
      "assembly-incompatible",
    );
    expect(error.details).toMatchObject({ capability: "client.camera" });
  });

  it("缺少宿主 Provider 时抛装配错误", () => {
    expectDomainError(
      () => renderToStaticMarkup(createElement(CameraProbe)),
      "assembly-incompatible",
    );
  });
});

describe("usePreferencePort", () => {
  it("读取宿主提供的纯展示偏好", () => {
    const preferences = fakePreferences();
    preferences.set("language", "zh-CN");
    const markup = renderWithHost(
      hostValue({ preferences }),
      createElement(LanguageProbe),
    );
    expect(markup).toBe("<span>zh-CN</span>");
  });

  it("未设置时返回 null 而不是编造默认值", () => {
    const markup = renderWithHost(
      hostValue({ preferences: fakePreferences() }),
      createElement(LanguageProbe),
    );
    expect(markup).toBe("<span>unset</span>");
  });

  it("偏好端口只接受已登记键", () => {
    expect(isPreferenceKey("language")).toBe(true);
    expect(isPreferenceKey("sound")).toBe(true);
    expect(isPreferenceKey("world")).toBe(false);
    expect(isPreferenceKey("permissions")).toBe(false);
  });

  it("宿主可以写入已登记偏好", () => {
    const preferences: PreferencePort = fakePreferences();
    preferences.set("display", { contrast: "high" });
    expect(preferences.get("display")).toEqual({ contrast: "high" });
  });
});
