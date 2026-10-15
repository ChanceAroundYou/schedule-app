import { forwardRef, useState } from 'react';
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

export const AiCompose = forwardRef<HTMLTextAreaElement, AiComposeProps>(
  function AiCompose({ text, onChange, onSend, onStop, busy }, ref) {
    const narrow = useIsNarrow();
    const [isComposing, setIsComposing] = useState(false);

    return (
      <div className="ai-compose">
        <Textarea
          ref={ref}
          className="ai-input"
          value={text}
          rows={narrow ? 1 : 2}
          placeholder="问点排期上的事…（回车发送，Shift+回车换行）"
          aria-label="跟 AI 说"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={busy}
        />
        {busy ? (
          <Btn variant="normal" onClick={onStop}><Square size={14} /> 停止</Btn>
        ) : (
          <Btn
            variant="primary"
            onClick={onSend}
            disabled={!text.trim() || isComposing}
          >
            <Send size={14} /> 发送
          </Btn>
        )}
      </div>
    );
  },
);