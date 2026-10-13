package space.xiaokubao.schedule;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 日程小组件。
 *
 * **只看单日**（用户 2026-10-13 明确）：顶部的日期条是选择器，不是把 7 天
 * 平铺开。选了哪天，下面就只画那天的定时任务。日期条一行装着**一周七天**，
 * 左右箭头按**周**翻（不是按月 —— 用户明确要求过）。
 *
 * 交互全部走广播回到这里处理（{@code PendingIntent.getBroadcast}），
 * 不启动 Activity —— 除了几个确实需要表单/表盘的地方（任务详情、新建、
 * 设置），那几个用对话框主题的 Activity，观感是弹窗而不是「打开 App」。
 *
 * ⚠️ RemoteViews 的限制（踩过的坑，改之前先看）：
 *   1. 容器只能是 FrameLayout / LinearLayout / RelativeLayout / GridLayout。
 *      用了 ScrollView 之类，**launcher inflate 时直接抛异常**，组件变成一块
 *      「载入窗口小部件时出现问题」的空板，而应用侧一条日志都没有。
 *      ⇒ 所以「时间轴看不到更晚的小时」**不能**靠加 ScrollView 解决，
 *        见 {@link #planRows}　那一带的翻页方案。
 *   2. 不能自定义 View、不能测量宽高。所以行高只能按档位选布局文件，
 *      不能真正「自适应」。
 *   3. 动态加子视图只能「按布局文件加」，不能凭空造容器 —— 想要多行就得
 *      有一个「行容器」的布局文件（见 widget_habit_row.xml）。
 *   4. 只有标了 {@code @RemotableViewMethod} 的方法能通过 setInt/setFloat
 *      反射调用。{@code View.setAlpha(float)} **没有**这个标注，所以透明度
 *      只能预先做成几档 drawable 来切 —— 见 {@link #bgFor}。
 *   5. 接不到手势。手指滑动、长按、双击一概做不到，只能靠点击。
 */
public class ScheduleWidgetProvider extends AppWidgetProvider {

    static final String ACTION_PICK_DAY = "space.xiaokubao.schedule.PICK_DAY";
    /** 左右箭头：按**周**翻（delta 单位是周，不是月） */
    static final String ACTION_WEEK = "space.xiaokubao.schedule.WEEK";
    static final String ACTION_TASK = "space.xiaokubao.schedule.TASK";
    static final String ACTION_HABIT = "space.xiaokubao.schedule.HABIT";
    static final String ACTION_ADD = "space.xiaokubao.schedule.ADD";
    static final String ACTION_SETTINGS = "space.xiaokubao.schedule.SETTINGS";
    /** 点左上角标识 = 回到今天 */
    static final String ACTION_TODAY = "space.xiaokubao.schedule.TODAY";
    /** 时间轴翻页：看更早 / 更晚的小时 */
    static final String ACTION_SCROLL = "space.xiaokubao.schedule.SCROLL";

    static final String EXTRA_DAY = "day";
    static final String EXTRA_DELTA = "delta";
    static final String EXTRA_ID = "id";
    /**
     * 翻页步长（= 一屏行数）。由渲染时算好塞进 PendingIntent ——
     * onReceive 里拿不到组件尺寸，算不出这个数。
     */
    static final String EXTRA_PAGE = "page";

    /** 打卡区每行放几个。用户要「每行 2-3 个、分 2-3 行」 */
    private static final int HABITS_PER_ROW = 3;

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        // App 每次推刷新都会走到这儿。顺手把离线期间攒的改动补发一次 ——
        // 用户刚打开过 App，票是新的，此刻推最可能成功。
        flushPending(c);
        // 快照只解析一次：以前每个实例各解析一遍，多实例时纯浪费
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        String day = WidgetPrefs.selectedDay(c);
        for (int id : ids) render(c, mgr, id, snap, day);
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        final String a = intent.getAction();
        if (ACTION_PICK_DAY.equals(a)) {
            WidgetPrefs.setSelectedDay(c, intent.getStringExtra(EXTRA_DAY));
        } else if (ACTION_TODAY.equals(a)) {
            // 回今天：**清掉选中日而不是写成今天** —— 存了「今天」之后
            // 跨天了那个值就是昨天，反而更绕。没值时 selectedDay() 自然用今天。
            WidgetPrefs.clearSelectedDay(c);
        } else if (ACTION_WEEK.equals(a)) {
            int delta = intent.getIntExtra(EXTRA_DELTA, 1);
            WidgetPrefs.setSelectedDay(c, addDays(WidgetPrefs.selectedDay(c), delta * 7));
        } else if (ACTION_SCROLL.equals(a)) {
            scroll(c, intent.getIntExtra(EXTRA_DELTA, 1), intent.getIntExtra(EXTRA_PAGE, 1));
        } else if (ACTION_TASK.equals(a)) {
            TaskDetailActivity.start(c, intent.getStringExtra(EXTRA_ID));
            return;
        } else if (ACTION_ADD.equals(a)) {
            CreateTaskActivity.start(c, WidgetPrefs.selectedDay(c));
            return;
        } else if (ACTION_SETTINGS.equals(a)) {
            WidgetSettingsActivity.start(c);
            return;
        } else if (ACTION_HABIT.equals(a)) {
            toggleHabit(c, intent.getStringExtra(EXTRA_ID));
        }

        // 顺手把攒着没发出去的改动补一次 —— 用户此刻正在看桌面，是票最新、
        // 最可能推成功的时候。以前只有 onUpdate 才补发，所以积压的队列
        // 要一直等到 App 推刷新才动，footer 上那个「N 待同步」永远不降。
        // 限流一分钟：失败时每次点击都重发上百条 op 太费电。
        if (WidgetPrefs.hasPending(c)
                && System.currentTimeMillis() - lastFlushAt > FLUSH_MIN_GAP_MS) {
            lastFlushAt = System.currentTimeMillis();
            flushPending(c);
        }

        refresh(c);
    }

    /** 上次尝试补发的时间戳 + 最小间隔，见 onReceive 里的限流说明 */
    private static long lastFlushAt = 0;
    private static final long FLUSH_MIN_GAP_MS = 60_000;

    /** 广播给所有实例重画 */
    static void refresh(Context c) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(c);
        int[] ids = mgr.getAppWidgetIds(new android.content.ComponentName(c, ScheduleWidgetProvider.class));
        if (ids == null || ids.length == 0) return;
        // 逐个渲染而不是批量 updateAppWidget(ids, v) —— 每个实例的尺寸可能
        // 不同（用户能各自拖大拖小），行高档位要按各自的 options 算
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        String day = WidgetPrefs.selectedDay(c);
        for (int id : ids) render(c, mgr, id, snap, day);
    }

    /* ============================ 渲染 ============================ */

    private static void render(Context c, AppWidgetManager mgr, int widgetId,
                               WidgetSnapshot snap, String day) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_schedule);
        // 「今天」优先用快照里那个（来自服务端）—— 手机时钟/时区不准时，
        // 自己算出来的今天会跟服务端差一天，打卡就写到隔壁去了。
        String today = (snap.today != null && !snap.today.isEmpty())
                ? snap.today : WidgetPrefs.today(c);

        // 底板透明度：四档预置 drawable 里挑一张（原因见类注释第 4 条）
        final int alpha = WidgetPrefs.alpha(c);
        v.setInt(R.id.widget_root, "setBackgroundResource", bgFor(alpha));

        String monday = mondayOf(day);
        v.setTextViewText(R.id.tv_month, weekTitle(monday, addDays(monday, 6)));

        /* ---- 日期条：选中日所在的那一周 ---- */
        v.removeAllViews(R.id.date_strip);
        for (int i = 0; i < 7; i++) {
            String iso = addDays(monday, i);
            RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_day_chip);
            boolean sel = iso.equals(day);
            boolean isToday = iso.equals(today);
            chip.setTextViewText(R.id.chip_wd, WD[i]);
            chip.setTextViewText(R.id.chip_date, dayOfMonth(iso));
            chip.setInt(R.id.chip_root, "setBackgroundResource",
                    sel ? R.drawable.widget_chip_bg_sel : R.drawable.widget_chip_bg);
            chip.setTextColor(R.id.chip_wd, sel ? 0xBFFFFFFF : 0xFF6B8574);
            // 今天那格即使没选中也用主绿写字，一眼能找到
            chip.setTextColor(R.id.chip_date,
                    sel ? 0xFFFFFFFF : (isToday ? 0xFF27795A : 0xFF1B3A2A));
            chip.setOnClickPendingIntent(R.id.chip_root,
                    WidgetIntent.of(c, ACTION_PICK_DAY, iso).put(EXTRA_DAY, iso).build(c));
            v.addView(R.id.date_strip, chip);
        }

        /* ---- 打卡区：每行 HABITS_PER_ROW 个，自动折行 ----
           完成态**只用一个信号**：整格变实心主绿 + 白字。
           以前还在文字前加「✓」，跟底色变化是同一件事说两遍 ——
           而且 chip 变宽会挤动排布，正是上一版「打卡项消失」的病根。 */
        v.removeAllViews(R.id.habit_rows);
        if (snap.habits.isEmpty()) {
            v.setViewVisibility(R.id.habit_rows, View.GONE);
        } else {
            v.setViewVisibility(R.id.habit_rows, View.VISIBLE);
            // 打卡条的底色跟着透明度走（这里没有圆角/描边，能直接用纯色）
            v.setInt(R.id.habit_rows, "setBackgroundColor", withAlpha(0xFFE7F3EA, alpha));
            int n = snap.habits.size();
            for (int i = 0; i < n; i += HABITS_PER_ROW) {
                RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_habit_row);
                for (int k = i; k < i + HABITS_PER_ROW; k++) {
                    boolean real = k < n;
                    RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_habit_chip);
                    if (!real) {
                        // 不满一行时补占位，让已有那几个的宽度跟满行一致 ——
                        // 不补的话最后一行两个格子各占一半，看着像放大了
                        chip.setTextViewText(R.id.habit_chip, "");
                        chip.setInt(R.id.habit_chip, "setBackgroundResource", 0);
                        row.addView(R.id.habit_row, chip);
                        continue;
                    }
                    WHabit h = snap.habits.get(k);
                    chip.setTextViewText(R.id.habit_chip, h.title);
                    chip.setInt(R.id.habit_chip, "setBackgroundResource",
                            h.done ? R.drawable.widget_habit_bg_done : R.drawable.widget_habit_bg);
                    chip.setTextColor(R.id.habit_chip, h.done ? 0xFFFFFFFF : 0xFF1B3A2A);
                    chip.setOnClickPendingIntent(R.id.habit_chip,
                            WidgetIntent.of(c, ACTION_HABIT, "h" + h.id).put(EXTRA_ID, h.id).build(c));
                    row.addView(R.id.habit_row, chip);
                }
                v.addView(R.id.habit_rows, row);
            }
        }

        /* ---- 时间轴 ---- */
        List<WTask> dayTasks = snap.tasksOf(day);
        List<WTask> timed = new ArrayList<>();
        List<WTask> untimed = new ArrayList<>();
        for (WTask t : dayTasks) {
            if (t.time == null) untimed.add(t);
            else timed.add(t);
        }

        int lo = WidgetPrefs.startHour(c);
        int hi = WidgetPrefs.endHour(c);
        int hourRows = hi - lo + 1;
        // 「未定时」那段算作时间轴的最后一行，一起参与分页 —— 这样它不会
        // 因为翻页落到组件外面去（上一版它永远吊在底部，翻页后反而容易丢）
        int totalRows = hourRows + (untimed.isEmpty() ? 0 : 1);

        int habitRows = snap.habits.isEmpty() ? 0
                : (snap.habits.size() + HABITS_PER_ROW - 1) / HABITS_PER_ROW;
        RowPlan plan = planRows(mgr, widgetId, totalRows, habitRows);

        final boolean paging = plan.perPage < totalRows;
        int top = 0;
        int bottom = totalRows - 1;
        if (paging) {
            top = Math.max(0, Math.min(totalRows - plan.perPage, WidgetPrefs.viewTop(c)));
            bottom = Math.min(top + plan.perPage - 1, totalRows - 1);
        }

        v.removeAllViews(R.id.hour_rows);
        boolean isToday = day.equals(today);
        int nowHour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        for (int i = top; i <= bottom; i++) {
            drawHourRow(c, v, plan.layout, i, lo, hourRows, timed, untimed, isToday, nowHour);
        }

        if (paging) {
            v.setViewVisibility(R.id.scroll_col, View.VISIBLE);
            // 到头了把箭头**变淡**而不是隐藏 —— 隐藏会让布局跳动，用户也看不出
            // 「到底是到头了还是根本没这功能」
            boolean atTop = top <= 0;
            boolean atBottom = bottom >= totalRows - 1;
            v.setTextColor(R.id.btn_scroll_up, atTop ? DIM : GREEN);
            v.setTextColor(R.id.btn_scroll_down, atBottom ? DIM : GREEN);
            v.setOnClickPendingIntent(R.id.btn_scroll_up,
                    WidgetIntent.of(c, ACTION_SCROLL, "sc-up")
                            .put(EXTRA_DELTA, -1).put(EXTRA_PAGE, plan.perPage).build(c));
            v.setOnClickPendingIntent(R.id.btn_scroll_down,
                    WidgetIntent.of(c, ACTION_SCROLL, "sc-down")
                            .put(EXTRA_DELTA, 1).put(EXTRA_PAGE, plan.perPage).build(c));
        } else {
            v.setViewVisibility(R.id.scroll_col, View.GONE);
        }

        /* ---- 底部状态 ---- */
        int pend = WidgetPrefs.pendingCount(c);
        StringBuilder foot = new StringBuilder();
        if (dayTasks.isEmpty() && snap.habits.isEmpty()) {
            foot.append("还没有数据，打开 App 同步一下");
        } else if (dayTasks.isEmpty()) {
            foot.append("这天没有安排");
        } else {
            foot.append(dayTasks.size()).append(" 项");
        }
        if (paging) {
            // 翻页时把「现在看的是哪一段」写出来，否则用户不知道还能往哪翻
            foot.append(" · ").append(Math.min(lo + top, hi))
                    .append("–").append(Math.min(lo + bottom, hi)).append(" 时");
        }
        // 时间在 [lo, hi] 之外的任务**一行都画不出来**（时间轴没有那一行）。
        // 不提示的话它们等于被静默吞掉，用户只会觉得「我明明记了」。
        int outside = 0;
        for (WTask t : timed) {
            int h = startHour(t);
            if (h < lo || h > hi) outside++;
        }
        if (outside > 0) foot.append(" · ").append(outside).append(" 项在范围外");
        foot.append(" · 更新 ").append(clockOf(snap.at));
        if (pend > 0) foot.append(" · ").append(pend).append(" 待同步");
        v.setTextViewText(R.id.tv_footer, foot.toString());
        v.setViewVisibility(R.id.tv_footer, View.VISIBLE);

        v.setOnClickPendingIntent(R.id.btn_add,
                WidgetIntent.of(c, ACTION_ADD, "add").build(c));
        v.setOnClickPendingIntent(R.id.btn_settings,
                WidgetIntent.of(c, ACTION_SETTINGS, "set").build(c));
        v.setOnClickPendingIntent(R.id.btn_prev_month,
                WidgetIntent.of(c, ACTION_WEEK, "pw").put(EXTRA_DELTA, -1).build(c));
        v.setOnClickPendingIntent(R.id.btn_next_month,
                WidgetIntent.of(c, ACTION_WEEK, "nw").put(EXTRA_DELTA, 1).build(c));
        // 左上角标识：点一下回今天。以前没挂 PendingIntent，点了完全没反应
        v.setOnClickPendingIntent(R.id.iv_logo,
                WidgetIntent.of(c, ACTION_TODAY, "today").build(c));

        mgr.updateAppWidget(widgetId, v);
    }

    /**
     * 画时间轴的第 {@code i} 行。
     *
     * {@code i < hourRows} 就是 {@code lo + i} 点那一行；最后一行留给「未定时」段。
     * 以前未定时的任务被塞进「起始小时」那一行，看起来像 8 点的任务 —— 语义是错的。
     */
    private static void drawHourRow(Context c, RemoteViews parent, int rowLayout, int i,
                                    int lo, int hourRows, List<WTask> timed, List<WTask> untimed,
                                    boolean isToday, int nowHour) {
        RemoteViews row = new RemoteViews(c.getPackageName(), rowLayout);
        if (i >= hourRows) {
            row.setTextViewText(R.id.hour_label, "—");
            row.setTextColor(R.id.hour_label, 0xFF8AA294);
            for (WTask t : untimed) row.addView(R.id.hour_body, taskBlock(c, t));
        } else {
            int h = lo + i;
            row.setTextViewText(R.id.hour_label, String.format(Locale.US, "%02d", h));
            boolean isNowRow = isToday && h == nowHour;
            row.setTextColor(R.id.hour_label, isNowRow ? 0xFF27795A : 0xFF8AA294);
            for (WTask t : timed) {
                if (startHour(t) != h) continue;
                row.addView(R.id.hour_body, taskBlock(c, t));
            }
        }
        parent.addView(R.id.hour_rows, row);
    }

    private static RemoteViews taskBlock(Context c, WTask t) {
        RemoteViews block = new RemoteViews(c.getPackageName(), R.layout.widget_task_block);
        block.setTextViewText(R.id.task_block, label(t));
        if (t.done) {
            // 完成后**整块退色**：底从浅绿变浅灰、左竖线由主绿转灰、字转灰。
            // 上一版只把字色改成 #9AAAA0，在浅绿底上几乎看不出来，用户反馈
            // 「点了完成时间轴上一点变化都没有」。
            // **不用删除线** —— 用户明确反感过，那东西在本来就不宽的任务块里太吵。
            block.setInt(R.id.task_block, "setBackgroundResource",
                    R.drawable.widget_task_bg_done);
            block.setTextColor(R.id.task_block, 0xFF7E8F84);
        } else {
            block.setInt(R.id.task_block, "setBackgroundResource",
                    R.drawable.widget_task_bg);
            block.setTextColor(R.id.task_block, 0xFF1B3A2A);
        }
        block.setOnClickPendingIntent(R.id.task_block,
                WidgetIntent.of(c, ACTION_TASK, "t" + t.id).put(EXTRA_ID, t.id).build(c));
        return block;
    }

    /**
     * 一屏能画几行、用哪档行高。
     *
     * RemoteViews 不能测量，所以「自适应」只能退化成「准备几套布局挑一套」。
     * 这里算两件事：
     *   · {@code layout} —— 把可用高度摊给全部行，落进哪一档就用哪档布局
     *   · {@code perPage} —— 用这一档的**实际**行高反过来算一屏能放几行
     *
     * 分页不是锦上添花，是修一个真 bug：以前行数超出可用高度就**直接画到
     * 组件外面**被裁掉，用户永远看不到 17 点之后的东西，而且没有任何提示 ——
     * 他只会觉得「这组件就到下午 4 点为止」。
     */
    private static RowPlan planRows(AppWidgetManager mgr, int widgetId,
                                    int totalRows, int habitRows) {
        Bundle opts = mgr.getAppWidgetOptions(widgetId);
        int totalDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 250);

        // 月份行 30 + 日期条 42 + footer 18 + 根 padding 20 + 各处 margin 10
        int availDp = Math.max(40, totalDp - (120 + habitRows * 26));

        int perRow = availDp / Math.max(1, totalRows);
        final int layout;
        final int rowDp;
        if (perRow >= 24) {
            layout = R.layout.widget_hour_row;
            rowDp = 38;
        } else if (perRow >= 18) {
            layout = R.layout.widget_hour_row_mid;
            rowDp = 28;
        } else {
            layout = R.layout.widget_hour_row_tight;
            rowDp = 21;
        }
        int perPage = Math.max(1, availDp / rowDp);
        return new RowPlan(layout, perPage);
    }

    /** 行高布局 + 一屏能放几行 */
    private static class RowPlan {
        final int layout;
        final int perPage;

        RowPlan(int layout, int perPage) {
            this.layout = layout;
            this.perPage = perPage;
        }
    }

    /**
     * 把时间轴翻到「这条任务将要出现的位置」。
     *
     * 为什么需要：新任务多半落在当前视口之外 —— 「未定时」更是被放在时间轴
     * 最后一行。用户点完保存，桌面上什么都没变，观感就是「没保存上」，
     * 比等一个网络往返还糟。
     *
     * @param time 任务的 HH:mm，null = 未定时
     */
    static void revealRow(Context c, String time) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(c);
        int[] ids = mgr.getAppWidgetIds(
                new android.content.ComponentName(c, ScheduleWidgetProvider.class));
        if (ids == null || ids.length == 0) return;

        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        int lo = WidgetPrefs.startHour(c);
        int hi = WidgetPrefs.endHour(c);
        int hourRows = hi - lo + 1;

        boolean hasUntimed = false;
        for (WTask t : snap.tasksOf(WidgetPrefs.selectedDay(c))) {
            if (t.time == null) { hasUntimed = true; break; }
        }
        int totalRows = hourRows + (hasUntimed ? 1 : 0);

        int habitRows = snap.habits.isEmpty() ? 0
                : (snap.habits.size() + HABITS_PER_ROW - 1) / HABITS_PER_ROW;
        RowPlan plan = planRows(mgr, ids[0], totalRows, habitRows);
        if (plan.perPage >= totalRows) return;   // 一屏就放得下，没什么可翻的

        final int row;
        if (time == null) {
            row = totalRows - 1;                 // 未定时 = 最后一行
        } else {
            int h;
            try {
                h = Integer.parseInt(time.substring(0, time.indexOf(':')));
            } catch (Exception e) {
                h = lo;
            }
            // 时间落在范围外的任务时间轴上根本没有那一行，clamp 到最近的端点
            row = Math.max(0, Math.min(hourRows - 1, h - lo));
        }
        // 让它落在可视区的**最后一行**而不是顶到最上面 —— 上下的上下文都还在，
        // 用户更能明白「我刚建的这条在以哪儿为中心的位置」
        int maxTop = Math.max(0, totalRows - plan.perPage);
        WidgetPrefs.setViewTop(c, Math.max(0, Math.min(maxTop, row - plan.perPage + 1)));
    }

    /**
     * 时间轴翻页。
     *
     * 在**这里**就把位置 clamp 到有效范围再存 —— 只在渲染时 clamp 的话，
     * 用户连点几下「下」会存下一个很大的值，之后再点「上」得按半天才动，
     * 看着像卡死。
     */
    private static void scroll(Context c, int dir, int page) {
        int lo = WidgetPrefs.startHour(c);
        int hi = WidgetPrefs.endHour(c);
        int rows = hi - lo + 1;
        for (WTask t : WidgetPrefs.snapshot(c).tasksOf(WidgetPrefs.selectedDay(c))) {
            if (t.time == null) { rows++; break; }
        }

        int step = Math.max(1, page - 1);   // 留一行重叠，翻页之后能接得上
        int maxTop = Math.max(0, rows - Math.max(1, page));
        int top = WidgetPrefs.viewTop(c) + dir * step;
        WidgetPrefs.setViewTop(c, Math.max(0, Math.min(maxTop, top)));
    }

    /* ============================ 打卡 ============================ */

    /**
     * 点打卡格。
     *
     * **乐观更新 → 直连 → 失败入队**，三步：
     *  ① 先改本地快照，桌面立刻变（几百毫秒的观感很重要）
     *  ② 有票就直连服务器（B 方案）—— 这才是真正落库，权限与 LWW 都在
     *     服务端 applyOps 里做，我们不多做一步判断
     *  ③ 没票 / 断网 / 票失效 → 攒进待同步队列，等 App 下次启动推走
     */
    private static void toggleHabit(Context c, String habitId) {
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        WHabit target = snap.habitById(habitId);
        if (target == null) return;

        final boolean on = !target.done;
        final String today = (snap.today != null && !snap.today.isEmpty())
                ? snap.today : WidgetPrefs.today(c);

        // ① 乐观更新
        try {
            JSONObject f = new JSONObject();
            f.put("done", on);
            f.put("streak", on ? target.streak + 1 : Math.max(0, target.streak - 1));
            WidgetPrefs.patchEntity(c, "habits", habitId, f, false);
        } catch (Exception ignored) {
        }

        // ② 直连。**必须拿到完整的 log 表才敢写**：applyOps 是字段整值替换，
        //    手里没有原表就只能发一个空对象上去，那会把这个人过去所有打卡
        //    一次抹干净。宁可先入队等 App 那边把新快照带下来。
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
            JSONObject fields = new JSONObject();
            // log 是「哪天打了勾」的稀疏表：勾上就加一个键，取消就把那个键删掉。
            // **整表回写** —— 服务端存的就是这张表，不是今天这一个值。
            // （以前这里发的是日期字符串，服务端存进去之后 h.log[today] 恒为
            //   undefined，表现是「打卡点了永远不生效」，还查不出错。）
            JSONObject log = new JSONObject(target.log.toString());
            if (on) log.put(today, true);
            else log.remove(today);
            fields.put("log", log);
            op.put("fields", fields);
            ops.put(op);

            WidgetApi.op(c, ops, new WidgetApi.Callback() {
                @Override
                public void onOk(JSONObject body) {
                    WidgetPrefs.replaceSnapshot(c, body);
                    refresh(c);
                }

                @Override
                public void onFail(String why) {
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

    /**
     * 服务端一次最多收多少条 op。**超过直接 400「一次最多 50 条」**，
     * 所以离线队列比这个长时必须分批 —— 以前是整批发、整队清，于是队列一过
     * 50 条就永远发不出去：每批都 400，队列原样留着，越攒越多。
     */
    private static final int MAX_OPS_PER_BATCH = 50;

    /**
     * 合并「同一件事」的重复记录，只留最后一次。
     *
     * 桌面上的打卡被反复点（以及正一次反一次）之后，离线队列里会攒下好几条
     * 互相抵消的记录 —— 实测攒到过 95 条，其实只对应 20 件事。发出去最终状态
     * 虽然也对（服务端按顺序执行），但白白撑大请求体，而请求体一大就撞上
     * {@link #MAX_OPS_PER_BATCH}。所以发送前先收敛一次。
     *
     * 去重键**必须带日期**：同一天同一件事才叫重复。
     */
    private static List<JSONObject> dedupe(List<JSONObject> raw) {
        java.util.Map<String, JSONObject> byKey = new java.util.LinkedHashMap<>();
        for (JSONObject p : raw) {
            String kind = p.optString("kind");
            String key;
            if ("habit".equals(kind)) {
                key = "habit|" + p.optString("habitId") + "|" + p.optString("date");
            } else if ("create".equals(kind)) {
                key = "create|" + p.optString("title") + "|" + p.optString("date")
                        + "|" + p.optString("time");
            } else {
                key = kind + "|" + p.optString("taskId");
            }
            byKey.put(key, p);      // 同键覆盖 → 保留最后一次意图
        }
        return new ArrayList<>(byKey.values());
    }

    /**
     * 队首开始、**能安全发出去**的最长前缀长度。
     *
     * 两类发不了：
     *   · habit 还没拿到完整的 log 表（老服务端只返回 done/streak）——
     *     发空对象会把历史打卡全抹掉，宁可等；
     *   · 实体在本地快照里已经找不到（被删了，或者当初就没建成功）。
     *
     * 遇到发不了的就**停在那儿**，而不是跳过去继续发后面的：服务端按顺序
     * 应用 op，跳过中间几条会让「同一件事的正反两次点击」收敛到错的最终值。
     */
    private static int usablePrefix(List<JSONObject> pending, WidgetSnapshot snap) {
        int n = 0;
        for (JSONObject p : pending) {
            if (n >= MAX_OPS_PER_BATCH) break;
            String kind = p.optString("kind");
            boolean ok;
            if ("habit".equals(kind)) {
                WHabit h = snap.habitById(p.optString("habitId"));
                ok = h != null && h.log != null;
            } else if ("create".equals(kind)) {
                ok = true;      // 新建不依赖已有实体
            } else {
                ok = snap.taskById(p.optString("taskId")) != null;
            }
            if (!ok) break;
            n++;
        }
        return n;
    }

    /** 把待同步队列发出去。App 启动时 / 组件刷新时 / 每次点击后调用，补上离线期间攒的改动 */
    static void flushPending(Context c) {
        if (!WidgetPrefs.canDirect(c)) return;
        List<JSONObject> pending = dedupe(WidgetPrefs.pendingOps(c));
        if (pending.isEmpty()) {
            WidgetPrefs.clearPending(c);
            return;
        }
        // 收敛后的结果写回队列：footer 上那个「N 待同步」也跟着变准
        WidgetPrefs.setPending(c, pending);

        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        // 只取「队首开始、能安全发出去」的那一段。**不能跳着发** —— 服务端按
        // 顺序应用 op，跳过中间几条会让「同一件事的正反两次点击」收敛到错的
        // 最终值（比如「取消打卡」先到、「打卡」后到）。
        final int take = usablePrefix(pending, snap);
        if (take == 0) return;   // 队首这条暂时发不了，整队先等下次

        JSONArray ops = new JSONArray();
        String calFallback = snap.tasks.isEmpty() ? "" : snap.tasks.get(0).calId;
        try {
            for (int i = 0; i < take; i++) {
                JSONObject p = pending.get(i);
                String kind = p.optString("kind");
                if ("habit".equals(kind)) {
                    WHabit h = snap.habitById(p.optString("habitId"));
                    if (h == null || h.log == null) return;   // usablePrefix 已挡过，纯兜底
                    JSONObject op = new JSONObject();
                    op.put("entity", "habit");
                    op.put("entityId", h.id);
                    op.put("calId", h.calId);
                    JSONObject fields = new JSONObject();
                    // **整表回写**：服务端存的是一张「哪天打了勾」的稀疏表，
                    // 不是今天这一个值。只发一天会把别的日期全抹掉。
                    JSONObject log = new JSONObject(h.log.toString());
                    String date = p.optString("date");
                    if (p.optBoolean("on")) log.put(date, true);
                    else log.remove(date);
                    fields.put("log", log);
                    op.put("fields", fields);
                    ops.put(op);
                } else if ("task".equals(kind) || "toggle".equals(kind)) {
                    WTask t = snap.taskById(p.optString("taskId"));
                    if (t == null) return;   // 同上，兜底；别丢队列
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", t.id);
                    op.put("calId", t.calId);
                    JSONObject fields = new JSONObject();
                    fields.put("done", p.optBoolean("on"));
                    fields.put("doneAt", p.optBoolean("on") ? System.currentTimeMillis() : JSONObject.NULL);
                    op.put("fields", fields);
                    ops.put(op);
                } else if ("create".equals(kind)) {
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", "@new");   // 服务端发真 id
                    op.put("calId", calFallback);
                    JSONObject fields = new JSONObject();
                    fields.put("title", p.optString("title"));
                    fields.put("date", p.optString("date"));
                    fields.put("time", p.isNull("time") ? JSONObject.NULL : p.optString("time"));
                    fields.put("dur", 0);
                    fields.put("done", false);
                    fields.put("doneAt", JSONObject.NULL);
                    op.put("fields", fields);
                    ops.put(op);
                }
            }
        } catch (Exception e) {
            return;   // 拼不出来就先别动队列，留在里面下次再试
        }
        if (ops.length() == 0) {
            // usablePrefix 已经保证过每条都拼得出来，走到这里说明有 bug。
            // 既不丢队列（丢了就是丢用户的操作），也不发空批上去换一个 400。
            android.util.Log.w("ScheduleWidget",
                    "队列前 " + take + " 条一条都没拼出来，本轮跳过");
            return;
        }

        WidgetApi.op(c, ops, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                WidgetPrefs.replaceSnapshot(c, body);
                WidgetPrefs.dropPending(c, take);   // 只扣掉真正发出去的这一批
                refresh(c);
                // 队列比一批长时接着发下一批
                if (WidgetPrefs.hasPending(c)) flushPending(c);
            }

            @Override
            public void onFail(String why) {
                // 留在队列里，下次再试。不做重试 —— 网络不好时重试只会更费电
            }
        });
    }

    /* ============================ 小工具 ============================ */

    private static final String[] WD = {"一", "二", "三", "四", "五", "六", "日"};

    /** 主绿 —— 跟 App 标识、时间轴当前小时用同一个色 */
    private static final int GREEN = 0xFF27795A;
    /** 淡绿 —— 时间轴翻页箭头用它表示「这个方向已经到头了」 */
    private static final int DIM = 0xFFCBDCD1;

    /** 透明度档位 → 底板资源。三档：不透明 / 70% / 45% */
    private static int bgFor(int alpha) {
        switch (alpha) {
            case 70: return R.drawable.widget_bg_a70;
            case 45: return R.drawable.widget_bg_a45;
            default: return R.drawable.widget_bg;
        }
    }

    /** 把颜色按百分比调透明。用于能用纯色背景的地方（打卡条） */
    private static int withAlpha(int color, int pct) {
        int a = (color >>> 24) * Math.max(0, Math.min(100, pct)) / 100;
        return (a << 24) | (color & 0x00FFFFFF);
    }

    private static String label(WTask t) {
        String when = t.time != null ? t.time : "未定时";
        String dur = t.dur > 0 ? " · " + t.dur / 60 + "h" + (t.dur % 60 > 0 ? t.dur % 60 + "m" : "") : "";
        return when + "  " + t.title + dur;
    }

    private static int startHour(WTask t) {
        if (t.time == null) return -1;
        int i = t.time.indexOf(':');
        try {
            return Integer.parseInt(t.time.substring(0, i));
        } catch (Exception e) {
            return -1;
        }
    }

    /** 标题显示**这一周**的范围，跟箭头按周翻保持一致（以前是「10月」） */
    private static String weekTitle(String monday, String sunday) {
        Calendar a = Calendar.getInstance();
        a.setTime(parse(monday));
        Calendar b = Calendar.getInstance();
        b.setTime(parse(sunday));
        int m1 = a.get(Calendar.MONTH) + 1;
        int m2 = b.get(Calendar.MONTH) + 1;
        int d1 = a.get(Calendar.DAY_OF_MONTH);
        int d2 = b.get(Calendar.DAY_OF_MONTH);
        if (m1 == m2) return m1 + "月" + d1 + "日 – " + d2 + "日";
        return m1 + "月" + d1 + "日 – " + m2 + "月" + d2 + "日";
    }

    private static String dayOfMonth(String iso) {
        return iso.substring(8, 10);
    }

    private static String clockOf(long ts) {
        if (ts <= 0) return "—";
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date(ts));
    }

    private static Date parse(String iso) {
        try {
            return new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(iso);
        } catch (Exception e) {
            return new Date();
        }
    }

    private static String mondayOf(String iso) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(iso));
        int dow = cal.get(Calendar.DAY_OF_WEEK);   // 周日 = 1
        int back = (dow == Calendar.SUNDAY) ? 6 : dow - Calendar.MONDAY;
        cal.add(Calendar.DAY_OF_MONTH, -back);
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.getTime());
    }

    private static String addDays(String iso, int n) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(iso));
        cal.add(Calendar.DAY_OF_MONTH, n);
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.getTime());
    }
}
