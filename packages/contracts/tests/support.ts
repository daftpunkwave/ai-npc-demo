/**
 * 契约测试的共享断言助手。
 * 依赖 vitest 与 zod schema 的 safeParse 接口，不读写文件、不访问网络。
 * 禁止在此定义业务夹具或绕过 schema 校验直接构造结果。
 */
import { expect } from "vitest";
import { z } from "zod";

/** 断言输入通过 schema。 */
export function expectValid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`期望合法输入，实际失败: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}

/** 断言输入被 schema 拒绝。 */
export function expectInvalid(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

/** 同一 schema 的合法与非法样例断言。 */
export function expectSchema(schema: z.ZodType, valid: unknown, invalid: unknown): void {
  expectValid(schema, valid);
  expectInvalid(schema, invalid);
}

/**
 * 断言严格对象 schema 拒绝未知键：合法样例加一个未声明字段后必须失败。
 * 用于数据型 strict schema 的统一回归。
 */
export function expectRejectsUnknownKey(schema: z.ZodType, valid: object): void {
  expectInvalid(schema, { ...valid, __unexpectedField: true });
}

/** 断言字符串 schema 拒绝非字符串与空字符串。 */
export function expectNonEmptyString(schema: z.ZodString, value: string): void {
  expectValid(schema, value);
  expectInvalid(schema, "");
  expectInvalid(schema, 42);
}

/** 断言 schema 拒绝 null 与 undefined。 */
export function expectRejectsNullish(schema: z.ZodType): void {
  expectInvalid(schema, null);
  expectInvalid(schema, undefined);
}
