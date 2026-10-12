/**
 * AiCompose.tsx —— AI 面板底部输入区
 *
 * 从 `AiPanel.tsx` 拆出来。输入区只有三样东西：文本框、发送 / 停止按钮、
 * 回车发送。它跟面板主体的关系是「把 text 和 send 交出去」—— 一个
 * `onSend(text)` 就够，不需要知道气泡、会话、确认那些。
 */

import { Send, Square } from 'lucide-react';
import { Btn, Textarea } from '../kit.tsx';
import { useIsNarrow } from '../hooks.ts';

export interface AiComposeProps {
  text: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
}

export function AiCompose({ text, onChange, onSend, onStop, busy }: AiComposeProps) {
  const narrow = useIsNarrow();
  return (
    <div className="ai-compose">
      <Textarea
        className="ai-input"
        value={text}
        rows={narrow ? 1 : 2}
        placeholder="问点排期上的事…（回车发送，Shift+回车换行）"
        aria-label="跟 AI 说"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        }}
        disabled={busy}
      />
      {busy ? (
        <Btn variant="normal" onClick={onStop}><Square size={14} /> 停止</Btn>
      ) : (
        <Btn variant="primary" onClick={onSend} disabled={!text.trim()}>
          <Send size={14} /> 发送
        </Btn>
      )}
    </div>
  );
}
