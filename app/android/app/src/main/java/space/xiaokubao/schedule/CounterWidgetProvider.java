package space.xiaokubao.schedule;

import android.app.AlarmManager;
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
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.widget.RemoteViews;

import java.util.Calendar;
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
 *
 * ## 渲染规则（2026-10-26 定稿：双字号 + 底对齐）
 * 两个独立字号常量：名字 NAME_FONT_DP = 30dp 固定字号、落笔按更高的
 * Kutai 取底边（naonao 下移底对齐）；数字按墨迹高 VALUE_INK_DP = 18dp
 * 反推字号。名字行高 ROW_DP = 28dp，按钮 BTN_DP = 40dp。位图按视图的
 * 像素尺寸 1:1 生成，ImageView 用 scaleType=center（不缩放，超宽居中裁切）。
 *
 * 为什么不再缩放：以前 fitTextSize 会因为「位图比视图大」而把字缩掉，
 * 于是改字号肉眼看不出。现在数字区净宽只保证 3～4 位数（`348` 占 45.8dp，
 * 净宽 67dp）；`00000` 会溢出被裁（用户 2026-10-26 选定方案 A），这是桌面
 * 组件宽度由 launcher 决定的物理上限，不是参数没调好。
 */
public class CounterWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "CounterWidget";

    /** 点 − / + ：带 id 和 delta（±1），走广播，不打开任何界面 */
    static final String ACTION_STEP = "space.xiaokubao.schedule.CTR_STEP";

    /**
     * 每天 0 点后自动刷新一次（2026-10-26 加）。
     *
     * 「每天 +6」是**服务端在读到计数器时结算的**，所以客户端这边不需要算日期、
     * 也不需要判断「过了几天」—— 只要在换日之后去读一次，数字就是新的。
     * 这里做的全部事情就是「0 点过后催一次读取」。
     *
     * 用 setAndAllowWhileIdle 而不是精确闹钟：精确闹钟在 Android 12+ 要单独申请
     * SCHEDULE_EXACT_ALARM 权限，为了「晚几分钟变数字」去要那个权限不值。
     * 而且**晚到不影响正确性** —— 结算按日期差算，哪怕 0 点过 40 分钟才跑，
     * 补的还是整整一天的量。
     */
    static final String ACTION_DAILY = "space.xiaokubao.schedule.CTR_DAILY";

    /** 换日之后等 5 分钟再刷新：给系统一点时间把日期真的翻过去 */
    private static final int DAILY_HOUR = 0;
    private static final int DAILY_MINUTE = 5;

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
        // 闹钟不会跨开机保留，重建组件时补排一次（幂等，FLAG_UPDATE_CURRENT 覆盖）
        scheduleDaily(c);
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
        scheduleDaily(c);
        Log.i(TAG, "CounterWidgetProvider enabled (first instance added)");
    }

    @Override
    public void onDisabled(Context c) {
        super.onDisabled(c);
        cancelDaily(c);
        Log.i(TAG, "CounterWidgetProvider disabled (last instance removed)");
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        super.onReceive(c, intent);

        // 每天换日：拉一次就是新的数（服务端读的时候就结算了）
        if (ACTION_DAILY.equals(intent.getAction())) {
            Log.i(TAG, "daily refresh");
            resync(c);
            scheduleDaily(c);   // 一次性闹钟，自己续明天的
            return;
        }

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

    /** 重画所有计数器实例（本进程内所有桌面上的这块，2×2 与 4×1 两个入口一起刷） */
    static void refreshAll(Context c) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            int[] ids = concatIds(mgr, c, CounterWidgetProvider.class, CounterWidgetWideProvider.class);
            for (int id : ids) render(c, mgr, id);
        } catch (Exception e) {
            Log.w(TAG, "refreshAll 失败: " + e);
        }
    }

    private static int[] concatIds(AppWidgetManager mgr, Context c, Class<?>... klasses) {
        int total = 0;
        int[][] all = new int[klasses.length][];
        for (int i = 0; i < klasses.length; i++) {
            try {
                all[i] = mgr.getAppWidgetIds(new ComponentName(c, klasses[i]));
            } catch (Exception e) {
                all[i] = new int[0];
            }
            total += all[i].length;
        }
        int[] out = new int[total];
        int p = 0;
        for (int[] a : all) {
            for (int id : a) out[p++] = id;
        }
        return out;
    }

    private static void render(Context c, AppWidgetManager mgr, int widgetId) {
        int[] dp = optionsDp(mgr, widgetId);
        boolean wide = isWide(dp);
        int layout = wide ? R.layout.widget_counter_h : R.layout.widget_counter_v;
        RemoteViews v = new RemoteViews(c.getPackageName(), layout);

        List<CounterStore.Item> items = CounterStore.load(c);
        CounterStore.Item a = items.size() > 0 ? items.get(0) : null;
        CounterStore.Item b = items.size() > 1 ? items.get(1) : null;

        Box box = Box.of(c, wide, dp);
        bind(c, v, true, a, box);
        bind(c, v, false, b, box);

        try {
            mgr.updateAppWidget(widgetId, v);
        } catch (Exception e) {
            Log.w(TAG, "更新组件 " + widgetId + " 失败: " + e);
        }
    }

    /** 组件当前的 dp 尺寸；launcher 没报（少见）时给一个合理默认值 */
    private static int[] optionsDp(AppWidgetManager mgr, int widgetId) {
        try {
            Bundle o = mgr.getAppWidgetOptions(widgetId);
            int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
            int h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            if (w > 0 && h > 0) return new int[]{w, h};
        } catch (Exception e) {
            Log.w(TAG, "读组件尺寸失败: " + e);
        }
        return null;
    }

    /**
     * 扁还是方。以宽高比 1.9 为界：
     *   4×1 大约 320×78 → 比 4.1   ✓ 扁
     *   2×2 大约 155×155 → 比 1.0   ✓ 方
     * 中间那些奇怪的比例（比如 3×2）按方的处理 —— 上下排更不容易挤。
     */
    private static boolean isWide(int[] dp) {
        if (dp == null) return false;
        return dp[0] >= dp[1] * 1.9;
    }

    /* -------------------------------------------------- 尺寸（与 layout 一一对应） */

    // ⚠️ 下面这些数必须和 widget_counter_v.xml / widget_counter_h.xml 里的
    //    padding / margin / layout_height / layout_width 完全一致。
    //    位图按这些 dp 反算出的像素尺寸生成，RemoteViews 没有测量回调，
    //    这是拿到「数字那块到底有多宽多高」的唯一办法。改了布局就要改这里。
    private static final float PAD_DP = 3f;    // 整卡 padding
    private static final float GAP_DP = 3f;    // 两块之间的缝
    private static final float ROW_DP = 28f;   // 名字行高（数字行另算，见 Box）
    private static final float BTN_DP = 40f;   // 加减按钮直径
    private static final float SIDE_DP = 1f;   // 数字行左右内边距

    /**
     * 名字与数字是**两个独立的字号常量**（2026-10-26 定稿）。
     *
     * 名字：固定字号 NAME_FONT_DP = 30dp，不再按墨迹一样大。naonao 与 Kutai
     * 用同一字号画，落笔按两者中更高的 Kutai 取底边，naonao 下移与 Kutai
     * 底对齐（见 renderName）。行高 28dp，Kutai 墨迹高 ~21.8dp，
     * 余 (28−21.8)/2 ≈ 3.1dp 上下留白。
     *
     * 数字：按墨迹高 VALUE_INK_DP = 18dp 反推字号（fontFor），不同数字
     * 字号不同但墨迹一样高。2×2 数字区净宽 67dp（145−2−80），`348` 占
     * 45.8dp 余 21.2dp；`00000` 占 83.2dp 会被裁 —— 方案 A：宁可裁，不缩字。
     */
    private static final float NAME_FONT_DP = 30f;
    private static final float VALUE_INK_DP = 18f;

    /** 名字描边宽度 = 字号 × 这个比例（同底色描边，让字有厚度） */
    private static final float STROKE_RATIO = 0.10f;

    /** 一块里每个位图该多大（像素）。 */
    private static final class Box {
        int lineW;    // 名字行位图宽 = 整格宽
        int lineH;    // 名字行高 = ROW_DP
        int valueW;   // 数字行位图宽 = 净宽（格宽 − 两侧边 − 两个按钮）
        int valueH;   // 数字行高 = 格高 − 名字行（剩余全给数字）
        int btn;

        static Box of(Context c, boolean wide, int[] dp) {
            float d = c.getResources().getDisplayMetrics().density;
            if (dp == null) dp = wide ? new int[]{320, 78} : new int[]{155, 155};
            float zoneW = wide ? (dp[0] - 2 * PAD_DP - GAP_DP) / 2f : (dp[0] - 2 * PAD_DP);
            float zoneH = wide ? (dp[1] - 2 * PAD_DP) : (dp[1] - 2 * PAD_DP - GAP_DP) / 2f;

            Box b = new Box();
            b.btn = px(BTN_DP, d);
            b.lineW = px(zoneW, d);
            b.lineH = px(ROW_DP, d);
            b.valueW = px(zoneW - 2 * SIDE_DP - 2 * BTN_DP, d);
            b.valueH = px(Math.max(20f, zoneH - ROW_DP), d);
            return b;
        }

        private static int px(float dp, float density) {
            return Math.max(1, Math.round(dp * density));
        }
    }

    /** 填一块（a = naonao 那块，b = Kutai 那块）。两块的 id 不同，所以只差在映射表 */
    private static void bind(Context c, RemoteViews v, boolean first,
                             CounterStore.Item item, Box box) {
        final int idName, idValue, idMinus, idPlus;
        if (first) {
            idName = R.id.ctr_a_name;
            idValue = R.id.ctr_a_value;
            idMinus = R.id.ctr_a_minus;
            idPlus = R.id.ctr_a_plus;
        } else {
            idName = R.id.ctr_b_name;
            idValue = R.id.ctr_b_value;
            idMinus = R.id.ctr_b_minus;
            idPlus = R.id.ctr_b_plus;
        }

        // 名字和数字都用位图渲染：RemoteViews 的 TextView 不支持自定义字体（Baloo2）。
        String id = item == null ? (first ? "naonao" : "kutai") : item.id;
        String name = item == null ? id : item.name;
        int value = item == null ? 0 : item.value;
        String text = String.valueOf(value);

        int nameColor = first ? 0xFFD4537E : 0xFF1D9E75;    // ctrPinkName / ctrGreenName
        int outlineColor = first ? 0xFFFBEAF0 : 0xFFE1F5EE; // ctrPinkOutline / ctrGreenOutline
        int inkColor = first ? 0xFF4B1528 : 0xFF04342C;     // ctrPinkInk / ctrGreenInk

        float stroke = STROKE_RATIO * NAME_FONT_DP * c.getResources().getDisplayMetrics().density;
        v.setImageViewBitmap(idName,
                renderName(c, name, box.lineW, box.lineH, nameColor, outlineColor, stroke));
        v.setImageViewBitmap(idValue,
                renderValue(c, text, box.valueW, box.valueH, inkColor));

        // − / + 也画成位图：这一对必须「同长同粗、在圆里正中」，
        // 用字体字符做不到（Baloo2 没有 U+2212，`-` 又比 `+` 细短且偏下），
        // 所以两个都按同一组比例画出来。见 glyphPlus / glyphMinus。
        int minusInk = first ? 0xFF993556 : 0xFF173404;     // ctrPinkMinusInk / ctrGreenMinusInk
        v.setImageViewBitmap(idMinus, glyphMinus(c, box.btn, minusInk));
        v.setImageViewBitmap(idPlus, glyphPlus(c, box.btn, Color.WHITE));

        // 加减按钮：一律走广播，不打开 App
        v.setOnClickPendingIntent(idMinus, stepIntent(c, id, -1));
        v.setOnClickPendingIntent(idPlus, stepIntent(c, id, 1));
        // 点数字：弹出直接输入的小窗（组件里放不了输入框，只能开一个对话框主题的 Activity）
        v.setOnClickPendingIntent(idValue, editIntent(c, id, name, value));
    }

    /* -------------------------------------------------------------- 位图 */

    private static Paint balooPaint(Context c, int color, float textSizePx) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        try {
            p.setTypeface(c.getResources().getFont(R.font.baloo2_extra_bold));
        } catch (Exception e) {
            p.setTypeface(Typeface.DEFAULT_BOLD);
        }
        p.setColor(color);
        p.setTextSize(textSizePx);
        p.setTextAlign(Paint.Align.CENTER);
        return p;
    }

    /**
     * 名字绘制。固定字号 NAME_FONT_DP，**底对齐**：落笔按两者中更高的
     * Kutai 取底边，naonao 下移与 Kutai 底对齐（预览 NameDbg 验证过，
     * d=2.0 时两底同为 49.81px，距行底 3.09dp，字不飞）。
     * 垂直不再居中 —— 居中会让 naonao 看起来往上飘。
     */
    private static Bitmap renderName(Context c, String text, int w, int h,
                                     int color, int outlineColor, float strokePx) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        float d = c.getResources().getDisplayMetrics().density;
        float px = NAME_FONT_DP * d;
        Rect rMax = new Rect();
        Paint probe = balooPaint(c, color, px);
        // 两名字中更高的决定底边：Kutai 带 K 的升部 + 降部，恒高于 naonao
        probe.getTextBounds("Kutai", 0, "Kutai".length(), rMax);
        Rect rSelf = new Rect();
        probe.getTextBounds(text, 0, text.length(), rSelf);
        // 底边按两者中更高的取：默认名里 Kutai 恒高于 naonao；用户改名后
        // 若新名更高则按新名取，避免写死 Kutai 把高字裁掉
        float maxH = Math.max((float) (rMax.bottom - rMax.top),
                (float) (rSelf.bottom - rSelf.top));
        float insetPx = Math.max(0f, (h - maxH) / 2f);
        float baseline = h - insetPx - rSelf.bottom;

        if (outlineColor != 0) {
            Paint outline = balooPaint(c, outlineColor, px);
            outline.setStyle(Paint.Style.STROKE);
            outline.setStrokeWidth(strokePx);
            canvas.drawText(text, w / 2f, baseline, outline);
        }

        Paint fill = balooPaint(c, color, px);
        canvas.drawText(text, w / 2f, baseline, fill);
        return bmp;
    }

    /**
     * 数字绘制。字号按墨迹高 VALUE_INK_DP 反推（fontFor），不同数字
     * 字号不同但墨迹一样高。超宽居中溢出被 Canvas 裁掉 —— 方案 A。
     * 垂直按**墨迹盒**居中，不是 fontMetrics：数字没有下行笔画，
     * 按 ascent/descent 居中会整体偏上。
     */
    private static Bitmap renderValue(Context c, String text, int w, int h, int color) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        float d = c.getResources().getDisplayMetrics().density;
        Paint probe = balooPaint(c, color, 10f * d);
        Rect r1 = new Rect();
        probe.getTextBounds(text, 0, text.length(), r1);
        float inkH1 = Math.max(1f, (float) (r1.bottom - r1.top));
        // 10dp 字号下墨迹 inkH1 px → 墨迹密度 inkH1/(10·d) px/dp，反推目标字号
        float px = 10f * VALUE_INK_DP * d * d / inkH1;

        Paint fill = balooPaint(c, color, px);
        Rect r = new Rect();
        fill.getTextBounds(text, 0, text.length(), r);
        canvas.drawText(text, w / 2f, h / 2f - (r.top + r.bottom) / 2f, fill);
        return bmp;
    }

    /* ------------------------------------------------------------ 加减号 */

    // 笔画比例，都相对**按钮直径**。取值来自 Baloo2 的 '+' 字形（墨迹 0.485em 宽、
    // 0.135em 粗）按「字号 ≈ 0.86×按钮直径」折算 —— 也就是这套卡片放大字号之后
    // '+' 在圆里的观感。减号就是加号去掉竖臂：两者等长、等粗、同心。
    private static final float BAR_LEN = 0.42f;
    private static final float BAR_THICK = 0.118f;

    private static Bitmap glyphPlus(Context c, int size, int color) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint p = barPaint(color, size);
        float c0 = size / 2f;
        // 圆头会把线端再往外扩 strokeWidth/2，所以线本身要缩回去，
        // 保证墨迹的外接尺寸正好是 BAR_LEN × size（否则 + 和 − 会长短不一）
        float half = size * BAR_LEN / 2f - p.getStrokeWidth() / 2f;
        canvas.drawLine(c0 - half, c0, c0 + half, c0, p);
        canvas.drawLine(c0, c0 - half, c0, c0 + half, p);
        return bmp;
    }

    private static Bitmap glyphMinus(Context c, int size, int color) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint p = barPaint(color, size);
        float c0 = size / 2f;
        float half = size * BAR_LEN / 2f - p.getStrokeWidth() / 2f;
        canvas.drawLine(c0 - half, c0, c0 + half, c0, p);
        return bmp;
    }

    private static Paint barPaint(int color, int size) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(size * BAR_THICK);
        // 圆头：Baloo2 的 + 是圆角的，方头会显得硬
        p.setStrokeCap(Paint.Cap.ROUND);
        return p;
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
    /**
     * 排下一次「换日刷新」。
     *
     * 用的是**一次性闹钟 + 每次触发时续一条**，不是 setRepeating ——
     * setRepeating 在 Doze 下会被推迟到不可预期，而且重复闹钟的间隔
     * 是按 24 小时算的，跨夏令时/手动改时间之后就永久偏了。
     * 每次 onUpdate / 每天触发时都重排一次，等于自我纠偏。
     */
    static void scheduleDaily(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextDailyAt(), dailyIntent(c));
        } catch (Exception e) {
            Log.w(TAG, "排每日刷新失败: " + e);
        }
    }

    private static void cancelDaily(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(dailyIntent(c));
        } catch (Exception e) {
            Log.w(TAG, "取消每日刷新失败: " + e);
        }
    }

    private static long nextDailyAt() {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, DAILY_HOUR);
        cal.set(Calendar.MINUTE, DAILY_MINUTE);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long t = cal.getTimeInMillis();
        if (t <= System.currentTimeMillis()) {
            cal.add(Calendar.DAY_OF_YEAR, 1);
            t = cal.getTimeInMillis();
        }
        return t;
    }

    private static PendingIntent dailyIntent(Context c) {
        Intent i = new Intent(c, CounterWidgetProvider.class).setAction(ACTION_DAILY);
        return PendingIntent.getBroadcast(c, ACTION_DAILY.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

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
