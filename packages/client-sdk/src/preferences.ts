/**
 * 定义纯展示偏好的读取与写入接口：语言、显示、镜头、声音与通知，作用域是设备或玩家。
 * 依赖公共契约的 JSON 值类型；不承载世界状态、权限、运行装配或服务端凭据。
 * 禁止把偏好写回世界、改变规则或作为授权判断依据。
 */
import type { Json } from "@ai-npc/contracts";

/** 已登记的纯展示偏好键；新增键必须先确认它只影响本机展示或输入表达。 */
export const preferenceKeys = ["language", "display", "camera", "sound", "notifications"] as const;

export type PreferenceKey = (typeof preferenceKeys)[number];

/**
 * 每个偏好键的值形状：语言是单值字符串，其余为按实现细分的展示参数。
 * 值只允许 JSON，宿主可以保存在设备本地或玩家配置中并即时应用。
 */
export interface PreferenceValues {
  readonly language: string;
  readonly display: Readonly<Record<string, Json>>;
  readonly camera: Readonly<Record<string, Json>>;
  readonly sound: Readonly<Record<string, Json>>;
  readonly notifications: Readonly<Record<string, Json>>;
}

/** 判断字符串是否为已登记的偏好键。 */
export function isPreferenceKey(value: string): value is PreferenceKey {
  return (preferenceKeys as readonly string[]).includes(value);
}

/**
 * 宿主提供的偏好端口：只读写纯展示偏好，按设备或玩家作用域保存，不进入运行清单。
 * 读取尚未设置的值返回 null；写入即时生效，但不会改变世界结果或模块装配。
 */
export interface PreferencePort {
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  get<K extends PreferenceKey>(key: K): PreferenceValues[K] | null;
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  set<K extends PreferenceKey>(key: K, value: PreferenceValues[K]): void;
}
