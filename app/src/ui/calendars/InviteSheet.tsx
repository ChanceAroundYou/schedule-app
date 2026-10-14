/**
 * InviteSheet.tsx —— 邀请收件箱
 */

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { Invite, LocalState } from '../../domain/types.ts';
import { ROLE_HINT, ROLE_LABEL } from '../../domain/types.ts';
import { api, ApiError } from '../../data/api.ts';
import * as store from '../../data/store.ts';
import * as engine from '../../sync/engine.ts';
import { Btn, Sheet, toast } from '../kit.tsx';

function say(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请重试';
}

export function InviteSheet({ state, open, onClose }: {
  state: LocalState; open: boolean; onClose: () => void;
}) {
  const [busy, setBusy] = useState('');

  /* 处理完最后一条就自己收掉。
     入口有两处（设置页的「邀请收件箱」、窄屏「更多」），所以「开着但没有
     邀请」只可能是「刚把最后一条处理完」—— 原来这里不关，遮罩就一直盖着
     整页，用户以为界面卡死了（真事：触屏拖拽的自动化探针就是被它挡住的）。
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
        <div className="py-6 text-center text-[13px] inv-empty">没有待处理的邀请</div>
      )}
      <div className="flex flex-col gap-2">
        {state.invites.map((i) => (
          <div key={i.id} className="inv-card border-[length:var(--border-w)] p-3">
            <div className="text-[13.5px]">
              <b>{i.fromName || '有人'}</b> 邀请你加入「{i.calName}」
            </div>
            <div className="mt-1 text-[12px] inv-meta">
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
