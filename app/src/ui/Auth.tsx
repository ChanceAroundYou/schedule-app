/**
 * Auth.tsx —— 登录 / 注册
 *
 * 服务器是**平等多用户**：没有管理员，任何人都能自助注册，注册完自动获得一个
 * 自己的「我的日程」。所以这里是一个普通的登录/注册切换，不再去问
 * `auth/state`、也不再有「第一个人是管理员」那套说明。
 *
 * 校验以服务器为准，这里只做「格式明显不对就别多发一趟请求」的前置提示；
 * 真正的错误（重名、弱密码、限流）由服务器返回，直接显示原文。
 */

import { useId, useState } from 'react';
import { CalendarCheck, Loader2, LogIn, UserPlus } from 'lucide-react';
import { api, ApiError, setToken } from '../data/api.ts';
import { Btn, Input } from './kit.tsx';
import type { PublicUser } from '../domain/types.ts';

type Mode = 'login' | 'register';

export function Auth({ onAuthed }: { onAuthed: (u: PublicUser) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 见 Drawer.tsx 同名注释：label 与控件必须靠 id 配上，不能只做兄弟 */
  const fid = useId();

  const register = mode === 'register';

  const swap = (m: Mode) => {
    setMode(m);
    setErr(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (n.length < 2) { setErr('用户名至少 2 个字'); return; }
    const nk = nickname.trim();
    // 和服务器 `auth.nicknameProblem` 同一句话：超过就别多发一趟请求
    if (register && nk.length > 20) { setErr('昵称最长 20 字'); return; }
    if (register && password.length < 6) { setErr('密码至少 6 位'); return; }
    if (!password) { setErr('请输入密码'); return; }

    setBusy(true);
    setErr(null);
    try {
      const r = register ? await api.register(n, password, nk) : await api.login(n, password);
      setToken(r.token);
      onAuthed(r.user);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : '连不上服务器，请重试');
      setBusy(false);
    }
  };

  return (
    // 可滚 + `my-auto` 居中，而**不是** items-center：手机上键盘一弹出，
    // 可视高度只剩一半，居中布局的卡片底部（尤其是提交按钮）正好压在键盘底下。
    // 固定定位的元素浏览器不会替我们滚，所以自己开滚动条；
    // 用 auto 外边距而不是 justify/items-center —— 后者在内容比容器高时
    // 会把顶部裁掉且滚不上去，正是这里最怕的那种情况。
    // pb 里的 --kb 是 ui/hooks.ts 量的键盘高度（见那里的注释）。
    <div className="auth-bg fixed inset-0 flex flex-col overflow-y-auto
                    p-6 pb-[calc(1.5rem+var(--kb))]">
      <form
        onSubmit={submit}
        className="auth-card mx-auto my-auto w-full max-w-sm
                   p-7 shadow-lg"
      >
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="auth-logo flex h-12 w-12 items-center justify-center
                          bg-[linear-gradient(140deg,var(--primary),var(--purple))]">
            <CalendarCheck size={24} />
          </div>
          <div className="text-lg font-semibold">日程清单</div>
          <div className="auth-sub text-[13px]">
            {register ? '注册后自动建一个「我的日程」' : '登录以同步你的日程'}
          </div>
        </div>

        <label htmlFor={fid + '-name'} className="auth-label mb-1 block text-[12.5px]">用户名</label>
        <Input
          id={fid + '-name'}
          className="auth-input mb-3 bg-transparent"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />

        {/* 昵称只在注册时出现：它是可选的，登录那一屏不该多一行问这个。
            注册完还能在「设置 → 安全」里改，所以这里不问第二遍。 */}
        {register && (
          <>
            <label htmlFor={fid + '-nick'} className="auth-label mb-1 block text-[12.5px]">昵称（可不填）</label>
            <Input
              id={fid + '-nick'}
              className="auth-input mb-3 bg-transparent"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={name || '显示给别人看的名字'}
              autoComplete="nickname"
            />
          </>
        )}

        <label htmlFor={fid + '-pwd'} className="auth-label mb-1 block text-[12.5px]">密码</label>
        <Input
          id={fid + '-pwd'}
          type="password"
          className="auth-input bg-transparent"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={register ? 'new-password' : 'current-password'}
        />
        {register && <div className="auth-hint mt-1 text-[11.5px]">至少 6 位</div>}

        {err && <div className="auth-err mt-3 text-[12.5px]">{err}</div>}

        <Btn variant="primary" type="submit" disabled={busy} className="mt-5 w-full">
          {busy ? <Loader2 size={15} className="animate-spin" />
            : register ? <UserPlus size={15} /> : <LogIn size={15} />}
          {busy ? '请稍候…' : register ? '注册并进入' : '登录'}
        </Btn>

        <div className="auth-foot mt-4 text-center text-[12.5px]">
          {register ? '已经有账户了？' : '还没有账户？'}
          <button
            type="button"
            onClick={() => swap(register ? 'login' : 'register')}
            className="auth-link ml-1 font-medium hover:underline"
          >
            {register ? '去登录' : '注册一个'}
          </button>
        </div>
      </form>
    </div>
  );
}
