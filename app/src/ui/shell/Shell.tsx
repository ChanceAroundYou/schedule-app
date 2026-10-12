/**
 * Shell.tsx —— 外壳：侧栏 / 主区 / 底栏 / 更多抽屉
 *
 * 三条必须守住的布局约定（都是踩坑换来的，改之前先读项目 CLAUDE.md）：
 *
 *   1. **顶栏绝对不能加 position / z-index / sticky。** 会生成层叠上下文，
 *      把里面的找日期面板（z-index 60）困住，被下方内容盖住变半透明。
 *      窄屏下顶栏随内容一起滚反而省垂直空间。
 *   2. **窄屏断点 900px** —— 这里的 `useIsNarrow()` 与 styles.css 的
 *      `@media (max-width: 900px)` 是同一根线，改一处必须改另一处。
 *   3. **浮层 z-index 必须 > 标签栏的 45**，否则抽屉被标签栏压住一截。
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { LocalState } from '../../domain/types.ts';
import { useIsNarrow } from '../hooks.ts';
import { useOverlayScrollbar } from '../scroll.ts';
import { Sidebar } from './Sidebar.tsx';
import { Tabbar, MoreSheet } from './Tabbar.tsx';
import { CalSheet } from '../Calendars.tsx';

export function Shell({
  state, contentRef, onNav,
  onInvites, more, setMore, topbar, quickAdd, children,
}: {
  state: LocalState;
  contentRef: React.RefObject<HTMLDivElement>;
  onNav: (k: string) => void;
  onInvites: () => void;
  /** 「更多」抽屉的开关放在 App 那边 —— Esc 要按 actSheet > 抽屉 > 找日期 的顺序关 */
  more: boolean; setMore: (v: boolean) => void;
  topbar: ReactNode;
  quickAdd: ReactNode;
  children: ReactNode;}) {
  const narrow = useIsNarrow();
  /* 主区会滚（长列表 / 周视图），原生那条一滚就把内容挤窄 —— 换浮条。
     `contentRef` 是从 App 传下来的，两个 ref 得一起写。 */
  const osbContent = useOverlayScrollbar<HTMLDivElement>(contentRef);

  /** 日程集多选弹窗（移动端「更多」里那格点出来的）。开关留在这一层：
   *  它和「更多」抽屉**互斥**（开它就关抽屉，见 MoreSheet 里那格），
   *  所以没有 Esc 顺序问题 —— 不用像 invOpen 那样提到 App 去。 */
  const [calOpen, setCalOpen] = useState(false);

  // 抽屉开着时给 body 一个标记：窄屏下 `.tab:active` 要压住，别在抽屉后面乱闪。
  // 旧版就有这个约定，重构时漏了，连带那条 CSS 规则一起成了死代码
  useEffect(() => {
    document.body.classList.toggle('sheet-open', more);
    return () => document.body.classList.remove('sheet-open');
  }, [more]);

  return (
    <div className="app">
      {!narrow && (
        <Sidebar state={state} onNav={onNav} />
      )}

      <main className="main">
        {topbar}
        {/* 日视图锁单屏：内容区不跟着滚（见 styles/calendar.css 的 .content-day）。
            判据是「日程页 + 日视图」—— 其它页面（列表 / 周 / 月）照常滚。 */}
        <div
          className={'content osb' + (state.ui.nav === 'calendar' && state.ui.view === 'day' ? ' content-day' : '')}
          id="content"
          ref={osbContent}
        >{children}</div>
        {quickAdd}
      </main>

      {narrow && <Tabbar state={state} onNav={onNav} onMore={() => setMore(true)} />}
      <MoreSheet
        state={state} open={more && narrow} onClose={() => setMore(false)}
        onNav={onNav} onInvites={onInvites}
        onCals={() => setCalOpen(true)}
      />
      {/* 只在窄屏开：桌面走顶栏那个下拉多选框，两边同时出现就是两套入口 */}
      <CalSheet state={state} open={calOpen && narrow} onClose={() => setCalOpen(false)} />
    </div>
  );
}
