/**
 * MembersSection —— 日程集成员与邀请管理。
 *
 * 从 Calendars.tsx 与 Settings.tsx 抽出来：那两份里的成员行、邀请行、
 * 角色下拉、撤回按钮**逐字相同**（只有缩进不同），改一处要同步两处，
 * 漏一处就是「管理日程集」和「设置」页行为不一致。
 *
 * `run` 由调用方传入 —— 两处的 run 略有差异（一个刷 reload+refresh，
 * 一个刷 reload+refreshCals），但签名相同，传进来即可。
 */

import { Crown, Eye, Pencil, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../data/api.ts';
import { ROLE_HINT, ROLE_LABEL, ROLES, type Invite, type Member, type Role } from '../domain/types.ts';
import { Btn, Dropdown, toast, useConfirm } from './kit.tsx';

interface MembersSectionProps {
  calId: string;
  members: Member[];
  sent: Invite[];
  manage: boolean;
  busy: boolean;
  /** 调用方的 run：包了 busy 守卫 + 错误 toast + 刷新 */
  run: (fn: () => Promise<void>) => void;
}

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

  return (
    <>
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
                  <Dropdown
                    value={m.role}
                    disabled={busy}
                    aria-labelledby={`member-role-${m.id}`}
                    label={`「${m.name}」的权限`}
                    size="sm"
                    options={ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
                    onPick={(role) => void run(async () => {
                      await api.setRole(calId, m.id, role);
                      toast('权限已更新');
                    })}
                  />
                  {/* 成员行是**紧凑行**（高度由 13px 的内容撑），IconBtn 的 32px
                      会把整行顶高 11px —— 这种行内小图标按钮保持原样 */}
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
            <Dropdown
              value={inviteRole}
              aria-label="邀请的权限"
              label="邀请的权限"
              size="sm"
              options={ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
              onPick={setInviteRole}
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
    </>
  );
}
