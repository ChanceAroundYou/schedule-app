/**
 * CountersCard.tsx —— 侧栏底部的计数器（naonao / Kutai）
 *
 * 桌面侧栏与窄屏「更多」抽屉**渲染同一个组件**（和 Pulse 一样），两处不能各写
 * 一份 —— 数字对不上时用户第一个发现。
 *
 * ## 为什么不存本地
 * 这个数字**会自己变**：服务端在每次读到它时结算「隔了几天 × 每日增量」。
 * 所以在本地存一份副本，另一台设备或另一天打开就会对不上。这里一律以服务端
 * 返回的 `counters` 为准，点 `+` 只是**先把界面改掉**（免得等网络），
 * 拿到响应后立刻用服务端那份覆盖。
 *
 * ## 桌面小组件那边是另一套代码
 * `app/android/.../CounterWidgetProvider.java` 直接走原生 HTTP。两边都调同一条
 * 接口，所以数字一致；但也意味着**改接口形状要同时改两边**（原生只认
 * id / name / value 三个字段，多给的字段它忽略）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { fetchCounters, patchCounter, type Counter, type CounterPatch } from '../../data/api/counters.ts';

/** 正在编辑哪一格的哪个字段。value / name / daily 三选一。 */
type Editing = { id: string; field: 'value' | 'name' | 'daily'; draft: string };

export function CountersCard() {
  const [list, setList] = useState<Counter[]>([]);
  const [edit, setEdit] = useState<Editing | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setList(await fetchCounters());
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读不到计数器');
    }
  }, []);

  /* 首次进来拉一次；之后**回到这个页面时**再拉（另一台设备 / 桌面组件改过的值
     要能看见）。不做定时轮询：这东西一天只自动变一次，定时拉是白烧电。 */
  useEffect(() => {
    void load();
    const onFocus = () => { void load(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /** 先改界面、再发请求；成功用服务端返回覆盖，失败回滚成服务端最新值。 */
  const send = (id: string, patch: CounterPatch, optimistic?: (c: Counter) => Counter) => {
    if (optimistic) {
      setList((prev) => prev.map((c) => (c.id === id ? optimistic(c) : c)));
    }
    patchCounter(id, patch)
      .then((next) => { setList(next); setErr(''); })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : '没存上');
        void load();  // 回滚：以服务端为准
      });
  };

  const commit = () => {
    if (!edit) return;
    const { id, field, draft } = edit;
    setEdit(null);
    if (field === 'name') {
      const v = draft.trim();
      if (v) send(id, { name: v });
      return;
    }
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) return;
    // 每日增量允许 0（关掉自动加），值不允许负数（服务端也会夹）
    send(id, field === 'value' ? { value: Math.max(0, n) } : { dailyIncrement: Math.max(0, n) });
  };

  if (!list.length) {
    // 没拉到时**什么也不画**：空壳比没有更费解（同 Pulse 的空抽屉处理）
    return err ? <div className="side-counters"><div className="sc-err">{err}</div></div> : null;
  }

  return (
    <div className="side-counters">
      {list.map((c) => {
        const editing = edit && edit.id === c.id ? edit : null;
        return (
          <div className="sc-item" key={c.id} data-counter={c.id}>
            <div className="sc-top">
              {editing?.field === 'name' ? (
                <input
                  className="sc-name-input"
                  aria-label="计数器名字"
                  value={editing.draft}
                  maxLength={24}
                  autoFocus
                  onChange={(e) => setEdit({ ...editing, draft: e.target.value })}
                  onBlur={commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(null); }}
                />
              ) : (
                <button
                  type="button"
                  className="sc-name"
                  title="点击改名"
                  onClick={() => setEdit({ id: c.id, field: 'name', draft: c.name })}
                >
                  {c.name}
                </button>
              )}
              <button
                type="button"
                className="sc-zero"
                title="归零（明天照样自动加）"
                onClick={() => send(c.id, { value: 0 }, (x) => ({ ...x, value: 0 }))}
              >
                归零
              </button>
            </div>

            <div className="sc-row">
              <button
                type="button"
                className="sc-btn sc-minus"
                aria-label={c.name + ' 减一'}
                onClick={() => send(c.id, { delta: -1 }, (x) => ({ ...x, value: Math.max(0, x.value - 1) }))}
              >
                <Minus size={14} />
              </button>

              {editing?.field === 'value' ? (
                <input
                  className="sc-value-input"
                  aria-label={c.name + ' 改为'}
                  type="text"
                  inputMode="numeric"
                  value={editing.draft}
                  autoFocus
                  onChange={(e) => setEdit({ ...editing, draft: e.target.value })}
                  onBlur={commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(null); }}
                />
              ) : (
                <button
                  type="button"
                  className="sc-value"
                  aria-label={c.name + ' 当前 ' + c.value + '，点击直接改'}
                  onClick={() => setEdit({ id: c.id, field: 'value', draft: String(c.value) })}
                >
                  {c.value}
                </button>
              )}

              <button
                type="button"
                className="sc-btn sc-plus"
                aria-label={c.name + ' 加一'}
                onClick={() => send(c.id, { delta: 1 }, (x) => ({ ...x, value: x.value + 1 }))}
              >
                <Plus size={14} />
              </button>
            </div>

            <div className="sc-foot">
              {editing?.field === 'daily' ? (
                <input
                  className="sc-daily-input"
                  aria-label={c.name + ' 每天自动加多少'}
                  type="text"
                  inputMode="numeric"
                  value={editing.draft}
                  autoFocus
                  onChange={(e) => setEdit({ ...editing, draft: e.target.value })}
                  onBlur={commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(null); }}
                />
              ) : (
                <button
                  type="button"
                  className="sc-daily"
                  title="点击改每天自动加多少（0 = 不自动加）"
                  onClick={() => setEdit({ id: c.id, field: 'daily', draft: String(c.dailyIncrement) })}
                >
                  {c.dailyIncrement > 0 ? `每天 +${c.dailyIncrement}` : '不自动加'}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {err && <div className="sc-err">{err}</div>}
    </div>
  );
}
