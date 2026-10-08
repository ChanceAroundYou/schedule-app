/**
 * AiPanel.tsx —— AI 对话面板
 *
 * 这是「能问」那一层的界面：一个对话框，模型自己去查排期（动作条会显示
 * 它查了什么），流式把答案打出来。
 *
 * 三件事不放这儿：
 *   SSE 怎么切        → domain/ai.ts 的 sseFeed()（纯函数，有单测）
 *   流怎么读          → ui/aiClient.ts
 *   key 怎么存        → AiSettings.tsx + 服务器
 *
 * **读 + 提案确认。** 模型能查、能算、能建议，也能提出改动 —— 但改数据要用户
 * 在卡片上点「确认」才落库（`POST /api/ai/confirm`）。写工具本身只造提案，
 * 见 server/lib/ai/tools.mjs 的文件头。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Loader2, Send, Settings2, Sparkles, Square,
} from 'lucide-react';
import { api } from '../data/api.ts';
import { chatStream } from './aiClient.ts';
import { AiSettingsSheet } from './AiSettings.tsx';
import { AiHistory } from './AiHistory.tsx';
import { AiMemory } from './AiMemory.tsx';
import { Btn, IconBtn, Input, Textarea, toast } from './kit.tsx';
import { useIsNarrow } from './hooks.ts';
import {
  applyEvent, actionText, buildContext, newLiveAssistant, proposalText,
} from '../domain/ai.ts';
import type { AiChatMessage, AiSessionMeta, LiveAssistant } from '../domain/ai.ts';
import type { LocalState } from '../domain/types.ts';

interface Bubble extends LiveAssistant {
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
function toBubble(m: AiChatMessage): Bubble {
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
const VISIBLE = new Set(['user', 'assistant']);

const EXAMPLES = [
  '这周还剩什么没做？',
  '下周哪天适合出去玩？',
  '最近排得怎么样，有什么落下的吗',
];

export function AiPanel({ state, onConfirmed }: {
  state: LocalState;
  /** 确认成功之后调一次，把 AI 写进来的 op 拉回来。省略 = 等下一轮轮询 */
  onConfirmed?: () => void;
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [settings, setSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 每条提案的编辑输入：proposalId → 用户输入的修改指令 */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** 当前视图：对话 / 历史 / 记忆 */
  const [view, setView] = useState<'chat' | 'history' | 'memory'>('chat');
  /** 对话列表 */
  const [sessions, setSessions] = useState<AiSessionMeta[]>([]);
  /** 对话列表是否展开 */
  const [showSessions, setShowSessions] = useState(false);
  /** 新手引导是否显示 */
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return !localStorage.getItem('schedule-ai-onboarded'); } catch (_) { return true; }
  });

  const ctl = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const narrow = useIsNarrow();

  /* -------- 开局：接着上次那条对话 -------- */
  // 续上而不是重开，因为「那周三呢」这种追问要上下文才答得对。
  // 想重新开始点上面的「新对话」。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.aiSettings();
        if (alive) setReady(s.ready);
      } catch (_) { /* 读不到就当没配，发的时候服务器还会再说一次 */ }

      try {
        const list = await api.aiSessions();
        if (alive) setSessions(list);
        if (!alive || !list.length) return;
        const one = await api.aiSession(list[0].id);
        if (!alive) return;
        setSessionId(one.session.id);
        setBubbles(one.messages.filter((m) => VISIBLE.has(m.role)).map(toBubble));
      } catch (_) { /* 没有历史就是空的，不是错误 */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => {
      alive = false;
      ctl.current?.abort();
    };
  }, []);

  // 跟着新内容滚到底
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles]);

  const stop = useCallback(() => { ctl.current?.abort(); }, []);

  const send = useCallback(async (raw?: string) => {
    const q = (raw ?? text).trim();
    if (!q || busy) return;

    setText('');
    setBusy(true);

    const id = 'live' + (++seq.current);
    const uid = 'user' + seq.current;
    setBubbles((prev) => [
      ...prev,
      { id: uid, role: 'user', text: q, actions: [], proposals: [] },
      { ...newLiveAssistant(id), role: 'assistant', streaming: true },
    ]);

    const c = new AbortController();
    ctl.current = c;

    const patch = (fn: (b: Bubble) => Bubble) =>
      setBubbles((prev) => prev.map((b) => (b.id === id ? fn(b) : b)));

    try {
      await chatStream(
        { text: q, sessionId, context: buildContext(state) },
        (ev) => {
          if (ev.type === 'session') { setSessionId(ev.sessionId); return; }
          if (ev.type === 'done') { patch((b) => ({ ...b, streaming: false })); return; }
          patch((b) => ({ ...applyEvent(b, ev), role: 'assistant' }));
        },
        c.signal,
      );
    } catch (e) {
      const err = e as Error;
      if (err?.name !== 'AbortError') {
        patch((b) => ({ ...b, error: err.message || '出错了', streaming: false }));
      }
    } finally {
      patch((b) => ({ ...b, streaming: false }));
      setBusy(false);
      ctl.current = null;
    }
  }, [text, busy, sessionId, state]);

  const fresh = () => {
    stop();
    setSessionId(null);
    setBubbles([]);
    setText('');
  };

  /* -------- 确认提案 -------- */
  // 点「确认」= 同意 AI 改这一条。划不划卡片**按服务器的回话定**，不做乐观更新：
  // 服务器那边会重查权限再落库（提案生成到确认之间用户可能被降级），
  // 猜它会成功的话，被挡下时用户看到的是「卡片没了但什么也没发生」。
  //
  // 失败的**不划掉** —— 用户可能想再试一次，至少也该看见它还挂着。
  //
  // 如果用户在编辑框里输了修改指令，先把指令发给 agent 处理，不直接确认。
  // agent 处理完会更新提案，用户再点一次确认。
  const confirmProposals = useCallback(async (ids: string[]) => {
    if (!ids.length || confirming) return;

    // 有修改指令：发给 agent，不确认
    const edit = edits[ids[0]]?.trim();
    if (edit) {
      setEdits((prev) => ({ ...prev, [ids[0]]: '' }));
      setText(edit);
      // 等 agent 处理完修改指令后，用户再点确认
      void send(edit);
      return;
    }

    setConfirming(true);
    try {
      const res = await api.aiConfirm(ids);
      const okIds = new Set(res.done.map((d) => d.id));

      if (okIds.size) {
        setBubbles((prev) => prev.map((b) => ({
          ...b,
          proposals: b.proposals.filter((p) => !okIds.has(p.id)),
        })));
        onConfirmed?.();
      }

      // 成功和失败说在同一条 toast 里 —— 分两条的话后一条把前一条盖掉了
      const parts = [];
      if (res.done.length) parts.push(`已确认 ${res.done.length} 条改动`);
      if (res.failed.length) {
        parts.push(`没成 ${res.failed.length} 条：${res.failed.map((f) => f.reason).join('；')}`);
      }
      if (parts.length) toast(parts.join('，'));
    } catch (_) {
      toast('确认失败，请稍后再试');
    } finally {
      setConfirming(false);
    }
  }, [confirming, onConfirmed, edits, send]);

  return (
    <div className="ai-wrap">
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
                <div className="ai-sessions-list">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      className={'ai-session-item' + (s.id === sessionId ? ' active' : '')}
                      onClick={() => {
                        setShowSessions(false);
                        setSessionId(s.id);
                        setBubbles([]);
                        setLoading(true);
                        api.aiSession(s.id).then((one) => {
                          setBubbles(one.messages.filter((m) => VISIBLE.has(m.role)).map(toBubble));
                          setLoading(false);
                        }).catch(() => setLoading(false));
                      }}
                    >
                      {s.title || '未命名'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {view === 'chat' && bubbles.length > 0 && (
            <Btn variant="ghost" size="sm" onClick={fresh} disabled={busy}>新对话</Btn>
          )}
          <IconBtn label="对话" onClick={() => setView('chat')}>
            <Sparkles size={16} />
          </IconBtn>
          <IconBtn label="历史" onClick={() => setView('history')}>
            <Settings2 size={16} />
          </IconBtn>
          <IconBtn label="记忆" onClick={() => setView('memory')}>
            <Settings2 size={16} />
          </IconBtn>
          <IconBtn label="AI 设置" onClick={() => setSettings(true)}>
            <Settings2 size={16} />
          </IconBtn>
        </div>
      </div>

      {view === 'history' && <AiHistory />}
      {view === 'memory' && <AiMemory />}

      {showOnboarding && view === 'chat' && (
        <div className="ai-onboarding">
          <div className="ai-onboarding-tip">改动要你点「确认」才生效——它先提案，你点头才落库。</div>
          <Btn
            variant="primary"
            size="sm"
            onClick={() => {
              setShowOnboarding(false);
              try { localStorage.setItem('schedule-ai-onboarded', '1'); } catch (_) { /* 隐私模式 */ }
            }}
          >
            知道了
          </Btn>
        </div>
      )}

      <div className="ai-scroll" ref={scroller}>
        {loading && (
          <div className="ai-hint"><Loader2 size={14} className="animate-spin" /> 正在读取对话…</div>
        )}

        {!loading && !bubbles.length && (
          <div className="ai-intro">
            <div className="ai-intro-ico"><Sparkles size={22} /></div>
            <div className="ai-intro-title">问我排期上的事</div>
            <div className="ai-intro-sub">
              我能读你的日程集、任务和空档 —— 回答里的日子都是查出来的，不是猜的。
            </div>
            <div className="ai-examples">
              {EXAMPLES.map((q) => (
                <button key={q} className="ai-example" onClick={() => void send(q)}>{q}</button>
              ))}
            </div>
          </div>
        )}

        {ready === false && (
          <div className="ai-banner">
            <AlertTriangle size={15} />
            <span>还没配置模型。填一下 Base URL 和模型名就能用了。</span>
            <Btn variant="primary" size="sm" onClick={() => setSettings(true)}>去设置</Btn>
          </div>
        )}

        {bubbles.map((b) => (
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
                <button className="ai-err-link" onClick={() => setSettings(true)}>打开设置</button>
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
                        onChange={(e) => setEdits((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void confirmProposals([p.id]);
                          }
                        }}
                      />
                      <Btn
                        variant="primary"
                        size="sm"
                        disabled={confirming}
                        onClick={() => void confirmProposals([p.id])}
                      >
                        <Check size={12} /> 确认
                      </Btn>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ai-compose">
        <Textarea
          className="ai-input"
          value={text}
          rows={narrow ? 1 : 2}
          placeholder="问点排期上的事…（回车发送，Shift+回车换行）"
          aria-label="跟 AI 说"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          disabled={busy}
        />
        {busy ? (
          <Btn variant="normal" onClick={stop}><Square size={14} /> 停止</Btn>
        ) : (
          <Btn variant="primary" onClick={() => void send()} disabled={!text.trim()}>
            <Send size={14} /> 发送
          </Btn>
        )}
      </div>

      <AiSettingsSheet
        open={settings}
        onClose={() => setSettings(false)}
        onSaved={(s) => {
          setReady(s.ready);
          if (bubbles.length) toast('下次提问就会用新配置');
        }}
      />
    </div>
  );
}
