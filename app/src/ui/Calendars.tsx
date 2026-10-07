/**
 * Calendars.tsx —— 日程集的切换、管理、邀请
 *
 * 三个部分：
 *   CalSwitcher  侧栏里那一段（切换 / 新建 / 有邀请时冒出来的一行）
 *   ManageSheet  管理当前日程集：改名、成员与权限、发邀请、退出 / 删除
 *   InviteSheet  待我处理的邀请，接受或谢绝
 *
 * 交互约定：**所有会改变别人能看到什么的操作都走应用内浮层与确认**，
 * 没有原生 confirm / alert（PWA 里会被静默吞掉，见 ui/kit.tsx 的文件头）。
 * 图标一律 lucide，不用 emoji。
 *
 * 权限判断一律用 types.ts 的 canWrite / canManage，别在这里写 role === 'owner'。
 */

import { useCallback, useEffect, useId, useState } from 'react';
import {
  AlertTriangle, Check, Crown, Eye, LogOut, MailPlus, Pencil, Plus, Settings,
  Trash2, UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import type { Cal, Invite, LocalState, Member, Role } from '../domain/types.ts';
import { ROLE_LABEL, canManage } from '../domain/types.ts';
import { api, ApiError } from '../data/api.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import { Btn, Sheet, toast, useConfirm } from './kit.tsx';

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
async function refresh(): Promise<void> {
  await engine.refreshMeta();
}

/* ============================== 侧栏那一段 ============================== */

export function CalSwitcher({ state, onManage, onInvites }: {
  state: LocalState;
  onManage: () => void;
  onInvites: () => void;
}) {
  const active = state.ui.cal;

  /**
   * 建一个新集。
   *
   * 不弹命名框 —— 原生 prompt 在 PWA 里会被静默吞掉（返回 null），
   * 那就等于「点了新建什么也没发生」。改成**先用默认名建出来、切过去、
   * 顺手把管理浮层打开**：改名输入框就在里面，比先问名字少一步。
   */
  const create = useCallback(async () => {
    try {
      const cal = await api.createCal('');
      await refresh();
      store.setActiveCal(cal.id);
      toast('已创建「' + cal.name + '」，可以改个名字');
      onManage();
    } catch (e) { toast(say(e)); }
  }, [onManage]);

  /** 默认日程集（「我的日程」）不进列表 —— 它是注册时自动建的，
   *  用户不需要在列表里看到它，也不能删除或退出。 */
  const visible = state.cals.filter((c) => !(c.name === '我的日程' && c.role === 'owner'));

  return (
    <div className="mb-2 flex flex-col gap-[2px]">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] tracking-wide text-[var(--text-3)]">日程集</span>
        <button
          type="button"
          title="新建日程集"
          data-cal-new="1"
          onClick={create}
          className="rounded-[var(--r-xs)] p-1 text-[var(--text-3)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
        >
          <Plus size={13} />
        </button>
      </div>

      {visible.map((c) => (
        <button
          type="button"
          key={c.id}
          data-cal={c.id}
          onClick={() => store.setActiveCal(c.id)}
          className={
            'flex items-center gap-2 rounded-[var(--r-md)] px-3 py-1.5 text-left text-[13px] transition '
            + (c.id === active
              ? 'bg-[var(--primary-soft)] font-medium text-[var(--primary)]'
              : 'text-[var(--text-2)] hover:bg-[var(--panel-3)]')
          }
        >
          <span className="min-w-0 flex-1 truncate">{c.name}</span>
          {c.role !== 'owner' && (
            <span className="shrink-0 rounded-[var(--r-xs)] bg-[var(--panel-3)] px-1.5 py-px text-[10.5px] text-[var(--text-3)]">
              {ROLE_LABEL[c.role]}
            </span>
          )}
        </button>
      ))}

      {!!state.invites.length && (
        <button
          type="button"
          onClick={onInvites}
          data-cal-invites="1"
          /* 打开的是浮层（Sheet / 管理浮层），先告诉读屏「按下去会弹东西」。
             这里用静态的 haspopup 而不是 aria-expanded：开没开是 App.tsx 的状态，
             两个布尔值要穿过两层 props 才传得到这儿，而浮层自己已经在开的那一瞬间
             念出名字了 —— 多这一层线不值得。 */
          aria-haspopup="dialog"
          className="mx-1 mt-1 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--primary-soft)]
                     px-2.5 py-1.5 text-left text-[12.5px] text-[var(--primary)]"
        >
          <MailPlus size={13} className="shrink-0" />
          <span className="flex-1">{state.invites.length} 个邀请等你处理</span>
        </button>
      )}

      <button
        type="button"
        onClick={onManage}
        disabled={!active}
        data-cal-manage="1"
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-[var(--r-md)] px-3 py-1.5 text-[12.5px] text-[var(--text-3)]
                   hover:bg-[var(--panel-3)] hover:text-[var(--text)] disabled:opacity-40"
      >
        <Settings size={13} /> 管理当前日程集
      </button>
    </div>
  );
}

/* ============================== 管理浮层 ============================== */

export function ManageSheet({ state, open, onClose }: {
  state: LocalState; open: boolean; onClose: () => void;
}) {
  const confirm = useConfirm();
  const calId = state.ui.cal || '';
  const cal: Cal | undefined = state.cals.find((c) => c.id === calId);

  const [members, setMembers] = useState<Member[]>([]);
  const [sent, setSent] = useState<Invite[]>([]);
  const [name, setName] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  /** 同 Drawer.tsx：label 与控件必须靠 id 配上。这里的「名字」原来是个 div，
   *  读屏念不出这个框是干什么的（见 CLAUDE.md 五、无障碍）。 */
  const fid = useId();

  const reload = useCallback(async () => {
    if (!calId) return;
    try {
      const r = await api.members(calId);
      setMembers(r.members);
      setSent(r.invites);
    } catch (e) { toast(say(e)); }
  }, [calId]);

  useEffect(() => { if (open) { setName(cal?.name || ''); void reload(); } }, [open, cal?.name, reload]);

  if (!cal) return null;

  const mine: Role = cal.role;
  const manage = canManage(mine);

  /** 包一层：统一 busy、错误提示、成功后重载 */
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); await refresh(); }
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
      await refresh();
      toast('已退出');
      onClose();
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
      await refresh();
      toast('已删除');
      onClose();
    } catch (e) { toast(say(e)); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="管理日程集">
      {/* 改名 */}
      <div className="mb-5">
        <label htmlFor={fid + '-name'} className="mb-1.5 block text-[12px] text-[var(--text-2)]">名字</label>
        <div className="flex gap-2">
          <input
            id={fid + '-name'}
            value={name}
            disabled={!manage}
            data-cal-name="1"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
            className="min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--input)]
                       bg-transparent px-3 py-1.5 text-sm outline-none
                       focus:border-[var(--primary)] disabled:opacity-60"
          />
          {manage && (
            <Btn variant="chip" size="sm" data-cal-save="1" onClick={saveName} disabled={busy || name.trim() === cal.name}>
              保存
            </Btn>
          )}
        </div>
      </div>

      {/* 成员 */}
      <div className="mb-5">
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
                  <select
                    value={m.role}
                    disabled={busy}
                    aria-label={`「${m.name}」的权限`}
                    onChange={(e) => void run(async () => {
                      await api.setRole(calId, m.id, e.target.value as Role);
                      toast('权限已更新');
                    })}
                    className="rounded-[var(--r-sm)] border border-[var(--input)] bg-transparent
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
        <div className="mb-5">
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
              className="min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--input)]
                         bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--primary)]"
            />
            <select
              value={inviteRole}
              aria-label="邀请的权限"
              onChange={(e) => setInviteRole(e.target.value as Role)}
              className="rounded-[var(--r-sm)] border border-[var(--input)] bg-transparent px-2 text-[13px] outline-none"
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

      {/* 危险区 */}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
        {manage ? (
          <button
            type="button"
            onClick={() => void remove()}
            className="flex items-center gap-1.5 rounded-[var(--r-md)] px-2.5 py-1.5 text-[12.5px]
                       text-[var(--danger)] hover:bg-[var(--danger-soft)]"
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
    </Sheet>
  );
}

/* ============================== 邀请收件箱 ============================== */

export function InviteSheet({ state, open, onClose }: {
  state: LocalState; open: boolean; onClose: () => void;
}) {
  const [busy, setBusy] = useState('');

  /* 处理完最后一条就自己收掉。
     浮层是从「有邀请」那个侧栏入口打开的，所以「开着但没有邀请」只可能是
     「刚把最后一条处理完」—— 原来这里不关，遮罩就一直盖着整页，
     用户以为界面卡死了（真事：触屏拖拽的自动化探针就是被它挡住的）。
     还有两条的时候不关，接着处理下一条。 */
  useEffect(() => {
    if (open && !state.invites.length) onClose();
  }, [open, state.invites.length, onClose]);

  const act = async (inv: Invite, accept: boolean) => {
    if (busy) return;
    setBusy(inv.id);
    try {
      if (!accept) {
        await api.declineInvite(inv.id);
        await engine.refreshMeta();
        toast('已谢绝');
        return;
      }
      await api.acceptInvite(inv.id);
      // 集列表多了一个 → 引擎发现不认识的 calId，会自动要一次全量快照。
      // 所以这里必须 await refreshMeta() 再 syncNow()，顺序反了就拉不到内容。
      await engine.refreshMeta();
      store.setActiveCal(inv.calId);
      await engine.syncNow();
      toast('已加入「' + inv.calName + '」');
    } catch (e) { toast(say(e)); }
    finally { setBusy(''); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="邀请">
      {!state.invites.length && (
        <div className="py-6 text-center text-[13px] text-[var(--text-3)]">没有待处理的邀请</div>
      )}
      <div className="flex flex-col gap-2">
        {state.invites.map((i) => (
          <div key={i.id} className="rounded-[var(--r-lg)] border border-[var(--border)] p-3">
            <div className="text-[13.5px]">
              <b>{i.fromName || '有人'}</b> 邀请你加入「{i.calName}」
            </div>
            <div className="mt-1 text-[12px] text-[var(--text-2)]">
              权限：{ROLE_LABEL[i.role]} —— {ROLE_HINT[i.role]}
            </div>
            <div className="mt-2.5 flex gap-2">
              <Btn variant="primary" size="sm" disabled={!!busy} onClick={() => void act(i, true)}>
                <Check size={14} /> 接受
              </Btn>
              <Btn variant="chip" size="sm" disabled={!!busy} onClick={() => void act(i, false)}>
                谢绝
              </Btn>
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
