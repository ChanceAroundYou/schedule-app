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
 *   2. 不能自定义 View、不能测量宽高。所以行高只能按档位选布局文件，
 *      不能真正「自适应」。
 *   3. 动态加子视图只能「按布局文件加」，不能凭空造容器 —— 想要多行就得
 *      有一个「行容器」的布局文件（见 widget_habit_row.xml）。
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

    /** 打卡区每行放几个。用户要「每行 2-3 个、分 2-3 行」 */
    private static final int HABITS_PER_ROW = 3;

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        // App 每次推刷新都会走到这儿。顺手把离线期间攒的改动补发一次 ——
        // 用户刚打开过 App，票是新的，此刻推最可能成功。
        flushPending(c);
        for (int id : ids) render(c, mgr, id);
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
        refresh(c);
    }

    /** 广播给所有实例重画 */
    static void refresh(Context c) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(c);
        int[] ids = mgr.getAppWidgetIds(new android.content.ComponentName(c, ScheduleWidgetProvider.class));
        if (ids == null || ids.length == 0) return;
        // 逐个渲染而不是批量 updateAppWidget(ids, v) —— 每个实例的尺寸可能
        // 不同（用户能各自拖大拖小），行高档位要按各自的 options 算
        for (int id : ids) render(c, mgr, id);
    }

    /* ============================ 渲染 ============================ */

    private static void render(Context c, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_schedule);
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        String day = WidgetPrefs.selectedDay(c);
        // 「今天」优先用快照里那个（来自服务端）—— 手机时钟/时区不准时，
        // 自己算出来的今天会跟服务端差一天，打卡就写到隔壁去了。
        String today = (snap.today != null && !snap.today.isEmpty())
                ? snap.today : WidgetPrefs.today(c);

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

        /* ---- 打卡区：每行 HABITS_PER_ROW 个，自动折行 ---- */
        v.removeAllViews(R.id.habit_rows);
        if (snap.habits.isEmpty()) {
            v.setViewVisibility(R.id.habit_rows, View.GONE);
        } else {
            v.setViewVisibility(R.id.habit_rows, View.VISIBLE);
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
                    chip.setTextViewText(R.id.habit_chip, (h.done ? "✓ " : "") + h.title);
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
        int rows = hi - lo + 1;

        v.removeAllViews(R.id.hour_rows);
        int rowLayout = hourRowLayoutFor(c, mgr, widgetId, rows, untimed.isEmpty() ? 0 : 1);
        boolean isToday = day.equals(today);
        int nowHour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);

        for (int h = lo; h <= hi; h++) {
            RemoteViews row = new RemoteViews(c.getPackageName(), rowLayout);
            row.setTextViewText(R.id.hour_label, String.format(Locale.US, "%02d", h));
            boolean isNowRow = isToday && h == nowHour;
            row.setTextColor(R.id.hour_label, isNowRow ? 0xFF27795A : 0xFF8AA294);

            for (WTask t : timed) {
                if (startHour(t) != h) continue;
                row.addView(R.id.hour_body, taskBlock(c, t));
            }
            v.addView(R.id.hour_rows, row);
        }

        /* ---- 未定时：单独放最后 ----
           以前没定时的任务被塞进「起始小时」那一行，看起来像 8 点的任务 ——
           语义是错的。放到底部单独一段，跟 App 里「未定时」区一个意思。 */
        if (!untimed.isEmpty()) {
            RemoteViews label = new RemoteViews(c.getPackageName(), rowLayout);
            label.setTextViewText(R.id.hour_label, "—");
            label.setTextColor(R.id.hour_label, 0xFF8AA294);
            for (WTask t : untimed) label.addView(R.id.hour_body, taskBlock(c, t));
            v.addView(R.id.hour_rows, label);
        }

        /* ---- 底部 ---- */
        int pend = WidgetPrefs.pendingCount(c);
        String foot;
        if (dayTasks.isEmpty() && snap.habits.isEmpty()) {
            foot = "还没有数据，打开 App 同步一下";
        } else if (dayTasks.isEmpty()) {
            foot = "这天没有安排";
        } else {
            foot = dayTasks.size() + " 项 · 更新于 " + clockOf(snap.at);
        }
        if (pend > 0) foot += " · " + pend + " 项待同步";
        v.setTextViewText(R.id.tv_footer, foot);
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

    private static RemoteViews taskBlock(Context c, WTask t) {
        RemoteViews block = new RemoteViews(c.getPackageName(), R.layout.widget_task_block);
        block.setTextViewText(R.id.task_block, label(t));
        if (t.done) block.setTextColor(R.id.task_block, 0xFF9AAAA0);
        block.setOnClickPendingIntent(R.id.task_block,
                WidgetIntent.of(c, ACTION_TASK, "t" + t.id).put(EXTRA_ID, t.id).build(c));
        return block;
    }

    /**
     * 按组件实际高度挑一档行高。
     *
     * RemoteViews 不能测量，所以「自适应」只能退化成「准备几套布局挑一套」。
     * 用户把时间轴设成 6:00–23:00（18 行）时要能塞进 4×4 的格子，就得换
     * 紧凑档；组件拖大了再用宽松档，不然会浪费空间。
     *
     * 算的是「除时间轴之外其它部分大约占多少」，剩下的除以行数就是每行能
     * 分到的高度。估得粗一点没关系 —— 差一档只是疏密不同。
     */
    private static int hourRowLayoutFor(Context c, AppWidgetManager mgr, int widgetId,
                                        int rows, int untimedRows) {
        Bundle opts = mgr.getAppWidgetOptions(widgetId);
        int totalDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 250);

        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        int habitRows = snap.habits.isEmpty() ? 0
                : (snap.habits.size() + HABITS_PER_ROW - 1) / HABITS_PER_ROW;
        // 月份行 30 + 日期条 42 + footer 18 + 根 padding 20 + 各处 margin 10
        int fixedDp = 120 + habitRows * 26;
        int availDp = Math.max(40, totalDp - fixedDp);
        int allRows = rows + untimedRows;
        int perRow = availDp / Math.max(1, allRows);

        if (perRow >= 24) return R.layout.widget_hour_row;
        if (perRow >= 18) return R.layout.widget_hour_row_mid;
        return R.layout.widget_hour_row_tight;
    }

    /* ============================ 打卡 ============================ */

    /**
     * 点打卡格。
     *
     * **乐观更新 → 直连 → 失败入队**，三步：
     *   ① 先改本地快照，桌面立刻变（几百毫秒的观感很重要）
     *   ② 有票就直连服务器（B 方案）—— 这才是真正落库，权限与 LWW 都在
     *      服务端 applyOps 里做，我们不多做一步判断
     *   ③ 没票 / 断网 / 票失效 → 攒进待同步队列，等 App 下次启动推走
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

        // ② 直连
        if (!WidgetPrefs.canDirect(c)) {
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
            // log 是「哪天打了勾」的映射。取消打勾要把那天移除 —— 服务端的
            // safeParse 会把 null 落成 null，客户端据此删键。
            fields.put("log", on ? today : JSONObject.NULL);
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

    /** 把待同步队列发出去。App 启动时 / 组件刷新时调用，把离线期间攒的改动补上 */
    static void flushPending(Context c) {
        if (!WidgetPrefs.canDirect(c)) return;
        List<JSONObject> pending = WidgetPrefs.pendingOps(c);
        if (pending.isEmpty()) return;

        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        JSONArray ops = new JSONArray();
        String calFallback = snap.tasks.isEmpty() ? "" : snap.tasks.get(0).calId;
        try {
            for (JSONObject p : pending) {
                String kind = p.optString("kind");
                if ("habit".equals(kind)) {
                    WHabit h = snap.habitById(p.optString("habitId"));
                    if (h == null) continue;
                    JSONObject op = new JSONObject();
                    op.put("entity", "habit");
                    op.put("entityId", h.id);
                    op.put("calId", h.calId);
                    JSONObject fields = new JSONObject();
                    fields.put("log", p.optBoolean("on") ? p.optString("date") : JSONObject.NULL);
                    op.put("fields", fields);
                    ops.put(op);
                } else if ("task".equals(kind)) {
                    WTask t = snap.taskById(p.optString("taskId"));
                    if (t == null) continue;
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
            return;   // 拼不出来就别发，留在队列里下次再试
        }
        if (ops.length() == 0) {
            WidgetPrefs.clearPending(c);
            return;
        }

        WidgetApi.op(c, ops, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                WidgetPrefs.replaceSnapshot(c, body);
                WidgetPrefs.clearPending(c);
            }

            @Override
            public void onFail(String why) {
                // 留在队列里，下次再试。不做重试 —— 网络不好时重试只会更费电
            }
        });
    }

    /* ============================ 小工具 ============================ */

    private static final String[] WD = {"一", "二", "三", "四", "五", "六", "日"};

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
