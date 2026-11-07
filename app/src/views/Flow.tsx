/**
 * Flow.tsx —— 「每日流程」功能区
 *
 * 一条按顺序推进的当日清单：勾掉一项，看下一项。参考时间是可选的，
 * 顺序才是主语 —— 这是它和「打卡」（有空就做）、「日程」（有固定时段）
 * 的根本区别，见 domain/flow.ts 开头那段。
 *
 * ## 两个模式
 *
 *   今日流程：当天那一份，可勾选、可改顺序、可临时增删
 *   常用模板：每天共用一份。改它只影响**之后**生成的日期
 *
 * ## 为什么这一页要放在日程集门禁之前
 *
 * 每日流程按账号归属，跟日程集无关（同 CounterView）。断网首启、一个集都
 * 还没拿到时，自己的流程表照样要能打开。
 *
 * `views/` 那一层的规矩是「纯展示、零回调」，但这一页和 Counter 一样自带
 * 数据源（`useFlow`），没有把写操作塞进点击委托 —— 因为它是独立文档，
 * 不参与任务那套 data-act 分派。
 */

import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { LocalState } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { FLOW_MAX_ITEMS } from '../domain/flow.ts';
import { useFlow } from '../ui/flow/useFlow.ts';

export function FlowView({ state }: { state: LocalState }) {
  const f = useFlow(state.meId);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [draft, setDraft] = useState('');

  const isDay = f.mode === 'day';
  const total = f.progress.total;
  const atMax = f.items.length >= FLOW_MAX_ITEMS;

  const submitDraft = () => {
    if (!draft.trim()) return;
    f.add(draft);
    setDraft('');
  };

  const commitEdit = () => {
    if (!editing) return;
    const { id, draft: text } = editing;
    setEditing(null);
    if (text.trim()) f.patch(id, { title: text });
  };

  return (
    <div className="flow-page">
      <div className="flow-head">
        <div className="flow-modes" role="tablist" aria-label="每日流程模式">
          <button
            type="button"
            role="tab"
            aria-selected={isDay}
            className={isDay ? 'on' : ''}
            onClick={() => f.setMode('day')}
          >今日流程</button>
          <button
            type="button"
            role="tab"
            aria-selected={!isDay}
            className={!isDay ? 'on' : ''}
            onClick={() => f.setMode('template')}
          >常用模板</button>
        </div>

        {isDay && (
          <div className="flow-date">
            <button type="button" title="前一天" aria-label="前一天" onClick={() => f.setDate(D.addDays(f.date, -1))}>
              <ChevronLeft size={15} />
            </button>
            <span className="flow-date-label">{D.relLabel(f.date) === '今天' ? '今天' : D.fmtSmart(f.date)} · 周{D.weekdayShort(f.date)}</span>
            <button type="button" title="后一天" aria-label="后一天" onClick={() => f.setDate(D.addDays(f.date, 1))}>
              <ChevronRight size={15} />
            </button>
            {f.date !== D.today() && (
              <button type="button" className="flow-today" onClick={() => f.setDate(D.today())}>今天</button>
            )}
          </div>
        )}
      </div>

      {isDay && total > 0 && (
        <div className="flow-sum">
          已完成 <b>{f.progress.done}</b> / <b>{total}</b>
          {f.next
            ? <span className="flow-next">下一项：{f.next.title}</span>
            : <span className="flow-next">今天这一串走完了</span>}
        </div>
      )}

      {isDay && total === 0 && (
        <div className="flow-empty">
          这一天还没有流程。<br />
          在下面加第一条，或者先去「常用模板」把每天固定要做的事排好。
        </div>
      )}

      {!isDay && total === 0 && (
        <div className="flow-empty">
          模板还是空的。在这里排好顺序，之后每天第一次打开就按它生成当天清单。
        </div>
      )}

      <ol className="flow-list">
        {f.items.map((item, i) => (
          <li key={item.id} className={'flow-row' + (isDay && item.done ? ' done' : '')}>
            {isDay && (
              <button
                type="button"
                className="flow-check"
                aria-pressed={item.done}
                aria-label={item.done ? '标记为未完成' : '标记为已完成'}
                onClick={() => f.toggle(item.id)}
              >
                <i>{item.done && <Check size={11} strokeWidth={3} />}</i>
              </button>
            )}
            <span className="flow-idx">{i + 1}</span>

            <div className="flow-main">
              {editing && editing.id === item.id ? (
                <input
                  className="flow-title-input"
                  value={editing.draft}
                  autoFocus
                  maxLength={120}
                  aria-label="这一项的名称"
                  onChange={(e) => setEditing({ id: item.id, draft: e.target.value })}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="flow-title"
                  title="点一下改名"
                  onClick={() => setEditing({ id: item.id, draft: item.title })}
                >{item.title}</button>
              )}

              <input
                className="flow-at"
                type="time"
                aria-label="参考时间（可不填）"
                title="参考时间，可不填"
                value={item.at ?? ''}
                onChange={(e) => f.patch(item.id, { at: e.target.value || null })}
              />
            </div>

            <div className="flow-acts">
              <button
                type="button"
                title="上移" aria-label="上移"
                disabled={i === 0}
                onClick={() => f.move(item.id, i - 1)}
              ><ArrowUp size={14} /></button>
              <button
                type="button"
                title="下移" aria-label="下移"
                disabled={i === f.items.length - 1}
                onClick={() => f.move(item.id, i + 1)}
              ><ArrowDown size={14} /></button>
              <button
                type="button"
                className="flow-del"
                title="删除这一项" aria-label="删除这一项"
                onClick={() => f.remove(item.id)}
              ><Trash2 size={14} /></button>
            </div>
          </li>
        ))}
      </ol>

      <div className="flow-add">
        <Plus size={15} className="opacity-50" />
        <input
          value={draft}
          maxLength={120}
          placeholder={isDay ? '加一项今天要做的事，回车确认' : '加一项每天都在的流程，回车确认'}
          aria-label={isDay ? '添加今天的一项' : '添加模板的一项'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitDraft(); }}
        />
        <button type="button" disabled={!draft.trim() || atMax} onClick={submitDraft}>添加</button>
      </div>

      {atMax && <div className="flow-err">一天最多 {FLOW_MAX_ITEMS} 项，先删掉一些再加。</div>}
      {f.err && <div className="flow-err">{f.err}</div>}

      {!isDay ? (
        <div className="flow-tip">
          模板每天共用一份。改动只影响<strong>之后</strong>生成的日期 ——
          已经打开过的某一天不会被回溯覆盖。时间是参考，不填也能排顺序。
        </div>
      ) : (
        <div className="flow-tip">
          顺序由你自己排，和具体钟点无关；时间只是给眼睛一个锚点。
          {f.pendingCount > 0 && (
            <> 还有 {f.pendingCount} 份没同步到服务器，<button type="button" className="underline" onClick={f.retry}>立即重试</button>。</>
          )}
        </div>
      )}
    </div>
  );
}
