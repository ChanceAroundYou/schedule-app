/**
 * MembersSection —— 日程集成员与邀请管理。
 *
 * 从 Calendars.tsx 与 Settings.tsx 抽出来：那两份里的成员行、邀请行、
 * 角色下拉、撤回按钮**逐字相同**（只有缩进不同），改一处要同步两处，
 * 漏一处就是「管理日程集」和「设置」页行为不一致。
 *
 * `run` 由调用方传入 —— 两处的 run 略有差异（一个刷 reload+refresh，
 * 一个刷 reload+refreshCals），但签名相同，传进来即可。
 *
 * **邀请就是「还没进来的最后一名成员」**，所以它不在下面单独一块、也不在
 * 上面再写一个「邀请成员」的小节标题 —— 它就是成员列表的最后一行，和上面
 * 那些行同宽同高，只是名字那一格是个输入框、右边是纸飞机而不是移出。
 * 单独给它一块，反而像「成员已经列完了，下面是另一件事」。
 */

import { Crown, Eye, Pencil, Send, UserMinus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../data/api.ts';
import {
  ASSIGNABLE_ROLES, ROLE_LABEL, type Invite, type Member, type Role,
} from '../domain/types.ts';
import { Dropdown, Field, Input, MiniIconBtn, toast, useConfirm } from './kit.tsx';
import type { DropdownOption } from './kit.tsx';

interface MembersSectionProps {
  calId: string;
  members: Member[];
  sent: Invite[];
  manage: boolean;
  busy: boolean;
  /** 调用方的 run：包了 busy 守卫 + 错误 toast + 刷新 */
  run: (fn: () => Promise<void>) => void;
}

/** 权限下拉的选项：可编辑 / 只读。创建者不是「可以分下去的权限」（见 ASSIGNABLE_ROLES） */
const ROLE_OPTIONS: DropdownOption<Role>[] =
  ASSIGNABLE_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }));

export function MembersSection({ calId, members, sent, manage, busy, run }: MembersSectionProps) {
  const confirm = useConfirm();
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');

  const invite = () => run(async () => {
    const n = inviteName.trim();
    if (!n) return;
    await api.invite(calId, n, inviteRole);
    setInviteName('');
    toast('已发出邀请');
  });

  const kick = (m: Member) => run(async () => {
    const ok = await confirm({
      title: `把「${m.name}」移出？`,
      body: '他马上就会看不到这个日程集，之后可以重新邀请。',
      confirmText: '移出', danger: true,
    });
    if (!ok) return;
    await api.kick(calId, m.id);
    toast('已移出');
  });

  return (
    <>
      {/* 成员。标题走 kit 的 `Field` —— 原先这里把 Field 的标题样式
          `mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]`
          **逐字抄了两遍**（成员、邀请成员各一份），抄出来的第二套一定会漂。 */}
      <Field label={`成员（${members.length}）`} icon={<Users size={13} />}>
        {/* 成员行**不带底色**。原先每行一个 `bg-[var(--panel-3)]` 的小框，
            套在日程集卡这个大框里，再套一层输入框 —— 用户说「一层层大框套
            小框」。一行就是一行，靠行距分开够了。 */}
        <div className="flex flex-col gap-1.5">
          {members.map((m) => (
            <div key={m.id} className="flex h-[30px] items-center gap-2">
              <span className="shrink-0">
                {m.role === 'owner' ? <Crown size={14} className="text-[var(--primary)]" />
                  : m.role === 'viewer' ? <Eye size={14} className="text-[var(--text-3)]" />
                    : <Pencil size={14} className="text-[var(--text-3)]" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{m.name}</span>

              {/* 创建者这一行两个控件都禁用：他的权限改不了（不变量 2 里
                  每个集必须留着 owner），也不能把自己移出。禁用而不是隐藏 ——
                  隐藏会让这一行莫名少两个按钮，看不出「这一格本来是干什么的」。 */}
              {manage ? (
                <>
                  <Dropdown
                    value={m.role}
                    disabled={busy || m.role === 'owner'}
                    label={`「${m.name}」的权限`}
                    size="sm"
                    options={ROLE_OPTIONS}
                    /* 创建者的 role='owner' **不在** ROLE_OPTIONS 里（owner 不是能分下去
                       的权限）。不加这一句，下拉会在选项里找不到当前值、按 placeholder
                       渲染成「选择…」—— 一个只读成员的权限写着「选择…」比没有还费解。 */
                    renderValue={() => ROLE_LABEL[m.role]}
                    onPick={(role) => void run(async () => {
                      await api.setRole(calId, m.id, role);
                      toast('权限已更新');
                    })}
                  />
                  <MiniIconBtn
                    danger
                    label="移出日程集"
                    disabled={busy || m.role === 'owner'}
                    onClick={() => void kick(m)}
                  >
                    <UserMinus size={13} />
                  </MiniIconBtn>
                </>
              ) : (
                <span className="text-[11.5px] text-[var(--text-3)]">{ROLE_LABEL[m.role]}</span>
              )}
            </div>
          ))}

          {/* 邀请 = 还没进来的成员，排最后。三个控件与上面每一行同高 30px，
              所以权限下拉是**竖直对齐**的，不是悬在上面。 */}
          {manage && (
            <div className="flex h-[30px] items-center gap-2">
              <Input
                value={inviteName}
                placeholder="输入邀请的成员的用户名"
                aria-label="输入邀请的成员的用户名"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setInviteName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void invite(); }}
                className="h-[30px] min-w-0 flex-1"
              />
              <Dropdown
                value={inviteRole}
                label="邀请的权限"
                size="sm"
                options={ROLE_OPTIONS}
                onPick={(v) => setInviteRole(v as Role)}
              />
              {/* 右侧一律图标钮，和上面那些行的移出钮同一套 MiniIconBtn ——
                  只有「发出去」用主色，点之前就分得清是「邀请」还是「移出」。 */}
              <MiniIconBtn
                label="发出邀请"
                disabled={busy || !inviteName.trim()}
                className="text-[var(--primary)] hover:bg-[var(--primary-soft)]"
                onClick={() => void invite()}
              >
                <Send size={13} />
              </MiniIconBtn>
            </div>
          )}
        </div>
      </Field>

      {/* 已发出、还在等对方确认的。位置在成员列表**下面**而不是里面 ——
          它不是成员，是一个待办；但它确实是「这个集的邀请」的一部分，
          所以和外层一样不再另起一个 `Field` 标题。 */}
      {!!sent.length && (
        <div className="flex flex-col gap-1.5">
          {sent.map((i) => (
            <div key={i.id} className="flex h-[30px] items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-3)]">
                {i.toName} · 等对方确认（{ROLE_LABEL[i.role]}）
              </span>
              <MiniIconBtn
                danger
                label="撤回邀请"
                disabled={busy}
                onClick={() => void run(async () => {
                  await api.revokeInvite(i.id);
                  toast('已撤回');
                })}
              >
                <X size={13} />
              </MiniIconBtn>
            </div>
          ))}
        </div>
      )}
    </>
  );
}