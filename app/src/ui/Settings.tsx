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
 * 页面结构：**大 header + 小 tab 切换**。四个 tab：
 *   外观 · 安全 · 日程集 · 关于
 *
 * 配色一律走 legacy.css 的 CSS 变量（新表面没有 legacy 规则，Tailwind 生效；
 * 写死颜色会让深色模式在这里失效）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check, Database, GripVertical, Info, KeyRound, Layers, LogOut, MailPlus, Palette, PanelTop,
  Pencil, Upload, Download, Trash2, UserRound, Plus, Settings, Crown, Eye, UserMinus,
  UserPlus, Users, X, AlertTriangle,
} from 'lucide-react';
import type { AccentKey, Invite, LocalState, Member, PublicUser, Role, StyleKey, ThemeMode } from '../domain/types.ts';
import { ROLE_LABEL, canManage } from '../domain/types.ts';
import { TAB_MAX } from '../domain/model.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import * as T from './theme.ts';
import { Btn, Sheet, useConfirm, toast } from './kit.tsx';
import { api, ApiError } from '../data/api.ts';
import { navDef } from './Shell.tsx';
import { useIsNarrow, useOnline } from './hooks.ts';
import { cx } from './cx.ts';

/** 构建期注入，见 vite-env.d.ts。取不到（比如被别的打包器吃掉）时不要显示空白 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * 描边走 **真令牌 `--border`**，不给兜底值。
 *
 * 老 surface（Calendars / Auth / kit）描边写的是一个**不存在的令牌**再配一个兜底值，
 * 而那个令牌在 legacy.css 里根本没定义 —— 有兜底值所以不报错、不白屏，
 * 只是两套主题下都在用写死的浅色。**静默降级比直接坏掉难查得多。**
 * 这个文件是新的，别把这个坏习惯带过来。
 */
const LINE = 'border-[var(--border)]';
const HOVER = 'hover:bg-[var(--panel-3)]';

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
                : 'text-[var(--text-2)] ' + HOVER + ' ' + LINE,
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

/* ============================ 功能区自定义 ============================ */

/**
 * 功能区自定义：底栏挑哪几项 + 侧栏怎么排。
 *
 * **移动端和桌面端都能拖拽**。窄屏（≤900px）显示底栏设置 + 可拖拽列表，
 * 宽屏显示侧栏设置 + 可拖拽列表。两段交叉着显示对谁都没用 —— 手机上永远
 * 看不到侧栏，电脑上永远看不到底栏，摆在一起只是让人多读一段与自己无关的
 * 设置。断点走 `useIsNarrow()`，与 Shell 的侧栏 / 底栏显隐是同一根线
 * （hooks.ts 的 `(max-width: 900px)`）。
 *
 * **不接 `ui/dnd.ts`**，这是有意的。那套是为任务/打卡的时间轴与让位洞设计的
 * （`ROW_SEL`、`data-untimed`、`rawLayout` 量原始布局、`shiftCells` 让位），
 * 套到一个 7 行的静态列表上属于杀鸡用牛刀 —— 而且它那套「按几何推列数」
 * 的假设在这里根本不成立。这里只要「拖到谁就跟谁换」，一个局部 HTML5
 * 拖拽就够。
 *
 * 拖拽期间改的是**本地 rows**，drop 时才写一次 `setUi` —— 每帧写盘的话
 * `persist()` 的防抖会被拖成一条长尾，而且中途松手会留下半个顺序。
 */
function NavCard({ state }: { state: LocalState }) {
  const ui = state.ui;
  const order = ui.navOrder;
  const tabs = new Set(ui.tabs);
  const bottom = new Set(ui.navBottom);
  const narrow = useIsNarrow();

  const [rows, setRows] = useState<string[]>(order);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // 别处改了 navOrder（比如另一台设备同步来一份）就跟着变，别让用户
  // 拖到一半发现列表自己重置了
  useEffect(() => setRows(order), [order]);

  const label = (k: string) => navDef(k).label;

  const toggleTab = (k: string) => {
    if (tabs.has(k)) {
      // 底栏至少留 1 格 —— 空栏等于没有导航，用户会以为应用坏了
      if (tabs.size <= 1) return;
      store.setUi({ tabs: ui.tabs.filter((x) => x !== k) });
    } else {
      if (tabs.size >= TAB_MAX) return;
      // 加进去时按 navOrder 排，不让它永远挂在末尾
      store.setUi({ tabs: order.filter((x) => tabs.has(x) || x === k) });
    }
  };

  const toggleBottom = (k: string) => {
    const next = bottom.has(k)
      ? ui.navBottom.filter((x) => x !== k)
      : [...ui.navBottom, k];
    store.setUi({ navBottom: next });
  };

  /** 拖到 `k` 上：跟它换一格。换完被拖元素就在 k 的位置，继续拖下一个还会再换 */
  const onDragOver = (k: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragKey || dragKey === k) return;
    const next = rows.slice();
    const i = next.indexOf(dragKey);
    const j = next.indexOf(k);
    if (i < 0 || j < 0) return;
    next[i] = k;
    next[j] = dragKey;
    setRows(next);
    setOverKey(k);
  };

  const endDrag = () => {
    if (dragKey && rows.join() !== order.join()) store.setUi({ navOrder: rows });
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <Card icon={<PanelTop size={14} />} title="功能区"
      hint={narrow
        ? '底栏最多 ' + TAB_MAX + ' 项，「更多」恒占最后一格。下面可以拖拽排序。'
        : '侧栏那列可以直接拖，也可以在这儿拖 —— 两边改的是同一份顺序。'}>
      {narrow && (
        /* 手机：显示底栏设置。侧栏在窄屏根本不渲染，摆出来只会让人困惑 */
        <div className="mb-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[11.5px] text-[var(--text-3)]">底栏</span>
            <span className="text-[11.5px] text-[var(--text-3)]">{tabs.size}/{TAB_MAX}</span>
          </div>
          {/*
            按 navOrder 排，与侧栏一致 —— 用户在这儿挑的顺序就是他眼睛里
            侧栏的顺序。用 Chips 那个组件不合适：它是单选（aria-pressed
            恒为 false），这里是多选开关。
          */}
          <div className="flex flex-wrap gap-1.5">
            {order.map((k) => {
              const on = tabs.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  data-tab={k}
                  aria-pressed={on}
                  onClick={() => toggleTab(k)}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition',
                    on
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                      : 'text-[var(--text-2)] ' + HOVER + ' ' + LINE,
                  )}
                >
                  {on && <Check size={12} />}
                  {label(k)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* 拖拽排序列表：移动端和桌面端都显示 */}
      <div>
        <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">
          {narrow ? '顺序 · 拖拽排序' : '侧栏 · 拖拽排序'}
        </div>
        <ul className="flex flex-col gap-1">
          {rows.map((k) => (
            <li
              key={k}
              data-nav-row={k}
              draggable
              onDragStart={(e) => {
                setDragKey(k);
                // Firefox 不给 dataTransfer 就完全不发起拖拽，必须塞点东西
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', k);
              }}
              onDragOver={onDragOver(k)}
              onDrop={(e) => { e.preventDefault(); endDrag(); }}
              onDragEnd={endDrag}
              className={cx(
                'flex cursor-grab items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px] active:cursor-grabbing',
                overKey === k && dragKey !== k
                  ? 'border-[var(--primary)] ' + LINE
                  : 'text-[var(--text-2)] ' + LINE,
              )}
            >
              <GripVertical size={13} />
              <span className="min-w-0 flex-1 truncate">{label(k)}</span>
              {!narrow && (
                <button
                  type="button"
                  data-bottom={k}
                  aria-pressed={bottom.has(k)}
                  onClick={() => toggleBottom(k)}
                  className={cx(
                    'shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition',
                    bottom.has(k)
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                      : 'text-[var(--text-3)] ' + HOVER + ' ' + LINE,
                  )}
                >
                  底部
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/* ============================ 修改密码 ============================ */

/**
 * 改口令的浮层。
 *
 * **「确认」那一栏必须有。** 没有它的话，手一抖把密码改成一个想不起来的，
 * 这个应用**没有找回口令的路子**（没有邮箱、没有手机、没有管理员）——
 * 那一下就是账号彻底没了。宁可多一个框。
 */
function ChangePasswordSheet({ onClose }: { onClose: () => void }) {
  const fid = useId();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (next !== again) { setErr('两次输入的新密码不一样'); return; }
    if (next === cur) { setErr('新密码和当前密码相同'); return; }
    setBusy(true);
    try {
      await api.changePassword(cur, next);
      toast('密码已修改，其他设备已经退出登录');
      onClose();
    } catch (e) {
      // 后端会说人话（「密码至少 6 位」「当前密码不对」），原样转述，
      // 不要在这里另写一套规则 —— 两套规则一定会漂，漂了以后用户看到的
      // 提示和实际挡下的理由对不上
      setErr(e instanceof Error ? e.message : '修改失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="修改密码">
      <div className="flex flex-col gap-3">
        <div className="field">
          <label htmlFor={fid + '-c'}>当前密码</label>
          <input id={fid + '-c'} type="password" autoComplete="current-password" value={cur}
            onChange={(e) => setCur(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-n'}>新密码</label>
          <input id={fid + '-n'} type="password" autoComplete="new-password" value={next}
            onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-a'}>再输一遍</label>
          <input id={fid + '-a'} type="password" autoComplete="new-password" value={again}
            onChange={(e) => setAgain(e.target.value)} />
        </div>

        {err && (
          <div role="alert" className="text-[12px] text-[var(--danger)]">{err}</div>
        )}

        <div className="drawer-foot">
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <Btn
            variant="primary"
            disabled={busy || !cur || !next || !again}
            onClick={() => void submit()}
          >
            修改
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

/* ============================ 日程集管理 ============================ */

const ROLES: Role[] = ['owner', 'editor', 'viewer'];

/** 角色一句话解释，选权限时直接写清楚会怎样 */
const ROLE_HINT: Record<Role, string> = {
  owner: '能改内容，也能改名、加人、删日程集',
  editor: '能增删改任务和打卡，管不了成员',
  viewer: '只能看',
};

function say(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请重试';
}

/** 权限变了 / 成员变了之后，把集列表和邀请刷新一遍 */
async function refreshCals(): Promise<void> {
  await engine.refreshMeta();
}

/**
 * 日程集管理 tab —— 完整的增删改查。
 *
 * 列表 + 切换 + 新建 + 改名 + 成员管理 + 邀请 + 删除/退出。
 * 默认日程集（「我的日程」）不能删除、不能退出、不能改名成空。
 */
function CalsTab({ state, onInvites }: { state: LocalState; onInvites: () => void }) {
  const confirm = useConfirm();
  const active = state.ui.cal;
  const cal = state.cals.find((c) => c.id === active) || null;

  const [members, setMembers] = useState<Member[]>([]);
  const [sent, setSent] = useState<Invite[]>([]);
  const [name, setName] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const fid = useId();

  const reload = async () => {
    if (!active) return;
    try {
      const r = await api.members(active);
      setMembers(r.members);
      setSent(r.invites);
    } catch (e) { toast(say(e)); }
  };

  useEffect(() => {
    setName(cal?.name || '');
    if (active) void reload();
  }, [active, cal?.name]);

  if (!cal || !active) return null;
  const calId: string = active;

  const mine = cal.role;
  const manage = canManage(mine);
  /** 默认日程集 = 用户注册时自动建的那个，名字固定叫「我的日程」 */
  const isDefault = cal.name === '我的日程' && mine === 'owner';

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); await refreshCals(); }
    catch (e) { toast(say(e)); }
    finally { setBusy(false); }
  };

  const saveName = () => run(async () => {
    const n = name.trim();
    if (!n || n === cal.name) return;
    await api.renameCal(calId, n);
    toast('已改名');
  });

  const invite = () => run(async () => {
    const who = inviteName.trim();
    if (!who) { toast('填一下对方的用户名'); return; }
    await api.invite(calId, who, inviteRole);
    setInviteName('');
    toast('邀请已发出，等对方确认');
  });

  const leave = async () => {
    const ok = await confirm({
      title: `退出「${cal.name}」？`,
      body: '退出后就看不到这个日程集里的内容了。你自己那份「我的日程」不受影响。',
      confirmText: '退出', danger: true,
    });
    if (!ok) return;
    try {
      await api.leaveCal(calId);
      await refreshCals();
      toast('已退出');
    } catch (e) { toast(say(e)); }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `删除「${cal.name}」？`,
      body: '所有成员都会看不到它，里面的任务和打卡记录一并消失。这一步不可撤销。',
      confirmText: '删除日程集', danger: true,
    });
    if (!ok) return;
    try {
      await api.removeCal(calId);
      await refreshCals();
      toast('已删除');
    } catch (e) { toast(say(e)); }
  };

  const create = async () => {
    try {
      const c = await api.createCal('');
      await refreshCals();
      store.setActiveCal(c.id);
      toast('已创建「' + c.name + '」，可以改个名字');
    } catch (e) { toast(say(e)); }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 日程集列表 */}
      <Card icon={<Layers size={14} />} title="我的日程集">
        <div className="flex flex-col gap-1">
          {state.cals.map((c) => (
            <button
              key={c.id}
              type="button"
              data-cal={c.id}
              onClick={() => store.setActiveCal(c.id)}
              className={cx(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition',
                c.id === active
                  ? 'bg-[var(--primary-soft)] font-medium text-[var(--primary)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--panel-3)]',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.role !== 'owner' && (
                <span className="shrink-0 rounded bg-[var(--panel-3)] px-1.5 py-px text-[10.5px] text-[var(--text-3)]">
                  {ROLE_LABEL[c.role]}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={create}
          className="mt-2 flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)]
                     px-3 py-2 text-[12.5px] text-[var(--text-3)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
        >
          <Plus size={13} /> 新建日程集
        </button>
      </Card>

      {/* 当前日程集详情 */}
      <Card icon={<Settings size={14} />} title={cal.name}>
        {/* 改名 */}
        <div className="mb-4">
          <label htmlFor={fid + '-name'} className="mb-1.5 block text-[12px] text-[var(--text-2)]">名字</label>
          <div className="flex gap-2">
            <input
              id={fid + '-name'}
              value={name}
              disabled={!manage}
              data-cal-name="1"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
              className="min-w-0 flex-1 rounded-lg border border-[var(--input)]
                         bg-transparent px-3 py-1.5 text-sm outline-none
                         focus:border-[var(--primary)] disabled:opacity-60"
            />
            {manage && (
              <Btn variant="chip" size="sm" data-cal-save="1" onClick={saveName} disabled={busy || name.trim() === cal.name}>
                保存
              </Btn>
            )}
          </div>
          {isDefault && (
            <div className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
              这是你的默认日程集，不能删除或退出。
            </div>
          )}
        </div>

        {/* 成员 */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
            <Users size={13} /> 成员（{members.length}）
          </div>
          <div className="flex flex-col gap-1.5">
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded-lg bg-[var(--panel-3)] px-2.5 py-1.5">
                <span className="shrink-0">
                  {m.role === 'owner' ? <Crown size={14} className="text-[var(--primary)]" />
                    : m.role === 'viewer' ? <Eye size={14} className="text-[var(--text-3)]" />
                      : <Pencil size={14} className="text-[var(--text-3)]" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{m.name}</span>
                {manage ? (
                  <>
                    <select
                      value={m.role}
                      disabled={busy}
                      aria-label={`「${m.name}」的权限`}
                      onChange={(e) => void run(async () => {
                        await api.setRole(calId, m.id, e.target.value as Role);
                        toast('权限已更新');
                      })}
                      className="rounded-md border border-[var(--input)] bg-transparent
                                 px-1.5 py-1 text-[12px] outline-none"
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                    <button
                      type="button"
                      title="移出日程集"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        const ok = await confirm({
                          title: `把「${m.name}」移出？`,
                          body: '他马上就会看不到这个日程集，之后可以重新邀请。',
                          confirmText: '移出', danger: true,
                        });
                        if (!ok) return;
                        await api.kick(calId, m.id);
                        toast('已移出');
                      })}
                      className="rounded p-1 text-[var(--text-3)] hover:text-[var(--danger)]"
                    >
                      <UserMinus size={13} />
                    </button>
                  </>
                ) : (
                  <span className="text-[11.5px] text-[var(--text-3)]">{ROLE_LABEL[m.role]}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 发邀请 */}
        {manage && (
          <div className="mb-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
              <UserPlus size={13} /> 邀请成员
            </div>
            <div className="flex gap-2">
              <input
                value={inviteName}
                placeholder="对方的用户名"
                aria-label="对方的用户名"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setInviteName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void invite(); }}
                className="min-w-0 flex-1 rounded-lg border border-[var(--input)]
                           bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--primary)]"
              />
              <select
                value={inviteRole}
                aria-label="邀请的权限"
                onChange={(e) => setInviteRole(e.target.value as Role)}
                className="rounded-lg border border-[var(--input)] bg-transparent px-2 text-[13px] outline-none"
              >
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <Btn variant="primary" size="sm" onClick={() => void invite()} disabled={busy}>邀请</Btn>
            </div>
            <div className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
              {ROLE_HINT[inviteRole]}。对方<b>接受之后</b>才生效。
            </div>

            {!!sent.length && (
              <div className="mt-3 flex flex-col gap-1.5">
                {sent.map((i) => (
                  <div key={i.id} className="flex items-center gap-2 rounded-lg border border-dashed
                                       border-[var(--border)] px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-2)]">
                      {i.toName} · 等对方确认（{ROLE_LABEL[i.role]}）
                    </span>
                    <button
                      type="button"
                      title="撤回邀请"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await api.revokeInvite(i.id);
                        toast('已撤回');
                      })}
                      className="rounded p-1 text-[var(--text-3)] hover:text-[var(--danger)]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 邀请入口 */}
        <div className="mb-2">
          <Btn variant="chip" size="sm" onClick={onInvites}>
            <MailPlus size={13} /> 邀请{state.invites.length ? `（${state.invites.length}）` : ''}
          </Btn>
        </div>

        {/* 危险区 */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
          {manage ? (
            <button
              type="button"
              disabled={isDefault}
              onClick={() => void remove()}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]
                         text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-40"
            >
              <Trash2 size={13} /> 删除日程集
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void leave()}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]
                         text-[var(--danger)] hover:bg-[var(--danger-soft)]"
            >
              <LogOut size={13} /> 退出日程集
            </button>
          )}
        </div>

        {mine === 'viewer' && (
          <div className="mt-2 flex items-start gap-1.5 text-[11.5px] text-[var(--text-3)]">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>你是只读成员，改不了里面的内容。</span>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ================================ 页面 ================================ */

type SettingsTab = 'appearance' | 'account' | 'sync' | 'cals' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'account', label: '账户安全' },
  { key: 'sync', label: '同步备份' },
  { key: 'cals', label: '日程集' },
  { key: 'about', label: '关于' },
];

export function SettingsView({ state, user, theme, onExport, onImport, onLogout, onInvites }: {
  state: LocalState;
  user: PublicUser | null;
  /** **实际生效**的那一档（auto 已解析）。色点要靠它才画得出暗色档的颜色 */
  theme: 'light' | 'dark';
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onInvites: () => void;
}) {
  const ui = state.ui;
  const confirm = useConfirm();
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');

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
      {/* 大 header + 小 tab */}
      <header className="mb-4">
        <h1 className="mb-3 text-[18px] font-semibold">设置</h1>
        <div className="flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--panel-3)] p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-settings-tab={t.key}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
              className={cx(
                'flex-1 rounded-lg px-3 py-1.5 text-[13px] transition',
                tab === t.key
                  ? 'bg-[var(--primary)] text-[var(--on-primary)] font-medium'
                  : 'text-[var(--text-2)] hover:bg-[var(--panel)]',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'appearance' && (
        <>
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

          {/* 功能区：底栏挑哪几项 + 侧栏怎么排。放在外观之后 —— 它改的是
              导航本身，比配色更「结构性」，试完配色接着试它最自然 */}
          <NavCard state={state} />
        </>
      )}

      {tab === 'account' && (
        <Card icon={<UserRound size={14} />} title="账户安全">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px]">{user ? user.name : '未登录'}</span>
            <Btn variant="chip" size="sm" onClick={() => setPwOpen(true)}>
              <KeyRound size={13} /> 修改密码
            </Btn>
            <Btn variant="ghost" size="sm" onClick={onLogout}>
              <LogOut size={13} /> 退出登录
            </Btn>
          </div>
          <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">
            这个应用没有找回口令的路子（没有邮箱、没有手机、没有管理员），
            改密码前请记得当前密码。退出登录后其他设备也需要重新登录。
          </div>
        </Card>
      )}

      {tab === 'sync' && (
        <Card icon={<Database size={14} />} title="同步与备份"
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
          <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
            <dt className="text-[var(--text-3)]">网络</dt>
            <dd>{online ? '在线' : '离线，改动先存在本机'}</dd>
            <dt className="text-[var(--text-3)]">待上传</dt>
            <dd>{state.outbox.length ? `${state.outbox.length} 条` : '没有待上传的改动'}</dd>
            <dt className="text-[var(--text-3)]">已拉到</dt>
            <dd>#{state.cursor}</dd>
          </div>
        </Card>
      )}

      {tab === 'cals' && <CalsTab state={state} onInvites={onInvites} />}

      {tab === 'about' && (
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
      )}

      {pwOpen && <ChangePasswordSheet onClose={() => setPwOpen(false)} />}
    </div>
  );
}
