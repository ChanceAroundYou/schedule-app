/**
 * Tabbar.tsx —— 底部标签栏 + 「更多」抽屉
 */

import { useRef } from 'react';
import { Layers, MailPlus, MoreHorizontal, Settings } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import { counts } from '../../domain/model.ts';
import { useFocusTrap, useModalFocus } from '../hooks.ts';
import { Pulse } from './Pulse.tsx';
import { badge, DEFAULT_ORDER, navDef, type NavDef } from './nav.tsx';

/* ============================ 底部标签栏 ============================ */

/**
 * 底栏成员读 `ui.tabs`，顺序也取自它（`normalizeUi` 保证它是 navOrder 的子集，
 * 所以侧栏拖个序，底栏跟着变 —— 两个列表的顺序没必要让用户各记一套）。
 *
 * 「更多」恒占最后一格，所以总格数 ≤ 5。
 */
export function Tabbar({ state, onNav, onMore }: {
  state: LocalState; onNav: (k: string) => void; onMore: () => void;
}) {
  const c = counts(state);
  const tabs = state.ui.tabs.map(navDef);
  return (
    <nav className="tabbar">
      {tabs.map((t) => {
        const b = badge(t.count ? (c as unknown as Record<string, number>)[t.count] : 0);
        return (
          <button
            className={'tab' + (state.ui.nav === t.key ? ' active' : '')}
            key={t.key}
            aria-current={state.ui.nav === t.key ? 'page' : undefined}
            onClick={() => onNav(t.key)}
          >
            <span className="ti">{t.icon}</span>
            <span className="tn">{t.label}</span>
            {b && <span className={'tb' + (t.warn ? ' warn' : '')}>{b}</span>}
          </button>
        );
      })}
      {/* 「更多」在打卡 / 已完成 / 垃圾箱这几页要点亮 —— 那几页只能从这里进，
          没高亮的话用户看不出自己当前在哪。判据是「当前 nav 不在 ui.tabs 里」，
          与底栏成员读的是同一份数据，不另立一套常量。 */}
      <button className={'tab' + (!state.ui.tabs.includes(state.ui.nav) ? ' active' : '')} onClick={onMore}>
        <span className="ti"><MoreHorizontal size={18} /></span>
        <span className="tn">更多</span>
      </button>
    </nav>
  );
}

/* ============================ 「更多」抽屉 ============================ */

/**
 * 「更多」抽屉：底栏没放进去的功能项 + 日程集 / 邀请 / 设置。
 *
 * 前半截是**差集**（`navOrder` 减去 `ui.tabs`），不是写死哪几项 ——
 * 底栏那 4 格是用户自己挑的，写死就会出现「底栏有、这里也有」的重复项。
 *
 * **深浅 / 导入 / 导出 / 退出登录不在这儿**：它们只有设置页一个入口
 * （外观卡、数据卡、账户卡）。抽屉里再放一份就是第二套入口，两边迟早说不到一起。
 */
export function MoreSheet({ state, open, onClose, onNav, onInvites, onCals }: {
  state: LocalState; open: boolean; onClose: () => void; onNav: (k: string) => void;
  onInvites: () => void; onCals: () => void;
}) {
  const c = counts(state);
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, open);
  /* 这个浮层盖着一层遮罩，Tab 能溜到背后的侧栏上 —— 那正是 aria-modal
     答应读屏「外面别念」之后不能出现的事。 */
  useModalFocus(panel, open);

  if (!open) return null;

  const goto = (k: string) => { onNav(k); onClose(); };
  const pending = state.invites.length;

  /**
   * 底栏没放进去的功能项，在这里补一份。
   *
   * 顺序跟着 navOrder 走 —— 与侧栏一致，用户扫一眼就知道在哪儿。
   * 差集而不是「写死哪几项」：底栏那 4 格是用户自己挑的，写死就会
   * 出现「底栏有、这里也有」的重复项。
   */
  const inTabs = new Set(state.ui.tabs);
  const order = state.ui.navOrder.length ? state.ui.navOrder : DEFAULT_ORDER;
  const rest = order.filter((k) => !inTabs.has(k)).map(navDef);

  const navTile = (def: NavDef) => {
    const n = def.count ? (c as unknown as Record<string, number>)[def.count] : 0;
    const b = badge(n);
    return (
      <button className="ms-item" key={def.key} data-nav={def.key} onClick={() => goto(def.key)}>
        <span className="mi">{def.icon}</span><span className="mt">{def.label}</span>
        {b && <span className="mc">{b}</span>}
      </button>
    );
  };

  return (
    <>
      <div className="sheet-mask" aria-hidden="true" onClick={onClose} />
      <div
        className="more-sheet"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="更多"
        tabIndex={-1}
      >
        <div className="ms-grab" />
        <div className="ms-grid">
          {rest.map(navTile)}
          {!!pending && (
            <button className="ms-item" onClick={() => { onInvites(); onClose(); }}>
              <span className="mi"><MailPlus size={20} /></span><span className="mt">邀请</span>
              <span className="mc">{badge(pending)}</span>
            </button>
          )}
          {/* 日程集多选：窄屏侧栏收起，桌面那个下拉多选框不存在 —— 没有这一格
              手机上就没有任何地方能改「显示哪几个集」。徽标写「勾了几个 / 共几个」，
              因为「勾了哪几个」正是这个入口唯一要传达的事。 */}
          <button className="ms-item" data-cal-sheet-open onClick={() => { onCals(); onClose(); }}>
            <span className="mi"><Layers size={20} /></span><span className="mt">日程集</span>
            <span className="mc">{state.ui.cals.length}/{state.cals.length}</span>
          </button>
          <button className="ms-item" data-nav="settings" onClick={() => goto('settings')}>
            <span className="mi"><Settings size={20} /></span><span className="mt">设置</span>
          </button>
        </div>
        {/* 窄屏侧栏是收起的，进度搬进抽屉里，两处渲染的是同一个 Pulse */}
        <div className="ms-pulse"><Pulse state={state} /></div>
      </div>
    </>
  );
}
