/**
 * CalItem.tsx —— 日程集管理里的一行（收起是一行，展开是它的全部设置）
 *
 * 从 `CalsTab.tsx` 拆出来：那一份同时管着「日视图时间窗 + 集列表外壳 +
 * 单行 213 行的全部设置」，而单行这一段有两倍长的注释、十个回调、自己
 * 一层本地状态。拆开不为了「变小」，是为了改这行的时候不用在 CalsTab 里
 * 上下翻 200 行确认改的是哪一段。
 *
 * 关键的共享口径「哪个是默认集」仍然由外层算好传进来（`isDefault`），
 * 没有跟着搬 —— 一个 tab 里 `resolveDefaultCal()` 只该跑一次。
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, LogOut, Star, Trash2 } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import type { Cal, Invite, Member } from '../../domain/types.ts';
import { ROLE_LABEL, canManage } from '../../domain/types.ts';
import { Btn, Field, InlineRename, MiniIconBtn, Row, useConfirm, toast } from '../kit.tsx';
import { MembersSection } from '../Members.tsx';
import { api, ApiError } from '../../data/api.ts';
import { cx } from '../cx.ts';
import * as store from '../../data/store.ts';
import * as engine from '../../sync/engine.ts';

/** 错误 → 一句人话。所有集操作的 catch 都走它 */
export function say(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请重试';
}

/** 权限变了 / 成员变了之后，把集列表和邀请刷新一遍 */
export async function refreshCals(): Promise<void> {
  await engine.refreshMeta();
}

/** 一个日程集：收起是一行，展开是它的全部设置 */
export function CalItem({ cal, active, isDefault, open, onToggle }: {
  cal: Cal;
  active: boolean;
  /** 是不是默认日程集。由 CalsTab 用 `resolveDefaultCal()` 算好传进来 */
  isDefault: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const confirm = useConfirm();
  const [members, setMembers] = useState<Member[]>([]);
  const [sent, setSent] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);

  const calId = cal.id;
  const mine = cal.role;
  const manage = canManage(mine);
  /* 「哪个是默认」是一个**显式的 id**（`ui.defaultCal`），不是拿名字比 ——
     以前写的是 `cal.name === '我的日程'`，改个名这条保护就失效了。 */

  const reload = async () => {
    try {
      const r = await api.members(calId);
      setMembers(r.members);
      setSent(r.invites);
    } catch (e) { toast(say(e)); }
  };

  useEffect(() => { if (open) void reload(); }, [open]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); await refreshCals(); }
    catch (e) { toast(say(e)); }
    finally { setBusy(false); }
  };

  const saveName = (next: string) => run(async () => {
    const n = next.trim();
    if (!n) { toast('日程集名字不能为空'); return; }
    await api.renameCal(calId, n);
    toast('已改名');
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
    /* 外框整个去掉了：原来「卡里一个大框、框里一个小框、小框里每行又是一个
       带底色的胶囊」，三层框套三层底色，用户说「一层层大框套小框」。
       现在**只有标题行是那块圆角 + 底色的东西**，正文直接摆在卡的留白里，
       左右边与标题行的内容对齐（不再多包一层 p-3）。 */
    <div>
      {/* 标题行分三区，从左到右：**名称区 · 操作区 · 箭头区**。
          固定 h-[40px]：改名输入框 28px、图标钮 24px，两态都落在这个高度上
          —— 一点铅笔，下面的成员区不会被顶一下。

          **名称区不再是按钮了。** 它原先整段可点（点名字展开），但名字右边
          要挂「设为默认」的星标、编辑态还要换成 `<input>` —— 两者都塞不进一个
          `<button>` 里（按钮套按钮是非法 HTML，input 也进不了 button）。
          所以展开 / 收起改由**最右边那个箭头**独家负责，它才是真的折叠开关，
          `aria-expanded` 也归它。 */}
      <div
        className="ci-row flex h-[40px] items-center gap-2 pl-3 pr-2 transition hover:brightness-95"
      >
        {/* —— 名称区 + 操作区 ——
            InlineRename 左边是名称区、右边那固定 52px 是操作区：
            平时「铅笔 + 删除」，编辑中「√ + ✕」，两态都是两格。 */}
        <InlineRename
          value={cal.name}
          label="日程集名字"
          disabled={!manage || busy}
          onSave={saveName}
          inputProps={{ 'data-cal-name': '1' } as InputHTMLAttributes<HTMLInputElement>}
          confirmProps={{ 'data-cal-save': '1' } as ButtonHTMLAttributes<HTMLButtonElement>}
          /* 删除挂在操作区第二格，原先在下面「危险区」里 —— 用户要求搬到标题行上。
             `manage` 之外不渲染：只读成员没有「删除日程集」这个动作，那一格留空
             （槽宽不变，所以箭头不挪窝）。禁用的只有「默认日程集」——
             删了它，下次新建的东西就没地方落。 */
          extraAction={manage ? (
            <MiniIconBtn
              tone="danger"
              label="删除日程集"
              disabled={busy || isDefault}
              onClick={() => void remove()}
            >
              <Trash2 size={13} />
            </MiniIconBtn>
          ) : null}
          display={(
            /* 星标**紧跟着名字**。放在 `display` 里 → 编辑态整个 display 被输入框
               换掉，星标和角色徽标自动隐藏，不用在外面再判一次 `editing`，
               也就不会出现「名字已经是输入框了，星标还杵在旁边」的错位。 */
            <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
              <span className={cx('min-w-0 flex-1 truncate', active ? 'font-medium ci-name-active' : 'ci-name-idle')}>
                {cal.name}
              </span>
              {/* 星标 = 默认日程集。传 `aria-pressed` 不传 `disabled`：它是显示状态
                  的标记，禁用了键盘就 Tab 不过去，也读不到「已经是默认了」。
                  「选中变主色」走 `tone="primary"` **prop** —— 叠 `className` 会被
                  基类的 `--text-3` 文字色按生成顺序压掉（实测过）。 */}
              <MiniIconBtn
                label={isDefault ? '默认日程集' : '设为默认日程集'}
                aria-pressed={isDefault}
                tone={isDefault ? 'primary' : undefined}
                onClick={() => {
                  if (isDefault) return;
                  store.setUi({ defaultCal: calId });
                  toast('「' + cal.name + '」已设为默认日程集');
                }}
              >
                <Star size={13} fill={isDefault ? 'currentColor' : 'none'} />
              </MiniIconBtn>
              {cal.role !== 'owner' && (
                <span className="ci-role shrink-0 px-1.5 py-px text-[10.5px]">
                  {ROLE_LABEL[cal.role]}
                </span>
              )}
            </span>
          )}
        />

        {/* —— 箭头区 —— 标题行最右侧，独家负责展开 / 收起。`aria-expanded`
            只给**真的是折叠开关**的东西，这一格就是。`data-cal-item` 也跟着
            从名字那一段搬过来：探针点这一下就是展开那一行。 */}
        <MiniIconBtn
          label={open ? '收起' : '展开'}
          aria-expanded={open}
          data-cal-item={cal.id}
          onClick={onToggle}
        >
          <ChevronDown size={13} className={cx('ci-chevron shrink-0 transition', open && 'rotate-180')} />
        </MiniIconBtn>
      </div>

      {open && (
        /* data-cal-body 是探针抓手：它量的是「标题行下面那块」的位置，
           用来盯住「切进行内改名时下面不许动」这条约定（见 kit.tsx 的
           InlineRename）。给它一个锚点，探针就不用去猜哪个元素是正文。 */
        // 正文**不占横向留白**：成员行 / 邀请行的两条边与标题条那个圆角条的
        // **外沿**齐平（用户 2026-10-09：「宽度再宽一点点，让邀请输入框、
        // 新建按钮、header 对齐」）。
        // 上一轮是把它们对齐到标题条的**内容盒**（`pl-3 pr-2` = 10.5 / 7），
        // 结果每一行都比标题条窄一截 —— 左边缩 10.5px、右边缩 7px，看着就是
        // 「没对齐」。这一轮直接贴齐外沿：邀请输入框比上一轮宽 17.5px
        // （456.48 → 473.98），纸飞机右缘与折叠箭头右缘重合。
        // 注意是**齐平**，不是超出 —— 上一轮那条「不许超过 header」仍然成立。
        <div data-cal-body="1" className="flex flex-col gap-3.5 pt-3.5">
          {/* 成员 / 邀请：走和「管理日程集」浮层**同一份** MembersSection。
              这里原先自己抄了一遍成员行、角色选择器、邀请行、撤回按钮，
              两份只有缩进不同 —— 角色一处用 Chips 一处用 Dropdown，
              圆角和颜色也跟着各自漂。 */}
          <MembersSection
            calId={calId}
            members={members}
            sent={sent}
            manage={manage}
            busy={busy}
            run={(fn) => void run(fn)}
          />

          {/* 危险区：**只在有东西可放时才出现**。删除按钮搬到标题行的操作区了
              （见上），所以创建者这一块整个不渲染 —— 剩一个只有标题的空框，
              比没有更费解。可编辑 / 只读成员仍然在这里「退出日程集」：
              那不是删集，是退掉一段关系，和「删除」不是一件事。
              和设置页别处的危险操作走同一个 variant，不再手写一套「红字 + hover 淡红底」。 */}
          {!manage && (
            <div className="ci-danger border-t-[length:var(--border-w)] pt-3.5">
              <Field label="危险区">
                <Row>
                  <Btn variant="danger" size="sm" onClick={() => void leave()}>
                    <LogOut size={13} /> 退出日程集
                  </Btn>
                </Row>
                {mine === 'viewer' && (
                  <div className="ci-hint mt-1.5 flex items-start gap-1.5 text-[11.5px]">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>你是只读成员，改不了里面的内容。</span>
                  </div>
                )}
              </Field>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
