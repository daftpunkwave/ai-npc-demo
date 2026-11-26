/**
 * 在 localStorage 中保存纯展示偏好，按固定前缀隔离并容忍损坏的本地数据。
 * 依赖浏览器 Storage 与 client-sdk 偏好端口；不保存会话、世界状态或权限。
 * 禁止让本地偏好参与授权判断或写回服务端运行配置。
 */
import type {
  PreferenceKey,
  PreferencePort,
  PreferenceValues,
} from "@world-prism/client-sdk";

const prefix = "world-prism.pref.";

export function localPreferencePort(): PreferencePort {
  return {
    get: <K extends PreferenceKey>(key: K): PreferenceValues[K] | null => {
      try {
        const raw = window.localStorage.getItem(`${prefix}${key}`);
        return raw === null ? null : (JSON.parse(raw) as PreferenceValues[K]);
      } catch {
        return null;
      }
    },
    set: <K extends PreferenceKey>(key: K, value: PreferenceValues[K]): void => {
      window.localStorage.setItem(`${prefix}${key}`, JSON.stringify(value));
    },
  };
}
