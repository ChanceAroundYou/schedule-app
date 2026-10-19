/**
 * QuickAdd.tsx —— 快速添加横条
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { quickDefaults } from '../../domain/model.ts';
import { useIsNarrow } from '../hooks.ts';
import { Textarea } from '../kit.tsx';
import { useOverlayScrollbar } from '../scroll.ts';
import { WhenPop } from '../overlays/WhenPop.tsx';
import { FastSide } from './FastSide.tsx';

/** 占位符**不随 tab 变** —— 需求 1B：展开后文本不需要跟着所在的 tab 变。
    按 tab 写不同文案的代价是「切个 tab，输入框里的话就变了」，用户会以为
    自己刚才打的东西被吃了。

    **短文案**（2026-10-19 用户：「不要写这么多，不要这么大，参考打卡的
    文本框」）—— 打卡那条只有一个「添加一个打卡项」级的短提示，这条原来
    是「新建任务，回车保存」七个字，配上两行高的框，比内容区第一条任务
    还高。回车保存这件事由 N 快捷键和保存按钮兜着，不占提示位。 */
const QUICK_PLACEHOLDER = '新建任务';

/**
 * 快速添加条**不出现**的页面（用户 2026-10-17：「待办箱和今天可以保留这个功能，
 * 逾期不需要这个功能；日程只需要点位置就地新建；打卡顶部已有添加入口」；
 * 项目同日程——只留点格子就地新建；已完成页同理：新任务不可能是已完成状态）。
 * 每个页面只保留**一种**最自然的新建入口，不做两套冗余的。
 */
const HIDDEN_NAVS = [
  'overdue',   // 逾期：复看页面，不在这建新的
  'calendar',  // 日程：点时间轴 / 格子就地新建（NewCellSlot）
  'projects',  // 项目：点泳道列空白处就地新建
  'habits',    // 打卡：顶部已有「添加打卡项」
  'done',      // 已完成：新建的任务不会是已完成
  'trash',
  'settings',
];

export function QuickAdd({ state, onSubmit }: {
  state: LocalState;
  onSubmit: (draft: { title: string; date: string | null; time: string | null; duration?: number | null; repeat?: unknown }, openDetail: boolean) => void;
}) {
  const narrow = useIsNarrow();
  const [text, setText] = useState('');
  /* 日期 / 时间的三态：`undefined` = 用户没表过态（用 tab 默认值），
     `null` = 用户明确说了「不要」，`'…'` = 选了这个。
     **必须区分 undefined 与 null** —— 否则「不设置」在「今天」页上会被
     默认值顶回来，点了跟没点一样（normalizeUi 的 navBottom 是同一类坑）。 */
  const [pendingDate, setPendingDate] = useState<string | null | undefined>(undefined);
  const [pendingTime, setPendingTime] = useState<string | null | undefined>(undefined);
  // 窄屏默认收起成右下角一个 FAB，点一下展开、再点收起（需求 3C）
  const [expanded, setExpanded] = useState(!narrow);
  /** 日期 / 时间那个面板（两层折叠，见 ui/WhenPop.tsx） */
  const [whenOpen, setWhenOpen] = useState(false);
  // 需求 3：关闭动画期间为 true。`.closing` class 触发 CSS 动画，
  // 动画结束后才真正 `setExpanded(false)`（内容 display:none）。
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  // 「N」快捷键与 FAB 都要先展开再聚焦 —— 展开是异步的，得等 DOM 更新
  const focusOnExpand = useRef(false);
  // 需求 2：点击外部关闭选择框后，**阻止 click 冒泡到 #content**，
  // 否则会触发日视图空白处的「新建任务」。
  const justClosed = useRef(false);
  const clockBtn = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const osbFast = useOverlayScrollbar<HTMLTextAreaElement>(inputRef);
  const barRef = useRef<HTMLDivElement>(null);

  // 需求 3：关闭横条时先播放收缩动画，动画结束后才真正 setExpanded(false)。
  // 直接 setExpanded(false) 会让内容立即 display:none，高度瞬间坍塌（"压扁"）。
  const closeBar = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setWhenOpen(false);
    closeTimer.current = window.setTimeout(() => {
      setExpanded(false);
      setClosing(false);
      closeTimer.current = undefined;
    }, 180);
  }, [closing]);

  // 展开时取消可能正在播放的关闭动画
  const openBar = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    setClosing(false);
    setExpanded(true);
  }, []);

  // 组件卸载时清理 timer
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const ui = state.ui;
  const def = quickDefaults(ui, D.today());
  /* 日期 / 时间只有两个来源：**面板选的** > **当前 tab 的默认值**。
     ⚠️ 以前这里还有第三档「从输入文本里自动识别」，2026-10-15 用户要求删掉 ——
        输入「买 3 本书」会被认成 3 号，猜错比不猜更糟。这条路整条移除了
        （`domain/parse/` 已删），要改日期就点时钟按钮显式选。 */
  const effDate = pendingDate !== undefined ? pendingDate : def.date;
  const effTime = pendingTime !== undefined ? pendingTime : def.time;

  const submit = (openDetail: boolean) => {
    const title = text.trim();
    if (!title) return;
    const date = pendingDate !== undefined ? pendingDate : def.date;
    const time = pendingTime !== undefined ? pendingTime : def.time;
    setText('');
    setPendingDate(undefined);
    setPendingTime(undefined);
    setWhenOpen(false);
    onSubmit({
      title,
      date,
      time,
    }, openDetail);
    // 交完就收起（窄屏）：任务已经落盘，横条还开着只是占地方。
    // **宽屏不收** —— 那边没有圆钮，横条是常驻的，收起来就点不回来
    // （「N」在宽屏只聚焦、不展开，见上面那个 keydown）。
    if (narrow) closeBar();
  };

  // 「N」聚焦输入框，跟旧版一致。窄屏下先展开再聚焦
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        /* 横条不显示的页面按 N 没意义（聚焦到一个 hidden 输入框上什么也不会发生） */
        if (HIDDEN_NAVS.includes(ui.nav)) return;
        e.preventDefault();
        if (narrow && !expanded) { setExpanded(true); focusOnExpand.current = true; }
        else inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [narrow, expanded, ui.nav]);

  // 展开之后才聚焦 —— 收起的横条是 display:none，聚焦不上去
  useEffect(() => {
    if (expanded && focusOnExpand.current) {
      focusOnExpand.current = false;
      inputRef.current?.focus();
    }
  }, [expanded]);

  /* 点外面收起 —— **两级，而且必须在同一个 handler 里**：
     面板开着就先收面板、横条留着；面板没开才收横条。
     分成两处挂会打架：两个都是 document 上的 capture 监听，谁先跑只看注册
     顺序，而面板又是横条的 DOM 子节点，「点在面板里」在两边都成立，
     必然有一边误判（先收横条的话，用户点空白想收面板却把整个输入框也收了）。
     横条与 + / × 里面的点击一律放行，交给各自的 onClick。

     收的时候**顺手把这记 click 吞掉**（justClosed + capture 阶段的
     stopPropagation）—— 不吞的话，点日视图空白会先收起横条、再顺手新建
     一条空任务（App 的委托挂在 #content 上，而 click 是从 document 往下
     走的，所以这里挡得住）。三条规矩：

     1. 输入框开着、点空白 → 关上，**不触发空白处的事件**；
     2. 顶栏 / 底栏是例外 —— 跟横条内部一样处理：**不收、也不吞**，点击照常
        落到内容上（「可以直接被点到内容」）。当「空白」处理的话，点一下搜索键
        会顺手把正在打字的横条收掉，那不是用户要的；
     3. 时间面板开着 → **点哪儿都只关面板**，顶栏 / 底栏也不例外
        （所以第 2 条那个例外只在前面的分支之后才轮到）。

     **只在真实 mousedown（e.isTrusted）时设置 justClosed** —— 合成事件
     （测试的 closeWhen()）只关面板，不该阻止后续 click。 */
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (barRef.current?.contains(t)) return;   // 横条 / 圆钮 / 面板内部
      if (whenOpen) {                            // 规矩 3
        setWhenOpen(false);
        if (e.isTrusted) justClosed.current = true;
        return;
      }
      // 宽屏没有 FAB，横条是常驻的，点空白只该收面板，不该把输入框收掉
      if (!narrow) return;
      // 规矩 2：顶栏 / 底栏不算「空白」—— 跟横条内部一样，不收、也不吞
      if ((t as HTMLElement).closest?.('.topbar, .tabbar')) return;
      closeBar();
      if (e.isTrusted) justClosed.current = true;   // 规矩 1
    };
    const onClick = (e: MouseEvent) => {
      if (!justClosed.current) return;
      justClosed.current = false;
      e.stopPropagation();
    };
    // 上一手势若没配上 click（比如在窗口外松手），标记会留在 true 上，
    // 下一记 click 就被白吞一次。pointerdown 一律先复位 —— 它总在 mousedown 前。
    const onPointerDown = () => { justClosed.current = false; };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [narrow, expanded, whenOpen, closeBar]);

  return (
    <>
      {/* 设置页 / 垃圾箱没有「往这儿加一条任务」这回事 —— 留着会让人以为加进设置里了 */}
      <div
        className={'fast-add' + (expanded ? ' open' : '') + (closing ? ' closing' : '')}
        ref={barRef}
        hidden={HIDDEN_NAVS.includes(ui.nav)}
        // 展开 / 关闭动画只该在窄屏（有圆钮、横条 fixed）时跑。用 JS 的 narrow
        // 而不是 CSS 的 @media：探针环境里两者不一致（JS 判窄、CSS 判宽），
        // 而圆钮和 fixed 定位本来就跟着 JS 的 narrow 走。
        data-narrow={narrow ? '' : undefined}
        style={narrow ? {
          position: 'fixed',
          left: '13px',
          right: '13px',
          // margin 也要在内联里清掉：基线上那条 `.fast-add { margin: 6px 22px 18px }`
          // 是给**流内**布局的，而 fixed + left/right 的定位里 margin 会**再加一层**偏移
          //（right:74px 实际让出 96px）。CSS 媒体块里虽然也清了，但媒体查询按**真实**
          // 视口宽度走，探针那种「JS 判窄、CSS 判宽」的环境里清不掉。
          margin: 0,
          bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))',
        } : undefined}
      >
        {/* 展开 / 关闭动画挂在**这一层**（见 styles/quick-add.css 的 fastPop / fastPopOut），
            不是挂在 `.fast-add` 上。圆钮（`.fast-fab`）是 `.fast-add` 的子节点、
            这一层的**兄弟** —— 父元素一 transform、一改 opacity，整棵子树跟着动，
            圆钮会被拖着右移 28px、缩小 4%、淡出，动画一结束再弹回原位
            （实测最大偏移 30.5px），看着就是「异常跳变」。所以动画和圆钮必须分层。 */}
        <div className="fast-add-shell">
          <div className="fast-add-body">
            {/* 单行小框（2026-10-19 用户「参考打卡的文本框」）：九成九是
                「一件事」，一行装得下。换行让给 Shift + Enter。 */}
            <Textarea
              ref={osbFast}
              rows={1}
              value={text}
              placeholder={QUICK_PLACEHOLDER}
              aria-label="快速添加"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              /* 点输入框 = 不选日期时间了，面板收掉。不收的话，面板钉在输入框
                 右边，打字时它一直挡在那儿（用户 2026-10-08 要求）。 */
              onClick={() => setWhenOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(e.ctrlKey || e.metaKey);
                }
                if (e.key === 'Escape') { e.currentTarget.blur(); }
              }}
            />
          </div>
          {/* 时间/保存按钮上下叠放（需求 4）：时间在上，保存在下，固定位置 */}
          <FastSide
            clockBtn={clockBtn}
            whenOpen={whenOpen}
            effDate={effDate}
            effTime={effTime}
            onToggleWhen={() => setWhenOpen((v) => !v)}
            onSave={() => submit(false)}
            canSave={!!text.trim()}
          />
        </div>
        <WhenPop
          open={whenOpen}
          anchor={clockBtn.current}
          date={effDate}
          time={effTime}
          todayIso={D.today()}
          loadOf={(iso) => jumpLoad(state, iso)}
          onDate={setPendingDate}
          onTime={setPendingTime}
          onClose={() => setWhenOpen(false)}
        />
        {/* 窄屏那个圆钮：在横条内（需求 2）。收起时是 +、展开时原地变 ×。 */}
        {narrow && (
          <button
            className={'fast-fab' + (expanded ? ' open' : '')}
            type="button"
            title={expanded ? '收起快速添加' : '快速添加'}
            aria-label={expanded ? '收起快速添加' : '快速添加'}
            aria-expanded={expanded}
            onClick={() => {
              // 收起时顺手把面板也收了：面板挂在横条里，横条没了它也就没了，
              // 留着 whenOpen 下次展开会「凭空」弹出上一次的面板
              if (expanded) closeBar();
              // 展开**不自动聚焦**（需求 2）：手机上那会当场弹出软键盘，把用户
              // 想先看一眼的输入框挡住。要打字自己点一下输入框 —— 键盘的 N
              // 仍然聚焦（那是明确要输入，见上面那个 useEffect）。
              else openBar();
            }}
          >{expanded ? <X size={20} /> : <Plus size={20} />}</button>
        )}
      </div>
    </>
  );
}

/** 供 QuickAdd 内部用的「某天任务数」—— 从 JumpPop 复制过来避免循环依赖 */
function jumpLoad(state: LocalState, isoDay: string): number {
  let n = 0;
  for (const k in state.tasks) {
    const t = state.tasks[k];
    if (t.date === isoDay && !t.deleted && !t.done) n++;
  }
  return n;
}
