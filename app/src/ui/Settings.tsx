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
 * 页面本身是**竖排卡片**：外观 / 数据 / 账户 / 日程集 / 关于。
 * 配色一律走 legacy.css 的 CSS 变量（新表面没有 legacy 规则，Tailwind 生效；
 * 写死颜色会让深色模式在这里失效）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check, Database, GripVertical, Info, KeyRound, Layers, LogOut, MailPlus, Palette, PanelTop,
  Pencil, Upload, Download, Trash2, UserRound,
} from 'lucide-react';
import type { AccentKey, LocalState, PublicUser, StyleKey, ThemeMode } from '../domain/types.ts';
import { ROLE_LABEL, canManage } from '../domain/types.ts';
import { TAB_MAX } from '../domain/model.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import * as T from './theme.ts';
import { Btn, Sheet, useConfirm, toast } from './kit.tsx';
import { api } from '../data/api.ts';
import { navDef } from './Shell.tsx';
import { useIsNarrow, useOnline } from './hooks.ts';
import { cx } from './cx.ts';

/** 构建期注入，见 vite-env.d.ts。取不到（比如被别的打包器吃掉）时不要显示空白 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * 描边走 **真令牌 `--border`**，不给兜底值。
 *
 * 老 surface（Calendars / Auth / kit）描边写的是一个**不存在的令牌**再配一个兜底值，
 * 而那个令牌在 legacy.css 里根本没定义 —— 有兜底值所以不报错、不白屏，
 * 只是两套主题下都在用写死的浅色。**静默降级比直接坏掉难查得多。**
 * 这个文件是新的，别把这个坏习惯带过来。
 */
const LINE = 'border-[var(--border)]';
const HOVER = 'hover:bg-[var(--panel-3)]';

/* ============================== 小组件 ============================== */

function Card({ icon, title, children, hint }: {
  icon: React.ReactNode; title: string; children: React.ReactNode; hint?: React.ReactNode;
}) {
  return (
    <section className={'mb-4 rounded-xl border p-4 ' + LINE}>
      <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
        <span className="text-[var(--text-3)]">{icon}</span> {title}
      </h2>
      {children}
      {hint && <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </section>
  );
}

/**
 * 一排二选一 / 三选一的胶囊。
 *
 * **不是 `<select>`**：这三轴一共 6+3+3 个选项，是用户会反复来回试的东西，
 * 每次都要展开一次下拉等于把「试」这件事的摩擦拉满。
 */
function Chips<K extends string>({ value, options, onPick, render }: {
  value: K;
  options: readonly K[];
  onPick: (k: K) => void;
  /** 色板那一轴要在胶囊里画一个色点，那个色点得跟着这一轴自己的取值走 */
  render?: (k: K) => React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((k) => {
        const on = k === value;
        return (
          <button
            key={k}
            type="button"
            data-pick={k}
            aria-pressed={on}
            onClick={() => onPick(k)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition',
              on
                ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                : 'text-[var(--text-2)] ' + HOVER + ' ' + LINE,
            )}
          >
            {render?.(k)}
            {(T.ACCENTS as Record<string, { label: string }>)[k as unknown as string]?.label
              || (T.THEMES as Record<string, { label: string }>)[k as unknown as string]?.label
              || (T.STYLES as Record<string, { label: string }>)[k as unknown as string]?.label || k}
          </button>
        );
      })}
    </div>
  );
}

/* ============================ 功能区自定义 ============================ */

/**
 * 功能区自定义：底栏挑哪几项 + 侧栏怎么排。
 *
 * **按设备分屏**：窄屏（≤900px）只显示底栏那一组，宽屏只显示侧栏那一组。
 * 两段交叉着显示对谁都没用 —— 手机上永远看不到侧栏，电脑上永远看不到底栏，
 * 摆在一起只是让人多读一段与自己无关的设置。断点走 `useIsNarrow()`，
 * 与 Shell 的侧栏 / 底栏显隐是同一根线（hooks.ts 的 `(max-width: 900px)`）。
 *
 * **不接 `ui/dnd.ts`**，这是有意的。那套是为任务/打卡的时间轴与让位洞设计的
 * （`ROW_SEL`、`data-untimed`、`rawLayout` 量原始布局、`shiftCells` 让位），
 * 套到一个 7 行的静态列表上属于杀鸡用牛刀 —— 而且它那套「按几何推列数」
 * 的假设在这里根本不成立。这里只要「拖到谁就跟谁换」，一个局部 HTML5
 * 拖拽就够。
 *
 * 拖拽期间改的是**本地 rows**，drop 时才写一次 `setUi` —— 每帧写盘的话
 * `persist()` 的防抖会被拖成一条长尾，而且中途松手会留下半个顺序。
 */
function NavCard({ state }: { state: LocalState }) {
  const ui = state.ui;
  const order = ui.navOrder;
  const tabs = new Set(ui.tabs);
  const bottom = new Set(ui.navBottom);
  const narrow = useIsNarrow();

  const [rows, setRows] = useState<string[]>(order);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // 别处改了 navOrder（比如另一台设备同步来一份）就跟着变，别让用户
  // 拖到一半发现列表自己重置了
  useEffect(() => setRows(order), [order]);

  const label = (k: string) => navDef(k).label;

  const toggleTab = (k: string) => {
    if (tabs.has(k)) {
      // 底栏至少留 1 格 —— 空栏等于没有导航，用户会以为应用坏了
      if (tabs.size <= 1) return;
      store.setUi({ tabs: ui.tabs.filter((x) => x !== k) });
    } else {
      if (tabs.size >= TAB_MAX) return;
      // 加进去时按 navOrder 排，不让它永远挂在末尾
      store.setUi({ tabs: order.filter((x) => tabs.has(x) || x === k) });
    }
  };

  const toggleBottom = (k: string) => {
    const next = bottom.has(k)
      ? ui.navBottom.filter((x) => x !== k)
      : [...ui.navBottom, k];
    store.setUi({ navBottom: next });
  };

  /** 拖到 `k` 上：跟它换一格。换完被拖元素就在 k 的位置，继续拖下一个还会再换 */
  const onDragOver = (k: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragKey || dragKey === k) return;
    const next = rows.slice();
    const i = next.indexOf(dragKey);
    const j = next.indexOf(k);
    if (i < 0 || j < 0) return;
    next[i] = k;
    next[j] = dragKey;
    setRows(next);
    setOverKey(k);
  };

  const endDrag = () => {
    if (dragKey && rows.join() !== order.join()) store.setUi({ navOrder: rows });
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <Card icon={<PanelTop size={14} />} title="功能区"
      hint={narrow
        ? '底栏最多 ' + TAB_MAX + ' 项，「更多」恒占最后一格。'
        : '侧栏那列可以直接拖，也可以在这儿拖 —— 两边改的是同一份顺序。'}>
      {narrow ? (
        /* 手机：只显示底栏设置。侧栏在窄屏根本不渲染，摆出来只会让人困惑 */
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[11.5px] text-[var(--text-3)]">底栏</span>
            <span className="text-[11.5px] text-[var(--text-3)]">{tabs.size}/{TAB_MAX}</span>
          </div>
          {/*
            按 navOrder 排，与侧栏一致 —— 用户在这儿挑的顺序就是他眼睛里
            侧栏的顺序。用 Chips 那个组件不合适：它是单选（aria-pressed
            恒为 false），这里是多选开关。
          */}
          <div className="flex flex-wrap gap-1.5">
            {order.map((k) => {
              const on = tabs.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  data-tab={k}
                  aria-pressed={on}
                  onClick={() => toggleTab(k)}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition',
                    on
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                      : 'text-[var(--text-2)] ' + HOVER + ' ' + LINE,
                  )}
                >
                  {on && <Check size={12} />}
                  {label(k)}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        /* 电脑：只显示侧栏设置。底栏在宽屏根本不渲染 */
        <div>
          <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">
            侧栏 · 拖拽排序
          </div>
          <ul className="flex flex-col gap-1">
            {rows.map((k) => (
              <li
                key={k}
                data-nav-row={k}
                draggable
                onDragStart={(e) => {
                  setDragKey(k);
                  // Firefox 不给 dataTransfer 就完全不发起拖拽，必须塞点东西
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', k);
                }}
                onDragOver={onDragOver(k)}
                onDrop={(e) => { e.preventDefault(); endDrag(); }}
                onDragEnd={endDrag}
                className={cx(
                  'flex cursor-grab items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px] active:cursor-grabbing',
                  overKey === k && dragKey !== k
                    ? 'border-[var(--primary)] ' + LINE
                    : 'text-[var(--text-2)] ' + LINE,
                )}
              >
                <GripVertical size={13} />
                <span className="min-w-0 flex-1 truncate">{label(k)}</span>
                <button
                  type="button"
                  data-bottom={k}
                  aria-pressed={bottom.has(k)}
                  onClick={() => toggleBottom(k)}
                  className={cx(
                    'shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition',
                    bottom.has(k)
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                      : 'text-[var(--text-3)] ' + HOVER + ' ' + LINE,
                  )}
                >
                  底部
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
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
          <input id={fid + '-c'} type="password" autoComplete="current-password" value={cur}
            onChange={(e) => setCur(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-n'}>新密码</label>
          <input id={fid + '-n'} type="password" autoComplete="new-password" value={next}
            onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-a'}>再输一遍</label>
          <input id={fid + '-a'} type="password" autoComplete="new-password" value={again}
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

/* ================================ 页面 ================================ */

export function SettingsView({ state, user, theme, onExport, onImport, onLogout, onManageCal, onInvites }: {
  state: LocalState;
  user: PublicUser | null;
  /** **实际生效**的那一档（auto 已解析）。色点要靠它才画得出暗色档的颜色 */
  theme: 'light' | 'dark';
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onManageCal: () => void;
  onInvites: () => void;
}) {
  const ui = state.ui;
  const confirm = useConfirm();
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const cal = state.cals.find((c) => c.id === ui.cal) || null;
  const pending = state.invites.length;

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

      <Card icon={<Palette size={14} />} title="外观"
        hint="深浅那一档选「跟随系统」时会随系统的日夜切换自动变，不用手动改。">
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">色板</div>
            <Chips<AccentKey>
              value={ui.accent}
              options={['jade', 'azure', 'clay', 'plum', 'gold', 'slate']}
              onPick={(k) => store.setUi({ accent: k })}
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
          </div>

          <div>
            <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">风格</div>
            <div>
              <Chips<StyleKey>
                value={ui.style}
                options={['soft', 'flat', 'notion']}
                onPick={(k) => store.setUi({ style: k })}
              />
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11.5px] text-[var(--text-3)]">
              深浅
              {/* 顶栏那个按钮是二元的（按下即离开「跟随系统」），三选一只有这里 */}
            </div>
            <Chips<ThemeMode>
              value={ui.theme}
              options={['auto', 'light', 'dark']}
              onPick={(k) => store.setUi({ theme: k })}
            />
          </div>
        </div>
      </Card>

      {/* 功能区：底栏挑哪几项 + 侧栏怎么排。放在外观之后 —— 它改的是
          导航本身，比配色更「结构性」，试完配色接着试它最自然 */}
      <NavCard state={state} />

      <Card icon={<Database size={14} />} title="数据"
        hint="备份是**合并**，不是覆盖：同 id 的会被覆盖，其余原样留着。">
        <div className="flex flex-wrap gap-2">
          <Btn variant="chip" size="sm" onClick={onExport}>
            <Upload size={13} /> 导出备份
          </Btn>
          <Btn variant="chip" size="sm" onClick={() => fileRef.current?.click()}>
            <Download size={13} /> 导入备份
          </Btn>
          <Btn variant="ghost" size="sm" disabled={busy} onClick={() => { setBusy(true); void wipeLocal().then(() => setBusy(false)); }}>
            <Trash2 size={13} /> 清空本机副本
          </Btn>
          <input
            ref={fileRef} type="file" accept="application/json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
          />
        </div>
      </Card>

      <Card icon={<Layers size={14} />} title="日程集">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {cal ? cal.name : '还没有拿到日程集'}
            {cal && <span className="ml-1.5 text-[11.5px] text-[var(--text-3)]">{ROLE_LABEL[cal.role]}</span>}
          </span>
          <Btn variant="chip" size="sm" disabled={!cal} onClick={onManageCal}>
            <Pencil size={13} /> 管理
          </Btn>
          <Btn variant="chip" size="sm" onClick={onInvites}>
            <MailPlus size={13} /> 邀请{pending ? `（${pending}）` : ''}
          </Btn>
        </div>
        {cal && !canManage(cal.role) && (
          <div className="mt-2 text-[11.5px] text-[var(--text-3)]">
            这个集里你不是创建者，名字与成员只有创建者能改。
          </div>
        )}
      </Card>

      <Card icon={<UserRound size={14} />} title="账户">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{user ? user.name : '未登录'}</span>
          <Btn variant="chip" size="sm" onClick={() => setPwOpen(true)}>
            <KeyRound size={13} /> 修改密码
          </Btn>
          <Btn variant="ghost" size="sm" onClick={onLogout}>
            <LogOut size={13} /> 退出登录
          </Btn>
        </div>
      </Card>

      <Card icon={<Info size={14} />} title="关于">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="text-[var(--text-3)]">版本</dt>
          <dd data-about="version">{VERSION}</dd>
          <dt className="text-[var(--text-3)]">网络</dt>
          <dd data-about="net">{online ? '在线' : '离线，改动先存在本机'}</dd>
          <dt className="text-[var(--text-3)]">同步</dt>
          <dd data-about="sync">
            {state.outbox.length ? `待上传 ${state.outbox.length} 条` : '没有待上传的改动'}
            <span className="text-[var(--text-3)]"> · 已拉到 #{state.cursor}</span>
          </dd>
        </dl>
        {/*
          设置页不显示「管理员」三个字 —— 这个应用没有管理员（见 CLAUDE.md 五）。
          下面这句说的是**日程集里的创建者**，那是另一回事。
        */}
        <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">
          数据在上面的服务器上，本机留一份离线副本，两边自动对齐。
        </div>
      </Card>

      {pwOpen && <ChangePasswordSheet onClose={() => setPwOpen(false)} />}
    </div>
  );
}
