package space.xiaokubao.schedule;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 打卡小组件（2026-11-04 拆分；2026-11-04 第二轮：去筛选 + 三点菜单 + ListView 滚动）。
 *
 * ## 变更摘要（第二轮）
 * 1. **字体不随尺寸缩放**：k 只跟字号档位（fontScale），不再乘 sizeK。
 * 2. **去掉筛选**：漏斗图标 / cycleFilter / applyFilter / filterLabel / 筛选持久化全砍。
 *    显示**全部**打卡项，按 App 里的顺序排。
 * 3. **三点菜单**：右上角 ic_more（与日程组件同一枚），点开弹设置弹框，只有
 *    「底板透明度」+「字体大小」两项（日程组件那套的子集）。
 * 4. **ListView 滚动**：chip 区从 LinearLayout 改成 ListView + RemoteViewsService
 *    （{@link HabitWidgetService}），装不下的原生滚动，不再折「+N」。
 *
 * ## 只看今天（用户 2026-11-04 定的口径）
 * 「桌面小组件是越简单越好」——不做日期翻阅、不做历史回看。打卡写入恒写
 * 实时今天（{@link WidgetPrefs#today}）。跨天靠每日换日闹钟（日程组件排的）
 * 顺带刷本组件 + App 推快照。
 *
 * ## 点击即打卡，不打开 App
 * 走广播 + 乐观更新三态（接受 / 拒绝 / 问不出去入队），与日程组件完全同一条路。
 * 见 {@link #toggleHabit}。
 *
 * ## RemoteViews 老规矩（改之前看 ScheduleWidgetProvider 类注释）
 * 容器白名单、不能测量、ScrollView 不能用（滚动靠 ListView + setRemoteAdapter）、
 * 透明度只能预烤 drawable。
 */
public class HabitWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "HabitWidget";

    /** 点打卡 chip（template PendingIntent 的 action；每颗 chip 的 fill-in 带 EXTRA_ID） */
    static final String ACTION_TOGGLE = "space.xiaokubao.schedule.HAB_TOGGLE";
    /** 右上角三点菜单：打开设置弹框 */
    static final String ACTION_SETTINGS = "space.xiaokubao.schedule.HAB_SETTINGS";

    static final String EXTRA_ID = "id";
    /** 组件实例 id（传给 RemoteViewsService，让它按实例宽度算 perRow） */
    static final String EXTRA_WID = "wid";

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        ScheduleWidgetProvider.flushPending(c);
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        for (int id : ids) render(c, mgr, id, snap);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager mgr,
                                          int widgetId, Bundle newOptions) {
        render(c, mgr, widgetId, WidgetPrefs.snapshot(c));
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        final String a = intent.getAction();
        if (ACTION_TOGGLE.equals(a)) {
            toggleHabit(c, intent.getStringExtra(EXTRA_ID), WidgetPrefs.today(c));
        } else if (ACTION_SETTINGS.equals(a)) {
            WidgetSettingsActivity.start(c, WidgetSettingsActivity.MODE_HABIT);
            return;   // 只是打开弹框，不需要重画
        }
        // 顺手补发离线队列（限流一分钟）
        if (WidgetPrefs.hasPending(c)
                && System.currentTimeMillis() - lastFlushAt > ScheduleWidgetProvider.FLUSH_MIN_GAP_MS) {
            lastFlushAt = System.currentTimeMillis();
            ScheduleWidgetProvider.flushPending(c);
        }
        refresh(c);
    }

    private static long lastFlushAt = 0;

    /* ============================ 渲染 ============================ */

    static void refresh(Context c) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            int[] ids = mgr.getAppWidgetIds(
                    new ComponentName(c, HabitWidgetProvider.class));
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

        final String today = WidgetPrefs.today(c);
        float k = WidgetPrefs.fontScale(c) / 100f;
        ScheduleWidgetProvider.Metrics m = new ScheduleWidgetProvider.Metrics(k);

        /* ---- 顶栏：日历徽标（今天几号）+ 月份 + 三点菜单 ---- */
        v.setViewLayoutHeight(R.id.hab_head, m.headRow, TypedValue.COMPLEX_UNIT_DIP);
        v.setTextViewText(R.id.hab_logo_day, today.substring(8, 10));
        v.setTextViewText(R.id.hab_month, cnMonth(today));
        ScheduleWidgetProvider.scaleView(v, R.id.hab_logo, 26, k);
        ScheduleWidgetProvider.scaleView(v, R.id.hab_settings_btn, 26, k);
        ScheduleWidgetProvider.font(v, R.id.hab_logo_day, 10, k);
        ScheduleWidgetProvider.font(v, R.id.hab_month, 15, k);

        // 三点菜单 → 打开设置弹框（habit 模式：只有透明度 + 字体）
        v.setOnClickPendingIntent(R.id.hab_settings_btn, WidgetIntent
                .of(c, HabitWidgetProvider.class, WidgetIntent.CODE_SALT_HABIT,
                        ACTION_SETTINGS, "s" + widgetId)
                .put(EXTRA_WID, widgetId).build(c));

        /* ---- chip 区背景 ---- */
        v.setInt(R.id.hab_list, "setBackgroundColor",
                ScheduleWidgetProvider.withAlpha(0xFFE7F3EA, alpha));

        /* ---- ListView 绑 RemoteViewsService ---- */
        Intent adapterIntent = new Intent(c, HabitWidgetService.class);
        adapterIntent.putExtra(EXTRA_WID, widgetId);
        v.setRemoteAdapter(R.id.hab_list, adapterIntent);

        // 空视图：count=0 时 ListView 自动切到 hab_empty
        v.setEmptyView(R.id.hab_list, R.id.hab_empty);
        ScheduleWidgetProvider.font(v, R.id.hab_empty, 8, k);

        /* ---- chip 点击：template PendingIntent + 每颗 chip 的 fill-in extras ----
           FLAG_MUTABLE 是 setOnClickFillInIntent 的硬性要求（Android 12+）：
           系统要往 template 里合入 fill-in 的 extras，不可变 PendingIntent 做不到。 */
        Intent toggleTemplate = new Intent(c, HabitWidgetProvider.class).setAction(ACTION_TOGGLE);
        PendingIntent templatePi = PendingIntent.getBroadcast(c, 0, toggleTemplate,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        v.setPendingIntentTemplate(R.id.hab_list, templatePi);

        // 触发 factory 重新读快照（打卡后 / 快照刷新后数据变了要重画列表）
        mgr.notifyAppWidgetViewDataChanged(new int[]{widgetId}, R.id.hab_list);

        mgr.updateAppWidget(widgetId, v);
    }

    private static String cnMonth(String todayIso) {
        int m;
        try { m = Integer.parseInt(todayIso.substring(5, 7)); } catch (Exception e) { return ""; }
        String[] cn = {"一月", "二月", "三月", "四月", "五月", "六月",
                       "七月", "八月", "九月", "十月", "十一月", "十二月"};
        return (m >= 1 && m <= 12) ? cn[m - 1] : m + "月";
    }

    /* ============================ 打卡（复用日程那套） ============================ */

    private static void toggleHabit(Context c, String habitId, String today) {
        if (habitId == null || habitId.isEmpty()) return;
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        WHabit target = snap.habitById(habitId);
        if (target == null) return;

        final boolean on = !(target.log != null && target.log.optBoolean(today, false));
        WidgetPrefs.dropQueuedHabit(c, habitId, today);

        try {
            JSONObject log = target.log == null
                    ? new JSONObject() : new JSONObject(target.log.toString());
            if (on) log.put(today, true);
            else log.remove(today);
            JSONObject f = new JSONObject();
            f.put("log", log);
            f.put("done", on);
            WidgetPrefs.patchEntity(c, "habits", habitId, f, false);
        } catch (Exception ignored) {
        }
        refresh(c);

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
                    WidgetPrefs.mergeEntities(c, body, "habits",
                            java.util.Collections.singletonList(habitId));
                    refresh(c);
                }

                @Override
                public void onRejected(JSONObject body, String why) {
                    WidgetPrefs.mergeEntities(c, body, "habits",
                            java.util.Collections.singletonList(habitId));
                    refresh(c);
                    Ui.toast(c, "这次打卡服务端没有接受");
                }

                @Override
                public void onUnreachable(String why) {
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
}
