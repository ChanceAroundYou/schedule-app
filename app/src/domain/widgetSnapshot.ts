/**
 * widgetSnapshot.ts —— 给桌面小组件看的「快照」
 *
 * **为什么需要它**：小组件是**独立进程**，不能读 IndexedDB、不能跑 React、
 * 更不能走同步引擎。它只能读原生 SharedPreferences 里的一份静态 JSON。
 * 这个文件就是负责把 `LocalState` 压成那份 JSON 的**纯函数**（放进 domain/
 * 是因为它没有 React / DOM / 网络，可以直接单测）。
 *
 * **一次装多周**：小组件上「上一周 / 下一周」的箭头是**原地切周**的，
 * 不能去开 App 取数 —— 那等于打开应用，小组件就没意义了。所以快照必须
 * 前后各带 4 周，共 9 周的数据。量很小（几十 KB），SharedPreferences 无压力。
 *
 * 键名刻意短（date/time/dur/title/done）：这份 JSON 每次数据变化都要
 * 重写一遍，缩短名字是为了让重写尽量便宜。
 */

import type { LocalState } from './types/types.ts';
import * as D from './date.ts';
import { liveTasks, liveHabits, habitStreak } from './model.ts';

/** 前后各带几周。少了箭头切不远，多了白写 —— 9 周够了 */
export const WIDGET_WEEKS = 4;

export interface SnapshotTask {
  /** 原生侧勾选 / 改期要用 —— 没有它小组件就只读不能写 */
  id: string;
  /**
   * 属于哪个集。**原生直连服务器时必带** —— 服务端的 applyOps 靠它查权限，
   * 缺了整条 op 会被丢掉（那边只做 `if (!calId) continue`，不报错）。
   * 这个坑的表现是「桌面点了半天，服务器没变」，最难查。
   */
  calId: string;
  date: string;
  /** null = 未定时 */
  time: string | null;
  dur: number | null;
  title: string;
  done: boolean;
}

export interface SnapshotHabit {
  id: string;
  /** 同上：原生打卡写服务器的必填项 */
  calId: string;
  title: string;
  /** 今天打过没有 */
  done: boolean;
  /** 连续天数 */
  streak: number;
}

export interface WidgetSnapshot {
  /** 快照格式版本。**形状变了要升它** —— 原生侧按这个字段判断要不要丢旧数据 */
  v: 1;
  /** 生成时刻（毫秒）。小组件上显示「更新于 …」用 */
  at: number;
  /**
   * 「今天」是哪天。小组件判今天、画「现在」红线都用它。
   *
   * **由服务端/App 给，不让原生自己算** —— 手机时区或时钟不准时，
   * 原生算出来的「今天」会跟服务端不一致，打卡就会写到隔壁那天去。
   * 从服务端 bootstrap 回来的那份也带这个字段（同一个含义）。
   */
  today: string;
  /** 覆盖范围的起止（含），按周一开头 */
  from: string;
  to: string;
  tasks: SnapshotTask[];
  habits: SnapshotHabit[];
}

/** 快照覆盖的日期范围：本周往前 4 周、往后 4 周 */
export function widgetRange(todayIso: string = D.today()): { from: string; to: string } {
  const monday = D.weekStart(todayIso);
  const from = D.addDays(monday, -7 * WIDGET_WEEKS);
  const to = D.addDays(monday, 7 * WIDGET_WEEKS + 6);
  return { from, to };
}

/** 把本地状态压成小组件快照 */
export function buildWidgetSnapshot(s: LocalState, todayIso: string = D.today()): WidgetSnapshot {
  const { from, to } = widgetRange(todayIso);

  // liveTasks 已经剔掉垃圾箱 / 彻底删除的，这里只按日期窗口再过滤一次
  const tasks: SnapshotTask[] = liveTasks(s)
    .filter((t) => {
      const d = t.date;
      return !!d && d >= from && d <= to;
    })
    .map((t) => ({
      id: t.id,
      calId: t.calId,
      date: t.date as string,
      time: t.time,
      dur: t.duration,
      title: t.title,
      done: t.done,
    }))
    // 排序：日期 → 时间（**未定时的排在最后**，跟 App 里「未定时区在最上方
    // 但属于同一段」的语义不同：这里是列表，未定时没有时刻就没有位置）
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
    });

  const habits: SnapshotHabit[] = liveHabits(s)
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))
    .map((h) => ({
      id: h.id,
      calId: h.calId,
      title: h.title,
      done: !!(h.log && h.log[todayIso]),
      streak: habitStreak(h, todayIso),
    }));

  return { v: 1, at: Date.now(), today: todayIso, from, to, tasks, habits };
}

/** 序列化。**给原生读的那一份**，键名短、无缩进 */
export function serializeWidgetSnapshot(s: LocalState): string {
  return JSON.stringify(buildWidgetSnapshot(s));
}
