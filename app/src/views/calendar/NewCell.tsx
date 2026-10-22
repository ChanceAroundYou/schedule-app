/**
 * NewCell.tsx —— 日历空白处「就地新建」
 *
 * 点日程表里任意一个空格子 → 就地出现一个输入框，**日期与时间由格子的位置决定**
 * （哪个格子落在哪一带 → 落到温泉的那个日期 + 时间）。回车保存、Esc 取消。
 * 日 / 周 / 月三个视图共用这一个组件，只有外框的定位不同 —— 定位由父级算好
 * 从 `style` 传进来（日视图按百分比、周视图按 px，两套分母不一样）。
 *
 * ⚠️ **不在它上面挂 onClick**，理由同 AGENTS.md「点击事件必须走委托」：
 * 这块的点击会被 `#content` 上那一个监听器接着。`data-act="draft"` 是给那边的
 * 早退信号 —— 否则「点输入框」会被当成「又点了一次空白」，草稿被重设。
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { commitDraftTask, setDraftNull } from '../../ui/newCell.ts';
import { isNarrowNow } from '../../ui/hooks.ts';
import { isNativeShell } from '../../app/kb.ts';
import type { DraftSeed, LocalState } from '../../domain/types.ts';


/**
 * 这个区域的草稿 —— 不是它名下的那个就不渲染。
 *
 * zone id 是 dnd 那边的命名（`timeline:2026-10-15` / `allday:…` / `week:…` /
 * `day:…`），点击派发器那边写的是同一套（见 app/clickDispatch.ts 的 openDraft）。
 * 一天在三个视图里名字不同，所以「这一天有没有草稿」天然是分区域的，不会串。
 */
export function draftOn(ui: LocalState['ui'], zoneId: string): DraftSeed | null {
  return ui.draft && ui.draft.zone === zoneId ? ui.draft : null;
}

/**
 * 视图里真正放的那个东西 —— 按 `zoneId` 认领自己的草稿，认到了才渲染。
 *
 * 五个地方用同一段（日视图的时间轴与全天区、周视图的列与未定时格、月视图的格子），
 * 差别只有**几何**（由各自的父级算好从 `style` 传进来）与要不要绝对定位。
 * 收成一段是因为「回车落成任务、清空草稿」这件事五处完全一致 —— 复制五遍的话，
 * 改一处就漏四处。
 */
export function NewCellSlot({
  state, zoneId, className, style,
}: {
  state: LocalState;
  zoneId: string;
  className?: string;
  style?: CSSProperties;
}) {
  const seed = draftOn(state.ui, zoneId);
  if (!seed) return null;
  return (
    <NewCell
      seed={seed}
      className={className}
      style={style}
      onCommit={(title) => {
        commitDraftTask(title, seed);
        setDraftNull();
        /* 不开抽屉：那条卡片已经竖在刚才那个位置上了，看得见就等于建好了。
           想补详细内容、设重复，再点它一次 —— 抽屉是「补细节」的地方，
           不承担「确定日期时间」。 */
      }}
      onCancel={() => setDraftNull()}
    />
  );
}

export function NewCell({
  seed, className, style, onCommit, onCancel,
}: {
  /** 这一格要建在哪。**引用变了就清空输入框** —— 点空白换个位置时，
      上一个框里已经打过的字不能跟过来（它已经被落成任务了）。 */
  seed?: DraftSeed;
  className?: string;
  /** 位置。日视图是百分比（top/height），周视图是 px */
  style?: CSSProperties;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  /* 三个出口（Enter / Esc / 点别处）都可能触发同一个动作（Esc → 卸载 → 再触发）。
     用一个闸门拦住第二次，否则「取消」会被当成「提交空串再取消」走两遍。 */
  const settled = useRef(false);
  /* 出生时刻。刚出现的 800ms 内**一律不做自动撤销** —— 键盘弹起动画就在这段里，
     任何基于「焦点/视口」的判定在这期间都不可靠（2026-10-17 真机两次踩坑）。 */
  const bornAt = useRef(Date.now());
  /* 被布局变化弄丢焦点后抢回来的次数。纯保险，防死循环，不参与结算。 */
  const focusTries = useRef(0);

  /* 一出现就聚焦（用户点格子的意图就是「要在这打字」）；
     **换了位置**（seed 是新对象）时还要清空文字 —— 上一处的字已经落成任务了，
     不能跟到新框里。settleDraftAndSet 每次都传新对象，所以换位置必触发。 */
  useEffect(() => {
    setText('');
    ref.current?.focus();
  }, [seed]);

  const settle = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };

  /* 直接读 DOM 值：受控 textarea 的 value 永远是最新的，
     比闭包里的 state 更不容易读到旧值（键盘/异步时序下踩过）。 */
  const commit = () => {
    const v = (ref.current?.value ?? '').trim();
    settle(() => (v ? onCommit(v) : onCancel()));
  };

  /* **收键盘 = 不想要这条**（用户 2026-10-17 提的原始需求）。
     ⚠️ 不能用 onBlur：安卓键盘弹起会把 App 高度撑变、布局重排，输入框会在
        200–400ms 之间被系统自己弄丢焦点 —— 那是布局后果，不是用户意图，
        拿它当「放弃」就会「输入法闪一下就没了」（真机踩过两轮）。
     ⚠️ 也不能用 visualViewport 差值：App 里键盘是 adjustResize（界面被压小），
        `innerHeight` 跟着变小，相减恒等于 0，等于从来没检测到过键盘
        （所以上一版「收键盘后框不消失」）。
     → 原生壳里用 `@capacitor/keyboard` 的 keyboardWillHide（见 app/kb.ts）。 */
  useEffect(() => {
    const onHide = () => {
      if (settled.current) return;
      if (Date.now() - bornAt.current < 300) return;   // 刚出现时收到的是残留事件
      const el = ref.current;
      if (el && !el.value.trim()) settle(onCancel);     // 只有空着才撤，有字不丢
    };
    window.addEventListener('kb:hide', onHide);
    return () => window.removeEventListener('kb:hide', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 原生壳里键盘是**盖在**界面上（capacitor.config.ts 关掉了 resizeOnFullScreen，
     2026-10-22 用户要的就是「别推上去，让键盘盖住时间表」）。代价是：框要是正好
     落在下半屏，就会被键盘整个挡住、只能盲打。所以弹起后把它挪到键盘上沿之上 ——
     **只滚最近的那个能滚的容器**，不碰布局，时间轴的高度一个像素都不变。 */
  useEffect(() => {
    if (!isNativeShell()) return;
    const onShow = () => {
      // 键盘动画约 200~300ms，量早了拿到的是弹起前的位置
      window.setTimeout(() => {
        const el = ref.current;
        if (!el) return;
        const kb = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--kb'),
        ) || 0;
        if (kb < 80) return;                       // 没真弹起来（或数值还没到）
        const over = el.getBoundingClientRect().bottom - (window.innerHeight - kb - 8);
        if (over <= 0) return;                     // 已经露在键盘上面
        let p: HTMLElement | null = el.parentElement;
        while (p) {
          const oy = getComputedStyle(p).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
            p.scrollTop += over;
            return;
          }
          p = p.parentElement;
        }
        window.scrollBy(0, over);                  // 都不滚就试整页
      }, 280);
    };
    window.addEventListener('kb:show', onShow);
    return () => window.removeEventListener('kb:show', onShow);
  }, []);

  /* 网页版（没有原生壳）保留 visualViewport 兜底 —— 手机浏览器里这条是有效的：
     键盘只压可视视口，布局视口不动，差值算得出真实高度。
     原生壳里直接跳过，否则它会把原生写好的 --kb 覆盖回 0、并误判收键盘。 */
  useEffect(() => {
    if (isNativeShell()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let kbSince = 0;              // 键盘被判定「弹起中」的起始时刻，0 = 没见过
    let hideTimer = 0;
    const inset = () => window.innerHeight - vv.height - vv.offsetTop;

    const onResize = () => {
      if (inset() > 120) {
        // 键盘占位变多。抖动会不断把起点往后推，只有真弹起才攒得住 400ms
        if (!kbSince) kbSince = Date.now();
        clearTimeout(hideTimer);
        return;
      }
      if (!kbSince) return;                    // 从没见过键盘
      if (Date.now() - kbSince < 400) {         // 弹起动画里的瞬态，不算数
        kbSince = 0;
        return;
      }
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (inset() > 120) return;              // 又弹回去了，是抖动
        kbSince = 0;
        if (settled.current) return;
        if (Date.now() - bornAt.current < 800) return;   // 刚出现，别动它
        const el = ref.current;
        if (!el) return;
        if (document.activeElement === el) {
          // 焦点还在 = 用户主动按了「收起键盘」→ 空的就当放弃
          if (!el.value.trim()) settle(onCancel);
        } else if (focusTries.current < 3) {
          // 焦点是键盘弹起时被布局弄丢的 → 抢回来，草稿留着
          focusTries.current += 1;
          el.focus();
        }
      }, 450);
    };
    vv.addEventListener('resize', onResize);
    return () => { clearTimeout(hideTimer); vv.removeEventListener('resize', onResize); };
    // 只挂一次：settled / onCancel 在整个生命周期里指向同一件事
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      data-act="draft"
      className={'new-cell' + (className ? ' ' + className : '')}
      style={style}
      rows={1}
      value={text}
      placeholder={isNarrowNow() ? '写点什么' : '写点什么，回车保存'}
      aria-label="新建任务"
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      /* ⚠️ 这里**故意没有 onBlur**。结算只看三件事：回车、Esc、手指点到框外。
         理由见上面 pointerdown 那段注释 —— 安卓键盘弹起会让框自己失焦。 */
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          settle(onCancel);
        }
      }}
    />
  );
}
