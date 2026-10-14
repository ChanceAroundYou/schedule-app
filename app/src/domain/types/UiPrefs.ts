/**
 * UiPrefs —— 设备本地偏好
 */

/** 深浅。`auto` = 跟随系统，实际生效的那一档由 ui/theme.ts 解析 */
export type ThemeMode = 'auto' | 'light' | 'dark';
/** 色板。只改主色族，底色归深浅那一轴 —— 见 styles/tokens.css 的「色板轴」一段 */
export type AccentKey = 'jade' | 'azure' | 'clay' | 'plum' | 'gold' | 'slate';
/** 风格。几何（圆角 / 阴影）全在 CSS 里，TS 这边只有 label —— 见 styles/tokens.css 的「风格轴」 */
export type StyleKey = 'soft' | 'flat' | 'notion';

export interface UiPrefs {
  nav: string;
  view: 'day' | 'week' | 'month';
  cursor: string;
  theme: ThemeMode;
  /** 6 套色板之一。`azure` = 换暖纸之前那套靛蓝，留着当退路 */
  accent: AccentKey;
  /** 柔和 / 扁平 / notion。`soft` 是空块，等价于「2026-10-06 之前的几何」 */
  style: StyleKey;
  search: string;
  navOrder: string[];
  navBottom: string[];
  /**
   * 宽屏侧栏里**用户主动藏起来**的功能项，`navOrder` 的子集。
   *
   * 为什么需要单独一个字段，而不是「从 `navOrder` 里删掉」：`normalizeUi` 会把
   * `CUSTOMIZABLE` 里缺的键**补回** `navOrder`（老用户本地那份顺序里没有新页，
   * 不补他们就永远看不见新功能）。所以「不在 navOrder 里」表达不了「用户不要它」，
   * 只有这个显式的黑名单表达得了。
   *
   * 只影响**宽屏侧栏**：窄屏那套是 `tabs`（底栏 4 格 + 「更多」抽屉），
   * 没进底栏的项在「更多」里照样进得去，不存在「藏起来」这回事。
   * 藏起来的项仍然能从 设置 → 外观 → 功能区 勾回来，所以不会变成死角。
   */
  navHidden: string[];
  /**
   * **默认日程集**：`null` 表示用户还没选过，按 `resolveDefaultCal()` 兜。
   *
   * 以前「哪个是默认」是拿名字比的 —— `cal.name === '我的日程'`。那条判断
   * 会在**改名**那一刻失效：把默认的那个改名叫「工作」，它就不再是默认、
   * 就可以被删掉，于是用户可能把自己最后一个集删没了（不变量 1 只在登录 /
   * 退出 / 被踢时才由服务端的 `ensureHasCalendar` 兜回来）。反过来，别人建
   * 一个也叫「我的日程」的集并把你拉进去，你这个只读成员会看到「这是你的
   * 默认日程集，不能删除」—— 一句对不上的话。
   *
   * 现在它是一个**显式的 id**，改不改名都不影响。
   *
   * 为什么存本地而不是跟 `cals` 一起同步：`ui.cal`（当前看哪个集）本来就是
   * 本地偏好，见下面 `cal` 的注释。「打开哪个」和「现在看哪个」是同一类
   * 偏好，各设备不一样是合理的。要改成跨设备就得加 users 表的一列 +
   * 接口，那是另一件事，别顺手动。
   */
  defaultCal: string | null;
  /**
   * 移动端底栏成员，1–4 项，顺序同 `navOrder`。
   *
   * 「更多」恒占最后一格，所以总格数 ≤ 5 —— 这是 Apple HIG 对 tab bar 的
   * 2–5 项约束，不是随手定的。**设置不进这个列表**，理由同 `CUSTOMIZABLE`：
   * 它是唯一能改回这份列表的地方。
   */
  tabs: string[];
  tdoneOpen: boolean;
  /**
   * 多选模式的选中集合（2026-10-14）。
   *
   * `null` = 没在多选；数组 = 正在多选（可以是空数组 = 已进入但一条没选）。
   * 用 null 而不是「空数组」表示关闭，是因为两者含义不同：进多选那一刻
   * 一条都没选，这时不能当作「没在多选」。
   *
   * **瞬时状态**：它有值只在当前这一次浏览里有意义，跨刷新留着只会让用户
   * 一打开 App 就莫名其妙处在多选态（还会带上过期的 id）。
   * 所以 normalizeUi 每次加载都把它清成 null —— 见 model/ui.ts。
   */
  sel: string[] | null;
  /** 当前选中的日程集。本地偏好，各设备可以看不同的集 */
  cal: string | null;
  /**
   * 侧栏勾选显示哪些集。**只管显示，不管归属** —— 新建的东西永远落 `cal`。
   *
   * 它跟 `cal` 分开是因为两件事的粒度不同：`cal` 必须是**一个**（新任务得有个
   * 归属），而「我想同时看哪几个」可以是零到多个。
   *
   * `store.toggleCal()` 保证至少留一个勾着的（归属不能落在看不见的集里，
   * 否则新建的东西会「凭空消失」）。空数组只可能来自老数据或手改的
   * localStorage，读取时照样当「什么都不显示」，不崩。
   */
  cals: string[];
  /**
   * 日视图时间窗，只看 `[dayFrom, dayTo)` 这几个小时（整数小时，0–24）。
   *
   * 默认 0–24 = 整天。收窄之后时间轴按比例重排，**不滚动的日视图**因此还能
   * 保持每小时足够高 —— 见 domain/layout.ts 的 DayWindow。
   */
  dayFrom: number;
  dayTo: number;
}
