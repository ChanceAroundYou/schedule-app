/**
 * Settings.tsx —— 设置页
 *
 * 放在 `ui/` 而不是 `views/`，**这是故意偏离方案的一处**：
 * 项目 CLAUDE.md 四、28 定死 `views/` 是「纯展示、零回调，只出 data-* 属性」，
 * 理由是那里的行会被拖拽重排 / 同步落地**换掉节点**，挂在行上的 handler 会跟着丢，
 * 所以全走 App.tsx 的事件委托。设置页没有这一类会被搬动的行 —— 它是普通表单，
 * 而 `ui/` 下本来就是这个形态（Calendars / Auth / Drawer / ActSheet 都收回调）。
 * 把它放进 views/ 会让那条不变量第一次出现例外，例外一多就没人守了。
 *
 * 页面结构：**大 header + 小 tab 切换**。四个 tab：
 *   外观 · 安全 · 日程集 · 关于
 *
 * 配色一律走 styles/tokens.css 的 CSS 变量（语义样式模块不覆盖这些新表面，Tailwind 生效；
 * 写死颜色会让深色模式在这里失效）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import {
  Check, Database, GripVertical, Info, KeyRound, Layers, LogOut, MailPlus, Palette, PanelTop,
  Upload, Download, Trash2, UserRound, Plus,
  AlertTriangle, ChevronDown, Wifi, WifiOff, CloudUpload, Clock, Star,
} from 'lucide-react';
import { type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { AccentKey, Cal, Invite, LocalState, Member, PublicUser, StyleKey, ThemeMode, UiPrefs } from '../domain/types.ts';
import { ROLE_LABEL, canManage } from '../domain/types.ts';
import { TAB_MAX, resolveDefaultCal } from '../domain/model.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import * as T from './theme.ts';
import { Btn, Card, Chips, Dropdown, Field, InlineRename, Input, MiniIconBtn, Row, Sheet, useConfirm, toast } from './kit.tsx';
import type { DropdownOption } from './kit.tsx';
import { MembersSection } from './Members.tsx';
import { api, ApiError } from '../data/api.ts';
import { navDef } from './Shell.tsx';
import { useIsNarrow, useOnline } from './hooks.ts';
import { SortableZone, useSortableItem } from './dndkit.tsx';
import { cx } from './cx.ts';

/** 构建期注入，见 vite-env.d.ts。取不到（比如被别的打包器吃掉）时不要显示空白 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * 描边走 **真令牌 `--border`**，不给兜底值。
 *
 * 老 surface（Calendars / Auth / kit）描边写的是一个**不存在的令牌**再配一个兜底值，
 * 而那个令牌在 styles/tokens.css 里根本没定义 —— 有兜底值所以不报错、不白屏，
 * 只是两套主题下都在用写死的浅色。**静默降级比直接坏掉难查得多。**
 * 这个文件是新的，别把这个坏习惯带过来。
 */
const HOVER = 'hover:bg-[var(--panel-3)]';

/* ============================== 小组件 ============================== */

/* `Card` / `Field` / `Row` 现在在 `kit.tsx`（组件库的「布局原语」那一段）——
   `Members.tsx` 也要用同一套（成员 / 邀请两块在两个地方渲染），放在这个文件里
   它就得自己再抄一份标题样式。**没有第二套**。 */

/* ============================ 功能区自定义 ============================ */

/**
 * 功能区自定义：一格一个功能项，**点一下切换显示 / 隐藏，拖一下排序**。
 *
 * 勾选的含义在两种设备上是同一个：**勾上 = 在这个设备的功能区里显示**。
 *   宽屏 · 功能区 = 侧栏那一列   → 不勾 = 藏起来（`ui.navHidden`）
 *   窄屏 · 功能区 = 底栏那 4 格   → 不勾 = 不进底栏，在「更多」抽屉里
 *
 * 原先宽屏那一半的勾选框管的是 `navBottom`（「挪到侧栏下面那一组」），
 * 于是点一下打勾，这一项就从侧栏主列里**消失**、跑到下面去了 —— 用户看到的是
 * 「勾选时消失，未勾选时显示」，正好反着。而且它的名字（勾）说的是「要不要它」，
 * 干的事却是「换个位置」，两回事。现在勾就是显示，位置只由拖拽决定。
 *
 * 为什么藏起来要用 `navHidden` 而不是把它从 `navOrder` 里删掉：`normalizeUi`
 * 会把缺的键补回 `navOrder`（老用户本地那份顺序里没有新页），删了刷新就回来。
 *
 * 拖拽走 @dnd-kit：MouseSensor 处理鼠标输入。移动 8px 才开始拖 ——
 * 轻点（不移动）不会触发拖，所以「点一下切换」不受影响。
 */
function NavCard({ state }: { state: LocalState }) {
  const ui = state.ui;
  const order = ui.navOrder;
  const tabs = new Set(ui.tabs);
  const hidden = new Set(ui.navHidden);
  const narrow = useIsNarrow();

  const [rows, setRows] = useState<string[]>(order);
  useEffect(() => setRows(order), [order]);

  /** 勾选口径跟着设备走：窄屏是底栏那几项，宽屏是侧栏里没被藏起来的那些 */
  const isOn = (k: string) => (narrow ? tabs.has(k) : !hidden.has(k));

  const toggle = (k: string) => {
    if (narrow) {
      if (tabs.has(k)) {
        if (tabs.size <= 1) return;
        store.setUi({ tabs: ui.tabs.filter((x) => x !== k) });
      } else {
        if (tabs.size >= TAB_MAX) return;
        store.setUi({ tabs: order.filter((x) => tabs.has(x) || x === k) });
      }
    } else {
      store.setUi({
        navHidden: hidden.has(k)
          ? ui.navHidden.filter((x) => x !== k)
          : [...ui.navHidden, k],
      });
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setRows((prev) => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) return prev;
        const next = arrayMove(prev, oldIndex, newIndex);
        store.setUi({ navOrder: next });
        return next;
      });
    }
  };

  return (
    <Card icon={<PanelTop size={14} />} title="功能区">
      <Field label={narrow ? `底栏 · 最多 ${TAB_MAX} 项（点选 + 拖拽）` : '侧栏 · 点选 + 拖拽'}>
        {/* 自己一套 context（SortableZone）而不是挂在顶层那个上：跟着手指走的
            那一份必须是浮层，顶层故意不挂浮层（挂了时间轴那条就废了）。
            顺带白拿让位动画和原位的占位虚影 —— 见 dndkit.tsx 的 SortableZone。 */}
        <SortableZone
          items={rows}
          onDragEnd={onDragEnd}
          renderGhost={(id) => <div className={cx('nav-chip', CHIP_CX, chipTone(isOn(id)))}><NavChipBody id={id} on={isOn(id)} /></div>}
        >
          {/* 三列网格而不是每项一行：九项一行一个要占 280px 高，一屏就没了。
              网格还有个好处 —— 每格等宽，拖拽时让位的落点是规则的。 */}
          <ul className="grid grid-cols-3 gap-1.5">
            {rows.map((k) => (
              <SortableNavChip key={k} id={k} on={isOn(k)} narrow={narrow} onToggle={toggle} />
            ))}
          </ul>
        </SortableZone>
      </Field>
    </Card>
  );
}

/**
 * 一格的样子。**行本体和浮层里跟着手指走的那一份必须一模一样** ——
 * 抄两遍尺寸就会漂，而落点判定量的正是浮层自己那份的矩形。
 */
const CHIP_CX = 'flex items-center gap-1 rounded-[var(--r-md)] border-[length:var(--border-w)] px-1.5 py-1 text-[12.5px] select-none';
const chipTone = (on: boolean) => (on
  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary)]'
  : 'border-[var(--border)] text-[var(--text-3)] ' + HOVER);

/** 一格的内容。行和浮层里那份共用 —— 两份长得不一样，拖起来像换了个东西。 */
function NavChipBody({ id, on }: { id: string; on: boolean }) {
  return (<>
    <span className="shrink-0 text-[var(--text-3)]">
      <GripVertical size={12} />
    </span>
    <span className="min-w-0 flex-1 truncate">{navDef(id).label}</span>
    {on && <Check size={12} className="shrink-0" />}
  </>);
}

/**
 * 功能区里一格可排序的导航项。
 *
 * **整行都是拖拽命中区**（`listeners` 在 `<li>` 上），不是只有那个 grip 图标。
 * 原先 listeners 只挂在 12px 的 grip `<span>` 上 —— 必须精确按住那个小图标
 * 才拖得动，按行的其余部分完全没反应，用户报「完全不跟手」。把手现在只剩
 * 视觉提示作用。
 *
 * 走共享的 `useSortableItem`（不另写一份 useSortable + CSS.Translate）：
 * 「只取位移不要缩放」「被拖项不给 transition、其余让位项给 transition」
 * 这两条规则都在那个 hook 里，这里再抄一遍就一定会和它漂。
 *
 * **占位虚影画在落点**（`.drag-land`，判据是 dnd-kit 的 `isOver` = 指针正压着的
 * 那一格），跟着手指走的是 `SortableZone` 浮层里那份实体卡。原先反过来了 ——
 * 虚线画在**被拖项**身上、钉在它出发的那一格（`.nav-chip-drag`），于是手指走了、
 * 虚影远远锁在角落不动，用户报「虚影锁定在原位，不会跟着走」。
 *
 * `data-nav-row` / `data-tab` 是探针认的锚点，别改。`attributes`（带
 * `role="button"`）也照旧挂着 —— 键盘那条路靠它。
 */
function SortableNavChip({ id, on, narrow, onToggle }: {
  id: string;
  on: boolean;
  narrow: boolean;
  onToggle: (k: string) => void;
}) {
  const { ref, style, isDragging, isOver, attributes, listeners } = useSortableItem(id);

  return (
    <li
      ref={ref}
      style={style}
      {...attributes}
      {...listeners}
      data-nav-row={id}
      data-tab={narrow ? id : undefined}
      onClick={() => onToggle(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id); } }}
      /* 被拖的那一格**整个藏起来**（浮层里那份实体卡跟着手指走），原位不留
         淡影 —— 留了就是「虚影锁定在原位」。占位虚影由 `isOver` 那一格画。 */
      className={cx('nav-chip cursor-grab', CHIP_CX, chipTone(on),
        isDragging && 'opacity-0', isOver && 'drag-land')}
    >
      <NavChipBody id={id} on={on} />
    </li>
  );
}

/* ============================ 修改密码 ============================ */

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

/* ============================ 日程集管理 ============================ */

/* 角色选项与角色说明不在这里 —— 成员 / 邀请那两块整体走 `Members.tsx` 的
   `MembersSection`（「管理日程集」浮层用的是同一份）。两份各自留一套
   ROLES / ROLE_HINT 的下场就是一处改了另一处没改。 */

function say(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请重试';
}

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
function DayWindowCard({ ui }: { ui: UiPrefs }) {
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
          <span className="text-[12.5px] text-[var(--text-2)]">到</span>
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

/** 权限变了 / 成员变了之后，把集列表和邀请刷新一遍 */
async function refreshCals(): Promise<void> {
  await engine.refreshMeta();
}

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

/** 一个日程集：收起是一行，展开是它的全部设置 */
function CalItem({ cal, active, isDefault, open, onToggle }: {
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
        className="flex h-[40px] items-center gap-2 rounded-[var(--r-md)] bg-[var(--panel-3)] pl-3 pr-2 transition hover:brightness-95"
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
              danger
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
              <span className={cx('min-w-0 flex-1 truncate', active ? 'font-medium text-[var(--primary)]' : 'text-[var(--text-2)]')}>
                {cal.name}
              </span>
              {/* 星标 = 默认日程集。传 `aria-pressed` 不传 `disabled`：它是显示状态
                  的标记，禁用了键盘就 Tab 不过去，也读不到「已经是默认了」。
                  「选中变主色」走 `primary` **prop** —— 叠 `className` 会被
                  基类的 `text-[var(--text-3)]` 按生成顺序压掉（实测过）。 */}
              <MiniIconBtn
                label={isDefault ? '默认日程集' : '设为默认日程集'}
                aria-pressed={isDefault}
                primary={isDefault}
                onClick={() => {
                  if (isDefault) return;
                  store.setUi({ defaultCal: calId });
                  toast('「' + cal.name + '」已设为默认日程集');
                }}
              >
                <Star size={13} fill={isDefault ? 'currentColor' : 'none'} />
              </MiniIconBtn>
              {cal.role !== 'owner' && (
                <span className="shrink-0 rounded-[var(--r-xs)] bg-[var(--panel)] px-1.5 py-px text-[10.5px] text-[var(--text-3)]">
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
          <ChevronDown size={13} className={cx('shrink-0 text-[var(--text-3)] transition', open && 'rotate-180')} />
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
            <div className="border-t-[length:var(--border-w)] border-[var(--border)] pt-3.5">
              <Field label="危险区">
                <Row>
                  <Btn variant="danger" size="sm" onClick={() => void leave()}>
                    <LogOut size={13} /> 退出日程集
                  </Btn>
                </Row>
                {mine === 'viewer' && (
                  <div className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-[var(--text-3)]">
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


/* ================================ 页面 ================================ */

type SettingsTab = 'appearance' | 'security' | 'cals' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'security', label: '安全' },
  { key: 'cals', label: '日程集' },
  { key: 'about', label: '关于' },
];

export function SettingsView({ state, user, theme, onExport, onImport, onLogout, onInvites }: {
  state: LocalState;
  user: PublicUser | null;
  /** **实际生效**的那一档（auto 已解析）。色点要靠它才画得出暗色档的颜色 */
  theme: 'light' | 'dark';
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onInvites: () => void;
}) {
  const ui = state.ui;
  const confirm = useConfirm();
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');

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

  return (
    <div className="mx-auto w-full max-w-[620px] pb-6">
      {/* tab 栏作为唯一 header */}
      <header className="mb-4">
        <div className="flex gap-1 rounded-[var(--r-lg)] border-[length:var(--border-w)] border-[var(--border)] bg-[var(--panel-3)] p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-settings-tab={t.key}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
              className={cx(
                'flex-1 rounded-[var(--r-sm)] px-3 py-1.5 text-[13px] transition',
                tab === t.key
                  ? 'bg-[var(--primary)] text-[var(--on-primary)] font-medium'
                  : 'text-[var(--text-2)] hover:bg-[var(--panel)]',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'appearance' && (
        <>
          {/* 功能区放在最前面 —— 它改的是导航本身，比配色更「结构性」 */}
          <NavCard state={state} />
          <Card icon={<Palette size={14} />} title="外观">
            <Field label="色板">
              <Chips<AccentKey>
                value={ui.accent}
                options={['jade', 'azure', 'clay', 'plum', 'gold', 'slate']}
                onPick={(k) => store.setUi({ accent: k })}
                labelOf={(k) => T.ACCENTS[k].label}
                // 色点在**自己身上**带 data-accent + data-theme，于是它拿到的
                // --primary 就是选中那套（含暗色档那组提亮过的值）。
                // 不在 TS 里再存一份十六进制 —— 那两份一定会漂。
                render={(k) => (
                  <span
                    data-accent={k}
                    data-theme={theme}
                    className="inline-block h-3 w-3 shrink-0 rounded-full"
                    style={{ background: 'var(--primary)' }}
                  />
                )}
              />
            </Field>

            <Field label="风格">
              <Chips<StyleKey>
                value={ui.style}
                options={['soft', 'flat', 'notion']}
                onPick={(k) => store.setUi({ style: k })}
                labelOf={(k) => T.STYLES[k].label}
              />
            </Field>

            {/* 顶栏那个按钮是二元的（按下即离开「跟随系统」），三选一只有这里 */}
            <Field label="深浅">
              <Chips<ThemeMode>
                value={ui.theme}
                options={['auto', 'light', 'dark']}
                onPick={(k) => store.setUi({ theme: k })}
                labelOf={(k) => T.THEMES[k].label}
              />
            </Field>
          </Card>

          <DayWindowCard ui={ui} />
        </>
      )}

      {tab === 'security' && (
        <>
          <Card icon={<UserRound size={14} />} title="账号">
            <Field label="当前账号">
              <Row>
                <span className="min-w-0 flex-1 truncate text-[13px]">{user ? user.name : '未登录'}</span>
                <Btn variant="chip" size="sm" onClick={() => setPwOpen(true)}>
                  <KeyRound size={13} /> 修改密码
                </Btn>
                <Btn variant="danger" size="sm" onClick={onLogout}>
                  <LogOut size={13} /> 退出登录
                </Btn>
              </Row>
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
                    ? <Wifi size={13} className="text-[var(--ok)]" />
                    : <WifiOff size={13} className="text-[var(--danger)]" />}
                  <span className={online ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}>
                    {online ? '在线' : '离线'}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-[12.5px]">
                  <CloudUpload
                    size={13}
                    className={state.outbox.length ? 'text-[var(--warn)]' : 'text-[var(--text-3)]'}
                  />
                  <span className={state.outbox.length ? 'text-[var(--warn)]' : 'text-[var(--text-2)]'}>
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
      )}

      {tab === 'cals' && <CalsTab state={state} onInvites={onInvites} />}

      {tab === 'about' && (
        <Card
          icon={<Info size={14} />}
          title="关于"
          hint="个人任务与打卡管理。数据在服务器上，多设备通过日程集共享。"
        >
          <Field label="版本">
            <span data-about="version" className="text-[12.5px]">{VERSION}</span>
          </Field>
          <Field label="技术栈">
            <span className="text-[12.5px]">React + Node + SQLite</span>
          </Field>
        </Card>
      )}

      {pwOpen && <ChangePasswordSheet onClose={() => setPwOpen(false)} />}
    </div>
  );
}
