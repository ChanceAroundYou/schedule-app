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
 * 配色一律走 styles/tokens.css 的 CSS 变量（语义样式模块不覆盖这些新表面，Tailwind 生效；
 * 写死颜色会让深色模式在这里失效）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check, Database, GripVertical, Info, KeyRound, Layers, LogOut, MailPlus, Palette, PanelTop,
  Pencil, Upload, Download, Trash2, UserRound, Plus, Crown, Eye, UserMinus,
  UserPlus, Users, X, AlertTriangle, ChevronDown, Wifi, WifiOff, CloudUpload,
} from 'lucide-react';
import { type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AccentKey, Cal, Invite, LocalState, Member, PublicUser, Role, StyleKey, ThemeMode } from '../domain/types.ts';
import { ROLE_LABEL, canManage } from '../domain/types.ts';
import { TAB_MAX } from '../domain/model.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import * as T from './theme.ts';
import { Btn, Chips, Input, Sheet, useConfirm, toast } from './kit.tsx';
import { api, ApiError } from '../data/api.ts';
import { navDef } from './Shell.tsx';
import { useIsNarrow, useOnline } from './hooks.ts';
import { DndScope } from './dndkit.tsx';
import { cx } from './cx.ts';

/** 构建期注入，见 vite-env.d.ts。取不到（比如被别的打包器吃掉）时不要显示空白 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * 描边走 **真令牌 `--border`**，不给兜底值。
 *
 * 老 surface（Calendars / Auth / kit）描边写的是一个**不存在的令牌**再配一个兜底值，
 * 而那个令牌在 styles/tokens.css 里根本没定义 —— 有兜底值所以不报错、不白屏，
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
    <section className={'mb-4 rounded-[var(--r-lg)] border p-4 ' + LINE}>
      <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
        <span className="text-[var(--text-3)]">{icon}</span> {title}
      </h2>
      {children}
      {hint && <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </section>
  );
}

/* ============================ 功能区自定义 ============================ */

/**
 * 功能区自定义：一个可拖拽 + 可打勾的胶囊列表。
 *
 * 每个胶囊一行：左边抓手、中间名字、右边打勾。**点一下打勾**（选中/取消），
 * **拖一下排序**。选择和排序是同一件事的两面 —— 用户要的就是「这几项按这个
 * 顺序排」，拆成两段反而要来回切。
 *
 * 拖拽走 @dnd-kit：MouseSensor 处理鼠标输入（mousedown/mousemove/mouseup）。
 * 移动 8px 才开始拖 —— 轻点（不移动）不会触发拖，所以「点一下打勾」不受影响。
 */
function NavCard({ state }: { state: LocalState }) {
  const ui = state.ui;
  const order = ui.navOrder;
  const tabs = new Set(ui.tabs);
  const bottom = new Set(ui.navBottom);
  const narrow = useIsNarrow();

  const [rows, setRows] = useState<string[]>(order);
  useEffect(() => setRows(order), [order]);

  /** 选中口径跟着设备走：窄屏是底栏那几项，宽屏是侧栏下半区那几项 */
  const isOn = (k: string) => (narrow ? tabs.has(k) : bottom.has(k));

  const toggle = (k: string) => {
    if (narrow) {
      if (tabs.has(k)) {
        if (tabs.size <= 1) return;
        store.setUi({ tabs: ui.tabs.filter((x) => x !== k) });
      } else {
        if (tabs.size >= TAB_MAX) return;
        store.setUi({ tabs: order.filter((x) => tabs.has(x) || x === k) });
      }
    } else {
      const next = bottom.has(k)
        ? ui.navBottom.filter((x) => x !== k)
        : [...ui.navBottom, k];
      store.setUi({ navBottom: next });
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setRows((prev) => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) return prev;
        const next = arrayMove(prev, oldIndex, newIndex);
        store.setUi({ navOrder: next });
        return next;
      });
    }
  };

  return (
    <Card icon={<PanelTop size={14} />} title="功能区"
      hint={narrow
        ? '底栏最多 ' + TAB_MAX + ' 项，「更多」恒占最后一格。点一下打勾，拖抓手排序。'
        : '侧栏那列可以直接拖，也可以在这儿拖 —— 两边改的是同一份顺序。'}>
      <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">
        {narrow ? '底栏 · 点选 + 拖拽' : '侧栏 · 拖拽排序'}
      </div>
      <DndScope onDragEnd={onDragEnd}>
        <SortableContext items={rows} strategy={rectSortingStrategy}>
          <ul className="flex flex-col gap-1">
            {rows.map((k) => (
              <SortableNavRow key={k} id={k} on={isOn(k)} narrow={narrow} onToggle={toggle} />
            ))}
          </ul>
        </SortableContext>
      </DndScope>
    </Card>
  );
}

/** 功能区里一行可排序的导航项 */
function SortableNavRow({ id, on, narrow, onToggle }: {
  id: string;
  on: boolean;
  narrow: boolean;
  onToggle: (k: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      data-nav-row={id}
      data-tab={narrow ? id : undefined}
      onClick={() => onToggle(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id); } }}
      className={cx(
        'flex cursor-pointer items-center gap-2 rounded-[var(--r-md)] border px-2.5 py-1.5 text-[12.5px] transition',
        isDragging && 'opacity-40',
        on
          ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
          : 'text-[var(--text-2)] ' + LINE + ' ' + HOVER,
      )}
    >
      <span {...listeners} className="shrink-0 cursor-grab text-[var(--text-3)]">
        <GripVertical size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate">{navDef(id).label}</span>
      {on && <Check size={13} className="shrink-0 text-[var(--primary)]" />}
    </li>
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
          <Input id={fid + '-c'} type="password" autoComplete="current-password" value={cur}
            onChange={(e) => setCur(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-n'}>新密码</label>
          <Input id={fid + '-n'} type="password" autoComplete="new-password" value={next}
            onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-a'}>再输一遍</label>
          <Input id={fid + '-a'} type="password" autoComplete="new-password" value={again}
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
 * 日程集管理 tab —— 一个可展开的列表。
 *
 * 每个日程集一行：点一下展开/收起（同时切到它），展开后是改名、成员、
 * 邀请、危险区。**不再有「列表」+「当前集详情」两张卡** —— 那两段在
 * 讲同一件事，分开反而要来回切。
 *
 * 默认日程集（「我的日程」）不能删除、不能退出、不能改名成空。
 */
function CalsTab({ state, onInvites }: { state: LocalState; onInvites: () => void }) {
  const active = state.ui.cal;
  const [openId, setOpenId] = useState<string | null>(active);

  const create = async () => {
    try {
      const c = await api.createCal('');
      await refreshCals();
      store.setActiveCal(c.id);
      setOpenId(c.id);
      toast('已创建「' + c.name + '」，可以改个名字');
    } catch (e) { toast(say(e)); }
  };

  return (
    <Card icon={<Layers size={14} />} title="我的日程集">
      <div className="flex flex-col gap-1.5">
        {state.cals.map((c) => (
          <CalItem
            key={c.id}
            cal={c}
            active={c.id === active}
            open={openId === c.id}
            invites={state.invites}
            onToggle={() => {
              store.setActiveCal(c.id);
              setOpenId((v) => (v === c.id ? null : c.id));
            }}
            onInvites={onInvites}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => void create()}
        className="mt-2 flex items-center gap-1.5 rounded-[var(--r-md)] border border-dashed border-[var(--border)]
                   px-3 py-2 text-[12.5px] text-[var(--text-3)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
      >
        <Plus size={13} /> 新建日程集
      </button>
    </Card>
  );
}

/** 一个日程集：收起是一行，展开是它的全部设置 */
function CalItem({ cal, active, open, invites, onToggle, onInvites }: {
  cal: Cal;
  active: boolean;
  open: boolean;
  invites: Invite[];
  onToggle: () => void;
  onInvites: () => void;
}) {
  const confirm = useConfirm();
  const [members, setMembers] = useState<Member[]>([]);
  const [sent, setSent] = useState<Invite[]>([]);
  const [name, setName] = useState(cal.name);
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const fid = useId();

  const calId = cal.id;
  const mine = cal.role;
  const manage = canManage(mine);
  /** 默认日程集 = 用户注册时自动建的那个，名字固定叫「我的日程」 */
  const isDefault = cal.name === '我的日程' && mine === 'owner';

  const reload = async () => {
    try {
      const r = await api.members(calId);
      setMembers(r.members);
      setSent(r.invites);
    } catch (e) { toast(say(e)); }
  };

  useEffect(() => {
    setName(cal.name);
    if (open) void reload();
  }, [open, cal.name]);

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

  return (
    <div className={cx(
      'rounded-[var(--r-md)] border transition',
      open ? 'border-[var(--border)] bg-[var(--panel-3)]' : 'border-transparent',
    )}>
      <button
        type="button"
        data-cal={cal.id}
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-3 py-2 text-left text-[13px] transition"
      >
        <span className={cx('min-w-0 flex-1 truncate', active ? 'font-medium text-[var(--primary)]' : 'text-[var(--text-2)]')}>
          {cal.name}
        </span>
        {cal.role !== 'owner' && (
          <span className="shrink-0 rounded-[var(--r-xs)] bg-[var(--panel-3)] px-1.5 py-px text-[10.5px] text-[var(--text-3)]">
            {ROLE_LABEL[cal.role]}
          </span>
        )}
        <ChevronDown size={13} className={cx('shrink-0 text-[var(--text-3)] transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="flex flex-col gap-4 px-3 pb-3">
          {/* 改名 */}
          <div>
            <label htmlFor={fid + '-name'} className="mb-1.5 block text-[12px] text-[var(--text-2)]">名字</label>
            <div className="flex gap-2">
              <Input
                id={fid + '-name'}
                value={name}
                disabled={!manage}
                data-cal-name="1"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
                className="min-w-0 h-[30px] flex-1 bg-transparent disabled:opacity-60"
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
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
              <Users size={13} /> 成员（{members.length}）
            </div>
            <div className="flex flex-col gap-1.5">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--panel-3)] px-2.5 py-1.5">
                  <span className="shrink-0">
                    {m.role === 'owner' ? <Crown size={14} className="text-[var(--primary)]" />
                      : m.role === 'viewer' ? <Eye size={14} className="text-[var(--text-3)]" />
                        : <Pencil size={14} className="text-[var(--text-3)]" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{m.name}</span>
                  {manage ? (
                    <>
                      <Chips<Role>
                        value={m.role}
                        options={ROLES}
                        onPick={(r) => void run(async () => {
                          await api.setRole(calId, m.id, r);
                          toast('权限已更新');
                        })}
                        labelOf={(r) => ROLE_LABEL[r]}
                        label={`「${m.name}」的权限`}
                      />
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
                        className="rounded-[var(--r-xs)] p-1 text-[var(--text-3)] hover:text-[var(--danger)]"
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
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
                <UserPlus size={13} /> 邀请成员
              </div>
              <div className="flex gap-2">
                <Input
                  value={inviteName}
                  placeholder="对方的用户名"
                  aria-label="对方的用户名"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setInviteName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void invite(); }}
                  className="min-w-0 h-[30px] flex-1 bg-transparent"
                />
                <Chips<Role>
                  value={inviteRole}
                  options={ROLES}
                  onPick={(r) => setInviteRole(r)}
                  labelOf={(r) => ROLE_LABEL[r]}
                  label="邀请的权限"
                />
                <Btn variant="primary" size="sm" onClick={() => void invite()} disabled={busy}>邀请</Btn>
              </div>
              <div className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
                {ROLE_HINT[inviteRole]}。对方<b>接受之后</b>才生效。
              </div>

              {!!sent.length && (
                <div className="mt-3 flex flex-col gap-1.5">
                  {sent.map((i) => (
                    <div key={i.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-dashed
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
                        className="rounded-[var(--r-xs)] p-1 text-[var(--text-3)] hover:text-[var(--danger)]"
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
          <div>
            <Btn variant="chip" size="sm" onClick={onInvites}>
              <MailPlus size={13} /> 邀请{invites.length ? `（${invites.length}）` : ''}
            </Btn>
          </div>

          {/* 危险区 */}
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
            {manage ? (
              <button
                type="button"
                disabled={isDefault}
                onClick={() => void remove()}
                className="flex items-center gap-1.5 rounded-[var(--r-md)] px-2.5 py-1.5 text-[12.5px]
                           text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-40"
              >
                <Trash2 size={13} /> 删除日程集
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void leave()}
                className="flex items-center gap-1.5 rounded-[var(--r-md)] px-2.5 py-1.5 text-[12.5px]
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
        </div>
      )}
    </div>
  );
}


/* ================================ 页面 ================================ */

type SettingsTab = 'appearance' | 'security' | 'cals' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'security', label: '安全' },
  { key: 'cals', label: '日程' },
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
      {/* tab 栏作为唯一 header */}
      <header className="mb-4">
        <div className="flex gap-1 rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--panel-3)] p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-settings-tab={t.key}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
              className={cx(
                'flex-1 rounded-[var(--r-sm)] px-3 py-1.5 text-[13px] transition',
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
          {/* 功能区放在最前面 —— 它改的是导航本身，比配色更「结构性」 */}
          <NavCard state={state} />

          <Card icon={<Palette size={14} />} title="外观">
            <div className="flex flex-col gap-3">
              <div>
                <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">色板</div>
                <Chips<AccentKey>
                  value={ui.accent}
                  options={['jade', 'azure', 'clay', 'plum', 'gold', 'slate']}
                  onPick={(k) => store.setUi({ accent: k })}
                  labelOf={(k) => T.ACCENTS[k].label}
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
                    labelOf={(k) => T.STYLES[k].label}
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
                  labelOf={(k) => T.THEMES[k].label}
                />
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === 'security' && (
        <Card icon={<UserRound size={14} />} title="安全">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px]">{user ? user.name : '未登录'}</span>
            <Btn variant="chip" size="sm" onClick={() => setPwOpen(true)}>
              <KeyRound size={13} /> 修改密码
            </Btn>
                <Btn variant="danger" size="sm" onClick={onLogout}>
                  <LogOut size={13} /> 退出登录
                </Btn>
          </div>

          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
              <Database size={13} /> 同步与备份
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant="chip" size="sm" onClick={onExport}>
                <Upload size={13} /> 导出备份
              </Btn>
              <Btn variant="chip" size="sm" onClick={() => fileRef.current?.click()}>
                <Download size={13} /> 导入备份
              </Btn>
              <Btn variant="danger" size="sm" disabled={busy} onClick={() => { setBusy(true); void wipeLocal().then(() => setBusy(false)); }}>
                <Trash2 size={13} /> 清空本机副本
              </Btn>
              <input
                ref={fileRef} type="file" accept="application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
              />
            </div>
            <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
              <dt className="flex items-center gap-1.5 text-[var(--text-3)]">
                {online ? <Wifi size={13} className="text-[var(--ok)]" /> : <WifiOff size={13} className="text-[var(--danger)]" />}
                网络
              </dt>
              <dd className={online ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}>{online ? '在线' : '离线'}</dd>
              <dt className="flex items-center gap-1.5 text-[var(--text-3)]">
                <CloudUpload size={13} className={state.outbox.length ? 'text-[var(--warn)]' : 'text-[var(--text-3)]'} />
                待上传
              </dt>
              <dd className={state.outbox.length ? 'text-[var(--warn)]' : 'text-[var(--text-2)]'}>
                {state.outbox.length ? `${state.outbox.length} 条` : '没有待上传的改动'}
              </dd>
            </div>
          </div>
        </Card>
      )}

      {tab === 'cals' && <CalsTab state={state} onInvites={onInvites} />}

      {tab === 'about' && (
        <Card icon={<Info size={14} />} title="关于">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
            <dt className="text-[var(--text-3)]">版本</dt>
            <dd data-about="version">{VERSION}</dd>
            <dt className="text-[var(--text-3)]">技术栈</dt>
            <dd>React + Node + SQLite</dd>
          </dl>
          <div className="mt-3 border-t border-[var(--border)] pt-3 text-[11.5px] leading-relaxed text-[var(--text-3)]">
            个人任务与打卡管理。数据在服务器上，多设备通过日程集共享。
          </div>
        </Card>
      )}

      {pwOpen && <ChangePasswordSheet onClose={() => setPwOpen(false)} />}
    </div>
  );
}
