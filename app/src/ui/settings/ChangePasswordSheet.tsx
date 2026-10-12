/**
 * ChangePasswordSheet.tsx —— 修改密码浮层
 */

import { useId, useState } from 'react';
import { Sheet, Btn, Input, toast } from '../kit.tsx';
import { api } from '../../data/api.ts';

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

export { ChangePasswordSheet };
