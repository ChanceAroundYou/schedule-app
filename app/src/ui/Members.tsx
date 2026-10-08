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
import { Btn, Dropdown, Field, Input, MiniIconBtn, Row, toast, useConfirm } from './kit.tsx';

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
      {/* 成员。标题走 kit 的 `Field` —— 原先这里把 Field 的标题样式
          `mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]`
          **逐字抄了两遍**（成员、邀请成员各一份），抄出来的第二套一定会漂。 */}
      <Field label={`成员（${members.length}）`} icon={<Users size={13} />}>
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
                  {/* 行内紧凑图标按钮走 kit 的 MiniIconBtn —— 这里原先手写了一个
                      `rounded-[var(--r-xs)] p-1` 的裸 button，和 Settings.tsx 里
                      那份逐字相同（见文件头）。 */}
                  <MiniIconBtn
                    danger
                    label="移出日程集"
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
                  >
                    <UserMinus size={13} />
                  </MiniIconBtn>
                </>
              ) : (
                <span className="text-[11.5px] text-[var(--text-3)]">{ROLE_LABEL[m.role]}</span>
              )}
            </div>
          ))}
        </div>
      </Field>

      {/* 发邀请。`mb-5` 去掉了 —— 父容器（设置页的展开面板、管理浮层）自己
          有 `gap`，这里再叠一层就是双倍间距，两块之间空 36px 而块内只有 14px。 */}
      {manage && (
        <Field label="邀请成员" icon={<UserPlus size={13} />}>
          <Row>
            <Input
              value={inviteName}
              placeholder="对方的用户名"
              aria-label="对方的用户名"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setInviteName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void invite(); }}
              className="h-[30px] min-w-0 flex-1 px-2.5"
            />
            <Dropdown
              value={inviteRole}
              aria-label="邀请的权限"
              label="邀请的权限"
              size="sm"
              options={ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
              onPick={setInviteRole}
            />
            {/* 「邀请」是**发出**邀请；收件箱那个在日程集卡的卡头，叫「邀请收件箱」。
                原先两个都叫「邀请」，一个发一个收，点错是常事。 */}
            <Btn variant="primary" size="sm" onClick={() => void invite()} disabled={busy}>发出邀请</Btn>
          </Row>
          <div className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
            {ROLE_HINT[inviteRole]}。对方<b>接受之后</b>才生效。
          </div>

          {!!sent.length && (
            <div className="mt-3 flex flex-col gap-1.5">
              {sent.map((i) => (
                <div key={i.id} className="flex items-center gap-2 rounded-[var(--r-md)] border-[length:var(--border-w)] border-dashed
                                           border-[var(--border)] px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-2)]">
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
        </Field>
      )}
    </>
  );
}
