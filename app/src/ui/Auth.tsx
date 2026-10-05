/**
 * Auth.tsx —— 登录 / 首次注册
 *
 * 服务器是**多账户**的：第一个注册的人自动成为管理员（`users` 表里 id 最小
 * 的那个）。所以登录页没有「注册」开关，而是问一下 `auth/state`：
 *   还没人注册 → 这张表单就是「创建管理员账户」
 *   已经有账户 → 就是普通登录
 *
 * 这样新部署的用户不需要先知道什么管理员密码，也不会给已有账户的人
 * 多出一个「注册」入口去试探重名。
 */

import { useEffect, useState } from 'react';
import { CalendarCheck, Loader2, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { api, ApiError, setToken } from '../data/api.ts';
import { Btn } from './kit.tsx';
import type { PublicUser } from '../domain/types.ts';

export function Auth({ onAuthed }: { onAuthed: (u: PublicUser) => void }) {
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.authState()
      .then((s) => { if (alive) setHasUsers(!!s.hasUsers); })
      // 连不上也让人能填表单 —— 否则网络抖一下就只剩一个空白页，连报错都没有
      .catch(() => { if (alive) setHasUsers(true); });
    return () => { alive = false; };
  }, []);

  const first = hasUsers === false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n || !password) { setErr('请填写用户名和密码'); return; }
    // 服务器那边也校验，这里只是提前给个反馈，省一趟往返
    if (first && password.length < 6) { setErr('密码至少 6 位'); return; }

    setBusy(true);
    setErr(null);
    try {
      const r = first ? await api.register(n, password) : await api.login(n, password);
      setToken(r.token);
      onAuthed(r.user);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : '登录失败，请重试');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[var(--bg,#f5f6f8)] p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl bg-[var(--card,#fff)] p-7 shadow-lg
                   text-[var(--text,#1c1f26)]"
      >
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl
                          bg-[var(--accent,#4f7cff)] text-white">
            <CalendarCheck size={24} />
          </div>
          <div className="text-lg font-semibold">日程清单</div>
          <div className="text-[13px] text-[var(--text-2,#5b6070)]">
            {first ? '创建第一个账户，它会成为管理员' : '登录以同步你的日程'}
          </div>
        </div>

        {first && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-[var(--chip,rgba(0,0,0,.05))] p-3
                          text-[12.5px] leading-relaxed text-[var(--text-2,#5b6070)]">
            <ShieldCheck size={15} className="mt-0.5 shrink-0" />
            <span>管理员可以添加其他账户。登录后本机浏览器里原有的日程会自动导入。</span>
          </div>
        )}

        <label className="mb-1 block text-[12.5px] text-[var(--text-2,#5b6070)]">用户名</label>
        <input
          className="mb-3 w-full rounded-lg border border-[var(--line,rgba(0,0,0,.12))] bg-transparent
                     px-3 py-2 text-sm outline-none focus:border-[var(--accent,#4f7cff)]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />

        <label className="mb-1 block text-[12.5px] text-[var(--text-2,#5b6070)]">密码</label>
        <input
          type="password"
          className="w-full rounded-lg border border-[var(--line,rgba(0,0,0,.12))] bg-transparent
                     px-3 py-2 text-sm outline-none focus:border-[var(--accent,#4f7cff)]"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={first ? 'new-password' : 'current-password'}
        />

        {err && <div className="mt-3 text-[12.5px] text-[var(--danger,#e5484d)]">{err}</div>}

        <Btn
          variant="primary"
          type="submit"
          disabled={busy || hasUsers === null}
          className="mt-5 w-full"
        >
          {busy ? <Loader2 size={15} className="animate-spin" />
            : first ? <UserPlus size={15} /> : <LogIn size={15} />}
          {busy ? '请稍候…' : first ? '创建并进入' : '登录'}
        </Btn>
      </form>
    </div>
  );
}
