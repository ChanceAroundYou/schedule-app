/**
 * TaskCard.tsx —— 日 / 周 / 月三视图**共用**的那张任务卡
 *
 * ## 为什么单开一个文件（2026-10-17）
 *
 * 原先这张卡写在 `DayView.tsx` 里，周视图另有一套 `.wk-event` 紧凑块。
 * 两套并存的结果是：日视图能就地勾选、能拖上下沿改时长、会随时间窗自动隐藏
 * 第二行；周视图三样都没有，改一处就要问「另一处要不要跟着改」。
 * 用户明确要「样式上更多复用日视图」，于是卡片本体搬到这里，两个视图都从这里拿。
 *
 * ## 分工
 *
 * 父级负责**数据**（传进来的 `style` / `variant` / `timeText`），这里负责**样子**：
 * 勾选圈 + 标题一行、时间段一行、备注一行、上下沿的拉伸把手。
 * 「两种卡片是同一套」不是口号 —— 真的只有这一段 DOM。
 */

import type { CSSProperties } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { DraftSeed, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  minToPct, pctRange, spanOf, timeRange, timeRangeCompact, CARD_SEAM,
  type DayWindow,
} from '../../domain/layout.ts';
import { CheckBtn, RepeatFlag } from '../parts.tsx';
import { useDraggableEvent } from '../../ui/dndkit.tsx';
import { useDragGhost } from '../../ui/dnd/lift.ts';
import { isNarrowNow } from '../../ui/hooks.ts';
import { useStackTop, setStackTop, type LayoutEvent } from './shared.ts';

/**
 * 压缩阶梯（2026-10-24 第五轮，用户定）：**卡片装不下时只许压，不许加长**。
 * 上一轮我给的是「压行距 → 再不够给这张卡一个 `min-height`」，用户明确否掉了：
 * 「没有什么地方是给卡片加长的兜底」—— 卡高就是时长，顶高一点等于把 61 分钟画成 68 分钟。
 * 于是改成一档一档往下压，判据是**量出来的**（文字行有没有超出卡片边界、
 * 时间行有没有被横向裁），不是照令牌猜：窄屏周视图一列 78px、窄屏一小时只有 ~20.5px，
 * 猜的值两头都对不上。
 *
 * **两个轴分开压**（一条阶梯两头共用会把不该缩的字也缩掉）：
 *
 * | 轴 | 判据（都是量出来的） | 阶梯 |
 * |---|---|---|
 * | 纵向 | `.ev-text` 的 scrollHeight 高出 `.ev-body` 的 clientHeight | ① 行距压到字号本身 ② 卡内上下留白归零 ③ 标题字号一轮降 0.5px，下限 9px |
 * | 横向 | `.ev-time` 的 scrollWidth 超出自己的 clientWidth | 源头先省（紧凑写法）→ ① 字距收紧 ② **时间行自己的**字号一轮降 0.5px，下限 7.5px |
 *
 * 为什么必须分两头（第四轮实测出来的）：合成一条阶梯时，窄屏周视图为了「时间行横向装不下」
 * 把**标题**也缩了一档，于是同一屏上 60 分钟卡 11px、61 分钟卡 10px ——
 * 「未定时与定时同字号」那条约定（用户 2026-10-22 专门要过）当场破了。
 * **横向的洞是时间行自己的，就该只压时间行。**
 *
 * 时间文本一律走**紧凑写法**（`09:30–10:30`，见 `timeRangeCompact`）：省下的正是两个空格
 * 和那根长破折号。抽屉 / 列表 / 气泡仍是完整写法，值不变。
 *
 * 两轴落在第几档写在卡上的 `data-fit`（形如 `v1h2`），探针按它读数 ——
 * 「压到哪一档」是要能看见的。
 */
const V_MAX = 3;
const H_MAX = 2;
/** 字号不是一档定死：一轮降半像素，直到装得下或读到可读下限。
 *  写死一档（−1.5px）时 30 分钟的卡差 1px 装不下，只能报「压到底还是不行」。 */
const FS_STEP = 0.5;
const FS_MIN_TITLE = 9;
const FS_MIN_TIME = 7.5;
const FIT_VARS = [
  '--ev-title-lh', '--ev-time-lh', '--ev-title-fs', '--ev-time-fs', '--ev-time-ls',
  '--tl-event-pad', '--allday-pill-pad', '--check-fs',
];

type Tokens = { titleFs: number; timeFs: number };
/** 两轴各自的档位与字号轮数（v / h = 第几档，vs / hs = 到字号档后降了几轮） */
type FitState = { v: number; vs: number; h: number; hs: number };
let tokenCache: { key: string; tk: Tokens } | null = null;
/** 每张卡落在哪一档 —— 元素级私有。DOM 上那条 `data-fit` 是给人和探针看的读数，
 *  不该反过来当状态源（读回字符串还得再解析一遍）。 */
const fitByCard = new WeakMap<HTMLElement, FitState>();

function readTokens(narrow: boolean): Tokens {
  const d = document.documentElement;
  const key = narrow + '|' + (d.dataset.style || '') + '|' + (d.dataset.theme || '');
  if (tokenCache && tokenCache.key === key) return tokenCache.tk;
  const cs = getComputedStyle(d);
  const v = (name: string, fallback: number) => {
    const x = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  const tk: Tokens = { titleFs: v('--fs-title', 12.5), timeFs: v('--fs-meta', 10.5) };
  tokenCache = { key, tk };
  return tk;
}

/** 当前这一档下，标题行与时间行各自的字号 */
function fsOf(tk: Tokens, st: FitState): { title: number; time: number } {
  return {
    title: st.v >= 3 ? Math.max(FS_MIN_TITLE, tk.titleFs - st.vs * FS_STEP) : tk.titleFs,
    time: st.h >= 2 ? Math.max(FS_MIN_TIME, tk.timeFs - st.hs * FS_STEP) : tk.timeFs,
  };
}

/** 某一档往卡上写哪些变量。(0, 0) 一个都不写（CSS 默认值就是宽松档）。 */
function fitVars(tk: Tokens, st: FitState): Record<string, string> {
  const px = (x: number) => x.toFixed(2) + 'px';
  const fs = fsOf(tk, st);
  const out: Record<string, string> = {};
  if (st.v >= 1) {
    /* 行距档：**行高 = 字号本身**（标题）、时间行再紧一点（×0.92）。
       1.05 / 1.0 试过一轮，桌面周视图 61 分钟的卡差 1.2px 过不去，一路滑到字号档 ——
       于是同一屏上 60 分钟卡 12.5px、61 分钟卡 11px，看着像两版皮肤。
       这一档压到底就把绝大多数卡留在「字号不动」那一层。 */
    out['--ev-title-lh'] = px(fs.title);
    out['--ev-time-lh'] = px(fs.time * 0.92);
  }
  if (st.v >= 2) {
    /* 卡内上下留白让给文字。**不能改 `--card-pad-y`**：卡片消费的是
       `--tl-event-pad` / `--allday-pill-pad`，那两条声明在 `:root` 上、
       `var(--card-pad-y)` 在那一刻就替换完了 —— 在卡上覆盖 `--card-pad-y` 等于没改
       （CSS 自定义属性的替换发生在**声明它的那个元素**上）。所以直接覆盖消费的那两条。 */
    out['--tl-event-pad'] = '0px var(--card-pad-x)';
    out['--allday-pill-pad'] = '0px var(--card-pad-x)';
  }
  if (st.v >= 3) {
    /* ⚠️ 缩了标题字号必须同时报 `--check-fs`：圈跟的是「所在那一行的字号」（tokens 五条第 5 条），
       它默认吃 1em = 卡片自己的 `--fs-title`，标题缩到 10 而圈还按 12.5 算 = 圈比任务名大。 */
    out['--ev-title-fs'] = px(fs.title);
    out['--check-fs'] = px(fs.title);
  }
  if (st.h >= 1) out['--ev-time-ls'] = '-.25px';   // 字距收紧（横向那一轴）
  if (st.h >= 2) out['--ev-time-fs'] = px(fs.time);
  return out;
}

function writeFit(card: HTMLElement, tk: Tokens, st: FitState) {
  for (const name of FIT_VARS) card.style.removeProperty(name);
  const vars = fitVars(tk, st);
  for (const [k, v] of Object.entries(vars)) card.style.setProperty(k, v);
  fitByCard.set(card, { ...st });
  card.dataset.fit = 'v' + st.v + 'h' + st.h;
}

/** 纵向：文字块高出内容层就是被 overflow 剪了半截字 */
function vFits(body: HTMLElement): boolean {
  const text = body.querySelector<HTMLElement>('.ev-text');
  return !text || text.scrollHeight - body.clientHeight <= 0.5;
}

/**
 * 横向：时间行超出自己可用宽 = 尾巴变省略号。
 * 标题允许被裁（长标题本来就该裁），时间行不允许 —— 用户：「时间要求完整显示」。
 *
 * ⚠️ 纵向判据用 **scrollHeight 比 clientHeight**，不用「行的矩形在不在卡里」：
 * 后者在只超出 1px 时会通过 —— `align-items: center` 把超出量**上下各分一半**，
 * 11px 的行装在 10.14px 的框里只各露 0.43px，卡在 0.5px 容差里出不来（实测就是
 * 这样停在 11px 没继续压）。探针与这里必须同一口径，否则一边绿一边红。
 */
function hFits(body: HTMLElement): boolean {
  const time = body.querySelector<HTMLElement>('.ev-time');
  return !time || time.scrollWidth - time.clientWidth <= 0.5;
}

/** 还能再压一档吗；到字号下限就到此为止（不许把字压成读不清） */
function stepV(st: FitState, tk: Tokens): boolean {
  if (st.v < V_MAX) { st.v++; return true; }
  if (tk.titleFs - (st.vs + 1) * FS_STEP >= FS_MIN_TITLE) { st.vs++; return true; }
  return false;
}
function stepH(st: FitState, tk: Tokens): boolean {
  if (st.h < H_MAX) { st.h++; return true; }
  if (tk.timeFs - (st.hs + 1) * FS_STEP >= FS_MIN_TIME) { st.hs++; return true; }
  return false;
}
/** 往回松一档（字号能保住就保住）。已经是最松则返回 false。 */
function relaxV(st: FitState): boolean {
  if (st.v >= 3 && st.vs > 0) { st.vs--; if (st.vs === 0) st.v = 2; return true; }
  if (st.v > 0) { st.v--; return true; }
  return false;
}
function relaxH(st: FitState): boolean {
  if (st.h >= 2 && st.hs > 0) { st.hs--; if (st.hs === 0) st.h = 1; return true; }
  if (st.h > 0) { st.h--; return true; }
  return false;
}

/**
 * **压缩阶梯** + **标题按整行裁**（合成一个 hook：阶梯一改行距就变，裁的行数必须重算）。
 *
 * 只吃 `.ev-body` 那一个 ref：卡片就是它的父元素，而变量要写在**卡片**上
 * （`--ev-*` 得让卡里的行都读到）。`drag.ref` 是 dnd-kit 的回调 ref，不是 RefObject，
 * 再套一层本地 ref 只是给「谁持有这个元素」添第二个真相。
 *
 * 用 ResizeObserver 而不是窗口 resize：卡片高度跟着时间轴百分比走，
 * 时间窗一改、卡片没动窗口也变了；跟着自己尺寸走才准。
 * 起点取这张卡上一次的档位（弱字典里存着），避免每次 resize 都从最松档重扫一遍。
 */
function useCardFit(bodyRef: { current: HTMLElement | null }, mustShowTime: boolean = false) {
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const card = body ? body.parentElement : null;
    if (!card || !body) return;
    const apply = () => {
      /* 令牌每轮重读：跨过断点（窄屏 ⇄ 桌面）时字号档会变，挂在闭包里的旧值
         会把窄屏的卡按桌面的字号去压。readTokens 按「断点 | 风格 | 明暗」缓存，
         同一档下每张卡每轮只读一次 computed style。 */
      const tk = readTokens(isNarrowNow());
      const st: FitState = fitByCard.get(card) ?? { v: 0, vs: 0, h: 0, hs: 0 };
      const put = () => { writeFit(card, tk, st); clampTitleLines(body); };
      const timeEl = body.querySelector<HTMLElement>('.ev-time');
      /* 先把时间行显示出来（默认态），再按空间决定是否藏掉 */
      if (timeEl) card.removeAttribute('data-notime');
      put();
      /* 装不下就一档一档压到底 */
      while (!vFits(body) && stepV(st, tk)) put();
      while (!hFits(body) && stepH(st, tk)) put();
      /* 压到底还装不下、且**不必**显示时间行 → 藏掉时间行，重新按「只有标题」的布局压 */
      if (timeEl && !mustShowTime && !vFits(body)) {
        card.setAttribute('data-notime', '');
        Object.assign(st, { v: 0, vs: 0, h: 0, hs: 0 });
        put();
        while (!vFits(body) && stepV(st, tk)) put();
        while (!hFits(body) && stepH(st, tk)) put();
      }
      /* 压完再逐轴往回松：先试松的，**两轴都还装得下**才留，否则退回。
         缩字号是最后手段，不该常驻在本来装得下的卡上。 */
      const bothFit = () => vFits(body) && hFits(body);
      for (const relax of [relaxV, relaxH]) {
        for (;;) {
          const backup = { ...st };
          if (!relax(st)) break;
          put();
          if (!bothFit()) { Object.assign(st, backup); put(); break; }
        }
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(body);
    return () => ro.disconnect();
  }, [mustShowTime]);
}

/**
 * 标题的 max-height 钉在行高的整数倍上：装不下一整行就整行不显示，不留半截字
 * （2026-10-22 九条第 9 条）。
 *
 * 时间行 / 详细内容行**先占位再算标题**：卡片矮的时候宁可少一行标题，
 * 时间那行也留得住（新规则：空间够就显示；>60 分钟必须露出来）。
 * 那两行的高度**量真实布局值**，不用 `--fs-meta × 1.2` 去猜 —— 压缩阶梯改的正是
 * 那一行自己的行距，猜的值两头都对不上。
 */
function clampTitleLines(body: HTMLElement) {
  const title = body.querySelector<HTMLElement>('.ev-title');
  if (!title) return;
  const text = body.querySelector<HTMLElement>('.ev-text');
  const lh = parseFloat(getComputedStyle(title).lineHeight) || 16;
  const aux = Array.from(body.querySelectorAll<HTMLElement>('.ev-time, .ev-note'));
  /* 被 CSS `display:none` 掉的行 offsetHeight 为 0，不给它占位。
     行距挂在 `.ev-text` 上（那一块才是逐行排的），不在 `.ev-body`。 */
  const gap = text ? (parseFloat(getComputedStyle(text).rowGap) || 0) : 0;
  const taken = aux.reduce((s, n) => s + n.offsetHeight + gap, 0);
  const room = body.clientHeight - taken;
  const lines = Math.max(1, Math.floor(Math.max(0, room) / lh));
  title.style.maxHeight = (lines * lh) + 'px';
}

export type TaskCardVariant = 'timed' | 'untimed' | 'compact';

/**
 * 类名拼装收口（P0-1）：调用方只给 variant + 状态，拼装只此一处。
 * compact = 月 pill（保留 .task-pill，探针 `month-measure` / `browser-cards` 靠它）。
 */
export function taskCardClass(
  t: Task,
  variant: TaskCardVariant,
  opts?: { live?: boolean; dragging?: boolean },
): string {
  const base = variant === 'compact' ? 'task-pill task-el' : `task-el task-el--${variant}`;
  return (
    base
    + (t.done ? ' done' : '')
    + (opts?.live ? ' live' : '')
    + (opts?.dragging ? ' dragging' : '')
  );
}

/**
 * 定时与未定时共用这一个组件 —— 位置由父级给的 `style` 决定，
 * 有没有第二行时间由 `timeText` 决定，其余完全一致。
 */
export function TaskCard({
  t, variant, live, style, timeText, noteText, title, resizable, lockX = true, mustShowTime = false, onClick,
}: {
  t: Task;
  /** 定时 / 未定时 / 月 pill。类名拼装收进 taskCardClass，调用方不再拼字符串 */
  variant: TaskCardVariant;
  /** 「现在正进行」高亮。定时卡由 TimedCard 算好传进来，未定时/compact 恒 false */
  live?: boolean;
  /** 位置：定时给四件套（top/height/left/width），未定时只给高度 */
  style: CSSProperties;
  /** 第二行的时间段文案。未定时传 null —— 它没有时间 */
  timeText: string | null;
  /** 详细内容的摘要。同 timeText 的门道：位置不够就传 null */
  noteText: string | null;
  title: string;
  /** 上下沿的拖拽把手。未定时卡片没有起止时间，给不了 */
  resizable: boolean;
  /** 横向锁死。**日视图必须锁**（同一天里只在时间轴上下挪），
      周视图不锁 —— 7 列并排时让它横着跟不上手，就等于跨天拖不动。 */
  lockX?: boolean;
  mustShowTime?: boolean;
  /** 层叠（三件以上重叠）里「压在下面」的卡用它翻层：stopPropagation 拦下
     #content 的点击分派，不让它顺手开详情。最上面的卡不传 = 点了照常开详情 */
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const drag = useDraggableEvent(t.id);
  /* 未定时卡在限高可滚的区里（.allday-zone / .wun-cell）—— 拖出边界会被容器
     裁掉（用户 2026-10-23：「未定时的一拖就整个消失」）。拖起时把**分身**画到
     body 上（不受任何容器裁剪），本体原地隐身（占位不变、其余卡片不跳动，
     dnd 的位移保持纯指针位移）。见 ui/dnd/lift.ts。定时卡所在的时间轴不裁，
     保持原样。 */
  const isUntimed = variant === 'untimed';
  const ghost = useDragGhost(isUntimed && drag.isDragging);
  const bodyRef = useRef<HTMLDivElement>(null);
  /* 卡片自己知道自己多高（compact 月 pill 没有 `.ev-body`，hook 自动不做事） */
  useCardFit(bodyRef, mustShowTime);
  /* 卡片内容：本体和分身各渲染一份 —— 分身那份**不挂 bodyRef**，
     否则同一个 ref 会被两棵树抢（本体是量测对象，分身只是画给人看的）。 */
  const content = (withRef: boolean) => (
    <>
      <div className="ev-body" ref={withRef ? bodyRef : undefined}>
        <CheckBtn id={t.id} on={!!t.done} />
        <div className="ev-text">
          <span className="ev-title">{t.title}</span>
          {timeText && <span className="ev-time">{timeText}</span>}
          {noteText && <span className="ev-note">{noteText}</span>}
        </div>
      </div>
      {/* 循环角标挂在**卡片层**（右上角、绝对定位），不进 .ev-body ——
          2026-10-25 用户：不要挤标题的位置。 */}
      <RepeatFlag t={t} corner />
    </>
  );
  const inner = content(true);
  const ghostInner = content(false);
  return (
    <>
      <div
        className={taskCardClass(t, variant, { live, dragging: drag.isDragging })}
        ref={(el) => { ghost.setNodeRef(el); drag.ref(el); }}
        style={{
          ...drag.style,
          /* 只取位移，纵向跟手；横向不锁的时候才有自由 */
          transform: lockX
            ? `translate3d(0px, ${drag.y}px, 0px)`
            : `translate3d(${drag.x}px, ${drag.y}px, 0px)`,
          ...style,
          /* 拖拽中本体**原地隐身**：占位不变（其余卡片不跳），分身替它出场 */
          ...(isUntimed && drag.isDragging ? { visibility: 'hidden' as const } : null),
        }}
        {...drag.attributes}
        {...drag.listeners}
        onClick={onClick}
        data-id={t.id}
        title={title}
      >
        {inner}
        {resizable && (
          <>
            <span
              className="ev-resize ev-resize-top" data-act="resize-top" data-id={t.id}
              tabIndex={0} aria-label={'调整「' + t.title + '」的开始时间，方向键上下微调'}
            />
            <span
              className="ev-resize" data-act="resize" data-id={t.id}
              tabIndex={0} aria-label={'调整「' + t.title + '」的结束时间，方向键上下微调'}
            />
          </>
        )}
      </div>
      {/* 分身：createPortal 到 body —— 不在 .wun-cell / .allday-zone 里，
          不会被它们的 overflow 裁掉；pointer-events:none 不挡落点判定。
          timeline.ts 的引导线优先读分身的 rect（本体原地不动）。 */}
      {isUntimed && drag.isDragging && ghost.ghostRect && createPortal(
        <div
          className={taskCardClass(t, variant, { live, dragging: true }) + ' drag-ghost'}
          style={{
            position: 'fixed', left: ghost.ghostRect.left, top: ghost.ghostRect.top,
            width: ghost.ghostRect.width, height: ghost.ghostRect.height, margin: 0,
            zIndex: 90, pointerEvents: 'none',
            transform: lockX
              ? `translate3d(0px, ${drag.y}px, 0px)`
              : `translate3d(${drag.x}px, ${drag.y}px, 0px)`,
          }}
          data-id={t.id}
          aria-hidden="true"
        >
          {ghostInner}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * 未定时卡。`TaskCard variant="untimed"` 的薄包装 —— 日/周两视图的未定时区共用。
 *
 * 未定时卡永远只有一行（勾选圈 + 标题）：没有时间行、没有备注行、不能拉伸改时长。
 * 高度不由调用方给 —— 卡高 = 所在容器的 `--row`（见 calendar.css 的 `.task-el--untimed`），
 * 日/周/窄屏各自的 `--row` 已对齐各自的字号档；调用方再传高度只会造出第四套口径
 * （之前 `height: 24` inline vs 日 20 vs 周 22 就是这么来的）。
 */
export function UntimedCard({
  t, title, lockX, style,
}: {
  t: Task;
  title: string;
  /** 日视图锁死（默认 true），周视图要跨天拖传 false */
  lockX?: boolean;
  /** 预留：联动 C 落地（P1-3）后由 JS 写高度；现在不传 */
  style?: CSSProperties;
}) {
  return (
    <TaskCard
      t={t}
      variant="untimed"
      style={style ?? {}}
      timeText={null}
      /* 未定时卡是一行高度的小药丸，塞不进第二行 ——
         它的详细内容只在列表与抽屉里露面 */
      noteText={null}
      title={title}
      resizable={false}
      lockX={lockX}
    />
  );
}

/**
 * 定时卡片。**内容与定位分开放**：文案、类名、四件套位置在这里算好，
 * 再交给共用的 `TaskCard` 渲染。
 */
export function TimedCard({
  e, isToday, nowMin, win, boxH, lockX,
}: {
  e: LayoutEvent;
  isToday: boolean;
  nowMin: number;
  win: DayWindow;
  /** 时间轴实测高（useTimelineMetrics/useElementHeight）。0 = 还没量到，退回旧百分比判据 */
  boxH?: number;
  lockX?: boolean;
}) {
  const t = e.item;
  /* 纵向一律走**百分比**：时间轴高度由容器决定（锁单屏），写死 px 会在
     窗口一缩放就整体错位。完全在窗外的整条不画，跨过窗沿的按窗沿截断。 */
  const box = pctRange(e.start, e.end, win);
  if (!box) return null;
  const w = 100 / e.cols;
  const live = isToday && nowMin >= e.start && nowMin < e.end;
  const narrow = isNarrowNow();
  /* P0-1：roomy/canResize 改用 px 行数（boxH/pxPerHour），不再用百分比魔法数。
     boxH<=0（首帧还没量到）退回旧百分比判据，保证首帧不断言失败。 */
  const pxH = boxH && boxH > 0 ? (box.height / 100) * boxH : -1;
  const roomy = pxH >= 0 ? pxH >= (narrow ? 34 : 22) : box.height >= (narrow ? 5.4 : 3.4);
  const hasEnd = t.duration != null;
  /* 时间行**只由时长决定**（2026-10-24 第四轮，用户定，AGENTS.md 钉着这一条）：
     `时长 > 60 分钟` → 一定有那一行；`≤ 60 分钟`（含整 1 小时、含没设过时长的）
     → 没有；月视图永远没有。
     ⚠️ 4c1414c 那版曾改成「只要空间装得下就显示」，于是 60 分钟卡有时有、有时没有
     —— 同一条时长在不同窗口下两种样子，正是这条约定要禁的。合并后按第四轮的
     口径收回：`timeText` 在 ≤ 60 时为 null（**元素根本不渲染**，不是靠
     `data-notime` 藏），`mustShowTime` 只用来告诉压缩阶梯「这一行不许藏」。
     ⚠️ 不要再加窄屏 `display: none`：判据只在这一处。 */
  const durMin = hasEnd ? (e.end - e.start) : 60;
  const mustShowTime = durMin > 60;
  const timeText = mustShowTime ? timeRangeCompact(e.start, e.end - e.start) : null;
  /* 卡高**只由时长定**（2026-10-24 第五轮，用户定：「没有什么地方是给卡片加长的兜底」）：
     装不下由 `useCardFit` 沿两个轴分别往下压（纵向 行距 → 留白 → 标题字号；横向 字距 → 时间行字号），
     这里不再给 `minHeight`。上一轮那个加长把 61 分钟的卡顶到 28.25px（一小时只有
     ~22px）—— 等于把时长画长了，探量和肉眼都不答应。
     圆角照这张卡**真实的高**报，没有任何修正项。 */
  const cardPx = pxH > 0 ? pxH - CARD_SEAM : 0;
  /* **1 小时及以上的卡一定有把手**（2026-10-25 用户：「1 小时长度的卡片也给显示
     时间调节把手」）—— 判据跟时间行那条一样按时长走，不按量出来的像素碰运气：
     同一张 60 分钟的卡在桌面日视图 27.17px、窄屏周视图 20.45px，按像素门槛就是
     「换个屏就没把手」，用户没法预期。
     ⚠️ 仍然保留像素门槛的那一半：**不足 1 小时**的卡还按 26px（两个 6px 把手 +
     14px 可拖带）判，卡比把手高就别画了（2026-10-20 用户：「高度非常窄的把上下
     把手隐藏掉」—— 盖住整张卡反而看不见标题，也根本抓不住）。退回档 4.5%
     （browser-smoke 验 1h 任务有把手）。 */
  const canResize = durMin >= 60 || (pxH >= 0 ? pxH >= 26 : box.height >= 4.5);
  /* 上下左右各留**固定的 1px**（2026-10-25 用户：「卡片右边和底部都改为 1px 的空白」；
     2026-10-22 九条回归定的是 1.5px）：定值缝在任何窗口下都稳定可见，不用相对百分比
     —— 窗一缩缝就跟着缩，手机上肉眼看不见。
     top 保持**纯数字百分比**（探针按 parseFloat(el.style.top) 读，掺 calc 会 NaN），
     缝全部让给 height/width 的 calc 尾数。 */
  const topPct = box.top;
  const hPct = Math.max(1.2, box.height);
  /* **三件以上重叠 → 整宽层叠**（方案 C，layoutOverlap 给的 stack）。
     几何：所有卡同宽（整宽再收掉层叠总错位），left 逐件右移 5px ——
     右边缘对齐，左边缘露出 5px 一档的「便签边」，看得出底下压着几件。
     纵向（top/height）分毫不动，时间映射与拖拽全不受影响。
     z：默认最早开始的在最上（i=0）；点压着的卡把它翻到最上（见下）。 */
  const st = e.stack;
  const topI = useStackTop(st ? st.key : '', st ? st.n : 1);
  const isTop = !st || st.i === topI;
  return (
    <TaskCard
      t={t}
      variant="timed"
      live={live}
      style={{
        top: topPct + '%',
        height: `calc(${hPct}% - ${CARD_SEAM}px)`,
        left: st ? `${st.i * 5}px` : `${e.col * w}%`,
        /* 右边**一律让出 1px 缝**（2026-10-25 用户：「卡片右边改为 1px 的空白」）：
           单列时卡片是满宽的，不扣缝就贴着面板右沿 / 列右沿，和未定时区同屏看是
           「一边留白一边贴边」。以前（2026-10-24 三问题统一）单列特意不扣，理由是
           「未定时卡 100% 宽，定时卡扣掉就比它窄一截、左右对不齐」—— 用户现在点名
           右边要留白，那条理由作废：两种卡都靠 --card-pad-x 给左右内留白，右沿的
           1px 缝是**卡与边界的呼吸**，不是对齐基线。两条卡并排时缝照留（不然同簇
           的两条糊在一起）。层叠时右边缘对齐，见上面。 */
        width: st
          ? `calc(100% - ${st.n * 5 - 5 + CARD_SEAM}px)`
          : `calc(${w}% - ${CARD_SEAM}px)`,
        zIndex: st ? (isTop ? 8 : 1 + st.i) : undefined,
        /* 圆角按卡高收（见 calendar.css 的 .task-el--timed）：这里直接把这张卡
           真正的像素高给出去（百分比 × 容器实高 − 缝），与未定时卡的 `--row`
           同一个来源，两种卡的圆角才会一样。pxH 还没量到就不给，CSS 回落 20px。
           卡高没有任何修正项 —— 加长兜底已撤（见上面那段）。
           ⚠️ 这里**必须给长度**（px），不能给百分比数字：border-radius 那条
           算式是 `calc(var(--card-h) * 0.28)`，无单位数乘出来还是数，整条声明
           直接失效 = 圆角没了（2026-10-25 合并事故）。 */
        '--card-px': cardPx > 0 ? cardPx + 'px' : undefined,
        /* 行距 / 留白 / 字号**不在这里给**：装不下才压，压几档由 `useCardFit` 量出来定 */
      } as CSSProperties}
      onClick={st && !isTop
        ? (ev) => {
            /* 压在下面的卡：第一下只翻层（拦住 #content 的分派，别顺手开详情）；
               翻到最上以后再点，才是开详情 */
            ev.stopPropagation();
            setStackTop(st.key, st.i);
          }
        : undefined}
      timeText={timeText}
      mustShowTime={mustShowTime}
      /* 详细内容也只在块够高时才露一行 —— 判据与时间行共用同一个 `roomy`：
         同一张卡要不要多出一行是**按空间算的**，写第二行会把标题挤没，
         那不如不写。完整内容仍在抽屉里。 */
      noteText={roomy && t.note ? t.note : null}
      title={`${t.title}　${timeRange(e.start, e.end - e.start)}　${D.fmtDuration(e.end - e.start)}`}
      /* **每条定时卡都带把手**（2026-10-19 用户报「没地方拖动改时长」）：
         以前 `resizable={hasEnd}` —— 没显式设过时长的任务一个把手都没有，
         而「点一下新建」的任务恰恰占大多数。时长是「默认 60 分钟」的含义，
         不是「不许改」的含义；拖把手就是把时长落定。
         但**比把手还窄的卡不给**（2026-10-20 用户要求）—— 见上面的 canResize。 */
      resizable={canResize}
      lockX={lockX}
    />
  );
}

/**
 * 月 pill（`TaskCard variant="compact"` 的薄包装 —— 唯一渲染 `.task-pill` 的地方）。
 *
 * 探针写死的口径（`month-measure` / `android-live-check` / `browser-smoke`）：
 * `.task-pill` / `.pill-title` / `.pill-more` / `data-jump` / `data-untimed` /
 * 宽屏 CheckBtn —— DOM 一律保留，只收类名拼装与拖拽。
 * ⚠️ `.pill-time` **已不再渲染**（2026-10-24 第三轮：月视图永远不显示时间），
 * 时间改挂在 `title` 气泡上。
 * 不走 `TaskCard` 主体那套 `.ev-body`：那是纵向两行的卡片语言，月格是单行文字行，
 * 硬套会把 `text-overflow: clip`（窄屏多看一个字）与 45px 整字宽量坏。
 */
export function CompactCard({ t, moreSuffix, moreJumpDay }: {
  t: Task; moreSuffix?: number;
  /**
   * 只给尾巴上的 `+N` 用：点它 → 跳到那一天的**日视图**（"还有 N 条，去日视图看全"）。
   * **胶囊本体不挂 `data-jump`** —— 点任务条 = 开这条任务的详情抽屉
   * （2026-10-26 用户改；之前整条胶囊跳日视图，是 2026-10-19 的旧口径）。
   */
  moreJumpDay?: string;
}) {
  /* 月视图格子专用：拖到别的格子 → 改期（定时任务保时间，见 ui/dnd/timeline.ts）。
     落点计算全在那边，这里只把 dnd-kit 的拖拽柄接上。 */
  const drag = useDraggableEvent(t.id);
  /* 月视图格子限高可滚（`.cell-tasks` 有 overflow-y:auto）—— 胶囊拖出格子
     会被裁掉。拖起时把**分身**画到 body 上（不受裁剪），本体原地隐身
     （占位不变、dnd 位移保持纯指针位移）。同未定时卡，见 ui/dnd/lift.ts。 */
  const ghost = useDragGhost(drag.isDragging);
  const cls = taskCardClass(t, 'compact', { dragging: drag.isDragging });
  const inner = (
    <>
      {/* 格子里唯一一个勾选入口。**必须是 <button>**（见 CheckBtn 头注释）；
          窄屏由 CSS 藏掉（格子净宽 46.86px，圈 + 5 个字就到边），想勾完成要点开抽屉。
          ⚠️ 这条与圈径无关 —— 圈跟着字号已经缩到 9.4px 了，窄屏**照样不画**
          （2026-10-24 用户确认：手机端月视图不加勾）。 */}
      <CheckBtn id={t.id} on={!!t.done} />
      {/* **月视图不显示时间**（2026-10-24 第三轮，用户定：日 / 周看时长决定，
          月视图永远不显示）：格子里那一行只有勾选圈 + 任务名（窄屏连圈都藏）。
          时间没丢 —— 挂在 `title` 气泡上，点开还是全的。 */}
      <span className="pill-title">{t.title}</span>
      <RepeatFlag t={t} corner />
      {/* 窄屏月视图专用：这一行是格子里**最后一条可见的**，尾巴上挂 "+N" 表示
          还有 N 条没显示出来（参考图 Google 日历就是「公司+2」这样）。
          +N 挂在行内而不是单独占一行 —— 省下的高度能多显示一行文字。
          **只有它自己挂 `data-jump`**（去那天的日视图看全）：胶囊本体点了是
          开这条任务的详情抽屉（2026-10-26 用户改），两种意图分开放。 */}
      {moreSuffix ? (
        <span className="pill-more" data-jump={moreJumpDay} title={`还有 ${moreSuffix} 条`}>+{moreSuffix}</span>
      ) : null}
    </>
  );
  return (
    <>
      <div
        className={cls}
        ref={(el) => { ghost.setNodeRef(el); drag.ref(el); }}
        style={{ ...drag.style, ...(drag.isDragging ? { visibility: 'hidden' as const } : null) }}
        {...drag.attributes}
        {...drag.listeners}
        data-id={t.id}
        data-untimed={t.time ? undefined : '1'}
        title={t.time ? t.title + '　' + t.time : t.title}
      >
        {inner}
      </div>
      {/* 分身：createPortal 到 body，不受 `.cell-tasks` 的 overflow 裁剪。
          ⚠️ `transform` **必须跟着**跟手位移一起给 —— 漏了它，分身定在提起时的
          原位不动，看起来就是「拖动过程没了」（2026-10-25 合并事故）。 */}
      {drag.isDragging && ghost.ghostRect && createPortal(
        <div
          className={cls + ' drag-ghost'}
          style={{
            position: 'fixed', left: ghost.ghostRect.left, top: ghost.ghostRect.top,
            width: ghost.ghostRect.width, height: ghost.ghostRect.height, margin: 0,
            zIndex: 90, pointerEvents: 'none', transform: drag.style.transform,
          }}
          data-id={t.id}
          aria-hidden="true"
        >
          {inner}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * 就地新建的草稿框在时间轴上的位置 —— **高度给的是默认时长那一段**
 * （`D.durOf(null)` 是 60 分钟），所以「框占多大，回车之后那条任务就正好
 * 占多大」，所见即所得。
 *
 * 起点同样是百分比：时间轴的高度由容器说了算（锁单屏），写 px 会一缩放就错位。
 * 分钟已经在点击那一刻对齐到 15 分钟了（`yToMin`），这里不再取整 ——
 * 二次取整会让框与真正的那条卡差出半格。
 *
 * **框多大 = 任务多大**：在时间轴上拉出来的草稿自带时长（`seed.duration`，
 * 见 dragCreate.ts），就照那段画；点一下开的草稿没有，退回默认的一小时。
 */
export function draftBox(seed: DraftSeed, win: DayWindow): CSSProperties {
  const min = D.timeToMin(seed.time) ?? win.from;
  const top = minToPct(Math.max(win.from, Math.min(win.to, min)), win) ?? 0;
  const len = seed.duration && seed.duration > 0 ? seed.duration : D.durOf(null);
  const h = Math.min(len, win.to - min);
  const pct = Math.max(1.2, (h / spanOf(win)) * 100);
  return { top: top + '%', height: 'calc(' + pct + '% - 1px)' };
}
