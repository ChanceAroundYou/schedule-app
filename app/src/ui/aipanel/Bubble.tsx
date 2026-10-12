/**
 * Bubble.tsx —— AI 对话气泡
 */

import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Btn, Input } from '../kit.tsx';
import { actionText, proposalText, type LiveAssistant } from '../../domain/ai.ts';
import type { AiChatMessage } from '../../domain/ai.ts';

export interface Bubble extends LiveAssistant {
  role: 'user' | 'assistant';
  /** 服务端还在这条上推字。用来画那个闪动的光标 */
  streaming?: boolean;
}

/**
 * 库里的一条消息 → 界面上的一条气泡。
 *
 * `toolResult` 那些**不画**（调用点先滤掉了）：那是模型自己看的东西，
 * 内容是整份查询结果的 JSON，几十 KB。历史里把它当气泡画出来，
 * 用户刷新一次就会看到一屏裸 JSON —— 而它本来只是「AI 查到了什么」。
 * 这一步在气泡上的表达是那条动作条，不是这段原文。
 */
export function toBubble(m: AiChatMessage): Bubble {
  return {
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    text: m.text,
    // 历史消息里的工具调用都是已经跑完的 —— 它们没有「正在查」这个中间态
    actions: m.tools.map((t) => ({
      name: t.name,
      label: actionText(t.name, (t.args || {}) as Record<string, unknown>),
      done: true,
    })),
    // 还没确认的提案会跟着消息一起回来 —— 刷新之后卡片要还在，
    // 否则用户看着模型说「点下面确认」却找不到那张卡片
    proposals: m.proposals || [],
  };
}

/** 画成气泡的那几种角色。别的（toolResult）是内部消息 */
export const VISIBLE = new Set(['user', 'assistant']);

export interface BubbleProps {
  b: Bubble;
  busy: boolean;
  confirming: boolean;
  edits: Record<string, string>;
  onEdit: (id: string, v: string) => void;
  onConfirm: (ids: string[]) => void;
  onOpenSettings: () => void;
}

/** 一条消息的气泡：动作条 + 文字 + 错误 + 提案卡片 */
export function BubbleMsg({ b, busy, confirming, edits, onEdit, onConfirm, onOpenSettings }: BubbleProps) {
  return (
    <div className={'ai-msg ' + b.role} key={b.id}>
      {!!b.actions.length && (
        <div className="ai-acts">
          {b.actions.map((a, i) => (
            <span className={'ai-act' + (a.error ? ' bad' : '')} key={i}>
              {a.done
                ? (a.error ? <AlertTriangle size={11} /> : <Check size={11} />)
                : <Loader2 size={11} className="animate-spin" />}
              {a.label}
            </span>
          ))}
        </div>
      )}

      {/* 纯工具调用那一轮（模型没说话、直接查）不画空气泡 —— 那段空白
          看起来像「回了个空」，而动作条已经把发生的事说清楚了 */}
      {(b.text || b.streaming) && (
        <div className="ai-bubble">
          {b.text}
          {b.streaming && !b.text && <span className="ai-dots"><i /><i /><i /></span>}
        </div>
      )}

      {b.error && (
        <div className="ai-err">
          <AlertTriangle size={14} />
          <span>{b.error}</span>
          <button className="ai-err-link" onClick={onOpenSettings}>打开设置</button>
        </div>
      )}

      {/* 提案卡片：AI 打算改什么，等用户点确认。
          措辞是「新建」「改期」这些没发生的动词 —— 确认之前它确实没发生 */}
      {!!b.proposals.length && (
        <div className="ai-props">
          {b.proposals.map((p) => {
            const edit = edits[p.id] || '';
            return (
              <div className="ai-prop" key={p.id}>
                <span className="ai-prop-text">
                  {p.calName && <span className="ai-prop-cal">{p.calName} · </span>}
                  {proposalText(p)}
                </span>
                <Input
                  dense
                  className="ai-prop-edit"
                  value={edit}
                  placeholder="要改什么？比如「改成 10月9日」"
                  spellCheck={false}
                  disabled={busy || confirming}
                  onChange={(e) => onEdit(p.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onConfirm([p.id]);
                    }
                  }}
                />
                <Btn
                  variant="primary"
                  size="sm"
                  disabled={confirming}
                  onClick={() => onConfirm([p.id])}
                >
                  <Check size={12} /> 确认
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
