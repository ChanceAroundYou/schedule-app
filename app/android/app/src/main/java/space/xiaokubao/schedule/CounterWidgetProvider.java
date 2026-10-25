package space.xiaokubao.schedule;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.widget.RemoteViews;

import java.util.List;

/**
 * 桌面计数器 —— naonao / Kutai 两块，能加、能减、能直接改数字。
 *
 * ## 一个 provider，两种形状
 * 用户在桌面把它拖成 2×2，就是上下两块（widget_counter_v）；拖成 4×1，
 * 就是左右两块（widget_counter_h）。判断依据是 options 里的
 * minWidth / minHeight 的**宽高比**，不是格数 —— 各家 launcher 一格多少 dp
 * 并不统一，按格数猜会算错。切换发生在 onAppWidgetOptionsChanged，
 * 那里必须用 updateAppWidget(id, 新 RemoteViews) 整份替换：RemoteViews 的
 * 根布局在构造时就定了，改不了。
 *
 * ## 点击为什么先改本地
 * 点 + 的那一下如果等网络回来才动数字，弱网下就是「按了没反应」。
 * 所以顺序固定：改本地缓存 → 立刻重绘 → 入队 → 攒 600ms 合并发一次。
 * 服务端回来再拿它的值覆盖 —— 本地算错了也能自愈。
 *
 * ## 连点为什么要合并
 * 每点一次就发一个请求的话，连点二十下就是二十个请求，还可能乱序。
 * 队列按 id 合并成一条「+20」，600ms 内的点击只有最后一次触发发送。
 *
 * ## 拿不到手势
 * 桌面组件收不到长按/滑动/双击，所以「直接改数字」只能靠点数字弹一个小窗
 * （CounterEditActivity），不是长按菜单。
 */
public class CounterWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "CounterWidget";

    /** 点 − / + ：带 id 和 delta（±1），走广播，不打开任何界面 */
    static final String ACTION_STEP = "space.xiaokubao.schedule.CTR_STEP";

    static final String EXTRA_ID = "id";
    static final String EXTRA_DELTA = "delta";

    /** 连点合并窗口。太短等于没合并，太长用户会觉得「攒着不发」 */
    private static final long FLUSH_DELAY_MS = 600;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static Runnable sPendingFlush = null;

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) render(c, mgr, id);
        // 组件被系统重新 inflate（开机 / 换主题 / 从缓存恢复）时顺手对齐一次服务端：
        // 先把离线攒的发出去，再用服务端的值校准显示。
        resync(c);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager mgr,
                                          int widgetId, Bundle newOptions) {
        // 用户拖动改了尺寸 —— 宽高比可能跨过阈值，必须整份换布局
        if (android.util.Log.isLoggable(TAG, android.util.Log.DEBUG)) {
            Log.d(TAG, "onAppWidgetOptionsChanged id=" + widgetId
                    + " minW=" + (newOptions == null ? -1 : newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH))
                    + " minH=" + (newOptions == null ? -1 : newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)));
        }
        render(c, mgr, widgetId);
    }

    @Override
    public void onEnabled(Context c) {
        super.onEnabled(c);
        Log.i(TAG, "CounterWidgetProvider enabled (first instance added)");
    }

    @Override
    public void onDisabled(Context c) {
        super.onDisabled(c);
        Log.i(TAG, "CounterWidgetProvider disabled (last instance removed)");
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        super.onReceive(c, intent);
        if (!ACTION_STEP.equals(intent.getAction())) return;

        String id = intent.getStringExtra(EXTRA_ID);
        int delta = intent.getIntExtra(EXTRA_DELTA, 0);
        if (id == null || id.isEmpty() || delta == 0) return;

        CounterStore.localDelta(c, id, delta);   // 先改本地：按下去就得有变化
        CounterStore.queueDelta(c, id, delta);   // 再入队：断网也不丢
        refreshAll(c);                           // 立刻重绘
        scheduleFlush(c);                        // 攒一小会儿，合并成一次请求
    }

    /* -------------------------------------------------------------- 渲染 */

    /** 重画所有计数器实例（本进程内所有桌面上的这块） */
    static void refreshAll(Context c) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(c, CounterWidgetProvider.class));
            for (int id : ids) render(c, mgr, id);
        } catch (Exception e) {
            Log.w(TAG, "refreshAll 失败: " + e);
        }
    }

    private static void render(Context c, AppWidgetManager mgr, int widgetId) {
        boolean wide = isWide(mgr, widgetId);
        int layout = wide ? R.layout.widget_counter_h : R.layout.widget_counter_v;
        RemoteViews v = new RemoteViews(c.getPackageName(), layout);

        List<CounterStore.Item> items = CounterStore.load(c);
        CounterStore.Item a = items.size() > 0 ? items.get(0) : null;
        CounterStore.Item b = items.size() > 1 ? items.get(1) : null;

        bind(c, v, true, a, wide);
        bind(c, v, false, b, wide);

        try {
            mgr.updateAppWidget(widgetId, v);
        } catch (Exception e) {
            Log.w(TAG, "更新组件 " + widgetId + " 失败: " + e);
        }
    }

    /**
     * 扁还是方。以宽高比 1.9 为界：
     *   4×1 大约 320×78 → 比 4.1   ✓ 扁
     *   2×2 大约 155×155 → 比 1.0   ✓ 方
     * 中间那些奇怪的比例（比如 3×2）按方的处理 —— 上下排更不容易挤。
     */
    private static boolean isWide(AppWidgetManager mgr, int widgetId) {
        try {
            Bundle o = mgr.getAppWidgetOptions(widgetId);
            int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
            int h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            if (w <= 0 || h <= 0) return false;
            return w >= h * 1.9;
        } catch (Exception e) {
            return false;
        }
    }

    /** 填一块（a = naonao 那块，b = Kutai 那块）。两块的 id 不同，所以只差在映射表 */
    private static void bind(Context c, RemoteViews v, boolean first,
                             CounterStore.Item item, boolean wide) {
        final int idName, idOutline, idValue, idMinus, idPlus;
        if (first) {
            idName = R.id.ctr_a_name;
            idOutline = R.id.ctr_a_name_outline;
            idValue = R.id.ctr_a_value;
            idMinus = R.id.ctr_a_minus;
            idPlus = R.id.ctr_a_plus;
        } else {
            idName = R.id.ctr_b_name;
            idOutline = R.id.ctr_b_name_outline;
            idValue = R.id.ctr_b_value;
            idMinus = R.id.ctr_b_minus;
            idPlus = R.id.ctr_b_plus;
        }

        String id = item == null ? (first ? "naonao" : "kutai") : item.id;
        String name = item == null ? id : item.name;
        int value = item == null ? 0 : item.value;
        String text = String.valueOf(value);

        // 名字写两遍：底层是描边（同底色、大 3sp），上层是彩色字。
        // 只设一个的话那个"气泡"就没有了 —— 见布局文件里的说明。
        v.setTextViewText(idName, name);
        v.setTextViewText(idOutline, name);

        // 名字长了要收字号，否则会被 maxLines=1 直接截断
        float nameSp = wide ? 18f : 17f;
        if (name.length() > 6) nameSp -= 3f;
        else if (name.length() > 5) nameSp -= 2f;
        v.setTextViewTextSize(idName, TypedValue.COMPLEX_UNIT_SP, nameSp);
        v.setTextViewTextSize(idOutline, TypedValue.COMPLEX_UNIT_SP, nameSp + 3f);

        v.setTextViewText(idValue, text);
        v.setTextViewTextSize(idValue, TypedValue.COMPLEX_UNIT_SP, valueSp(text, wide));

        // 加减按钮：一律走广播，不打开 App
        v.setOnClickPendingIntent(idMinus, stepIntent(c, id, -1));
        v.setOnClickPendingIntent(idPlus, stepIntent(c, id, 1));
        // 点数字：弹出直接输入的小窗（组件里放不了输入框，只能开一个对话框主题的 Activity）
        v.setOnClickPendingIntent(idValue, editIntent(c, id, name, value));
    }

    /**
     * 数字字号：位数越多越小。数字区宽度只有 40dp 左右，
     * 21sp 撑死放三位，四位往上必须收，否则会被布局裁掉一半。
     */
    private static float valueSp(String text, boolean wide) {
        float base = wide ? 22f : 21f;
        int n = text.length();
        if (n <= 3) return base;
        if (n == 4) return base - 4f;
        if (n == 5) return base - 7f;
        return base - 9f;
    }

    private static PendingIntent stepIntent(Context c, String id, int delta) {
        return WidgetIntent.of(c, CounterWidgetProvider.class, ACTION_STEP, id + (delta > 0 ? "+" : "-"))
                .put(EXTRA_ID, id)
                .put(EXTRA_DELTA, delta)
                .build(c);
    }

    /** 点数字的小窗。code 按 id 区分，否则两个计数器会共用一个弹窗实例。 */
    private static PendingIntent editIntent(Context c, String id, String name, int value) {
        Intent i = new Intent(c, CounterEditActivity.class)
                .putExtra(CounterEditActivity.EXTRA_ID, id)
                .putExtra(CounterEditActivity.EXTRA_NAME, name)
                .putExtra(CounterEditActivity.EXTRA_VALUE, value)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, ("ctr-edit-" + id).hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* -------------------------------------------------------------- 同步 */

    /** 攒一小会儿再发：连点二十下最终只发一条「+20」 */
    private static void scheduleFlush(Context c) {
        final Context app = c.getApplicationContext();
        if (sPendingFlush != null) MAIN.removeCallbacks(sPendingFlush);
        sPendingFlush = new Runnable() {
            @Override
            public void run() {
                sPendingFlush = null;
                CounterStore.flush(app, new Runnable() {
                    @Override
                    public void run() {
                        refreshAll(app);
                    }
                });
            }
        };
        MAIN.postDelayed(sPendingFlush, FLUSH_DELAY_MS);
    }

    /** 先补发离线改动，再用服务端的值校准（顺序不能反，反了本地新改动会被旧值盖掉） */
    private static void resync(final Context c) {
        final Context app = c.getApplicationContext();
        CounterStore.flush(app, new Runnable() {
            @Override
            public void run() {
                CounterStore.pull(app, new Runnable() {
                    @Override
                    public void run() {
                        refreshAll(app);
                    }
                });
            }
        });
    }
}
