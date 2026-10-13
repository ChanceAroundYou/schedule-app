package space.xiaokubao.schedule;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.TypedValue;
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
 *   2. 不能自定义 View、不能测量宽高。
 *      ⇒「卡片按真实分钟定位」于是这样做：**自己算绝对位置** —— 用
 *        {@code setViewLayoutHeight} 把每个元素的高度钉死，再靠空占位条把
 *        后面的元素顶到位。见 {@link #renderTimeline}。
 *        （该接口是 API 31 / Android 12 起才有的，低版本 launcher 认不了。）
 *   3. 动态加子视图只能「按布局文件加」，不能凭空造容器 —— 想要多行就得
 *      有一个「行容器」的布局文件（见 widget_habit_row.xml）。
 *   4. 子视图白名单里**没有裸 {@code View}**，占位条 / 分隔线一律用空 TextView。
 *   5. 只有标了 {@code @RemotableViewMethod} 的方法能通过 setInt/setFloat
 *      反射调用。{@code View.setAlpha(float)} **没有**这个标注，所以透明度
 *      只能预先做成几档 drawable 来切 —— 见 {@link #bgFor}。
 *   6. 接不到手势。手指滑动、长按、双击一概做不到，只能靠点击。
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

    static final String EXTRA_DAY = "day";
    static final String EXTRA_DELTA = "delta";
    static final String EXTRA_ID = "id";

    /**
     * 打卡区每行放几个。
     *
     * 3 → 4 是因为用户说「很有可能会添加第七个」：3 个一行时第 7 个要单开
     * 第三行，白占一整行高度；4 个一行的话 7 个正好两行（4+3），
     * 常见习惯数（6-9 个）也都在两到三行内。
     */
    private static final int HABITS_PER_ROW = 4;

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
            // 圆放在**固定 26dp 的 chip_circle** 上（宽高相等 → 永远是正圆）。
            // 不能放在 chip_root 上：那是 weight 等分出来的矩形，oval 铺上去
            // 必然被拉成椭圆 —— 这正是用户看到的「选中的日期变成了椭圆」。
            chip.setInt(R.id.chip_circle, "setBackgroundResource",
                    sel ? R.drawable.widget_chip_bg_sel : 0);
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

        int habitRows = snap.habits.isEmpty() ? 0
                : (snap.habits.size() + HABITS_PER_ROW - 1) / HABITS_PER_ROW;

        // 时间轴能分到多少高度。**顶部和面板的固定件全是定值**（用户要求顶部
        // 不随组件缩放），所以这里能精确算出来。组件越高，多出来的全给时间轴。
        int totalDp = mgr.getAppWidgetOptions(widgetId)
                .getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 300);
        int fixedDp = 16                       // root padding 上下各 8
                + 22 + 2                        // head 行 + margin
                + DATE_STRIP_DP + 2             // 日期条 + margin
                + (habitRows > 0 ? habitRows * HABIT_ROW_DP + 7 : 0)   // 打卡区 + margin
                + PANEL_BAR_DP + 1 + 2          // 未定时横条（常驻）+ 横分割线 + margin
                + 15;                           // footer 预留
        int timelineDp = Math.max(70, totalDp - fixedDp);

        boolean isToday = day.equals(today);
        int nowMin = isToday ? nowMinutes() : -1;
        renderScale(c, v, lo, hi, timelineDp, isToday, nowMin);
        renderTimeline(c, v, timed, lo, hi, timelineDp, isToday, nowMin);
        renderUntimedBar(c, v, untimed);

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
        // 改过时间轴范围就把范围写出来 —— 不然用户看到一个「从 6 点开始」的
        // 时间轴，会以为是显示出了 bug 而不是自己设的
        if (lo != WidgetPrefs.DEFAULT_START_HOUR || hi != WidgetPrefs.DEFAULT_END_HOUR) {
            foot.append(" · ").append(lo).append("–").append(hi).append(" 时");
        }
        // 整条都落在 [lo, hi] 之外的任务画不出来（时间轴没有那一段）。
        // 不提示的话它们等于被静默吞掉，用户只会觉得「我明明记了」。
        int outside = 0;
        for (WTask t : timed) {
            int s = startMin(t);
            if (s < 0) continue;
            if (s + durOf(t) <= lo * 60 || s >= (hi + 1) * 60) outside++;
        }
        if (outside > 0) foot.append(" · ").append(outside).append(" 项在范围外");
        if (!untimed.isEmpty()) foot.append(" · ").append(untimed.size()).append(" 未定时");
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

    /* ==================== 时间轴渲染 ==================== */

    /**
     * 整条时间轴**整体下移**多少 dp。
     *
     * 用户 2026-10-14：细线原本画在每格的**顶边**，而左侧「08/10/12」是
     * top 对齐、也贴着顶边 —— 于是线压在数字**上方**，数字整颗吊在线下面。
     * 把线和内容一起下移半个字高（9sp ≈ 11dp → 约 5dp），数字的**垂直中心**
     * 就正好落在自己那根线上。
     *
     * ⚠️ 线、现在红线、任务卡**必须一起下移** —— 它们是同一套换算，
     * 只动线会让「10:00 的任务」顶边比 10:00 那根线高一截。
     * 代价：时间轴底部少 5dp（用户已确认）。
     */
    private static final int LINE_OFFSET_DP = 5;

    /** 未定时横条最多直接露几个，超出的折成一格「+N」 */
    private static final int UNTIMED_MAX = 5;
    /** 打卡区单行占高（格子本身 + 上下 margin），用于算预算 */
    private static final int HABIT_ROW_DP = 19;
    /** 日期条占高（29dp 的正圆） */
    private static final int DATE_STRIP_DP = 29;
    /** 十字面板顶行（左空白角 + 右未定时横条）的高度。常驻，不随有无任务变 */
    private static final int PANEL_BAR_DP = 15;
    /**
     * 任务卡最小高度。
     *
     * 2026-10-13 由 13dp 提到 **15dp**：字号固定成 9sp 之后不再随块高缩小，
     * 很短的卡片（5 分钟任务）如果只有 13dp，去掉 1dp 上下 padding 后
     * 只剩 11dp 放字，会被裁。
     */
    private static final int MIN_BLOCK_DP = 15;

    /**
     * 十字面板左下角的**刻度列**。
     *
     * 和右下主体的网格格用**同一个高度公式**（累进取整，避免逐行攒出误差），
     * 所以左边的数字和右边的小时线严格同高。
     */
    private static void renderScale(Context c, RemoteViews v, int lo, int hi,
                                    int timelineDp, boolean isToday, int nowMin) {
        v.removeAllViews(R.id.tl_scale);
        int hours = hi - lo + 1;
        // 和主体用同一个「一小时多少 dp」—— 见 LINE_OFFSET_DP：主体整体下移了
        // 5dp，所以可用高度要先扣掉，否则数字和线会越往下越错开。
        float dpPerHour = Math.max(1, timelineDp - LINE_OFFSET_DP) / (float) hours;
        // 行高很小时数字会叠在一起 → 隔 2~3 小时才写一个（判据跟 App 日视图一致）。
        // ⚠️ 字号**不再随行高变化** —— 用户 2026-10-13 要求刻度 / 打卡 / 任务卡
        // 统一 9sp，字号在 widget_tl_hour.xml 里定死，这里只控制「写哪几个」。
        int step = dpPerHour < 11f ? 3 : (dpPerHour < 16f ? 2 : 1);

        int prevY = 0;
        for (int k = 0; k < hours; k++) {
            int nextY = Math.round((k + 1) * dpPerHour);
            int hgt = Math.max(1, nextY - prevY);
            prevY = nextY;

            RemoteViews e = new RemoteViews(c.getPackageName(), R.layout.widget_tl_hour);
            e.setViewLayoutHeight(R.id.tl_hour, hgt, TypedValue.COMPLEX_UNIT_DIP);
            e.setTextViewText(R.id.tl_hour,
                    (k % step == 0) ? String.format(Locale.US, "%02d", lo + k) : "");
            // 「现在」那一小时的刻度标红 —— 全宽红线在主体里单独一层
            e.setTextColor(R.id.tl_hour,
                    (isToday && nowMin >= 0 && (lo + k) == nowMin / 60)
                            ? 0xFFD24A2E : 0xFFA2B5A9);
            v.addView(R.id.tl_scale, e);
        }
    }

    /**
     * 画时间轴。
     *
     * **核心：自己算绝对位置。**
     *
     * RemoteViews 既不能测量、也不能任意摆座标，所以「按真实分钟定位」只能
     * 这样落地：把每个元素该占多少 dp 全算出来，用 {@code setViewLayoutHeight}
     * 把高度钉死，再靠一个个空占位条把后面的元素顶到正确的位置。
     *
     * 三层共用同一个「每分钟多少 dp」的比例，所以：
     *   · 整点线落在整点上（网格层等高铺满）
     *   · 卡片落在它**真正的分钟**上，而不是吸附到 8:00 / 9:00
     *   · 「现在」红线落在真实的现在
     *
     * ⚠️ {@code setViewLayoutHeight} 是 API 31（Android 12）才有的。低版本
     * launcher 认不了这些 action，时间轴会退化成不定位的堆叠 —— 当前目标机
     * 是 API 36，没问题。
     */
    private static void renderTimeline(Context c, RemoteViews v, List<WTask> timed,
                                       int lo, int hi, int timelineDp,
                                       boolean isToday, int nowMin) {
        int hours = hi - lo + 1;
        int fromMin = lo * 60;
        int toMin = (hi + 1) * 60;
        // 扣掉整体下移量。**线、红线和任务卡共用这一个比例**，
        // 所以下移之后三者仍然严格对齐（见 LINE_OFFSET_DP）。
        int innerDp = Math.max(1, timelineDp - LINE_OFFSET_DP);
        float dpPerMin = innerDp / (float) (hours * 60);
        float dpPerHour = innerDp / (float) hours;

        /* ---- 网格层：等高的格子，格子的顶边就是整点。只有线，刻度在左侧列 ---- */
        v.removeAllViews(R.id.tl_grid);
        v.addView(R.id.tl_grid, spacer(c, LINE_OFFSET_DP));
        int prevY = 0;
        for (int k = 0; k < hours; k++) {
            // 用累进目标值取整，避免逐行四舍五入攒出十几 dp 的偏移
            int nextY = Math.round((k + 1) * dpPerHour);
            int hgt = Math.max(1, nextY - prevY);
            prevY = nextY;

            RemoteViews e = new RemoteViews(c.getPackageName(), R.layout.widget_tl_line);
            e.setViewLayoutHeight(R.id.tl_line, hgt, TypedValue.COMPLEX_UNIT_DIP);
            v.addView(R.id.tl_grid, e);
        }

        /* ---- 「现在」红线 ---- */
        v.removeAllViews(R.id.tl_now);
        if (isToday && nowMin >= fromMin && nowMin <= toMin) {
            v.addView(R.id.tl_now, spacer(c, LINE_OFFSET_DP));
            v.addView(R.id.tl_now, spacer(c, Math.round((nowMin - fromMin) * dpPerMin)));
            v.addView(R.id.tl_now, new RemoteViews(c.getPackageName(), R.layout.widget_tl_nowline));
        }

        /* ---- 任务层 ---- */
        v.removeAllViews(R.id.tl_tasks);

        List<Ev> evs = new ArrayList<>();
        for (WTask t : timed) {
            int s = startMin(t);
            if (s < 0) continue;
            int e = s + durOf(t);
            if (e <= fromMin || s >= toMin) continue;   // 整条都在范围外，画不出来
            evs.add(new Ev(t, Math.max(s, fromMin), Math.min(e, toMin)));
        }
        evs.sort((a, b) -> Integer.compare(a.s, b.s));

        // 从「负的偏移」起步 → 第一个 spacer 自动多出 5dp，整层跟着下移
        int cursor = -LINE_OFFSET_DP;
        int i = 0;
        while (i < evs.size()) {
            // 摘一个「时间上连通重叠」的簇：簇内的任务才需要并排分列
            int clS = evs.get(i).s;
            int clE = evs.get(i).e;
            List<Ev> cluster = new ArrayList<>();
            int j = i;
            while (j < evs.size() && evs.get(j).s < clE) {
                clE = Math.max(clE, evs.get(j).e);
                cluster.add(evs.get(j));
                j++;
            }
            List<List<Ev>> cols = assignColumns(cluster);

            int topDp = Math.round((clS - fromMin) * dpPerMin);
            int spanDp = Math.max(MIN_BLOCK_DP, Math.round((clE - clS) * dpPerMin));
            if (topDp - cursor > 0) v.addView(R.id.tl_tasks, spacer(c, topDp - cursor));

            RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_tl_row);
            row.setViewLayoutHeight(R.id.tl_row, spanDp, TypedValue.COMPLEX_UNIT_DIP);
            for (List<Ev> col : cols) {
                RemoteViews colv = new RemoteViews(c.getPackageName(), R.layout.widget_tl_col);
                colv.setViewLayoutHeight(R.id.tl_col, spanDp, TypedValue.COMPLEX_UNIT_DIP);
                int inner = 0;
                for (Ev ev : col) {
                    // 列内互不重叠 → 用前置占位条把卡片顶到它自己的分钟
                    int sDp = Math.round((ev.s - clS) * dpPerMin);
                    int hDp = Math.max(MIN_BLOCK_DP, Math.round((ev.e - ev.s) * dpPerMin));
                    if (sDp - inner > 0) colv.addView(R.id.tl_col, spacer(c, sDp - inner));
                    colv.addView(R.id.tl_col, taskBlock(c, ev.t, hDp));
                    inner = sDp + hDp;
                }
                row.addView(R.id.tl_row, colv);
            }
            v.addView(R.id.tl_tasks, row);

            cursor = topDp + spanDp;
            i = j;
        }
    }

    /** 任务在时间轴上的区间（分钟，已按显示范围裁剪） */
    private static class Ev {
        final WTask t;
        final int s;
        final int e;

        Ev(WTask t, int s, int e) {
            this.t = t;
            this.s = s;
            this.e = e;
        }
    }

    /** 一个高度精确的空占位条。只能是 TextView —— RemoteViews 白名单里没有裸 View */
    private static RemoteViews spacer(Context c, int dp) {
        RemoteViews sp = new RemoteViews(c.getPackageName(), R.layout.widget_tl_spacer);
        sp.setViewLayoutHeight(R.id.tl_spacer, dp, TypedValue.COMPLEX_UNIT_DIP);
        return sp;
    }

    /**
     * 簇内分列：互相重叠的并排，能共存的塞同一列。
     * 贪心 —— 按开始时间走，找第一列「上一件已经结束」的放进去。
     */
    private static List<List<Ev>> assignColumns(List<Ev> cluster) {
        List<List<Ev>> cols = new ArrayList<>();
        List<Integer> ends = new ArrayList<>();
        for (Ev ev : cluster) {
            int k = -1;
            for (int m = 0; m < cols.size(); m++) {
                if (ends.get(m) <= ev.s) {
                    k = m;
                    break;
                }
            }
            if (k < 0) {
                cols.add(new ArrayList<>());
                ends.add(0);
                k = cols.size() - 1;
            }
            cols.get(k).add(ev);
            ends.set(k, ev.e);
        }
        return cols;
    }

    private static RemoteViews taskBlock(Context c, WTask t, int hDp) {
        RemoteViews block = new RemoteViews(c.getPackageName(), R.layout.widget_task_block);
        block.setTextViewText(R.id.task_block, label(t));
        block.setViewLayoutHeight(R.id.task_block, hDp, TypedValue.COMPLEX_UNIT_DIP);
        // ⚠️ **字号不再按块高变化** —— 用户 2026-10-13 明确「任务卡上的文字不随着
        // 卡片变大而变大」。统一 9sp，写在 widget_task_block.xml 里（以前这里
        // 按 hDp 挑 9/10/11sp，同屏卡片字大小不一）。
        if (t.done) {
            // 完成后**整块退色**：底从浅绿变浅灰、左竖线由主绿转灰、字转灰。
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
     * 十字面板**右上角**的未定时横条。
     *
     * 用户 2026-10-13 定的形态：**不写「未定时」三个字** —— 左边的空白角
     * 就是这一行的标记（两者是同一块面板的四格之一，不是两块）。
     * 卡片排成一行、按数量等分宽度；超过 {@link #UNTIMED_MAX} 个就折成
     * 一格「+N」—— 再多就没法看了。
     */
    private static void renderUntimedBar(Context c, RemoteViews v, List<WTask> untimed) {
        v.removeAllViews(R.id.untimed_bar);
        int n = untimed.size();
        if (n == 0) return;   // 空白角常驻，横条留空即可

        boolean fold = n > UNTIMED_MAX;
        int shown = fold ? UNTIMED_MAX - 1 : n;   // 折叠时留一格给「+N」

        for (int i = 0; i < shown; i++) {
            WTask t = untimed.get(i);
            RemoteViews r = new RemoteViews(c.getPackageName(), R.layout.widget_untimed_row);
            r.setTextViewText(R.id.untimed_row, t.title);
            if (t.done) {
                r.setInt(R.id.untimed_row, "setBackgroundResource",
                        R.drawable.widget_task_bg_done);
                r.setTextColor(R.id.untimed_row, 0xFF7E8F84);
            }
            r.setOnClickPendingIntent(R.id.untimed_row,
                    WidgetIntent.of(c, ACTION_TASK, "u" + t.id).put(EXTRA_ID, t.id).build(c));
            v.addView(R.id.untimed_bar, r);
        }
        if (fold) {
            RemoteViews more = new RemoteViews(c.getPackageName(), R.layout.widget_untimed_more);
            more.setTextViewText(R.id.untimed_more, "+" + (n - shown));
            v.addView(R.id.untimed_bar, more);
        }
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
            } else if ("delete".equals(kind)) {
                // 删除自带 calId，不依赖本地还有没有这条 —— 乐观删除之后
                // taskById 必然查不到，若在这里判 null，删除就永远发不出去
                ok = true;
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
                } else if ("edit".equals(kind)) {
                    // 编辑弹框存下的改动：标题 / 起止时间（= time + duration），
                    // 可选连带「完成」状态
                    WTask t = snap.taskById(p.optString("taskId"));
                    if (t == null) return;
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", t.id);
                    op.put("calId", t.calId);
                    JSONObject fields = new JSONObject();
                    fields.put("title", p.optString("title"));
                    // 日期可改了（2026-10-14）。老队列里没有这个键 → 不下发，
                    // 免得把日期写成空串
                    if (p.has("date") && !p.isNull("date")) {
                        fields.put("date", p.optString("date"));
                    }
                    fields.put("time", p.isNull("time") ? JSONObject.NULL : p.optString("time"));
                    // ⚠️ 字段名是 **duration**，不是 dur（服务端与 App 都读 duration）
                    fields.put("duration", p.optInt("duration", 0));
                    // done 为 null = 「这次没动完成状态」，别把它当成 false 下发
                    if (!p.isNull("done")) {
                        boolean d = p.optBoolean("done");
                        fields.put("done", d);
                        fields.put("doneAt", d ? System.currentTimeMillis() : JSONObject.NULL);
                    }
                    op.put("fields", fields);
                    ops.put(op);
                } else if ("delete".equals(kind)) {
                    // 删除不依赖本地快照里还有没有这条 —— 乐观删除之后
                    // taskById 就查不到了，但 calId 早就跟着队列存下来了
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", p.optString("taskId"));
                    op.put("calId", p.optString("calId"));
                    JSONObject fields = new JSONObject();
                    fields.put("deleted", true);
                    fields.put("deletedAt", p.optLong("deletedAt"));
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
                    // ⚠️ duration，不是 dur
                    fields.put("duration", p.optInt("duration", 0));
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

    /** 透明度档位 → 底板资源。五档：40% / 55% / 70% / 85% / 不透明 */
    private static int bgFor(int alpha) {
        switch (alpha) {
            case 40: return R.drawable.widget_bg_a40;
            case 55: return R.drawable.widget_bg_a55;
            case 70: return R.drawable.widget_bg_a70;
            case 85: return R.drawable.widget_bg_a85;
            default: return R.drawable.widget_bg;
        }
    }

    /** 把颜色按百分比调透明。用于能用纯色背景的地方（打卡条） */
    private static int withAlpha(int color, int pct) {
        int a = (color >>> 24) * Math.max(0, Math.min(100, pct)) / 100;
        return (a << 24) | (color & 0x00FFFFFF);
    }

    private static String label(WTask t) {
        // 卡片本身已经按「真实分钟」摆好了，标题前不再重复时长，把宽度让给标题
        String when = t.time != null ? t.time : "未定时";
        return when + "  " + t.title;
    }

    /** "HH:mm" → 从 0 点起的分钟数；解析不了返回 -1 */
    private static int startMin(WTask t) {
        if (t.time == null) return -1;
        int i = t.time.indexOf(':');
        try {
            return Integer.parseInt(t.time.substring(0, i)) * 60
                    + Integer.parseInt(t.time.substring(i + 1));
        } catch (Exception e) {
            return -1;
        }
    }

    /** 时长（分钟）。跟 App 的 durOf 一致：没设的按 60 分钟算 */
    private static int durOf(WTask t) {
        return t.dur > 0 ? t.dur : 60;
    }

    /** 设备当前时刻（从 0 点起的分钟数），给「现在」红线和刻度标红用 */
    private static int nowMinutes() {
        Calendar cal = Calendar.getInstance();
        return cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
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
