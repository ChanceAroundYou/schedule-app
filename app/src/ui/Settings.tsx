/**
 * Settings.tsx —— 设置页
 *
 * 放在 `ui/` 而不是 `views/`，**这是故意偏离方案的一处**：
 * 项目 CLAUDE.md 四、28 定死 `views/` 是「纯展示、零回调，只出 data-* 属性」，
 * 理由是那里的行会被拖拽重排 / 同步落地**换掉节点**，挂在行上的 handler 会跟着丢，
 * 所以全走 App.tsx 的事件委托。设置页没有这一类会被搬动的行 —— 它是普通表单，
 * 而 `ui/` 下本来就是这个形态（Calendars / Auth / Drawer / ActSheet 都收回调）。
 * 把它放进 views/ 会让那条不变量第一次出现例外，例外一多就没人守了。
 *
 * 页面本身是**竖排卡片**：外观 / 数据 / 账户 / 日程集 / 关于。
 * 配色一律走 legacy.css 的 CSS 变量（新表面没有 legacy 规则，Tailwind 生效；
 * 写死颜色会让深色模式在这里失效）。
 */
import { useRef, useState } from 'react';
import {
  Database, Info, Layers, LogOut, MailPlus, Palette, Pencil, Upload, Download,
  Trash2, UserRound,
} from 'lucide-react';
import type { AccentKey, LocalState, PublicUser, StyleKey, ThemeMode } from '../domain/types.ts';
import { ROLE_LABEL, canManage } from '../domain/types.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import * as T from './theme.ts';
import { Btn, useConfirm, toast } from './kit.tsx';
import { useOnline } from './hooks.ts';
import { cx } from './cx.ts';

/** 构建期注入，见 vite-env.d.ts。取不到（比如被别的打包器吃掉）时不要显示空白 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

const LINE = 'border-[var(--line,rgba(0,0,0,.12))]';

/* ============================== 小组件 ============================== */

function Card({ icon, title, children, hint }: {
  icon: React.ReactNode; title: string; children: React.ReactNode; hint?: React.ReactNode;
}) {
  return (
    <section className={'mb-4 rounded-xl border p-4 ' + LINE}>
      <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
        <span className="text-[var(--text-3)]">{icon}</span> {title}
      </h2>
      {children}
      {hint && <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </section>
  );
}

/**
 * 一排二选一 / 三选一的胶囊。
 *
 * **不是 `<select>`**：这三轴一共 6+3+3 个选项，是用户会反复来回试的东西，
 * 每次都要展开一次下拉等于把「试」这件事的摩擦拉满。
 */
function Chips<K extends string>({ value, options, onPick, render }: {
  value: K;
  options: readonly K[];
  onPick: (k: K) => void;
  /** 色板那一轴要在胶囊里画一个色点，那个色点得跟着这一轴自己的取值走 */
  render?: (k: K) => React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((k) => {
        const on = k === value;
        return (
          <button
            key={k}
            type="button"
            data-pick={k}
            aria-pressed={on}
            onClick={() => onPick(k)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition',
              on
                ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                : 'text-[var(--text-2)] hover:bg-[var(--hover,rgba(0,0,0,.05))] ' + LINE,
            )}
          >
            {render?.(k)}
            {(T.ACCENTS as Record<string, { label: string }>)[k as unknown as string]?.label
              || (T.THEMES as Record<string, { label: string }>)[k as unknown as string]?.label
              || (T.STYLES as Record<string, { label: string }>)[k as unknown as string]?.label || k}
          </button>
        );
      })}
    </div>
  );
}

/* ================================ 页面 ================================ */

export function SettingsView({ state, user, theme, onExport, onImport, onLogout, onManageCal, onInvites }: {
  state: LocalState;
  user: PublicUser | null;
  /** **实际生效**的那一档（auto 已解析）。色点要靠它才画得出暗色档的颜色 */
  theme: 'light' | 'dark';
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onManageCal: () => void;
  onInvites: () => void;
}) {
  const ui = state.ui;
  const confirm = useConfirm();
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const cal = state.cals.find((c) => c.id === ui.cal) || null;
  const pending = state.invites.length;

  const wipeLocal = async () => {
    const ok = await confirm({
      title: '清空本机这份副本？',
      // 正文必须说清「服务器那份还在」——不然没人敢点
      body: '本机缓存的全部内容会删掉，随后从服务器重新拉一份。'
        + '还没同步上去的改动会丢失。服务器上的数据不受影响。',
      confirmText: '清空并重新拉取', danger: true,
    });
    if (!ok) return;
    store.resetLocal();
    toast('已清空，正在重新拉取');
    try { await engine.syncNow(); } catch (_) { /* 断网时顶栏会说话 */ }
  };

  return (
    <div className="mx-auto w-full max-w-[620px] pb-6">

      <Card icon={<Palette size={14} />} title="外观"
        hint="深浅那一档选「跟随系统」时会随系统的日夜切换自动变，不用手动改。">
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">色板</div>
            <Chips<AccentKey>
              value={ui.accent}
              options={['jade', 'azure', 'clay', 'plum', 'gold', 'slate']}
              onPick={(k) => store.setUi({ accent: k })}
              // 色点在**自己身上**带 data-accent + data-theme，于是它拿到的
              // --primary 就是选中那套（含暗色档那组提亮过的值）。
              // 不在 TS 里再存一份十六进制 —— 那两份一定会漂。
              render={(k) => (
                <span
                  data-accent={k}
                  data-theme={theme}
                  className="inline-block h-3 w-3 shrink-0 rounded-full"
                  style={{ background: 'var(--primary)' }}
                />
              )}
            />
          </div>

          <div>
            <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">风格</div>
            <div>
              <Chips<StyleKey>
                value={ui.style}
                options={['soft', 'flat', 'notion']}
                onPick={(k) => store.setUi({ style: k })}
              />
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">
              深浅
              {/* 顶栏那个按钮是二元的（按下即离开「跟随系统」），三选一只有这里 */}
            </div>
            <Chips<ThemeMode>
              value={ui.theme}
              options={['auto', 'light', 'dark']}
              onPick={(k) => store.setUi({ theme: k })}
            />
          </div>
        </div>
      </Card>

      <Card icon={<Database size={14} />} title="数据"
        hint="备份是**合并**，不是覆盖：同 id 的会被覆盖，其余原样留着。">
        <div className="flex flex-wrap gap-2">
          <Btn variant="chip" size="sm" onClick={onExport}>
            <Upload size={13} /> 导出备份
          </Btn>
          <Btn variant="chip" size="sm" onClick={() => fileRef.current?.click()}>
            <Download size={13} /> 导入备份
          </Btn>
          <Btn variant="ghost" size="sm" disabled={busy} onClick={() => { setBusy(true); void wipeLocal().then(() => setBusy(false)); }}>
            <Trash2 size={13} /> 清空本机副本
          </Btn>
          <input
            ref={fileRef} type="file" accept="application/json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
          />
        </div>
      </Card>

      <Card icon={<Layers size={14} />} title="日程集">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {cal ? cal.name : '还没有拿到日程集'}
            {cal && <span className="ml-1.5 text-[11.5px] text-[var(--text-3)]">{ROLE_LABEL[cal.role]}</span>}
          </span>
          <Btn variant="chip" size="sm" disabled={!cal} onClick={onManageCal}>
            <Pencil size={13} /> 管理
          </Btn>
          <Btn variant="chip" size="sm" onClick={onInvites}>
            <MailPlus size={13} /> 邀请{pending ? `（${pending}）` : ''}
          </Btn>
        </div>
        {cal && !canManage(cal.role) && (
          <div className="mt-2 text-[11.5px] text-[var(--text-3)]">
            这个集里你不是创建者，名字与成员只有创建者能改。
          </div>
        )}
      </Card>

      <Card icon={<UserRound size={14} />} title="账户">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{user ? user.name : '未登录'}</span>
          <Btn variant="ghost" size="sm" onClick={onLogout}>
            <LogOut size={13} /> 退出登录
          </Btn>
        </div>
      </Card>

      <Card icon={<Info size={14} />} title="关于">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="text-[var(--text-3)]">版本</dt>
          <dd data-about="version">{VERSION}</dd>
          <dt className="text-[var(--text-3)]">网络</dt>
          <dd data-about="net">{online ? '在线' : '离线，改动先存在本机'}</dd>
          <dt className="text-[var(--text-3)]">同步</dt>
          <dd data-about="sync">
            {state.outbox.length ? `待上传 ${state.outbox.length} 条` : '没有待上传的改动'}
            <span className="text-[var(--text-3)]"> · 已拉到 #{state.cursor}</span>
          </dd>
        </dl>
        {/*
          设置页不显示「管理员」三个字 —— 这个应用没有管理员（见 CLAUDE.md 五）。
          下面这句说的是**日程集里的创建者**，那是另一回事。
        */}
        <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">
          数据在上面的服务器上，本机留一份离线副本，两边自动对齐。
        </div>
      </Card>

    </div>
  );
}
