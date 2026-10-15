/**
 * Projects.tsx —— 长周期项目：泳道看板
 *
 * 泳道 = 项目，列 = 任务状态（待办 / 进行中 / 已完成）。
 *
 * **为什么不是甘特图。** 用户自述「有很多个项目在并行推进，但大多数没有非常
 * 明确的时间节点，也不太习惯去列出清晰的计划」。文件系统佐证：`~/work/projects/`
 * 下 7 个并行项目，多数无起止日。这是 PARA 里 **Area**（持续关注、无结束点）
 * 的形态 —— 甘特图强制每根横条有开始日与结束日，会逼用户给每个项目编一个假日期。
 * 真正的痛点不是「错过截止」，而是**某个项目被忘掉两个月**，所以泳道头围绕
 * 「多久没动 + 下一步是什么」组织。
 *
 * 这个文件**零回调、只出 data-*** —— 和 `views/` 其它文件同一条规矩。本该
 * 早就是这样：文件头原来写「页级动作是例外」替自己开脱，但那三条理由全不成立
 * （「节点不会在脚下被换掉」只是**当前**没换，不是结构上不会换；`TodayView`
 * 的 `onNav` 是跳转不是写 store）。真正必须留在本地的只有**折叠开关**：它是
 * 纯 UI 状态，刷新复位是合理的，写进 store 反而是噪音。其余一律 `data-act`
 * 走 App 的点击委托（见 `app/clickDispatch.ts`）。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  STALE_DAYS, STATUS_LABEL, liveProjects, projectColumn, projectProgress,
  projectStaleDays, sortProjects, tasksOfProject,
} from '../domain/model.ts';
import type { LocalState, Project, Task } from '../domain/types.ts';
import { fmtMD } from '../domain/date.ts';
import { useDraggableEvent, useDroppableZone } from '../ui/dndkit.tsx';
import { Btn } from '../ui/kit.tsx';
import { Empty } from './parts.tsx';

/** 三列。顺序就是板子上的顺序 —— `projectColumn` 的返回值要对得上 */
const COLS = [
  { key: 'todo', label: '待办' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '已完成' },
] as const;

/* ============================== 任务卡 ============================== */

/**
 * 卡片刻意**同时**带上 `.task-el` 与 `data-card`：
 *  - `.task-el` 是 dnd-kit 的 `useDraggableEvent` 认的类
 *  - `data-card` 是泳道列的标识属性
 * 两个各管一头，不是重复。
 */
function ProjCard({ t }: { t: Task }) {
  const drag = useDraggableEvent(t.id);
  return (
    <div
      className={'task-el pj-card' + (t.done ? ' done' : '')}
      data-card
      data-id={t.id}
      ref={drag.ref}
      style={drag.style}
      {...drag.attributes}
      {...drag.listeners}
      title={t.title}
    >
      <span className="pj-card-t">{t.title}</span>
      {t.date && <span className="pj-card-d">{fmtMD(t.date)}</span>}
    </div>
  );
}

function ProjColumn({ state, p, c }: { state: LocalState; p: Project; c: { key: string; label: string } }) {
  const zone = useDroppableZone(`proj:${p.id}:${c.key}`);
  const items = tasksOfProject(state, p.id).filter((t) => projectColumn(t) === c.key);
  return (
    <div
      className="pj-col"
      ref={zone.ref}
      data-zone-id={`proj:${p.id}:${c.key}`}
      data-kind="project"
      data-scope={'proj:' + p.id + ':' + c.key}
    >
      <div className="pj-col-h">
        <span>{c.label}</span><b>{items.length}</b>
      </div>
      <div className="pj-col-b">
        {items.map((t) => <ProjCard key={t.id} t={t} />)}
      </div>
    </div>
  );
}

/* ============================== 泳道 ============================== */

function Lane({ state, p }: { state: LocalState; p: Project }) {
  const list = tasksOfProject(state, p.id);
  const done = list.filter((t) => t.done).length;
  const stale = projectStaleDays(state, p.id);
  const pct = projectProgress(state, p.id);
  const manual = p.progress !== null;

  const [open, setOpen] = useState(true);
  /**
   * 「下一步」是**本地草稿**，blur 时才落库一次。
   *
   * 每敲一个字就 commit 会同时踩两个坑：产生一大串没意义的 op，以及让光标在
   * 重渲染里跳回开头（AGENTS.md 四、第 5 条 CSS 层叠 / 踩坑 17 —— Drawer 的标题、备注是同一个理由）。
   * `useEffect` 那条是防「另一台设备改了，本机草稿把新值盖住」。
   */
  const [next, setNext] = useState(p.next);
  useEffect(() => { setNext(p.next); }, [p.next]);

  return (
    <section className="pj-lane" data-lane={p.id}>
      <header className="pj-head">
        <button
          className="pj-toggle" type="button"
          aria-expanded={open}
          aria-label={(open ? '收起' : '展开') + '：' + p.name}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <span className={'pj-name pj-st-' + p.status} title={'状态：' + STATUS_LABEL[p.status]}>
          {p.name}
        </span>

        {/* 停滞**只在项目页里标**，不主动弹（用户裁决）。
            判据是「多久没动」，不是「错过截止」—— 这个模型里没有截止日。 */}
        {stale >= STALE_DAYS && (
          <span className="pj-stale" title={`${stale} 天没有动过了`}>
            <AlertTriangle size={12} /> {stale} 天没动
          </span>
        )}

        <span className="pj-count">{done}/{list.length}</span>

        <span className="pj-bar" title={manual ? `手填进度 ${pct}%` : `按任务自动算 ${pct}%`}>
          <i style={{ width: pct + '%' }} />
        </span>

        {/* 编辑 = 打开那个浮层。浮层的开关在 App 那一层（pjSheet），这里只发信号 */}
        <button className="pj-more" type="button"
          data-act="edit-project"
          data-id={p.id}
          aria-label={'编辑项目：' + p.name}>编辑</button>
      </header>

      <div className="pj-next">
        <span className="pj-next-l">下一步</span>
        <input
          className="pj-next-i"
          data-project-next={p.id}
          value={next}
          placeholder="还没写"
          onChange={(e) => setNext(e.target.value)}
          /* blur 才落库：每敲一个字就 commit 会刷一大串 op、还会让光标乱跳。
             同样**不挂 onChange 写 store** —— 走原生 change 事件委托，
             理由同 clickDispatch.ts（行会被换掉）。 */
          data-act="next-project"
          data-id={p.id}
          aria-label={'下一步（' + p.name + '）'}
        />
      </div>

      {open && (
        <div className="pj-cols">
          {COLS.map((c) => (
            <ProjColumn key={c.key} state={state} p={p} c={c} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ================================ 页面 ================================ */

export function ProjectsView({ state }: { state: LocalState }) {
  const list = sortProjects(state, liveProjects(state));

  return (
    <div className="pj-wrap">
      <div className="pj-top">
        <h2 className="pj-h">项目</h2>
        <Btn variant="normal" size="sm" type="button" data-act="new-project">＋ 新建项目</Btn>
      </div>

      {!list.length && <Empty text="还没有项目" sub="长周期的事放这儿。" />}

      {list.map((p) => <Lane key={p.id} state={state} p={p} />)}
    </div>
  );
}
