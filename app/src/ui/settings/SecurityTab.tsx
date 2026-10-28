/**
 * SecurityTab.tsx —— 设置页「安全」tab 内容（账号 + 同步与备份）
 *
 * 从 `SettingsView.tsx` 拆出来。这两张卡各自独立，而且共享一个 `wipeLocal`
 * 的确认流程 —— 那个流程的确认弹窗文案说「服务器那份还在」，是用户敢点它的
 * 唯一理由，值得单独一处维护。
 */

import { useRef, useState } from 'react';
import {
  CloudUpload, Database, Download, KeyRound, LogOut, Trash2, Upload,
  UserRound, Wifi, WifiOff,
} from 'lucide-react';
import type { LocalState, PublicUser } from '../../domain/types.ts';
import * as store from '../../data/store.ts';
import * as engine from '../../sync/engine.ts';
import { Btn, Card, Field, InlineRename, Row, useConfirm, toast } from '../kit.tsx';
import { useOnline } from '../hooks.ts';
import { displayName } from '../../domain/people.ts';
import { api, ApiError } from '../../data/api.ts';

export function SecurityTab({ state, user, onExport, onImport, onLogout, onChangePassword }: {
  state: LocalState;
  user: PublicUser | null;
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  /** 改密码 —— 弹层由 SettingsView 持有（它是全局的，跟哪个 tab 无关） */
  onChangePassword: () => void;
}) {
  const confirm = useConfirm();
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

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

  const saveNickname = async (next: string) => {
    const v = next.trim();
    if (busy) return;
    setBusy(true);
    try {
      await api.setNickname(v || null);
      await engine.refreshMeta();
      toast(v ? '昵称已改成「' + v + '」' : '已取消昵称，改用用户名');
    } catch (e) { toast(e instanceof ApiError ? e.message : '改昵称失败，请重试'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Card icon={<UserRound size={14} />} title="账号">
        <Field label="当前账号">
          <Row>
            {/* 优先显示昵称（用户 2026-10-28）；没昵称就是用户名。判据只此一处 */}
            <span className="min-w-0 flex-1 truncate text-[13px]">{user ? displayName(user) : '未登录'}</span>
            <Btn variant="chip" size="sm" onClick={onChangePassword}>
              <KeyRound size={13} /> 修改密码
            </Btn>
            <Btn variant="danger" size="sm" onClick={onLogout}>
              <LogOut size={13} /> 退出登录
            </Btn>
          </Row>
        </Field>

        {/* 昵称：可空。空着 = 用用户名。别人看到的「谁建的这条」用的就是它，
            用户名是登录名、常常是没法公开的那一个。 */}
        <Field label="昵称" hint="留空就用用户名">
          <InlineRename
            value={user?.nickname ?? ''}
            label="昵称"
            /* 没设昵称时显示格是空的 —— 空着会被读成「这一行没内容」。
               填 displayName 的结果（也就是用户名），和 placeholder 说的是
               同一件事：留空就用它。 */
            display={user ? <span className="truncate text-[13px]">{displayName(user)}</span> : undefined}
            placeholder={user ? user.name : ''}
            disabled={!user || busy}
            onSave={(v) => void saveNickname(v)}
          />
        </Field>
      </Card>

      {/* 同步与备份原来挂在「安全」那张卡里当二级小节，和上面的账号行一个
          左右分布、一个标题 + 内容，两块排法不同。现在各占一张卡，
          卡内都是 Field —— 和安全那份读法一致。 */}
      <Card icon={<Database size={14} />} title="同步与备份">
        <Field label="连接状态">
          <Row>
            <span className="flex items-center gap-1.5 text-[12.5px]">
              {online
                ? <Wifi size={13} className="sec-icon-on" />
                : <WifiOff size={13} className="sec-icon-off" />}
              <span className={online ? 'sec-status-on' : 'sec-status-off'}>
                {online ? '在线' : '离线'}
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-[12.5px]">
              <CloudUpload
                size={13}
                className={state.outbox.length ? 'sec-up-warn' : 'sec-up-idle-icon'}
              />
              <span className={state.outbox.length ? 'sec-up-warn' : 'sec-up-idle'}>
                {state.outbox.length ? `${state.outbox.length} 条待上传` : '没有待上传的改动'}
              </span>
            </span>
          </Row>
        </Field>

        <Field label="备份">
          <Row>
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
          </Row>
        </Field>
      </Card>
    </>
  );
}
