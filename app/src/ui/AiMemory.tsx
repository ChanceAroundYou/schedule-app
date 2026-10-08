/**
 * AiMemory.tsx —— 记忆与授权管理
 *
 * 记忆：agent 在对话中自己决定记什么，用户在这里看见、编辑、删除。
 * 授权：任务增删改默认免确认，打卡和日程集管理默认需确认。
 */

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../data/api.ts';
import type { AiAuthorizations, AiMemory } from '../domain/ai.ts';
import { Dropdown, Input } from './kit.tsx';

const TYPE_LABEL: Record<string, string> = {
  preference: '偏好',
  decision: '决定',
  pattern: '模式',
};

export function AiMemory() {
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const [auth, setAuth] = useState<AiAuthorizations | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([api.aiMemories(), api.aiAuthorizations()])
      .then(([m, a]) => {
        if (!alive) return;
        setMemories(m);
        setAuth(a);
      })
      .catch(() => { /* 读不到就是空的 */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const saveEdit = async (id: string) => {
    const content = editText.trim();
    if (!content) return;
    try {
      await api.aiUpdateMemory(id, content);
      setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
      setEditingId(null);
    } catch (_) { /* 失败就失败 */ }
  };

  const remove = async (id: string) => {
    try {
      await api.aiDeleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (_) { /* 失败就失败 */ }
  };

  const saveAuth = async (patch: Partial<AiAuthorizations>) => {
    try {
      const a = await api.aiSaveAuthorizations(patch);
      setAuth(a);
    } catch (_) { /* 失败就失败 */ }
  };

  if (loading) return <div className="ai-hint">正在读取…</div>;

  return (
    <div className="ai-memory">
      {/* ---- 授权 ---- */}
      {auth && (
        <div className="ai-memory-section">
          <div className="ai-memory-title">授权</div>
          <div className="ai-auth-grid">
            <label className="ai-auth-item">
              <span>任务增删改</span>
              <Dropdown
                value={auth.taskCrud}
                options={[{ value: 'free', label: '免确认' }, { value: 'confirm', label: '需确认' }]}
                onPick={(value) => void saveAuth({ taskCrud: value })}
                label="任务增删改"
                size="sm"
              />
            </label>
            <label className="ai-auth-item">
              <span>打卡</span>
              <Dropdown
                value={auth.habitCheckin}
                options={[{ value: 'free', label: '免确认' }, { value: 'confirm', label: '需确认' }]}
                onPick={(value) => void saveAuth({ habitCheckin: value })}
                label="打卡"
                size="sm"
              />
            </label>
            <label className="ai-auth-item">
              <span>日程集管理</span>
              <Dropdown
                value={auth.calendarMgmt}
                options={[{ value: 'free', label: '免确认' }, { value: 'confirm', label: '需确认' }]}
                onPick={(value) => void saveAuth({ calendarMgmt: value })}
                label="日程集管理"
                size="sm"
              />
            </label>
            <label className="ai-auth-item">
              <span>晚间汇报</span>
              <Dropdown
                value={auth.eveningReportEnabled ? 'on' : 'off'}
                options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }]}
                onPick={(value) => void saveAuth({ eveningReportEnabled: value === 'on' })}
                label="晚间汇报"
                size="sm"
              />
            </label>
            {auth.eveningReportEnabled && (
              <label className="ai-auth-item">
                <span>汇报时间</span>
                <Input
                  dense
                  type="time"
                  value={auth.eveningReportTime}
                  onChange={(e) => void saveAuth({ eveningReportTime: e.target.value })}
                />
              </label>
            )}
          </div>
        </div>
      )}

      {/* ---- 记忆 ---- */}
      <div className="ai-memory-section">
        <div className="ai-memory-title">记忆</div>
        {!memories.length ? (
          <div className="ai-hint">还没有记忆。跟 AI 聊聊天，它会自己记住一些事。</div>
        ) : (
          <div className="ai-memory-list">
            {memories.map((m) => (
              <div className="ai-memory-item" key={m.id}>
                <span className="ai-memory-type">{TYPE_LABEL[m.type] || m.type}</span>
                {editingId === m.id ? (
                  <input
                    className="ai-memory-edit"
                    value={editText}
                    aria-label="编辑记忆"
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveEdit(m.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    className="ai-memory-content"
                    onClick={() => { setEditingId(m.id); setEditText(m.content); }}
                  >
                    {m.content}
                  </span>
                )}
                <button
                  className="ai-memory-del"
                  onClick={() => void remove(m.id)}
                  title="删除"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
