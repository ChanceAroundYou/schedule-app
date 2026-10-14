/**
 * AiHistory.tsx —— 操作历史视图
 *
 * 所有写进 changes 表的改动都在这里，AI 执行的有特殊标记。
 * 数据来自 GET /api/ai/history。
 */

import { useEffect, useState } from 'react';
import { Bot, User } from 'lucide-react';
import { api } from '../../data/api.ts';
import type { AiHistoryItem } from '../../domain/ai.ts';

export function AiHistory() {
  const [items, setItems] = useState<AiHistoryItem[]>([]);
  const [aiOnly, setAiOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.aiHistory(aiOnly)
      .then((h) => { if (alive) setItems(h); })
      .catch(() => { /* 读不到就是空的 */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [aiOnly]);

  return (
    <div className="ai-history">
      <div className="ai-history-bar">
        <label className="ai-history-filter">
          <input
            type="checkbox"
            checked={aiOnly}
            onChange={(e) => setAiOnly(e.target.checked)}
          />
          只看 AI 的
        </label>
      </div>

      {loading ? (
        <div className="ai-hint">正在读取…</div>
      ) : !items.length ? (
        <div className="ai-hint">还没有操作记录</div>
      ) : (
        <div className="ai-history-list">
          {items.map((it) => (
            <div className="ai-history-item" key={it.seq}>
              <span className="ai-history-icon">
                {it.isAi ? <Bot size={14} /> : <User size={14} />}
              </span>
              <span className="ai-history-body">
                <span className="ai-history-text">
                  {it.calName && <span className="ai-prop-cal">{it.calName} · </span>}
                  {it.entity === 'task' ? '任务' : '打卡'} · {it.field}
                  {it.value ? ` = ${it.value}` : ''}
                </span>
                <span className="ai-history-time">
                  {new Date(it.ts).toLocaleString('zh-CN', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
