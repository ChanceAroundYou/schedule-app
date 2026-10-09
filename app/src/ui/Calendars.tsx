/**
 * Calendars.tsx —— 日程集多选（桌面下拉 / 移动弹窗）+ 邀请收件箱
 *
 * 三部分：
 *   CalRow   一行一个集，两种容器**共用**（各画一遍的下场是改了这边忘那边）
 *   CalMenu  桌面端：顶栏里的下拉多选框
 *   CalSheet 移动端：「更多」里那个按钮点出来的多选弹窗面板
 *   InviteSheet  待我处理的邀请，接受或谢绝
 *
 * 「改名 / 成员 / 权限 / 退出 / 删除」**不在这里** —— 设置页的「日程集管理」
 * （Settings.tsx 的 CalsTab）本来就是同一套，连 MembersSection 都是抽出来
 * 共用的一份。原先侧栏那个「管理当前日程集」浮层是纯重复入口，已删。
 *
 * 交互约定：**所有会改变别人能看到什么的操作都走应用内浮层与确认**，
 * 没有原生 confirm / alert（PWA 里会被静默吞掉，见 ui/kit.tsx 的文件头）。
 * 图标一律 lucide，不用 emoji。
 *
 * 权限判断一律用 types.ts 的 canWrite / canManage，别在这里写 role === 'owner'。
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { Cal, Invite, LocalState } from '../domain/types.ts';
import { ROLE_HINT, ROLE_LABEL } from '../domain/types.ts';
import { api, ApiError } from '../data/api.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import { Btn, Sheet, toast } from './kit.tsx';
import { useOutsideClose } from './hooks.ts';

/* 角色选项与角色说明在 Members.tsx —— 成员 / 邀请那两块整体走 MembersSection，
   这里不再各留一份 ROLES / ROLE_HINT。 */

function say(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请重试';
}

/* ============================== 日程集多选 ============================== */

/**
 * 一行一个集。桌面下拉多选与移动端弹窗面板**共用这一份** —— 两处各画一遍的
 * 下场是改了选中态忘了改另一边。
 *
 * 勾选只影响**显示**（见 ui/hooks.ts 的 useScopedState）；新东西落在 `ui.cal`，
 * 也就是最后一次点开的那个集 —— toggleCal 里顺手设好。
 *
 * 默认日程集（「我的日程」）也列出来 —— 它是真实存在的集，勾不勾是用户的
 * 自由。原先按「注册时自动建的」把它藏掉，那是在单选模型下的判断（它是
 * 兜底的那个，不用切过去）；多选之后这条理由不成立了。
 */
function CalRow({ c, on }: { c: Cal; on: boolean }) {
  return (
    <button
      type="button"
      data-cal-row={c.id}
      onClick={() => store.toggleCal(c.id)}
      aria-pressed={on}
      className={
        'flex items-center gap-2 rounded-[var(--r-md)] px-3 py-1.5 text-left text-[13px] transition '
        + (on
          ? 'bg-[var(--primary-soft)] font-medium text-[var(--primary)]'
          : 'text-[var(--text-3)] hover:bg-[var(--panel-3)] hover:text-[var(--text-2)]')
      }
    >
      {/* 勾选圈走 CheckBtn 那套（命中区 ≥24，视觉不变），见 views/parts.tsx。
          这里用 span 而不是 input[type=checkbox]：整个按钮就是控件，
          再塞一个真 checkbox 会让 Tab 多停一格、读屏念两遍。 */}
      <span className={'check-btn' + (on ? ' on' : '')} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      {c.role !== 'owner' && (
        <span className="shrink-0 rounded-[var(--r-xs)] bg-[var(--panel-3)] px-1.5 py-px text-[10.5px] text-[var(--text-3)]">
          {ROLE_LABEL[c.role]}
        </span>
      )}
    </button>
  );
}

/** 触发按钮上那行字。只写「全家」看不出还有别的集也勾着 —— 「勾了哪几个」
 *  就是这个按钮唯一要传达的事，所以全勾时报总数、部分勾时报头一个加「等 N 个」。 */
function calSummary(visible: Cal[], shown: string[]): string {
  const on = visible.filter((c) => shown.includes(c.id));
  if (on.length === visible.length) return `全部 ${visible.length} 个`;
  if (on.length === 1) return on[0].name;
  return `${on[0].name} 等 ${on.length} 个`;
}

/**
 * 桌面端：顶栏里的**下拉多选框**。
 *
 * 为什么不在侧栏：侧栏顺序是用户自己排的（`ui.navOrder`），塞个常驻控件进去
 * 会跟「底栏挑哪几项」抢位置；而「我在看哪几个集」是**全局**状态 —— 今天 /
 * 逾期 / 待办箱本来就跨集，放在顶栏哪儿都看得见。
 *
 * 移动端没有这个按钮：那边走「更多」抽屉里的入口 + 弹窗面板（CalSheet）。
 */
export function CalMenu({ state }: { state: LocalState }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useOutsideClose(root, open, () => setOpen(false));
  /* Esc 关掉并把焦点还给触发键 —— 不还的话焦点掉到 body，键盘用户得从
     页首重新 Tab 一遍（同 Drawer / Sheet 那条约定）。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const visible = state.cals;
  const shown = state.ui.cals;

  return (
    <div className="cal-menu" ref={root}>
      <button
        ref={btn}
        type="button"
        data-cal-menu
        className={'cal-menu-btn' + (open ? ' on' : '')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="显示的日程集"
        onClick={() => setOpen(!open)}
      >
        <span className="min-w-0 max-w-[10rem] truncate">{calSummary(visible, shown)}</span>
        <ChevronDown size={13} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="cal-menu-pop" role="group" aria-label="显示的日程集">
          {visible.map((c) => <CalRow key={c.id} c={c} on={shown.includes(c.id)} />)}
        </div>
      )}
    </div>
  );
}

/**
 * 移动端：「更多」抽屉里那个按钮点出来的**多选弹窗面板**。
 *
 * 窄屏侧栏是收起的，桌面那个下拉多选框根本不存在 —— 没有这个面板的话，
 * 手机上就没有任何地方能改「显示哪几个集」。
 */
export function CalSheet({ state, open, onClose }: {
  state: LocalState; open: boolean; onClose: () => void;
}) {
  const shown = state.ui.cals;
  return (
    <Sheet open={open} onClose={onClose} title="显示的日程集">
      <div className="flex flex-col gap-[2px]">
        {state.cals.map((c) => <CalRow key={c.id} c={c} on={shown.includes(c.id)} />)}
      </div>
    </Sheet>
  );
}

/* ============================== 邀请收件箱 ============================== */

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
        <div className="py-6 text-center text-[13px] text-[var(--text-3)]">没有待处理的邀请</div>
      )}
      <div className="flex flex-col gap-2">
        {state.invites.map((i) => (
          <div key={i.id} className="rounded-[var(--r-lg)] border-[length:var(--border-w)] border-[var(--border)] p-3">
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
