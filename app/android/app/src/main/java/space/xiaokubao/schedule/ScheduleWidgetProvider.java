package space.xiaokubao.schedule;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 日程小组件。
 *
 * **只看单日**（用户 2026-10-13 明确）：顶部的日期条是选择器，不是把 7 天
 * 平铺开。选了哪天，下面就只画那天的定时任务。
 *
 * 交互全部走广播回到这里处理（{@code PendingIntent.getBroadcast}），
 * 不启动 Activity —— 除了两个确实需要表单的地方（任务详情、新建），
 * 那两个用对话框主题的 Activity，观感是弹窗而不是「打开 App」。
 *
 * ⚠️ RemoteViews 的限制：不能自定义 View、不能用 ConstraintLayout。
 * 时间轴是「每小时一行」的 LinearLayout 堆出来的，任务块塞进它开始的那一行。
 */
public class ScheduleWidgetProvider extends AppWidgetProvider {

    static final String ACTION_PICK_DAY = "space.xiaokubao.schedule.PICK_DAY";
    static final String ACTION_MONTH = "space.xiaokubao.schedule.MONTH";
    static final String ACTION_TASK = "space.xiaokubao.schedule.TASK";
    static final String ACTION_HABIT = "space.xiaokubao.schedule.HABIT";
    static final String ACTION_ADD = "space.xiaokubao.schedule.ADD";

    static final String EXTRA_DAY = "day";
    static final String EXTRA_DELTA = "delta";
    static final String EXTRA_ID = "id";

    private static final SimpleDateFormat ISO =
            new SimpleDateFormat("yyyy-MM-dd", Locale.US);
    /** 时间轴最少覆盖的小时范围，否则空白天会占掉大半高度 */
    private static final int MIN_HOUR = 8;
    private static final int MAX_HOUR = 20;

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        // App 每次推刷新都会走到这儿。顺手把离线期间攒的改动补发一次 ——
        // 用户刚打开过 App，票是新的，此刻推最可能成功。
        flushPending(c);
        for (int id : ids) render(c, mgr, id);
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String a = intent.getAction();
        if (ACTION_PICK_DAY.equals(a)) {
            WidgetPrefs.setSelectedDay(c, intent.getStringExtra(EXTRA_DAY));
        } else if (ACTION_MONTH.equals(a)) {
            int delta = intent.getIntExtra(EXTRA_DELTA, 1);
            WidgetPrefs.setSelectedDay(c, addMonths(WidgetPrefs.selectedDay(c), delta));
        } else if (ACTION_TASK.equals(a)) {
            TaskDetailActivity.start(c, intent.getStringExtra(EXTRA_ID));
            return;
        } else if (ACTION_ADD.equals(a)) {
            CreateTaskActivity.start(c, WidgetPrefs.selectedDay(c));
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
        if (ids != null && ids.length > 0) onUpdateStatic(c, mgr, ids);
    }

    private static void onUpdateStatic(Context c, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) render(c, mgr, id);
    }

    /* ============================ 渲染 ============================ */

    private static void render(Context c, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_schedule);
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        String day = WidgetPrefs.selectedDay(c);
        // 「今天」优先用快照里那个（来自服务端）—— 手机时钟/时区不准时，
        // 自己算出来的今天会跟服务端差一天，打卡就写到隔壁去了。
        // 快照是空的（还没同步过）才退回设备时间。
        String today = (snap.today != null && !snap.today.isEmpty())
                ? snap.today : WidgetPrefs.today(c);

        v.setTextViewText(R.id.tv_month, monthTitle(day));

        /* ---- 日期条：选中日所在的周（周一开头） ---- */
        v.removeAllViews(R.id.date_strip);
        String monday = mondayOf(day);
        for (int i = 0; i < 7; i++) {
            String iso = addDays(monday, i);
            RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_day_chip);
            boolean sel = iso.equals(day);
            chip.setTextViewText(R.id.chip_wd, WD[i]);
            chip.setTextViewText(R.id.chip_date, dayOfMonth(iso));
            chip.setInt(R.id.chip_root, "setBackgroundResource",
                    sel ? R.drawable.widget_chip_bg_sel : R.drawable.widget_chip_bg);
            chip.setTextColor(R.id.chip_wd, sel ? 0xBFFFFFFF : 0xFF6B8574);
            chip.setTextColor(R.id.chip_date, sel ? 0xFFFFFFFF : 0xFF1B3A2A);
            chip.setOnClickPendingIntent(R.id.chip_root,
                    WidgetIntent.of(c, ACTION_PICK_DAY, iso).put(EXTRA_DAY, iso).build(c));
            v.addView(R.id.date_strip, chip);
        }

        /* ---- 打卡条 ---- */
        v.removeAllViews(R.id.habit_strip);
        if (snap.habits.isEmpty()) {
            v.setViewVisibility(R.id.habit_strip, View.GONE);
        } else {
            v.setViewVisibility(R.id.habit_strip, View.VISIBLE);
            RemoteViews label = new RemoteViews(c.getPackageName(), R.layout.widget_habit_chip);
            label.setTextViewText(R.id.habit_chip, "打卡");
            label.setInt(R.id.habit_chip, "setBackgroundResource", 0);
            v.addView(R.id.habit_strip, label);
            for (WHabit h : snap.habits) {
                RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_habit_chip);
                chip.setTextViewText(R.id.habit_chip, (h.done ? "✓ " : "") + h.title);
                chip.setInt(R.id.habit_chip, "setBackgroundResource",
                        h.done ? R.drawable.widget_habit_bg_done : R.drawable.widget_habit_bg);
                chip.setTextColor(R.id.habit_chip, h.done ? 0xFFFFFFFF : 0xFF1B3A2A);
                chip.setOnClickPendingIntent(R.id.habit_chip,
                        WidgetIntent.of(c, ACTION_HABIT, "h" + h.id).put(EXTRA_ID, h.id).build(c));
                v.addView(R.id.habit_strip, chip);
            }
        }

        /* ---- 时间轴 ---- */
        v.removeAllViews(R.id.hour_rows);
        List<WTask> dayTasks = snap.tasksOf(day);
        int lo = MIN_HOUR, hi = MAX_HOUR;
        for (WTask t : dayTasks) {
            int h = startHour(t);
            lo = Math.min(lo, h);
            hi = Math.max(hi, Math.min(23, h + 1));
        }
        boolean isToday = day.equals(today);
        int nowHour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);

        for (int h = lo; h <= hi; h++) {
            RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_hour_row);
            row.setTextViewText(R.id.hour_label, String.format(Locale.US, "%02d", h));
            boolean isNowRow = isToday && h == nowHour;
            row.setTextColor(R.id.hour_label, isNowRow ? 0xFF27795A : 0xFF8AA294);

            for (WTask t : dayTasks) {
                if (startHour(t) != h) continue;
                RemoteViews block = new RemoteViews(c.getPackageName(), R.layout.widget_task_block);
                block.setTextViewText(R.id.task_block, label(t));
                if (t.done) block.setTextColor(R.id.task_block, 0xFF9AAAA0);
                block.setOnClickPendingIntent(R.id.task_block,
                        WidgetIntent.of(c, ACTION_TASK, "t" + t.id).put(EXTRA_ID, t.id).build(c));
                row.addView(R.id.hour_body, block);
            }
            v.addView(R.id.hour_rows, row);
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
        v.setOnClickPendingIntent(R.id.btn_prev_month,
                WidgetIntent.of(c, ACTION_MONTH, "pm").put(EXTRA_DELTA, -1).build(c));
        v.setOnClickPendingIntent(R.id.btn_next_month,
                WidgetIntent.of(c, ACTION_MONTH, "nm").put(EXTRA_DELTA, 1).build(c));

        mgr.updateAppWidget(widgetId, v);
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
     *
     * 直连成功后用服务端返回的新快照**整体覆盖**本地 —— 它比我们乐观改的
     * 更权威（可能同时有别人改过）。
     */
    private static void toggleHabit(Context c, String habitId) {
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        WHabit target = null;
        for (WHabit h : snap.habits) if (h.id.equals(habitId)) target = h;
        if (target == null) return;

        final boolean on = !target.done;
        final String today = snap.today != null && !snap.today.isEmpty()
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
            // log 是「哪天打了勾」的映射。取消打勾要把那天移除 —— 服务端
            // 的 safeParse 会把 null 落成 null，客户端据此删键。
            fields.put("log", on ? today : JSONObject.NULL);
            op.put("fields", fields);
            ops.put(op);

            WidgetApi.op(c, ops, new WidgetApi.Callback() {
                @Override
                public void onOk(JSONObject body) {
                    WidgetPrefs.replaceSnapshot(c, body);
                }

                @Override
                public void onFail(String why) {
                    // unauthorized 说明票失效了，入队等 App 重新登录后推
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
     * 把待同步队列发出去。App 启动时调用一次，把离线期间攒的改动补上。
     *
     * 队列里的 op 是「简化 op」（kind/habitId/date/on 或 kind/taskId/on），
     * 这里转成服务端要的形状。calId 从当前快照里找 —— 快照是 App 写的，
     * 一定带。
     */
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
                // 留在队列里，下次启动再试。不重试爆露在网络不好的场景
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
        if (t.time == null) return MIN_HOUR;
        int c = t.time.indexOf(':');
        return Integer.parseInt(t.time.substring(0, c));
    }

    private static String monthTitle(String iso) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(iso));
        return (cal.get(Calendar.MONTH) + 1) + "月";
    }

    private static String dayOfMonth(String iso) {
        return iso.substring(8, 10);
    }

    private static String clockOf(long ts) {
        if (ts <= 0) return "—";
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date(ts));
    }

    private static Date parse(String iso) {
        try { return ISO.parse(iso); } catch (Exception e) { return new Date(); }
    }

    private static String mondayOf(String iso) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(iso));
        int dow = cal.get(Calendar.DAY_OF_WEEK);   // 周日 = 1
        int back = (dow == Calendar.SUNDAY) ? 6 : dow - Calendar.MONDAY;
        cal.add(Calendar.DAY_OF_MONTH, -back);
        return ISO.format(cal.getTime());
    }

    private static String addDays(String iso, int n) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(iso));
        cal.add(Calendar.DAY_OF_MONTH, n);
        return ISO.format(cal.getTime());
    }

    private static String addMonths(String iso, int n) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(iso));
        int last = cal.getActualMaximum(Calendar.DAY_OF_MONTH);
        cal.add(Calendar.MONTH, n);
        // 1月31日 + 1 个月不能变成 3月3日 —— 夹到当月最后一天
        cal.set(Calendar.DAY_OF_MONTH, Math.min(cal.get(Calendar.DAY_OF_MONTH), last));
        return ISO.format(cal.getTime());
    }
}
