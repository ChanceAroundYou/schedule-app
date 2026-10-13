/**
 * widget.ts —— 把状态推给桌面小组件
 *
 * **数据通道**：App 每次数据变化 → 序列化成快照 JSON →
 * `@capacitor/preferences`（底层就是 MODE_PRIVATE SharedPreferences，
 * 原生侧能直接读）→ 发广播让小组件重画。
 *
 * 为什么绕这么一圈：小组件是独立进程，读不到 IndexedDB、跑不了 React，
 * 更不能走同步引擎。SharedPreferences 是唯一两边都能读写的地方。
 *
 * **只写不读**：小组件不需要反向读（它自己从那份 JSON 画）。
 * 打卡的勾选回写是另一条路，见 `pendingWidgetOps.ts`。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { serializeWidgetSnapshot } from '../domain/widgetSnapshot.ts';
import type { LocalState } from '../domain/types.ts';

/** 原生侧读同一个 key。**两边必须一致**，改这里要同步改 Kotlin */
export const WIDGET_SNAPSHOT_KEY = 'schedule_widget_snapshot';

interface WidgetBridgePlugin {
  /** 通知指定小组件重画。provider 传组件类全名 */
  refresh(options: { provider: string }): Promise<{ ids: number }>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge');

/**
 * 把当前状态写进 SharedPreferences 并通知小组件。
 *
 * **静默失败**：写快照失败不影响用户正在做的事（他只是桌面没更新而已），
 * 所以这里不抛。真正该被用户看到的是同步失败，那个走 `state.lastError`。
 */
export async function publishWidgetSnapshot(state: LocalState): Promise<void> {
  let json: string;
  try {
    json = serializeWidgetSnapshot(state);
  } catch (_) {
    return;
  }

  try {
    await Preferences.set({ key: WIDGET_SNAPSHOT_KEY, value: json });
  } catch (_) {
    return;
  }

  if (!Capacitor.isNativePlatform()) return;

  // 小程序件可能有多个，各自都刷一遍。类名写在这里而不是让原生写死 ——
  // 见 WidgetBridge.java 的注释
  const providers = [
    'space.xiaokubao.schedule.ScheduleWidgetProvider',
    'space.xiaokubao.schedule.HabitWidgetProvider',
  ];
  for (const p of providers) {
    try { await WidgetBridge.refresh({ provider: p }); } catch (_) { /* 这个没有实例 */ }
  }
}
