/**
 * nav.ts —— 导航表与工具函数
 */

import type { ReactNode } from 'react';
import {
  AlarmClock, CalendarDays, CheckCircle2, Flame,
  FolderKanban, Inbox, Plus, Settings, Sparkles, Sun, Trash2,
} from 'lucide-react';
import { CUSTOMIZABLE } from '../../domain/model.ts';

export interface NavDef {
  key: string;
  label: string;
  icon: ReactNode;
  count?: 'inbox' | 'today' | 'overdue' | 'habits' | 'trash';
  warn?: boolean;
}

/** 图标一律 lucide，不用 emoji —— 语义精确、跨平台字形一致 */
export const NAV: NavDef[] = [
  { key: 'inbox', label: '待办箱', icon: <Inbox size={16} />, count: 'inbox' },
  { key: 'today', label: '今天', icon: <Sun size={16} />, count: 'today' },
  { key: 'overdue', label: '逾期', icon: <AlarmClock size={16} />, count: 'overdue', warn: true },
  { key: 'calendar', label: '日程', icon: <CalendarDays size={16} /> },
  { key: 'projects', label: '项目', icon: <FolderKanban size={16} /> },
  { key: 'habits', label: '打卡', icon: <Flame size={16} />, count: 'habits' },
  // 「+1」= 计数器页（naonao / Kutai，每天自动 +N）。排在打卡后面：
  // 两个都是「每天记一笔」的东西，放一起用户找得着。
  { key: 'counter', label: '+1', icon: <Plus size={16} /> },
  { key: 'done', label: '已完成', icon: <CheckCircle2 size={16} /> },
  { key: 'ai', label: 'AI', icon: <Sparkles size={16} /> },
];

export const TRASH_NAV: NavDef = { key: 'trash', label: '垃圾箱', icon: <Trash2 size={16} />, count: 'trash' };

/**
 * 设置**不在** `ui.navOrder` 里（见 domain/model.ts 的 CUSTOMIZABLE）：
 * 它得能被打开，才谈得上改回来。所以它只进这张表，不参加排序。
 */
export const SETTINGS_NAV: NavDef = { key: 'settings', label: '设置', icon: <Settings size={16} /> };

const ALL_NAV = [...NAV, TRASH_NAV, SETTINGS_NAV];

/**
 * 按 nav key 取定义。**导出给设置页用** —— 那边的「功能区」卡片要画同一套
 * 图标与名字，在这儿另抄一份的下场是改了 label 忘了改那边。
 *
 * 认不出的 key 回落到垃圾箱：设置页只可能拿到 CUSTOMIZABLE 里的键，
 * 但拖拽时 dataTransfer 里塞的是用户数据，宁可画错也不要白屏。
 */
export const navDef = (k: string): NavDef => ALL_NAV.find((n) => n.key === k) || TRASH_NAV;

/** 没有 navOrder 时的兜底。取自 domain 的白名单，别在这里另抄一份 */
const DEFAULT_ORDER: readonly string[] = CUSTOMIZABLE;

/** `>99` 显示 `99+` —— 徽标再宽就挤垮布局了 */
export function badge(n: number): string | null {
  if (!n) return null;
  return n > 99 ? '99+' : String(n);
}

/** 供 Shell / Sidebar / MoreSheet / Tabbar 共用 */
export { DEFAULT_ORDER };
