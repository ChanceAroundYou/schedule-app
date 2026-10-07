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
 * `views/` 的规矩是「零回调、只出 data-*」（CLAUDE.md 四、28），那条**针对的是行** ——
 * 行会被拖拽重排 / 同步落地换掉节点，挂在行上的 handler 会跟着丢。这个文件里
 * 传到外面的三样（新建、编辑、改「下一步」）都是**页级 / 泳道级**的动作，
 * 节点不会在脚下被换掉；`TodayView` 收 `onNav`、`HabitsView` 收 `onAdd`
 * 是同一个先例。**卡片本身仍然零回调**：它们靠 `data-card` / `.task-el`
 * 走 dnd 那一套。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  STALE_DAYS, STATUS_LABEL, liveProjects, projectColumn, projectProgress,
  projectStaleDays, sortProjects, tasksOfProject,
} from '../domain/model.ts';
import type { LocalState, Project, Task } from '../domain/types.ts';
import { fmtMD } from '../domain/date.ts';
import { Btn } from '../ui/kit.tsx';

/** 三列。顺序就是板子上的顺序 —— `projectColumn` 的返回值要对得上 */
const COLS = [
  { key: 'todo', label: '待办' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '已完成' },
] as const;

/* ============================== 任务卡 ============================== */

/**
 * 卡片刻意**同时**带上 `.task-el` 与 `data-card`：
 *  - `.task-el` 是 `dnd.ts` 的 `onDragStart` 认的类（少了它卡片根本拖不起来）
 *  - `data-card` 是泳道列的 `zoneCells` 认的属性（少了它让位洞不会画）
 * 两个各管一头，不是重复。
 */
function Card({ t }: { t: Task }) {
  return (
    <div
      className={'task-el pj-card' + (t.done ? ' done' : '')}
      data-card
      data-id={t.id}
      draggable
      title={t.title}
    >
      <span className="pj-card-t">{t.title}</span>
      {t.date && <span className="pj-card-d">{fmtMD(t.date)}</span>}
    </div>
  );
}

/* ============================== 泳道 ============================== */

function Lane({ state, p, onNext, onEdit }: {
  state: LocalState; p: Project;
  onNext: (id: string, value: string) => void;
  onEdit: (id: string) => void;
}) {
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
   * 重渲染里跳回开头（CLAUDE.md 四、17 —— Drawer 的标题 / 备注是同一个理由）。
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

        <button className="pj-more" type="button"
          aria-label={'编辑项目：' + p.name} onClick={() => onEdit(p.id)}>编辑</button>
      </header>

      <div className="pj-next">
        <span className="pj-next-l">下一步</span>
        <input
          className="pj-next-i"
          data-project-next={p.id}
          value={next}
          placeholder="还没写"
          onChange={(e) => setNext(e.target.value)}
          onBlur={() => { if (next !== p.next) onNext(p.id, next); }}
          aria-label={'下一步（' + p.name + '）'}
        />
      </div>

      {open && (
        <div className="pj-cols">
          {COLS.map((c) => {
            const items = list.filter((t) => projectColumn(t) === c.key);
            return (
              <div
                className="pj-col" key={c.key}
                /* `data-drop="proj"` 而不是 `"list"`：列的语义是「状态桶」不是
                   有序表（换列才提交，桶内顺序不动）。但让位洞那一套
                   （drop-hole / shiftCells）是按 `data-kind` + 格子选择器走的，
                   所以落点反馈白拿一份 —— 拖起来看得见自己要放哪儿。 */
                data-drop="proj"
                data-kind="project"
                data-scope={'proj:' + p.id + ':' + c.key}
              >
                <div className="pj-col-h">
                  <span>{c.label}</span><b>{items.length}</b>
                </div>
                <div className="pj-col-b">
                  {items.map((t) => <Card key={t.id} t={t} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ================================ 页面 ================================ */

export function ProjectsView({ state, onNew, onEdit, onNext }: {
  state: LocalState;
  onNew: () => void;
  onEdit: (id: string) => void;
  onNext: (id: string, value: string) => void;
}) {
  const list = sortProjects(state, liveProjects(state));

  return (
    <div className="pj-wrap">
      <div className="pj-top">
        <h2 className="pj-h">项目</h2>
        <Btn variant="ghost" className="text-btn" type="button" onClick={onNew}>＋ 新建项目</Btn>
      </div>

      {!list.length && (
        <div className="empty">
          <div>还没有项目</div>
          <div className="empty-sub">长周期的事放这儿。</div>
        </div>
      )}

      {list.map((p) => <Lane key={p.id} state={state} p={p} onNext={onNext} onEdit={onEdit} />)}
    </div>
  );
}
