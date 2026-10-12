/**
 * Sidebar.tsx —— 侧栏
 */

import { useEffect, useRef, useState } from 'react';
import { CalendarCheck, MoreHorizontal, Settings } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import { counts } from '../../domain/model.ts';
import { useOutsideClose } from '../hooks.ts';
import { useOverlayScrollbar } from '../scroll.ts';
import { Btn } from '../kit.tsx';
import { Pulse } from './Pulse.tsx';
import { badge, DEFAULT_ORDER, navDef } from './nav.tsx';

function Sidebar({ state, onNav }: {
  state: LocalState; onNav: (k: string) => void;
}) {
  const c = counts(state);
  const order = state.ui.navOrder.length ? state.ui.navOrder : DEFAULT_ORDER;
  const bottom = state.ui.navBottom;
  /* 用户主动藏起来的项（设置 → 外观 → 功能区 取消勾选）。**在渲染这一层过滤**，
     不从 `navOrder` 里删 —— 那个字段每次 normalizeUi 都会把缺的键补回来
     （老用户看不到新页），所以「不在 navOrder 里」表达不了「不要它」。 */
  const hidden = new Set(state.ui.navHidden);
  const shown = order.filter((k) => !hidden.has(k));

  // 主区 = 顺序里不属于底部组的；底部组 = 底部数组里的（按底部数组自己的顺序）
  const main = shown.filter((k) => !bottom.includes(k));
  const bottoms = bottom.filter((k) => !hidden.has(k)).map(navDef);

  /* 被藏起来的那几项 —— 侧栏底部「更多」列的就是它（顺序跟着 navOrder）。
     桌面没有底栏那个「更多」抽屉，不给个入口的话一勾掉就只剩设置页能找回来。 */
  const tucked = order.filter((k) => hidden.has(k));

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRoot = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  /* 浮条：侧栏自己会滚（导航 + 进度 + 底部两键），原生那条一滚就把整列
     挤窄一截 —— 见 ui/scroll.ts。 */
  const osbSide = useOverlayScrollbar<HTMLElement>();
  useOutsideClose(moreRoot, moreOpen, () => setMoreOpen(false));
  /* Esc 关掉并把焦点还给触发键 —— 同 CalMenu（不还的话焦点掉到 body 上，
     键盘用户得从页首重新 Tab 一遍）。 */
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoreOpen(false); moreBtn.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  /* `onPick` 只有「更多」浮层里那份要传（点完得把浮层收掉）。浮层里的行也挂
     `data-nav`：它**就是**一条导航项，没必要另立一个锚点。 */
  const item = (k: string, onPick?: () => void) => {
    const def = navDef(k);
    const n = def.count ? (c as unknown as Record<string, number>)[def.count] : 0;
    const b = badge(n);
    return (
      <button
        className={'nav-item' + (state.ui.nav === k ? ' active' : '')}
        key={k}
        data-nav={k}
        /* 当前在哪一页：视觉上靠 .active 那点底色，读屏只认这个属性。
           侧栏和底部标签栏指同一件事（同一份 ui.nav），两处都写。 */
        aria-current={state.ui.nav === k ? 'page' : undefined}
        onClick={onPick || (() => onNav(k))}
      >
        <span className="ico">{def.icon}</span>
        <span className="label">{def.label}</span>
        {b && <span className={'count' + (def.warn ? ' warn' : '')}>{b}</span>}
      </button>
    );
  };

  return (
    <aside className="sidebar osb" ref={osbSide}>
      <div className="brand">
        <div className="brand-logo"><CalendarCheck size={24} /></div>
        <div className="brand-name">日程清单</div>
      </div>

      {/* 日程集多选**不在侧栏**：侧栏顺序是用户自己排的，塞个常驻控件进去会跟
          「底栏挑哪几项」抢位置。桌面在顶栏（CalMenu），移动端在「更多」里
          （CalSheet）—— 两处都见 Calendars.tsx。 */}
      <nav className="nav" id="nav">{main.map((k) => item(k))}</nav>
      <nav className="nav nav-bottom" id="navBottom">{bottoms.map((d) => item(d.key))}</nav>

      <Pulse state={state} />

      <div className="sidebar-footer">
        {/* 设置不参加排序，入口固定在这儿（和窄屏「更多」里那格是同一件事）。
            导入 / 导出 / 深浅 / 退出登录**只留在设置页一处** —— 这里原先各有一份
            重复入口，收进设置页之后侧栏底部只留设置这一个动作。 */}
        <Btn variant="ghost" className="ghost-btn" data-nav="settings" onClick={() => onNav('settings')}>
          <Settings size={13} /> 设置
        </Btn>
        {/* 一个都没藏就不画 —— 空浮层比没有更费解。 */}
        {!!tucked.length && (
          <div className="side-more" ref={moreRoot}>
            <Btn
              ref={moreBtn}
              variant="ghost"
              className="ghost-btn"
              data-nav-more="1"
              aria-haspopup="true"
              aria-expanded={moreOpen}
              aria-label="更多功能"
              onClick={() => setMoreOpen(!moreOpen)}
            >
              <MoreHorizontal size={13} /> 更多
            </Btn>
            {moreOpen && (
              <div className="side-more-pop" role="group" aria-label="更多功能">
                {tucked.map((k) => item(k, () => { onNav(k); setMoreOpen(false); }))}
              </div>
            )}
          </div>
        )}
        <div className="tip">数据已同步到服务器，本机也留了一份</div>
      </div>
    </aside>
  );
}

export { Sidebar };
