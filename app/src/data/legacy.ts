/**
 * legacy.ts —— 读旧版留在浏览器里的数据
 *
 * 旧版把状态存在 `schedule-app-v1`，本项目第一次登录时把它搬进服务器。
 *
 * **旧键一个字节都不动。** 导入是「再写一份到服务端」，不是搬家 ——
 * 万一新版有问题，退回旧版打开还能看到原始数据。等新版用满一个月再清理。
 */

import { migrateV3, type MigrationResult } from '../domain/model.ts';

export const LEGACY_KEY = 'schedule-app-v1';

/** 这台设备的浏览器里还有没有旧版数据 */
export function hasLegacy(): boolean {
  try { return !!localStorage.getItem(LEGACY_KEY); } catch (_) { return false; }
}

export interface LegacyData extends MigrationResult {
  /** 旧数据里的版本号，只用来在提示里说明「从 v3 导入」 */
  version: number;
}

/**
 * 读出旧数据并转成 v4 实体。
 * @returns 没有旧数据 / 数据坏了 / 是空的，都返回 null。
 */
export function readLegacy(): LegacyData | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch (_) { return null; }
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw) as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') return null;

    const r = migrateV3(obj);
    // 一条内容都没有就别导 —— 空对象、或者只剩被迁移丢掉的备忘录，都没意义
    if (!r.tasks.length && !r.habits.length) return null;

    return { ...r, version: Number(obj.version) || 0 };
  } catch (_) {
    // 坏 JSON 就当作没有旧数据。**不能在这里抛** —— 它会在登录流程里
    // 把用户卡在「登录成功但打不开」的状态上。
    return null;
  }
}
