package space.xiaokubao.schedule;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 打卡小组件（2026-11-04 拆分，用户明确要求「打卡是打卡，日程是日程」）。
 *
 * 与 {@link ScheduleWidgetProvider} 的分工：
 *   · 日程组件 = 只有时间表（日期条 + 未定时区 + 时间轴），打卡区整体移除；
 *   · 本组件 = 只有打卡（今天的 chip 网格 + 筛选），没有任何任务。
 * 两者共用同一份数据快照（{@link WidgetPrefs#snapshot}）与同一套离线队列 /
 * 乐观更新 / 直连写机制（{@link WidgetApi}、{@link WidgetPrefs#mergeEntities}）。
 * 渲染工具（bgFor / withAlpha / Metrics / habitChip 等）直接复用日程那边的
 * 现成实现（同包、package-private），不复制第二份。
 *
 * ## 只看今天（用户 2026-11-04 定的口径）
 * 「桌面小组件是越简单越好」——不做日期翻阅、不做历史回看。打卡写入恒写
 * 实时今天（{@link WidgetPrefs#today}）。跨天不用等谁推送：每次重画都实时
 * 算日期；更新靠每日换日闹钟（日程组件的闹钟顺带刷本组件）+ App 推快照
 * + 右上角刷新按钮。
 *
 * ## 点击即打卡，不打开 App
 * 走广播 + 乐观更新三态（接受 / 拒绝 / 问不出去入队），与日程组件完全同一条路。
 * 见 {@link #toggleHabit}。
 *
 * ## 筛选（按组件实例，Android 本地存）
 * 右上角漏斗循环切换：全部 → 各分类 →（有未归类项时）未分类 → 未打 → 全部…
 * 只 **Android 本地按实例存**（{@link WidgetPrefs#filterOf}），理由：
 *   · 快照通道本来就是全局一份，任何全局持久化都要动服务端同步协议 —— 不值；
 *   · 「未打 / 未分类」这两个哨兵值在分类 id 空间里根本不存在，硬塞进服务端
 *     等于把客户端显示偏好伪装成共享数据。
 * 副作用要说清楚：launcher 在恢复组件时**可能换发新的 widget id**
 * （跨开机 / 换桌面），那时本实例的筛选回落到「全部」——不是 bug，是 id 的
 * 生命周期如此。
 *
 * ## 尺寸：默认 2×2，拖到 4×4（用户口径）
 * 见 res/xml/habit_widget_info.xml：minResize 110dp（≈2 格）起，
 * maxResize 265dp（≈4 格）封顶。渲染**不猜格数**，按 launcher 报的实际 dp
 * 反算每行几颗 chip（62dp 一颗：≈155dp 装 2 颗、≈188dp 装 3 颗、
 * ≈250dp 装 4 颗），所以 2×3 / 3×2 / 2×4 / 4×2 和中间任何连续尺寸都成立。
 * 字号锚点：chip 行高 18dp 是 8sp 字的舒展档，与日程组件的 16dp/8sp 同一密度。
 *
 * ## RemoteViews 老规矩（改之前看 ScheduleWidgetProvider 类注释）
 * 容器白名单、不能测量、接不到手势、透明度只能预烤 drawable。
 */
public class HabitWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "HabitWidget";

    /** 点打卡 chip */
    static final String ACTION_TOGGLE = "space.xiaokubao.schedule.HAB_TOGGLE";
    /** 右上角漏斗 /「+N」行：循环切筛选 */
    static final String ACTION_FILTER = "space.xiaokubao.schedule.HAB_FILTER";
    /** 「+N」↔「收起」：翻本实例的展开标记（复用 KEY_HABIT_EXPANDED——id 全局唯一，不会撞） */
    static final String ACTION_EXPAND = "space.xiaokubao.schedule.HAB_EXPAND";
    /** 右上角刷新：先补发离线队列，再直连拉一份新快照 */
    static final String ACTION_REFRESH = "space.xiaokubao.schedule.HAB_REFRESH";

    static final String EXTRA_ID = "id";
    /** 组件实例 id（chip 每行颗数按实例算，筛选也按实例存） */
    static final String EXTRA_WID = "wid";

    /** chip 行高基准（与日程组件的 HABIT_ROW_DP 同值，保证两组件同一视觉密度） */
    private static final int HABIT_ROW_DP = 18;
    /** 一颗 chip 的实用宽度 ≈ 62dp（8sp 字 + 两侧 margin），155dp→2、188dp→3、250dp→4 */
    private static final int CHIP_CELL_DP = 62;
    /** 顶栏（徽标行 + 筛选提示行）未缩放高度：30 + 2 + 14 */
    private static final int HEAD_BLOCK_DP = 46;

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        // App 推数据 / 系统重建组件都会走到这。顺手补发离线期间攒的改动 ——
        // 此刻用户刚打开过 App，票是新的，推最可能成功（与日程组件同款）
        ScheduleWidgetProvider.flushPending(c);
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        for (int id : ids) render(c, mgr, id, snap);
    }

    /** 用户拖动把手改了尺寸——launcher 只发这个回调，必须在这里重画（日程组件踩过这坑） */
    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager mgr,
                                          int widgetId, Bundle newOptions) {
        if (Log.isLoggable(TAG, Log.DEBUG)) {
            Log.d(TAG, "onAppWidgetOptionsChanged id=" + widgetId
                    + " minW=" + (newOptions == null ? -1
                        : newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH))
                    + " minH=" + (newOptions == null ? -1
                        : newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)));
        }
        render(c, mgr, widgetId, WidgetPrefs.snapshot(c));
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        final String a = intent.getAction();
        if (ACTION_TOGGLE.equals(a)) {
            // 只看今天 → 恒写实时今天，不存在「翻到别的日子点错」的问题
            toggleHabit(c, intent.getStringExtra(EXTRA_ID), WidgetPrefs.today(c));
        } else if (ACTION_FILTER.equals(a)) {
            int wid = intent.getIntExtra(EXTRA_WID, -1);
            if (wid >= 0) cycleFilter(c, wid);
        } else if (ACTION_EXPAND.equals(a)) {
            int wid = intent.getIntExtra(EXTRA_WID, -1);
            if (wid >= 0) {
                WidgetPrefs.setHabitsExpanded(c, wid, !WidgetPrefs.habitsExpanded(c, wid));
            }
        } else if (ACTION_REFRESH.equals(a)) {
            doRefresh(c);
            return;   // doRefresh 自己负责重画，不再走下面的公共刷新
        }
        // 其余动作（App 推来的 ACTION_APPWIDGET_UPDATE 等）落到下面的公共刷新，
        // 与日程组件 onReceive 的同一条兜底路径

        // 与日程组件同款：点完顺手把攒着没发的补一次（限流一分钟）
        if (WidgetPrefs.hasPending(c)
                && System.currentTimeMillis() - lastFlushAt > ScheduleWidgetProvider.FLUSH_MIN_GAP_MS) {
            lastFlushAt = System.currentTimeMillis();
            ScheduleWidgetProvider.flushPending(c);
        }
        refresh(c);
    }

    private static long lastFlushAt = 0;

    /* ============================ 渲染 ============================ */

    /** 重画本 provider 的全部实例（尺寸可能各不相同，逐个渲染） */
    static void refresh(Context c) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            int[] ids = mgr.getAppWidgetIds(
                    new android.content.ComponentName(c, HabitWidgetProvider.class));
            if (ids == null || ids.length == 0) return;
            WidgetSnapshot snap = WidgetPrefs.snapshot(c);
            for (int id : ids) render(c, mgr, id, snap);
        } catch (Exception e) {
            Log.w(TAG, "重画失败: " + e);
        }
    }

    private static void render(Context c, AppWidgetManager mgr, int widgetId,
                               WidgetSnapshot snap) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_habit);
        final int alpha = WidgetPrefs.alpha(c);
        v.setInt(R.id.habit_root, "setBackgroundResource", ScheduleWidgetProvider.bgFor(c, alpha));

        final String today = WidgetPrefs.today(c);   // 实时今天（快照 today 可能过期，不用它）

        Bundle o = options(mgr, widgetId);
        int wDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        if (wDp <= 0) wDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
        if (wDp <= 0) wDp = 124;                     // launcher 没报时的 2×2 缺省
        int hDp = ScheduleWidgetProvider.widgetHeightDp(c, mgr, widgetId);

        /* 每行几颗：按实测宽度反算，不猜格数（各家 launcher 一格多少 dp 不统一，
           计数器组件 2026-10-26 就定过这条「按宽高而不是格数」的规矩）。 */
        int perRow = wDp >= 4 * CHIP_CELL_DP ? 4
                : (wDp >= 3 * CHIP_CELL_DP ? 3 : 2);

        /* ---- 筛选（按实例）---- */
        String filter = WidgetPrefs.filterOf(c, widgetId);
        boolean filterable = !snap.habits.isEmpty();
        List<WHabit> shown = applyFilter(snap, filter, today);

        /* ---- 缩放系数 ----
           竖向可用高度 = 组件总高 − 顶栏 − padding。chip 行高基准 18dp，
           8.5 行 ≈ 153dp 是「2×3 竖满」的舒展档（锚点 1.0）。 */
        int rowsFit = Math.max(1, (hDp - 10 - HEAD_BLOCK_DP) / HABIT_ROW_DP);
        float sizeK = Math.max(0.75f, Math.min(2.0f, rowsFit / 8.5f));
        float k = sizeK * (WidgetPrefs.fontScale(c) / 100f);
        ScheduleWidgetProvider.Metrics m = new ScheduleWidgetProvider.Metrics(k);

        int fixedDp = 8 + 2 + m.headRow + 2 + Metrics.px(14, k);   // padding上8 + 顶栏 + margin + 提示行

        /* ---- 顶栏：日历徽标（今天几号）+ 月份 + 漏斗 + 刷新 ---- */
        v.setViewLayoutHeight(R.id.hab_head, m.headRow, TypedValue.COMPLEX_UNIT_DIP);
        v.setTextViewText(R.id.hab_logo_day, today.substring(8, 10));
        v.setTextViewText(R.id.hab_month, cnMonth(today));
        ScheduleWidgetProvider.scaleView(v, R.id.hab_logo, 26, k);
        ScheduleWidgetProvider.scaleView(v, R.id.hab_filter_btn, 26, k);
        ScheduleWidgetProvider.scaleView(v, R.id.hab_refresh_btn, 26, k);
        ScheduleWidgetProvider.font(v, R.id.hab_logo_day, 10, k);
        ScheduleWidgetProvider.font(v, R.id.hab_month, 15, k);

        // 漏斗的视觉状态：非「全部」时换激活档图标。RemoteViews 接不到
        // setColorFilter（View.setColorFilter 没有 @RemotableViewMethod，反射会抛
        // ActionException —— 正是本组件类注释里那条老规矩），所以预烤两张
        // ic_filter / ic_filter_on 换 src，与 widget_bg_a* 透明度档位同一个思路。
        v.setImageViewResource(R.id.hab_filter_btn,
                isPlainAll(filter) ? R.drawable.ic_filter : R.drawable.ic_filter_on);
        String label = filterLabel(filter, snap);
        v.setTextViewText(R.id.hab_filter_hint, label);
        ScheduleWidgetProvider.font(v, R.id.hab_filter_hint, 8, k);
        v.setViewVisibility(R.id.hab_filter_hint,
                filterable && !label.isEmpty() ? View.VISIBLE : View.INVISIBLE);

        if (filterable) {
            PendingIntent fpi = WidgetIntent
                    .of(c, HabitWidgetProvider.class, WidgetIntent.CODE_SALT_HABIT,
                            ACTION_FILTER, "f" + widgetId)
                    .put(EXTRA_WID, widgetId).build(c);
            v.setOnClickPendingIntent(R.id.hab_filter_btn, fpi);
            v.setOnClickPendingIntent(R.id.hab_filter_hint, fpi);
        } else {
            // 没有任何可筛的维度（还没有打卡项）：漏斗点了没反应是静默，藏掉
            v.setViewVisibility(R.id.hab_filter_btn, View.INVISIBLE);
        }
        v.setOnClickPendingIntent(R.id.hab_refresh_btn, WidgetIntent
                .of(c, HabitWidgetProvider.class, WidgetIntent.CODE_SALT_HABIT,
                        ACTION_REFRESH, "r" + widgetId).build(c));
        // 徽标不可点：组件恒显今天，没有「回今天」这回事

        /* ---- 打卡区：有分类数据就带组头（与 App 打卡页同一视觉语言）---- */
        v.removeAllViews(R.id.hab_rows);
        boolean grouped = !snap.groups.isEmpty();
        if (shown.isEmpty()) {
            RemoteViews empty = new RemoteViews(c.getPackageName(), R.layout.widget_habit_head);
            // shown 为空只有两种来路：整个账号还没有打卡项；或有打卡项但当前
            // 筛选（多半是「未打」）下一条都不剩
            empty.setTextViewText(R.id.habit_head,
                    snap.habits.isEmpty() ? "还没有打卡项，打开 App 加一个"
                                          : "这个筛选下没有要打的 ✓");
            ScheduleWidgetProvider.font(empty, R.id.habit_head, 8, k);
            v.addView(R.id.hab_rows, empty);
        } else {
            java.util.Map<String, List<WHabit>> buckets = new java.util.LinkedHashMap<>();
            List<WHabit> ungroupedIn = new ArrayList<>();
            if (grouped) {
                for (WGroup g : snap.groups) buckets.put(g.id, new ArrayList<>());
                for (WHabit h : shown) {
                    List<WHabit> b = h.groupId == null ? null : buckets.get(h.groupId);
                    if (b == null) ungroupedIn.add(h);
                    else b.add(h);
                }
            }
            /* 行计划：rows / rowDp / rowChips 一一对应（颗数记账，「+N」的 N 靠它） */
            List<RemoteViews> rows = new ArrayList<>();
            List<Integer> rowDp = new ArrayList<>();
            List<Integer> rowChips = new ArrayList<>();
            if (grouped) {
                for (WGroup g : snap.groups) {
                    List<WHabit> b = buckets.get(g.id);
                    if (b == null || b.isEmpty()) continue;   // 空组不占地方
                    rows.add(ScheduleWidgetProvider.habitHead(c, g.name, k));
                    rowDp.add(m.habitHead);
                    rowChips.add(0);
                    addRows(c, rows, rowDp, rowChips, b, today, k, perRow, m);
                }
                if (!ungroupedIn.isEmpty()) {
                    rows.add(ScheduleWidgetProvider.habitHead(c, "未分类", k));
                    rowDp.add(m.habitHead);
                    rowChips.add(0);
                    addRows(c, rows, rowDp, rowChips, ungroupedIn, today, k, perRow, m);
                }
            } else {
                addRows(c, rows, rowDp, rowChips, shown, today, k, perRow, m);
            }

            /* 高度装不下就折：能塞几行塞几行，尾行给一颗「+N」（点了展开，
               展开态尾部给「收起」）。与日程组件 2026-11-03 的折叠同款。 */
            int avail = Math.max(2 * m.habitRow, hDp - fixedDp);
            int need = 0;
            for (int d : rowDp) need += d;
            boolean expanded = WidgetPrefs.habitsExpanded(c, widgetId);
            int shownRows = rows.size();

            if (need > avail && !expanded) {
                int acc = 0;
                shownRows = 0;
                for (int i = 0; i < rows.size(); i++) {
                    if (acc + rowDp.get(i) > avail) break;
                    acc += rowDp.get(i);
                    shownRows++;
                }
                // 「+N」自己也要占一行：最后一行装不下它就让位
                if (shownRows > 0 && acc + m.habitRow > avail) {
                    acc -= rowDp.get(shownRows - 1);
                    shownRows--;
                }
                int hidden = shown.size() - chipsIn(rowChips, shownRows);
                if (shownRows < rows.size()) {
                    rows.add(toggleRow(c, widgetId, "+" + hidden, k, perRow));
                    rowDp.add(m.habitRow);
                    rowChips.add(0);
                    shownRows++;                      // toggle 行自己也要上屏
                }
            } else if (need > avail) {   // 展开态：尾部给一颗「收起」
                rows.add(toggleRow(c, widgetId, "收起", k, perRow));
                shownRows = rows.size();
            }

            for (int i = 0; i < shownRows; i++) v.addView(R.id.hab_rows, rows.get(i));
        }

        // chip 区底色跟着透明度走（纯色，无圆角描边——与日程组件同款）
        v.setInt(R.id.hab_rows, "setBackgroundColor",
                ScheduleWidgetProvider.withAlpha(0xFFE7F3EA, alpha));

        mgr.updateAppWidget(widgetId, v);
    }

    /** 前 n 行里实际画了几颗 chip（组头行记 0，「+N」行记 0） */
    private static int chipsIn(List<Integer> rowChips, int n) {
        int sum = 0;
        for (int i = 0; i < Math.min(n, rowChips.size()); i++) sum += rowChips.get(i);
        return sum;
    }

    /** 把一批打卡项按每行 perRow 颗折成 chip 行（不满补占位，否则末行格子被均分放大——踩过） */
    private static void addRows(Context c, List<RemoteViews> rows, List<Integer> rowDp,
                                List<Integer> rowChips, List<WHabit> list, String today,
                                float k, int perRow, ScheduleWidgetProvider.Metrics m) {
        for (int i = 0; i < list.size(); i += perRow) {
            RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_habit_row);
            int real = 0;
            for (int kk = i; kk < i + perRow; kk++) {
                if (kk < list.size()) {
                    PendingIntent pi = WidgetIntent
                            .of(c, HabitWidgetProvider.class, WidgetIntent.CODE_SALT_HABIT,
                                  ACTION_TOGGLE, "t" + list.get(kk).id)
                            .put(EXTRA_ID, list.get(kk).id).build(c);
                    row.addView(R.id.habit_row,
                            ScheduleWidgetProvider.habitChip(c, list.get(kk), today, today, k, pi));
                    real++;
                } else {
                    row.addView(R.id.habit_row, ScheduleWidgetProvider.emptyChip(c));
                }
            }
            rows.add(row);
            rowDp.add(m.habitRow);
            rowChips.add(real);
        }
    }

    /** 「+N」/「收起」那一行：一颗主绿字的 chip + 占位，点了翻本实例的展开标记 */
    private static RemoteViews toggleRow(Context c, int widgetId, String label, float k, int perRow) {
        RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_habit_row);
        RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_habit_chip);
        chip.setTextViewText(R.id.habit_chip, label);
        chip.setInt(R.id.habit_chip, "setBackgroundResource", 0);
        chip.setTextColor(R.id.habit_chip, 0xFF27795A);
        ScheduleWidgetProvider.font(chip, R.id.habit_chip, 8, k);
        chip.setOnClickPendingIntent(R.id.habit_chip, WidgetIntent
                .of(c, HabitWidgetProvider.class, WidgetIntent.CODE_SALT_HABIT,
                        ACTION_EXPAND, "e" + widgetId)
                .put(EXTRA_WID, widgetId).build(c));
        row.addView(R.id.habit_row, chip);
        for (int p = 1; p < perRow; p++) row.addView(R.id.habit_row, ScheduleWidgetProvider.emptyChip(c));
        return row;
    }

    /* ============================ 筛选 ============================ */

    /**
     * 漏斗一次点击 = 沿「全部 → 分类1 → … → 未分类* → 未打 → 全部」走一格
     * （* 仅当存在没归类的打卡项；没有分类数据时只有「全部 ↔ 未打」两格）。
     * 分类顺序 = 快照 groups 的 order 序（App 与服务端同一口径）。
     */
    private static void cycleFilter(Context c, int wid) {
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        boolean ungrouped = habitsUngrouped(snap);
        String cur = WidgetPrefs.filterOf(c, wid);
        String next;
        if (isPlainAll(cur)) {
            next = snap.groups.isEmpty() ? WidgetPrefs.FILTER_UNDONE
                    : snap.groups.get(0).id;
        } else if (WidgetPrefs.FILTER_UNDONE.equals(cur)) {
            next = WidgetPrefs.FILTER_ALL;
        } else if (WidgetPrefs.FILTER_UNGROUPED.equals(cur)) {
            next = WidgetPrefs.FILTER_UNDONE;
        } else {
            int i = indexOfGroup(snap, cur);
            if (i < 0) {                       // 分类被删了 → 跳到下一站别卡死
                next = ungrouped ? WidgetPrefs.FILTER_UNGROUPED : WidgetPrefs.FILTER_UNDONE;
            } else if (i + 1 < snap.groups.size()) {
                next = snap.groups.get(i + 1).id;
            } else {
                next = ungrouped ? WidgetPrefs.FILTER_UNGROUPED : WidgetPrefs.FILTER_UNDONE;
            }
        }
        WidgetPrefs.setFilter(c, wid, next);
    }

    private static boolean isPlainAll(String f) {
        return f == null || f.isEmpty() || WidgetPrefs.FILTER_ALL.equals(f);
    }

    /** 悬空引用（groupId 指向已删分类）也算「未分类」，与渲染层同一裁决 */
    private static boolean habitsUngrouped(WidgetSnapshot snap) {
        for (WHabit h : snap.habits) {
            boolean known = false;
            for (WGroup g : snap.groups) if (g.id.equals(h.groupId)) { known = true; break; }
            if (!known) return true;
        }
        return false;
    }

    private static int indexOfGroup(WidgetSnapshot snap, String id) {
        for (int i = 0; i < snap.groups.size(); i++) if (snap.groups.get(i).id.equals(id)) return i;
        return -1;
    }

    private static List<WHabit> applyFilter(WidgetSnapshot snap, String filter, String today) {
        List<WHabit> out = new ArrayList<>();
        boolean undone = WidgetPrefs.FILTER_UNDONE.equals(filter);
        boolean byGroup = !isPlainAll(filter) && !undone
                && !WidgetPrefs.FILTER_UNGROUPED.equals(filter);
        for (WHabit h : snap.habits) {
            if (byGroup) {
                // 指定分类：悬空 id（分类已删）不匹配任何组 → 不出现在该组的筛选里
                if (!filter.equals(h.groupId)) continue;
            } else if (WidgetPrefs.FILTER_UNGROUPED.equals(filter)) {
                // 「未分类」站：只留真正没归类的（含悬空引用）
                boolean known = false;
                for (WGroup g : snap.groups) if (g.id.equals(h.groupId)) { known = true; break; }
                if (known) continue;
            }
            if (undone && h.log != null && h.log.optBoolean(today, false)) continue;
            out.add(h);
        }
        return out;
    }

    /** 顶栏下方那行小字：当前筛选的中文名（「全部」时留空，不占视觉） */
    private static String filterLabel(String filter, WidgetSnapshot snap) {
        if (isPlainAll(filter)) return "";
        if (WidgetPrefs.FILTER_UNDONE.equals(filter)) return "筛选：未打";
        if (WidgetPrefs.FILTER_UNGROUPED.equals(filter)) return "筛选：未分类";
        for (WGroup g : snap.groups) if (g.id.equals(filter)) return "筛选：" + g.name;
        return "筛选：（分类已删除）";
    }

    private static String cnMonth(String todayIso) {
        int m;
        try { m = Integer.parseInt(todayIso.substring(5, 7)); } catch (Exception e) { return ""; }
        String[] cn = {"一月", "二月", "三月", "四月", "五月", "六月",
                       "七月", "八月", "九月", "十月", "十一月", "十二月"};
        return (m >= 1 && m <= 12) ? cn[m - 1] : m + "月";
    }

    /* ============================ 打卡 / 刷新（复用日程那套） ============================ */

    /** 三态乐观更新——完整口径见 ScheduleWidgetProvider 原 toggleHabit 的注释（已迁移至此） */
    private static void toggleHabit(Context c, String habitId, String today) {
        if (habitId == null || habitId.isEmpty()) return;
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        WHabit target = snap.habitById(habitId);
        if (target == null) return;

        final boolean on = !(target.log != null && target.log.optBoolean(today, false));
        // 新意图作废旧意图（2026-10-26 教训）：队列里同一格的老操作先丢掉
        WidgetPrefs.dropQueuedHabit(c, habitId, today);

        // ① 乐观更新 + 立刻重绘。写的是 log 里那一天，与渲染取值口径一致
        try {
            JSONObject log = target.log == null
                    ? new JSONObject() : new JSONObject(target.log.toString());
            if (on) log.put(today, true);
            else log.remove(today);
            JSONObject f = new JSONObject();
            f.put("log", log);
            f.put("done", on);   // 组件只写今天，done 恒跟得上
            WidgetPrefs.patchEntity(c, "habits", habitId, f, false);
        } catch (Exception ignored) {
        }
        refresh(c);

        // ② 直连。必须拿着完整 log 表才敢写（applyOps 整值替换，半张表会抹掉历史）
        if (!WidgetPrefs.canDirect(c) || target.log == null) {
            enqueueHabit(c, habitId, today, on);
            return;
        }
        try {
            JSONArray ops = new JSONArray();
            JSONObject op = new JSONObject();
            op.put("entity", "habit");
            op.put("entityId", habitId);
            op.put("calId", target.calId);
            JSONObject log = new JSONObject(target.log.toString());
            if (on) log.put(today, true);
            else log.remove(today);
            JSONObject fields = new JSONObject();
            fields.put("log", log);
            op.put("fields", fields);
            ops.put(op);

            WidgetApi.op(c, ops, new WidgetApi.OpCallback() {
                @Override
                public void onAccepted(JSONObject body) {
                    // 只同步这一条：整表替换会把还没发出去的乐观改动抹掉
                    WidgetPrefs.mergeEntities(c, body, "habits",
                            java.util.Collections.singletonList(habitId));
                    refresh(c);
                }

                @Override
                public void onRejected(JSONObject body, String why) {
                    // 服务端不答应 → 回到它返回的真相
                    WidgetPrefs.mergeEntities(c, body, "habits",
                            java.util.Collections.singletonList(habitId));
                    refresh(c);
                    Ui.toast(c, "这次打卡服务端没有接受");
                }

                @Override
                public void onUnreachable(String why) {
                    // 离线/问不出去 → 保留本地结果，入队等下次
                    enqueueHabit(c, habitId, today, on);
                }
            });
        } catch (Exception e) {
            enqueueHabit(c, habitId, today, on);
        }
    }

    private static void enqueueHabit(Context c, String habitId, String today, boolean on) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "habit");
            op.put("habitId", habitId);
            op.put("date", today);
            op.put("on", on);
            WidgetPrefs.enqueuePending(c, op);
        } catch (Exception ignored) {
        }
    }

    /** 刷新按钮：先补发离线队列再拉新快照（顺序不能反，反了会把刚勾的盖掉——同款教训） */
    private static void doRefresh(Context c) {
        ScheduleWidgetProvider.flushPending(c);
        WidgetApi.bootstrap(c, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                WidgetPrefs.replaceSnapshot(c, body);
                refresh(c);
            }

            @Override
            public void onFail(String why) {
                refresh(c);   // 拉不动也重画：本地乐观状态先保着
            }
        });
    }

    private static Bundle options(AppWidgetManager mgr, int widgetId) {
        try {
            Bundle o = mgr.getAppWidgetOptions(widgetId);
            return o == null ? new Bundle() : o;
        } catch (Exception e) {
            return new Bundle();
        }
    }

    /** Metrics.px 是嵌套类里的 static，起个本地别名免得每处写全名 */
    private static final class Metrics {
        static int px(int base, float k) {
            return ScheduleWidgetProvider.Metrics.px(base, k);
        }
    }
}
