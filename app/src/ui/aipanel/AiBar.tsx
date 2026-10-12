/**
 * AiBar.tsx —— AI 面板顶栏：标题 + 视图切换 + 对话列表
 *
 * 从 `AiPanel.tsx` 拆出来。顶栏这一段自己就有一组状态（`view` / `sessions` /
 * `showSessions` / `sessionId`）和一段「点会话 → 拉历史 → 换气泡」的异步流程，
 * 跟面板主体的发送 / 确认逻辑没有共享状态 —— 拆出去之后两边都变短，而且
 * 「换会话」这件事只有一个地方在管。
 */

import { useRef, useState } from 'react';
import { Settings2, Sparkles } from 'lucide-react';
import { Btn, IconBtn } from '../kit.tsx';
import { useOverlayScrollbar } from '../scroll.ts';
import type { AiSessionMeta } from '../../domain/ai.ts';

export interface AiBarProps {
  /** 当前视图 */
  view: 'chat' | 'history' | 'memory';
  onView: (v: 'chat' | 'history' | 'memory') => void;
  /** 当前会话 id（chat 视图用） */
  sessionId: string | null;
  /** 换会话：清掉气泡、拉历史 */
  onPickSession: (id: string) => void;
  /** 新对话 */
  onFresh: () => void;
  /** 有没有气泡（决定「新对话」按钮显不显示） */
  hasBubbles: boolean;
  /** 忙不忙（发送中禁用「新对话」） */
  busy: boolean;
  /** 打开设置 */
  onSettings: () => void;
  /** 对话列表（由 AiPanel 加载） */
  sessions: AiSessionMeta[];
}

export function AiBar({
  view, onView, sessionId, onPickSession, onFresh, hasBubbles, busy, onSettings, sessions,
}: AiBarProps) {
  const [showSessions, setShowSessions] = useState(false);
  const sessionsList = useRef<HTMLDivElement>(null);
  const osbSessions = useOverlayScrollbar<HTMLDivElement>(sessionsList);

  return (
    <div className="ai-bar">
      <span className="ai-bar-title">
        <Sparkles size={14} /> {view === 'chat' ? (sessionId ? '继续这次对话' : '新对话') : view === 'history' ? '操作历史' : '记忆与授权'}
      </span>
      <div className="ai-bar-actions">
        {view === 'chat' && sessions.length > 0 && (
          <div className="ai-sessions">
            <Btn variant="ghost" size="sm" onClick={() => setShowSessions((v) => !v)}>
              对话 ({sessions.length})
            </Btn>
            {showSessions && (
              <div className="ai-sessions-list osb" ref={osbSessions}>
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    className={'ai-session-item' + (s.id === sessionId ? ' active' : '')}
                    onClick={() => {
                      setShowSessions(false);
                      onPickSession(s.id);
                    }}
                  >
                    {s.title || '未命名'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {view === 'chat' && hasBubbles && (
          <Btn variant="ghost" size="sm" onClick={onFresh} disabled={busy}>新对话</Btn>
        )}
        <IconBtn label="对话" onClick={() => onView('chat')}>
          <Sparkles size={16} />
        </IconBtn>
        <IconBtn label="历史" onClick={() => onView('history')}>
          <Settings2 size={16} />
        </IconBtn>
        <IconBtn label="记忆" onClick={() => onView('memory')}>
          <Settings2 size={16} />
        </IconBtn>
        <IconBtn label="AI 设置" onClick={onSettings}>
          <Settings2 size={16} />
        </IconBtn>
      </div>
    </div>
  );
}
