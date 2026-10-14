/**
 * CalsTab.tsx —— 日程集管理 + 日视图时间窗
 *
 * `CalItem`（一行的全部设置，213 行）拆去 `./CalItem.tsx`；`say()` /
 * `refreshCals()` 也跟着搬走，因为只有它在用。这里只剩时间窗卡和集列表外壳。
 */

import { useState } from 'react';
import { Clock, Layers, MailPlus, Plus } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import { resolveDefaultCal } from '../../domain/model.ts';
import * as store from '../../data/store.ts';
import { Btn, Card, Dropdown, Field, Row, toast, type DropdownOption } from '../kit.tsx';
import { api } from '../../data/api.ts';
import { CalItem, refreshCals, say } from './CalItem.tsx';

/* ============================ 日视图时间窗 ============================ */

/** 0:00 … 24:00。**24 是合法的结束值**（「一直到今天结束」），不是笔误 ——
 *  `windowOf()` 会把它乘成 1440。 */
const HOUR_OPTIONS: DropdownOption<number>[] =
  Array.from({ length: 25 }, (_, h) => ({ value: h, label: h + ':00' }));

/**
 * 日视图只看哪几个小时。
 *
 * 日视图是**锁单屏、不滚动**的（见 styles/calendar.css 的 .content-day），
 * 整天 24 小时摊在一屏里每小时只有二十几 px。收窄时间窗 = 每小时重新变高，
 * 于是这一档既是「隐藏夜里的任务」，也是「让白天的时间块读得清」。
 *
 * 下限由 normalizeUi 兜（MIN_SPAN 小时），这里不重复判断。
 *
 * **两个都是 `Dropdown`，不是原生 `<select>`**（项目硬规则：`.tsx` 里零原生
 * select，`color-scan.mjs` 锁着）。为什么不用 `ClockBody` 那只转盘：这里的值域是
 * **0–24 的整点**，而 `ui.dayFrom` / `ui.dayTo` 在领域里就是**小时数**
 * （`windowOf()` 做 `Math.round(dayFrom) * 60`，`domain.test.ts` 直接比
 * `{dayFrom: 7, dayTo: 23} → {from: 420, to: 1380}`）。转盘给的是 `HH:MM`
 * 且画不出 **24:00**（它最上面是 0 点）—— 换转盘就得连领域和它的用例一起改，
 * 还会把「结束 = 24:00」这个值弄丢。25 个固定整点正是 `Dropdown` 的场合。
 */
function DayWindowCard({ ui }: { ui: LocalState['ui'] }) {
  return (
    <Card icon={<Clock size={14} />} title="日视图">
      <Field label="只看这段时间">
        <Row>
          <Dropdown
            value={ui.dayFrom}
            label="时间窗从几点开始"
            size="sm"
            options={HOUR_OPTIONS}
            onPick={(h) => store.setUi({ dayFrom: h })}
          />
          <span className="text-[12.5px] caltab-to">到</span>
          <Dropdown
            value={ui.dayTo}
            label="时间窗到几点结束"
            size="sm"
            options={HOUR_OPTIONS}
            onPick={(h) => store.setUi({ dayTo: h })}
          />
        </Row>
      </Field>
    </Card>
  );
}

/* ============================ 日程集管理 ============================ */

/* 角色选项与角色说明不在这里 —— 成员 / 邀请那两块整体走 `Members.tsx` 的
   `MembersSection`（「管理日程集」浮层用的是同一份）。两份各自留一套
   ROLES / ROLE_HINT 的下场就是一处改了另一处没改。 */

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
  /* 口径只有这一处：默认集 = `ui.defaultCal`，失效时兜到第一个自己建的集。
     在这一层算一遍传下去，别让每个 CalItem 各自问一遍（那种写法迟早
     有一项忘了更新，星标和「不能删」就对不上了）。 */
  const defaultId = resolveDefaultCal(state.ui, state.cals);

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
    <Card
      icon={<Layers size={14} />}
      title="日程集管理"
      /* 邀请收件箱是**全局**的（别人邀请我，跟哪个日程集无关），所以放在卡头，
         不塞在某个日程集的展开面板里。原先它占展开面板里整整一行，而且按钮
         文字就叫「邀请」—— 和上面「邀请成员」那个提交按钮重名，两个按钮
         一个发邀请、一个看收件箱，点错是常事。 */
      extra={!!state.invites.length && (
        <Btn variant="chip" size="sm" data-cal-invites="1" onClick={onInvites}>
          <MailPlus size={13} /> 邀请收件箱 {state.invites.length}
        </Btn>
      )}
    >
      <div className="flex flex-col gap-1.5">
        {state.cals.map((c) => (
          <CalItem
            key={c.id}
            cal={c}
            active={c.id === active}
            isDefault={c.id === defaultId}
            open={openId === c.id}
            onToggle={() => {
              store.setActiveCal(c.id);
              setOpenId((v) => (v === c.id ? null : c.id));
            }}
          />
        ))}
      </div>
      {/* normal 而不是「虚线框的 chip」：虚线是「这里可以放东西」的暗示，
          而新建是一个**按钮**，虚线框让它看着像一块待填的占位区。 */}
      <Btn
        variant="normal"
        onClick={() => void create()}
        className="w-full"
      >
        <Plus size={13} /> 新建日程集
      </Btn>
    </Card>
  );
}

export { DayWindowCard, CalsTab };
