/**
 * Counter.tsx —— 「+1」功能区（计数器页）
 *
 * 两块计数器竖排、卡片加宽，加减按钮比侧栏卡片大一圈。读写全在
 * `ui/counters/useCounters.ts`，这里只画。
 *
 * ## 为什么是独立功能区而不是侧栏小卡片
 * 侧栏那块太窄，数字和按钮都缩着；而且它常驻在导航下面，和「今日进度」
 * 挤在一起。用户 2026-10-26 定：**独立成页**，名字就叫「+1」。
 *
 * ## 不依赖日程集
 * 计数器按账号归属（`counters` 表按 user_id），跟日程集无关。所以这一页要在
 * contentDispatch 的「一个集都没拿到」那道门禁**之前**返回 —— 否则断网首启
 * 时看不见自己的数字。
 */

import { Minus, Plus } from 'lucide-react';
import { useCounters } from '../ui/counters/useCounters.ts';
import type { Counter } from '../data/api/counters.ts';

export function CounterView() {
  const { list, edit, setEdit, err, send, commit } = useCounters();

  if (!list.length) {
    return (
      <div className="ctr-page">
        <div className="ctr-empty">
          {err || '正在读取计数器…'}
        </div>
      </div>
    );
  }

  return (
    <div className="ctr-page">
      {list.map((c) => (
        <Pad
          key={c.id}
          c={c}
          editing={edit && edit.id === c.id ? edit : null}
          setEdit={setEdit}
          send={send}
          commit={commit}
        />
      ))}
      {err && <div className="ctr-err">{err}</div>}
    </div>
  );
}

function Pad({ c, editing, setEdit, send, commit }: {
  c: Counter;
  editing: { id: string; field: 'value' | 'name' | 'daily'; draft: string } | null;
  setEdit: (v: { id: string; field: 'value' | 'name' | 'daily'; draft: string } | null) => void;
  send: (id: string, patch: Record<string, unknown>, optimistic?: (x: Counter) => Counter) => void;
  commit: () => void;
}) {
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setEdit(null);
  };

  return (
    <section className="ctr-pad" data-counter={c.id} aria-label={c.name + ' 计数器'}>
      <header className="ctr-head">
        {editing?.field === 'name' ? (
          <input
            className="ctr-name-input"
            aria-label="计数器名字"
            value={editing.draft}
            maxLength={24}
            autoFocus
            onChange={(e) => setEdit({ ...editing, draft: e.target.value })}
            onBlur={commit}
            onKeyDown={key}
          />
        ) : (
          <button
            type="button"
            className="ctr-name"
            title="点击改名"
            onClick={() => setEdit({ id: c.id, field: 'name', draft: c.name })}
          >
            {c.name}
          </button>
        )}
        <button
          type="button"
          className="ctr-zero"
          title="归零（第二天照样自动加）"
          onClick={() => send(c.id, { value: 0 }, (x) => ({ ...x, value: 0 }))}
        >
          归零
        </button>
      </header>

      <div className="ctr-row">
        <button
          type="button"
          className="ctr-btn ctr-minus"
          aria-label={c.name + ' 减一'}
          onClick={() => send(c.id, { delta: -1 }, (x) => ({ ...x, value: Math.max(0, x.value - 1) }))}
        >
          <Minus size={24} />
        </button>

        {editing?.field === 'value' ? (
          <input
            className="ctr-value-input"
            aria-label={c.name + ' 改为'}
            type="text"
            inputMode="numeric"
            value={editing.draft}
            autoFocus
            onChange={(e) => setEdit({ ...editing, draft: e.target.value })}
            onBlur={commit}
            onKeyDown={key}
          />
        ) : (
          <button
            type="button"
            className="ctr-value"
            aria-label={c.name + ' 当前 ' + c.value + '，点击直接改'}
            onClick={() => setEdit({ id: c.id, field: 'value', draft: String(c.value) })}
          >
            {c.value}
          </button>
        )}

        <button
          type="button"
          className="ctr-btn ctr-plus"
          aria-label={c.name + ' 加一'}
          onClick={() => send(c.id, { delta: 1 }, (x) => ({ ...x, value: x.value + 1 }))}
        >
          <Plus size={24} />
        </button>
      </div>

      <footer className="ctr-foot">
        {editing?.field === 'daily' ? (
          <input
            className="ctr-daily-input"
            aria-label={c.name + ' 每天自动加多少'}
            type="text"
            inputMode="numeric"
            value={editing.draft}
            autoFocus
            onChange={(e) => setEdit({ ...editing, draft: e.target.value })}
            onBlur={commit}
            onKeyDown={key}
          />
        ) : (
          <button
            type="button"
            className="ctr-daily"
            title="点击改每天自动加多少（0 = 不自动加）"
            onClick={() => setEdit({ id: c.id, field: 'daily', draft: String(c.dailyIncrement) })}
          >
            {c.dailyIncrement > 0
              ? `每天 0 点自动 +${c.dailyIncrement}`
              : '每天不自动加'}
          </button>
        )}
      </footer>
    </section>
  );
}
