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
 *
 * 顶栏（`AiBar`）与输入区（`AiCompose`）拆去同目录 —— 各自有独立的状态
 * 和异步流程，跟面板主体的发送 / 确认逻辑没有共享状态。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../data/api.ts';
import { chatStream } from '../aiClient.ts';
import { AiSettingsSheet } from './AiSettings.tsx';
import { AiHistory } from './AiHistory.tsx';
import { AiMemory } from './AiMemory.tsx';
import { Btn, toast } from '../kit.tsx';
import { useOverlayScrollbar } from '../scroll.ts';
import {
  applyEvent, buildContext, newLiveAssistant,
} from '../../domain/ai.ts';
import type { AiSessionMeta } from '../../domain/ai.ts';
import type { LocalState } from '../../domain/types.ts';
import { BubbleMsg, toBubble, VISIBLE, type Bubble } from './Bubble.tsx';
import { AiBar } from './AiBar.tsx';
import { AiCompose } from './AiCompose.tsx';

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
  /** 新手引导是否显示 */
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return !localStorage.getItem('schedule-ai-onboarded'); } catch (_) { return true; }
  });

  const ctl = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /* 浮条：消息列表会越聊越长 —— 见 ui/scroll.ts */
  const osbChat = useOverlayScrollbar<HTMLDivElement>(scroller);
  const seq = useRef(0);

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

  /* -------- 换会话 -------- */
  const pickSession = useCallback((id: string) => {
    setSessionId(id);
    setBubbles([]);
    setLoading(true);
    api.aiSession(id).then((one) => {
      setBubbles(one.messages.filter((m) => VISIBLE.has(m.role)).map(toBubble));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

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
      <AiBar
        view={view}
        onView={setView}
        sessionId={sessionId}
        onPickSession={pickSession}
        onFresh={fresh}
        hasBubbles={bubbles.length > 0}
        busy={busy}
        onSettings={() => setSettings(true)}
        sessions={sessions}
      />

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

      <div className="ai-scroll osb" ref={osbChat}>
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
          <BubbleMsg
            key={b.id}
            b={b}
            busy={busy}
            confirming={confirming}
            edits={edits}
            onEdit={(id, v) => setEdits((prev) => ({ ...prev, [id]: v }))}
            onConfirm={(ids) => void confirmProposals(ids)}
            onOpenSettings={() => setSettings(true)}
          />
        ))}
      </div>

      <AiCompose
        text={text}
        onChange={setText}
        onSend={() => void send()}
        onStop={stop}
        busy={busy}
      />

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
