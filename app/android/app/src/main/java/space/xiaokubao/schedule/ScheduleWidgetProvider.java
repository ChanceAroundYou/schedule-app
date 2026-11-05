package space.xiaokubao.schedule;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.Log;
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
 * **点击的交互模型：乐观更新。** 点下去的那一瞬间就改本地快照 + 重绘，
 * 请求**并发**发出去，绝不拿网络往返的时间换界面的响应。三种结局：
 *   · 服务端接受 → 只把碰到的这几条换成服务端的值，别的不动
 *   · 服务端拒绝 → 同样换成服务端的值 = 回到它返回的真相，并提示用户
 *   · 问不出去（离线/超时/票失效）→ 保留本地结果，入队等下次补发
 * 实现散在 TaskDetailActivity、CreateTaskActivity 和 {@link #flushPending}，
 * 共用的合并逻辑在 {@link WidgetPrefs#mergeEntities}，三态回调在
 * {@link WidgetApi.OpCallback}。
 *
 * **2026-11-04 拆分**（用户：「打卡是打卡，日程是日程」）：打卡区、打卡 chip、
 * 打卡写入整体迁到 {@link HabitWidgetProvider}，本组件只剩时间表。
 * 渲染工具（bgFor / withAlpha / Metrics / habitChip / emptyChip / habitHead /
 * toggleHabit / flushPending / 每日换日闹钟）**留着供那边复用**——同包、
 * package-private，不复制第二份。
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

    private static final String TAG = "ScheduleWidget";

    static final String ACTION_PICK_DAY = "space.xiaokubao.schedule.PICK_DAY";
    /** 左右箭头：按**周**翻（delta 单位是周，不是月） */
    static final String ACTION_WEEK = "space.xiaokubao.schedule.WEEK";
    static final String ACTION_TASK = "space.xiaokubao.schedule.TASK";
    static final String ACTION_ADD = "space.xiaokubao.schedule.ADD";
    static final String ACTION_SETTINGS = "space.xiaokubao.schedule.SETTINGS";
    /** 点左上角标识 = 回到今天 */
    static final String ACTION_TODAY = "space.xiaokubao.schedule.TODAY";
    /* 2026-11-04 拆分：ACTION_HABIT / ACTION_HABITS_TOGGLE（打卡 chip 与
       「+N/收起」）随打卡区整体迁到 HabitWidgetProvider，这里不再有打卡交互 */

    /**
     * 每天 0:05 自动重画一次（2026-10-31 加）。
     *
     * 跨天时日期必须自己翻页 —— 不能指望 updatePeriodMillis（Android 12+ 是
     * 不精确闹钟，ColorOS 还会更懒，可能推迟几小时）。这里用 setAndAllowWhileIdle
     * 排一条一次性闹钟，触发时 refresh + 自己续明天。晚到几分钟无所谓：重画的
     * 「今天」是实时算的（见 render），只要触发那一刻日期已经翻过去就对。
     *
     * 只重画、不联网 —— 任务/打卡内容仍以 App 推来的快照为准（本次只修日期显示）。
     */
    static final String ACTION_DAILY = "space.xiaokubao.schedule.WDG_DAILY";
    private static final int DAILY_HOUR = 0;
    private static final int DAILY_MINUTE = 5;

    static final String EXTRA_DAY = "day";
    static final String EXTRA_DELTA = "delta";
    static final String EXTRA_ID = "id";

    /** 分组标题行高（未缩放）。8sp 字 + 上下 padding，比 chip 行矮。
     *  2026-11-04 起供 HabitWidgetProvider 复用（chip 三件套不复制第二份） */
    private static final int HABIT_HEAD_DP = 13;

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

    /**
     * 用户拖动把手把组件改大 / 改小了。
     *
     * **必须重写**（2026-11-02 加）：launcher 改尺寸时**只发这个回调**，
     * 不会再发 APPWIDGET_UPDATE —— 不在这里重画，外壳变大了、内容还是按旧
     * 高度算的那一份（时间轴挤在上半截、下面空一大块），用户看到的就是
     * 「大小根本改不了」。计数器组件早就重写了这个方法，日程组件一直漏着。
     */
    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager mgr,
                                          int widgetId, Bundle newOptions) {
        if (Log.isLoggable(TAG, Log.DEBUG)) {
            Log.d(TAG, "onAppWidgetOptionsChanged id=" + widgetId
                    + " minH=" + (newOptions == null ? -1
                        : newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT))
                    + " maxH=" + (newOptions == null ? -1
                        : newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)));
        }
        render(c, mgr, widgetId, WidgetPrefs.snapshot(c), WidgetPrefs.selectedDay(c));
    }

    @Override
    public void onDisabled(Context c) {
        super.onDisabled(c);
        // 桌面上最后一个**日程**实例被移除 → 本组件没东西可画了。但换日闹钟是
        // 全 App 共用的一条（2026-11-04 起打卡组件也靠它翻页）——只有当打卡
        // 实例也不剩时才撤。
        if (!hasHabitInstances(c)) cancelDaily(c);
    }

    /** 桌面上还留着打卡组件实例（闹钟撤不撤的判据） */
    private static boolean hasHabitInstances(Context c) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            int[] ids = mgr.getAppWidgetIds(
                    new android.content.ComponentName(c, HabitWidgetProvider.class));
            return ids != null && ids.length > 0;
        } catch (Exception e) {
            return true;   // 查不到就当还有——多留一条闹钟无害，掐错了打卡组件不翻页
        }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        final String a = intent.getAction();
        if (ACTION_DAILY.equals(a)) {
            // 每天换日：重画一次（doRefresh 里会顺手把明天的闹钟续上），然后收工。
            // 2026-11-04：打卡组件的「今天」也要跟着翻页——闹钟只有这一条（由
            // 日程组件排），顺带把 HabitWidgetProvider 一起刷，打卡组件不自己排闹钟。
            refresh(c);
            HabitWidgetProvider.refresh(c);
            return;
        }
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
        }
        // 2026-11-04 拆分：ACTION_HABIT / ACTION_HABITS_TOGGLE 随打卡区迁往
        // HabitWidgetProvider.onReceive，本组件不再有打卡交互

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
    static final long FLUSH_MIN_GAP_MS = 60_000;

    /**
     * 重入保护：已经在刷就别再进一次。
     *
     * 2026-10-14（用户报「整个 App 卡在开屏页不能操作」时加）：`refresh` 里会调
     * `RepeatSpawn.refillAll`，而 `spawn` 补完实例后**又直接调 refresh** ——
     * 普通 Java 调用，不是广播，所以它是在**当前线程（主线程）上递归**的。
     *
     * 平时靠 `spawn` 里的 `if (made == 0) return;` 自终止：第二轮补不出新东西
     * 就收手。但只要存在「补得出来、转头又被别处删掉」的系列
     * （比如已结束的系列），每一轮都 `made > 0` → 无限递归 → 主线程被钉死、
     * WebView 永远画不出首屏，连 DevTools 求值都超时。
     *
     * 所以这里加一道**结构性**的保险：不管数据什么样，刷新最多嵌套一层。
     * 数据层面的判据（`repeatUntil`）是另一道，两道都要有。
     */
    private static boolean refreshing = false;

    /** 广播给所有实例重画 */
    static void refresh(Context c) {
        if (refreshing) return;      // 已经在刷里了，别递归
        refreshing = true;
        try {
            doRefresh(c);
        } finally {
            refreshing = false;
        }
    }

    private static void doRefresh(Context c) {
        // 提醒闹钟跟着数据走：刷新一次就整体重排（新建 / 编辑 / 删除 / 勾完成
        // 都会走到这里，见 ReminderScheduler 的说明）。
        ReminderScheduler.reschedule(c);

        /* 重复任务的窗口补齐（2026-10-14）。
         *
         * 原来只在「新建 / 编辑那一刻」派生一次，用户设完就走，之后几天窗口
         * 用完就断了（他报「每天只重复几天就断了」）。这里挂在 refresh 上：
         * 组件每次刷新都会检查一遍，窗口不足就补。refillAll 幂等且窗口够时
         * 直接返回，不会有额外开销或请求。
         *
         * 必须在 ReminderScheduler 之前还是之后无所谓，但要在读快照之前跑 ——
         * 它会写快照，补出来的新实例要参与本次渲染。 */
        RepeatSpawn.refillAll(c);

        AppWidgetManager mgr = AppWidgetManager.getInstance(c);
        int[] ids = mgr.getAppWidgetIds(new android.content.ComponentName(c, ScheduleWidgetProvider.class));
        if (ids != null && ids.length > 0) {
            // 逐个渲染而不是批量 updateAppWidget(ids, v) —— 每个实例的尺寸可能
            // 不同（用户能各自拖大拖小），行高档位要按各自的 options 算
            WidgetSnapshot snap = WidgetPrefs.snapshot(c);
            String day = WidgetPrefs.selectedDay(c);
            for (int id : ids) render(c, mgr, id, snap, day);
        }
        // 每次刷新都（幂等）续一条明天的换日闹钟。开机/重启后由 ReminderReceiver 补排。
        // 2026-11-04：桌面上**只剩打卡组件**时也要排——全 App 只有这一条换日闹钟，
        // 打卡组件的「今天」翻页靠它（ACTION_DAILY 会顺带刷那边）。以前这里
        // 在「没有日程实例」时提前 return，闹钟就永远不排了。
        scheduleDaily(c);

        // 2026-11-04 拆分：打卡组件跟着一起重画。共用快照、共用设置
        //（透明度 / 字号在同一个设置弹框里改）、共用离线队列（flush 的 settle
        // 也走到这里）——只刷日程实例会让打卡组件停留在旧外观。
        // 打卡侧 render 不会再回调本方法，无递归风险。
        HabitWidgetProvider.refresh(c);
    }

    /* ======================= 每日换日闹钟 ======================= */

    /** 排下一条「过 0 点重画」闹钟。一次性 + 每次触发自己续，避免 setRepeating 在 Doze 下漂移。 */
    static void scheduleDaily(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextDailyAt(), dailyIntent(c));
        } catch (Exception e) {
            Log.w(TAG, "排换日闹钟失败: " + e);
        }
    }

    static void cancelDaily(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(dailyIntent(c));
        } catch (Exception e) {
            Log.w(TAG, "取消换日闹钟失败: " + e);
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
        Intent i = new Intent(c, ScheduleWidgetProvider.class).setAction(ACTION_DAILY);
        return PendingIntent.getBroadcast(c, ACTION_DAILY.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* ============================ 渲染 ============================ */

    /**
     * 组件**当前**有多高（dp）。
     *
     * ⚠️ 必须按屏幕方向取：`OPTION_APPWIDGET_MIN_HEIGHT` 是**竖屏**下的当前高度，
     * `MAX_HEIGHT` 是**横屏**下的（手机上更矮）。2026-11-02 之前这里读的一直是
     * MAX_HEIGHT —— 竖屏把组件拖高，读到的还是横屏那个矮值，于是内容一点都不
     * 跟着长，看起来就是「大小改不了」。CounterWidgetProvider 一直用的是
     * MIN_*，这里对齐。
     */
    static int widgetHeightDp(Context c, AppWidgetManager mgr, int widgetId) {
        int h = 0;
        try {
            Bundle o = mgr.getAppWidgetOptions(widgetId);
            boolean land = c.getResources().getConfiguration().orientation
                    == Configuration.ORIENTATION_LANDSCAPE;
            h = o.getInt(land
                    ? AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT
                    : AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            if (h <= 0) h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        } catch (Exception e) {
            Log.w(TAG, "读组件高度失败: " + e);
        }
        return h > 0 ? h : 300;
    }

    private static void render(Context c, AppWidgetManager mgr, int widgetId,
                               WidgetSnapshot snap, String day) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_schedule);
        // 「今天」一律按手机实时日期算（2026-10-31 修）。
        // 以前优先用快照里的 today —— 但快照只在 App 推送时更新，App 几天没开
        // 就会停在旧日期：左上角徽标和日期条的绿色「今天」标记会一直停在几天前
        // （用户报：31 号了，徽标还写 29、29 那格还是绿的）。而圆圈走的是实时的
        // selectedDay，于是「圆圈对、绿字和徽标错」，两者自相矛盾。
        // 打卡写入的日期不受影响：toggleHabit 自己按实时今天算。
        String today = WidgetPrefs.today(c);

        // 底板透明度：连续档位里挑一张（每 2% 一张，见 drawable/widget_bg_a*.xml）
        final int alpha = WidgetPrefs.alpha(c);
        v.setInt(R.id.widget_root, "setBackgroundResource", bgFor(c, alpha));

        String monday = mondayOf(day);
        v.setTextViewText(R.id.tv_month, monthTitle(day));
        // 左上角徽标 = **黑白日历 + 当天日期数字**。用户 2026-10-14：
        // 光一个数字太素，要日历小图标、中间写着今天几号；点一下仍回今天。
        v.setTextViewText(R.id.tv_logo_day, dayOfMonth(today));

        /* ---- 预算与缩放系数（提前到一切渲染之前）----
           2026-11-03：字/圆/格都要乘 k，而日期条、打卡区在时间轴之前就渲染，
           所以这套计算必须放在最前面，不能等画完头部再算。 */
        int lo = WidgetPrefs.startHour(c);
        int hi = WidgetPrefs.endHour(c);
        List<WTask> dayTasks = snap.tasksOf(day);
        List<WTask> timed = new ArrayList<>();
        List<WTask> untimed = new ArrayList<>();
        for (WTask t : dayTasks) {
            if (t.time == null) untimed.add(t);
            else timed.add(t);
        }

        /* ---- 2026-11-04 拆分：打卡区分桶整体迁到 HabitWidgetProvider ----
           本组件只剩时间表，snap.habits / groups 不再参与这里的任何预算。 */

        // 未定时区实占多少高：**两两一行**，行数随任务增加（最多 3 行 = 6 格）。
        // 2026-10-25 修（用户报「最底下的时间数值被挡住、显示不完整」）：
        // 以前这里只按常驻的 PANEL_BAR_DP(15) 算，未定时任务一多，顶行实际长到
        // 30/45dp，时间轴却仍按 15dp 分预算 → 时间轴画得比可用空间高，底部被裁，
        // 最后一格刻度（20 点那个数字）就剩半截。按实际行数算，一分不差。
        int untimedShown = Math.min(untimed.size(), UNTIMED_MAX);
        int untimedRows = (untimedShown + 1) / 2;
        int barDp = Math.max(PANEL_BAR_DP, untimedRows * UNTIMED_ROW_DP);

        // 时间轴能分到多少高度。**顶部和面板的固定件全是定值**（用户要求顶部
        // 不随组件缩放），所以这里能精确算出来。组件越高，多出来的全给时间轴。
        int totalDp = widgetHeightDp(c, mgr, widgetId);

        /* ---- 缩放系数（2026-11-04 用户：字体不随组件尺寸变，只跟字号档位走）----
           以前两层相乘：sizeK（组件越大字越大）× fontScale。用户明确不要 sizeK
           那层——组件拉大只该多装内容，字号本身不变。现在 k 只有字号档位。 */
        float k = WidgetPrefs.fontScale(c) / 100f;
        Metrics m = new Metrics(k);
        // 未定时区的横条高度也要跟着缩（行数不变，单行高度 × k）
        barDp = Math.max(m.panelBar, untimedRows * m.untimedRow);

        // 全部固定件（缩放后）。2026-11-04 拆分后打卡区不在这份预算里了，
        // 时间轴 = 总高 − 固定件，一步到位。
        //
        // ⚠️ 2026-11-05（第三次修圆角）：底部留白回到 2dp —— 桌面圆角**不再靠
        // root padding 硬留**（试过 4 / 14 / 20 / 32，全都不对：留少了被切、
        // 留多了格子被挤掉甚至轴溢出）。现在由 renderScale 的 cornerGuardDp
        // 只给刻度列留，任务区照常画满。这里必须和 widget_schedule.xml 的
        // root paddingBottom 一致（都是 2dp）。
        final int fixedDp = 10                       // root padding：上 8 + 下 2
                + m.headRow + 2                 // head 行（FrameLayout 30dp）+ margin
                + m.dateStrip + 2              // 日期条 + margin
                + barDp + 1 + 2;                // 未定时区（按实际行数）+ 横分割线 + margin

        /* ---- 顶部：标题、日期徽标、四颗按钮随 k 缩放（宽高 + 字号） ---- */
        v.setViewLayoutHeight(R.id.head_row, m.headRow, TypedValue.COMPLEX_UNIT_DIP);
        scaleView(v, R.id.iv_logo, 26, k);
        scaleView(v, R.id.btn_prev_month, 20, k);
        scaleView(v, R.id.btn_next_month, 20, k);
        scaleView(v, R.id.btn_add, 26, k);
        scaleView(v, R.id.btn_settings, 26, k);
        font(v, R.id.tv_logo_day, 10, k);
        font(v, R.id.tv_month, 15, k);
        // 十字面板左列（左上空白角 + 左下刻度列）同宽同缩，竖线才不错位
        v.setViewLayoutWidth(R.id.panel_corner, m.scaleW, TypedValue.COMPLEX_UNIT_DIP);
        v.setViewLayoutWidth(R.id.tl_scale, m.scaleW, TypedValue.COMPLEX_UNIT_DIP);

        /* ---- 日期条：选中日所在的那一周 ---- */
        v.removeAllViews(R.id.date_strip);
        for (int i = 0; i < 7; i++) {
            String iso = addDays(monday, i);
            RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_day_chip);
            boolean sel = iso.equals(day);
            boolean isToday = iso.equals(today);
            chip.setTextViewText(R.id.chip_wd, WD[i]);
            chip.setTextViewText(R.id.chip_date, dayOfMonth(iso));
            // 字与圆随 k 缩放（2026-11-03）。圆的父框 chip_frame 宽=高 → 缩放后
            // 仍是正圆；chip_circle / chip_date 都是 match_parent，跟着框走。
            font(chip, R.id.chip_wd, 8, k);
            font(chip, R.id.chip_date, 11, k);
            scaleView(chip, R.id.chip_frame, 20, k);
            // 圆放在**固定 26dp 的 chip_circle** 上（宽高相等 → 永远是正圆）。
            // 不能放在 chip_root 上：那是 weight 等分出来的矩形，oval 铺上去
            // 必然被拉成椭圆 —— 这正是用户看到的「选中的日期变成了椭圆」。
            chip.setInt(R.id.chip_circle, "setBackgroundResource",
                    sel ? R.drawable.widget_chip_bg_sel : 0);
            // 星期是固定的，**不用白色**（白字在没有底的星期上会看不见）；
            // 选中时只把它染成主绿做轻微提示（用户 2026-10-14 第八轮）。
            chip.setTextColor(R.id.chip_wd, sel ? 0xFF27795A : 0xFF6B8574);
            // 今天那格即使没选中也用主绿写字，一眼能找到；选中=圆圈内白字
            chip.setTextColor(R.id.chip_date,
                    sel ? 0xFFFFFFFF : (isToday ? 0xFF27795A : 0xFF1B3A2A));
            chip.setOnClickPendingIntent(R.id.chip_root,
                    WidgetIntent.of(c, ACTION_PICK_DAY, iso).put(EXTRA_DAY, iso).build(c));
            v.addView(R.id.date_strip, chip);
        }

        /* ---- 2026-11-04 拆分：打卡区整体移除（迁往 HabitWidgetProvider）----
           布局里的 habit_rows 容器留着但恒 GONE —— 删容器要动 XML、且旧版
           快照用户升级后第一次渲染前，RemoteViews 对缺失 id 会抛。藏掉最稳。 */
        v.setViewVisibility(R.id.habit_rows, View.GONE);

        // 时间轴拿剩下的（至少 40dp，见 renderScale 的说明）。
        // ⚠️ 2026-11-05：下限从 70 降到 40。以前挤掉高度后仍按 70 画，时间轴会
        // **溢出 panel 底边**，最下面那条「终点数字」照样被圆角切掉 —— 加多少
        // padding 都没用。40dp 在最小号字体下仍够画 12 格。
        int timelineDp = Math.max(40, totalDp - fixedDp);

        /* 轴尾 = 设定终点，但**晚间任务不能因此丢掉**：轴现在只画到终点，
           有任务跨过终点就把它延到任务结束的那个整点（没有就没有代价）。 */
        int hiEff = hi;
        for (WTask t : timed) {
            int end = startMin(t) + durOf(t);
            hiEff = Math.max(hiEff, (end + 59) / 60);
        }

        boolean isToday = day.equals(today);
        int nowMin = isToday ? nowMinutes() : -1;
        renderScale(c, v, lo, hiEff, timelineDp, m);
        renderTimeline(c, v, timed, lo, hiEff, timelineDp, isToday, nowMin, m);
        renderUntimedBar(c, v, untimed, m);

        /* ---- 底部状态：用户 2026-10-14 要求整行去掉，页面更精简 ---- */
        v.setViewVisibility(R.id.tv_footer, View.GONE);

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

    /* ============ 打卡 chip 三件套（2026-11-04 起供 HabitWidgetProvider 复用） ============
       渲染工具留在这里、不复制第二份（用户 2026-10-13 的「先想能不能复用已有的」）。
       完成态判定、底色语言、占位补法全部原样保留。 */

    /** 分组标题行。灰绿小字，与 App 打卡页的组头同一套视觉语言；不可点 */
    static RemoteViews habitHead(Context c, String name, float k) {
        RemoteViews head = new RemoteViews(c.getPackageName(), R.layout.widget_habit_head);
        head.setTextViewText(R.id.habit_head, name);
        font(head, R.id.habit_head, 8, k);
        return head;
    }

    /**
     * 一颗打卡 chip。
     *
     * 完成态按**要显示的那一天**取（不能用快照里按「今天」算好的 h.done ——
     * 翻到别的日期会整片误亮，2026-10-14 修）。没有 log 表的老快照只能拿 done
     * 兜底，且只对「今天」有意义。
     *
     * 点击意图由调用方给（{@code pi}）：2026-11-04 拆分后 chip 归打卡组件，
     * 它用自己的 action / requestCode 空间，这里只负责画和挂。
     */
    static RemoteViews habitChip(Context c, WHabit h, String day, String today,
                                 float k, android.app.PendingIntent pi) {
        RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_habit_chip);
        chip.setTextViewText(R.id.habit_chip, h.title);
        boolean hDone = h.log != null
                ? h.log.optBoolean(day, false)
                : (h.done && day.equals(today));
        chip.setInt(R.id.habit_chip, "setBackgroundResource",
                hDone ? R.drawable.widget_habit_bg : R.drawable.widget_habit_bg_done);
        chip.setTextColor(R.id.habit_chip, hDone ? 0xFF7E8F84 : 0xFF1B3A2A);
        font(chip, R.id.habit_chip, 8, k);
        if (pi != null) chip.setOnClickPendingIntent(R.id.habit_chip, pi);
        return chip;
    }

    /** 占位 chip：不满一行时补空格，让已有那几个的宽度跟满行一致 */
    static RemoteViews emptyChip(Context c) {
        RemoteViews chip = new RemoteViews(c.getPackageName(), R.layout.widget_habit_chip);
        chip.setTextViewText(R.id.habit_chip, "");
        chip.setInt(R.id.habit_chip, "setBackgroundResource", 0);
        return chip;
    }

    /** chip 行高基准（dp）。HabitWidgetProvider 用它算每屏几行，保持两组件同一密度 */
    static final int HABIT_ROW_DP = 18;

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

    /**
     * 时间轴**最后一条**占多高：只为了放「终点那个小时」的数字。
     *
     * 2026-10-25：轴以前画到「设定终点 + 1 小时」，多出来的那格没有数字，
     * 轴底就白出一整格（约 14dp）—— 用户连着三轮说「底部空太多」。
     * 现在主体只画到终点，终点数字单独占这一条贴在轴底。
     * 10dp 是量出来的：8sp 一行约 5.7dp，但 TextView 自带最小高度 + 上下留白
     * 约 7dp，给 6dp 时数字会被父容器裁掉下半截（2026-10-25 装机实测）。
     */
    private static final int AXIS_END_DP = 10;

    /** 十字面板左列宽（左上空白角 / 左下刻度列共用，2026-10-14 定 20dp） */
    private static final int SCALE_COL_DP = 20;

    /** 未定时横条最多直接露几个，超出的折成一格「+N」 */
    /** 未定时区最多显示的**格子数**（3 排 × 每排 2 格，2026-10-25 用户定：
     *  两两一行、行数随任务增加；再多折「+N」—— 再多就没法看了，
     *  行数继续长会把时间轴挤没）。 */
    private static final int UNTIMED_MAX = 6;
    /** 未定时区**一行**（两张半宽卡）占高。2026-10-25：16 → 15dp（整体缩一号） */
    private static final int UNTIMED_ROW_DP = 15;
    /**
     * 日期条占高。2026-10-14 第八轮：高亮圈只包日期数字后，结构变成
     * 「星期（9sp）在上 + 日期圆（22dp）在下」，条高 29 → **35dp**。
     * 2026-10-25：字号各小 1sp、圆 22 → 20dp，条高收到 **33dp**。
     */
    private static final int DATE_STRIP_DP = 33;
    /** 十字面板顶行（左空白角 + 右未定时区）的最小高度。常驻，不随有无任务变。
     *  2026-10-25：15 → 14dp（整体缩一号） */
    private static final int PANEL_BAR_DP = 14;
    /**
     * 任务卡最小高度。
     *
     * 2026-10-13 由 13dp 提到 **15dp**：字号固定成 9sp 之后不再随块高缩小，
     * 很短的卡片（5 分钟任务）如果只有 13dp，去掉 1dp 上下 padding 后
     * 只剩 11dp 放字，会被裁。
     *
     * 2026-10-25：字号 9 → 8sp，最小高同步 15 → **14dp**（8sp 一行约 11dp，
     * 加 1dp 上下 padding 共 13dp，装得下）。
     */
    private static final int MIN_BLOCK_DP = 14;
    /**
     * 任务卡上允许画第二行（详细内容摘要）的**最小块高**。
     *
     * 8sp 一行约 11dp，两行 22dp，再加上 1dp 上下 padding —— 低于这个高度就只
     * 画标题。这块的高度是按任务时长钉死的，15 分钟的任务只有 15dp，
     * 硬塞两行会把两行的头尾一起切掉。
     */
    private static final int NOTE_LINE_MIN_DP = 24;

    /**
     * 一次渲染里随缩放系数 k 变化的全部尺寸（2026-11-03）。
     * 常量是**设计基准值**，这里统一乘 k 得到实际用的 dp —— 免得每处手乘、
     * 漏一处就出现「字大了格子没大」的错位。
     */
    static class Metrics {
        final float k;
        final int dateStrip, panelBar, untimedRow, habitRow, minBlock, noteMin, axisEnd, lineOff, headRow;
        /** 十字面板左列宽（左上空白角 + 左下刻度列必须同宽，2026-11-03 随 k 缩放） */
        final int scaleW;
        /** 未定时区单张卡的高（行高 untimedRow 里减去那条缝） */
        final int untimedCard;
        /** 分组标题行高（2026-11-03 随 k 缩放） */
        final int habitHead;

        Metrics(float k) {
            this.k = k;
            dateStrip = px(DATE_STRIP_DP, k);
            panelBar = px(PANEL_BAR_DP, k);
            untimedRow = px(UNTIMED_ROW_DP, k);
            habitRow = px(HABIT_ROW_DP, k);
            minBlock = px(MIN_BLOCK_DP, k);
            noteMin = px(NOTE_LINE_MIN_DP, k);
            axisEnd = px(AXIS_END_DP, k);
            lineOff = px(LINE_OFFSET_DP, k);
            headRow = px(30, k);
            scaleW = px(SCALE_COL_DP, k);
            untimedCard = px(UNTIMED_ROW_DP - 1, k);
            habitHead = px(HABIT_HEAD_DP, k);
        }

        static int px(int base, float k) {
            return Math.max(1, Math.round(base * k));
        }
    }

    /** 文字随 k 缩放（sp）。RemoteViews 有 setTextViewTextSize（API 16+），最稳的一条路 */
    static void font(RemoteViews v, int id, float baseSp, float k) {
        v.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, Math.max(1f, baseSp * k));
    }

    /** 方形图标视图随 k 缩放（宽高一起）。setViewLayoutWidth/Height 是 API 31+，
     *  与时间轴定位用的 setViewLayoutHeight 同一条款 —— 目标机 API 36，没问题 */
    static void scaleView(RemoteViews v, int id, int baseDp, float k) {
        int d = Metrics.px(baseDp, k);
        v.setViewLayoutWidth(id, d, TypedValue.COMPLEX_UNIT_DIP);
        v.setViewLayoutHeight(id, d, TypedValue.COMPLEX_UNIT_DIP);
    }

    /**
     * 时间轴「画几格 + 每几个钟头写一个数字」。
     *
     * **返回 {bands, step}**，刻度列和网格层共用同一份 —— 两边都必须据此算高度，
     * 否则左边的数字和右边的小时线会越往下越错开。
     *
     * 2026-10-25（用户连着三轮「底部空太多」）真凶在这里：以前格子数恒定等于
     * {@code hi - lo + 1}，也就是「设到 20 点」实际画到 **21 点** —— 多出整整
     * 一格，而数字是隔 2 小时写一个的，21 是奇数格没有数字，于是轴底白出一整格
     * （约 14dp），比留白本身显眼得多。留白怎么调都调不掉，因为白的是「多出来的
     * 那一小时」。
     *
     * 现在按设定范围画 {@code hi - lo} 格（8 → 20 就是 12 格，正好到 20:00），
     * 终点数字单独占一条 {@link #AXIS_END_DP} 高的尾巴压在轴底 —— 轴底再没有
     * 空出来的格子。
     */
    private static int[] axisPlan(int lo, int hi, int timelineDp, int axisEndDp) {
        int bands = Math.max(1, hi - lo);
        float dph = Math.max(1, timelineDp - axisEndDp) / (float) bands;
        // 行高很小 → 数字会叠在一起，隔 2~3 小时才写一个（判据跟 App 日视图一致）
        int step = dph < 11f ? 3 : (dph < 16f ? 2 : 1);
        return new int[]{bands, step};
    }

    /** 时间轴主体（不含贴底那一条终点数字）的高度 */
    private static int axisHeight(int timelineDp, int axisEndDp) {
        return Math.max(1, timelineDp - axisEndDp);
    }

    /**
     * 刻度列最底部**必须让给桌面圆角遮罩**的高度（dp）。
     *
     * 2026-11-05（第三次修圆角）。前两轮的坑：
     * · 第一轮给底行加 paddingBottom=4dp → 「21」整个消失（格子被压掉）；
     * · 第二轮给 root 加 paddingBottom 14/20/32dp → 轴整体上移了，但 21 还是被切。
     *
     * 真凶有两个：
     * 1. `timelineDp = Math.max(70, totalDp - fixedDp)` 的下限 70 一挤就顶住，
     *    时间轴画得比 panel 还高，溢出的部分又被圆角吃掉 —— 加多少底距都没用；
     * 2. 桌面（ColorOS）在组件外面**另加了一层圆角遮罩**，半径比 drawable 的 20dp
     *    更大，且随组件高度变。刻度列宽只有 20dp，圆弧在这个 x 位置扫过的高度
     *    是 `r - sqrt(r² - (r-20)²)`（r=32 时约 12dp），数字顶在格子顶部正好被切。
     *
     * 现在不猜底距：轴画满 panel，底部**只在刻度列这一支**留出这个高度，
     * 数字放在这段高度**上方**，绕开圆弧。
     */
    private static int cornerGuardDp(Context c, Metrics m) {
        int r = widgetCornerRadiusDp(c);
        int inset = m.scaleW;                       // 数字离组件左边缘的距离
        if (r <= inset) return 4;
        int guard = r - (int) Math.round(
                Math.sqrt((double) r * r - (double) (r - inset) * (r - inset)));
        return Math.min(30, guard + 2);             // +2dp 余量，抗 launcher 遮罩抖动
    }

    /**
     * 桌面给小组件套的圆角半径（dp），best-effort。
     *
     * 系统 dimen `system_app_widget_background_radius` 是 AOSP 给 launcher 用的
     * 那个值（Android 12+ 存在），ColorOS 等 ROM 大多沿用。读不到就退到 28dp
     * —— 这是实测这家 ROM 的量级，稍大一点只是多留一点白，不会切字。
     */
    private static int widgetCornerRadiusDp(Context c) {
        try {
            int id = c.getResources().getIdentifier("system_app_widget_background_radius",
                    "dimen", "android");
            if (id != 0) {
                int px = c.getResources().getDimensionPixelSize(id);
                if (px > 0) return Math.round(px / c.getResources().getDisplayMetrics().density);
            }
        } catch (Exception ignored) {
            // 读不到走默认
        }
        return 28;
    }

    /**
     * 十字面板左下角的**刻度列**。
     *
     * 和右下主体的网格格用**同一个高度公式**（累进取整，避免逐行攒出误差），
     * 所以左边的数字和右边的小时线严格同高。
     *
     * 2026-11-05：数字改成**顶对齐到自己的整点线**（不再跟着网格整体下移
     * LINE_OFFSET_DP）。网格/任务卡下移 5dp 是为了让卡片落在整点内部，刻度列
     * 跟着下移会把最底下那格的字推出轴底 —— 那就是「21 直接没了」的真凶。
     *
     * 轴底那段 `guard` 高度留给桌面圆角：数字一律在 guard 之上，最底下那条
     * 「终点数字」也整条落在这条线上方，不再贴轴底。
     */
    private static void renderScale(Context c, RemoteViews v, int lo, int hi,
                                    int timelineDp, Metrics m) {
        v.removeAllViews(R.id.tl_scale);
        int[] plan = axisPlan(lo, hi, timelineDp, m.axisEnd);
        int bands = plan[0];
        int step = plan[1];
        int guard = cornerGuardDp(c, m);

        /* 有数字的格子 = lo, lo+step, ... ，每个数字顶在自己的整点线上；
           轴底往上 guard 以内不写字（桌面圆角的裁剪区）。
           数字顶对齐、占约 8dp 高 → 一个数字要完整显示，它的格顶必须
           ≤ 轴底 - guard - 8。放不下的最后那个整点，把数字挪进轴尾（轴尾
           自身高度已经含 guard，数字排在 guard 之上）。 */
        int numH = Math.round(8 * m.k);             // 一行 8sp 数字的实际占高
        int endNum = lo + bands;                    // 终点数字（如 21）
        int lastOkIdx = -1;                         // 最后一个「放得下」的整点格下标
        float dpPerBand = axisHeight(timelineDp, m.axisEnd) / (float) bands;
        for (int k = 0; k < bands; k += step) {
            if (Math.round(k * dpPerBand) <= timelineDp - guard - numH) lastOkIdx = k;
        }
        // 倒数第一格（bands-step）放得下吗？放不下 → 它的数字并进轴尾，尾巴里两行
        boolean lastBandFits = (lastOkIdx >= bands - step);

        int prevY = 0;
        for (int k = 0; k < bands; k++) {
            int nextY = Math.round((k + 1) * dpPerBand);
            int hgt = Math.max(1, nextY - prevY);
            prevY = nextY;

            boolean show = (k % step == 0) && (k <= lastOkIdx);
            RemoteViews e = new RemoteViews(c.getPackageName(), R.layout.widget_tl_hour);
            e.setViewLayoutHeight(R.id.tl_hour, hgt, TypedValue.COMPLEX_UNIT_DIP);
            e.setTextViewText(R.id.tl_hour, show ? String.format(Locale.US, "%02d", lo + k) : "");
            // 刻度数字恒为普通灰。**不再给「当前那一小时」标红**（用户 2026-10-14：
            // 不要任何「现在几点」的体现）。
            e.setTextColor(R.id.tl_hour, 0xFFA2B5A9);
            font(e, R.id.tl_hour, 8, m.k);
            v.addView(R.id.tl_scale, e);
        }

        /* 轴尾：从主体底部一直到底（含 guard）。
           · 倒数第一格放不下 → 它和终点数字一起放这里（两行竖排）
           · 都排在 guard 之上，永远不会被桌面圆角切 */
        String tailText = lastBandFits
                ? String.format(Locale.US, "%02d", endNum)
                : String.format(Locale.US, "%02d\n%02d", lo + bands - step, endNum);
        int lines = lastBandFits ? 1 : 2;
        int tailDp = m.axisEnd + guard + (lines - 1) * numH;

        RemoteViews tail = new RemoteViews(c.getPackageName(), R.layout.widget_tl_hour);
        tail.setViewLayoutHeight(R.id.tl_hour, tailDp, TypedValue.COMPLEX_UNIT_DIP);
        tail.setTextViewText(R.id.tl_hour, tailText);
        tail.setTextColor(R.id.tl_hour, 0xFFA2B5A9);
        font(tail, R.id.tl_hour, 8, m.k);
        if (lines > 1) {
            // setInt 走 RemoteViews 的「setXxx(Type)」反射，只认 int/boolean 包装；
            // false 会被当成 Object 找不到方法，必须用 0
            tail.setInt(R.id.tl_hour, "setSingleLine", 0);
            tail.setInt(R.id.tl_hour, "setMaxLines", 2);
        }
        v.addView(R.id.tl_scale, tail);
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
                                       boolean isToday, int nowMin, Metrics m) {
        int[] plan = axisPlan(lo, hi, timelineDp, m.axisEnd);
        int bands = plan[0];
        int fromMin = lo * 60;
        int toMin = (lo + bands) * 60;
        // 扣掉整体下移量。**线、红线和任务卡共用这一个比例**，
        // 所以下移之后三者仍然严格对齐（见 LINE_OFFSET_DP）。
        int innerDp = Math.max(1, axisHeight(timelineDp, m.axisEnd) - m.lineOff);
        float dpPerMin = innerDp / (float) (bands * 60);
        float dpPerHour = innerDp / (float) bands;

        /* ---- 网格层：等高的格子，格子的顶边就是整点。只有线，刻度在左侧列 ---- */
        v.removeAllViews(R.id.tl_grid);
        v.addView(R.id.tl_grid, spacer(c, m.lineOff));
        int prevY = 0;
        for (int k = 0; k < bands; k++) {
            // 用累进目标值取整，避免逐行四舍五入攒出十几 dp 的偏移
            int nextY = Math.round((k + 1) * dpPerHour);
            int hgt = Math.max(1, nextY - prevY);
            prevY = nextY;

            RemoteViews e = new RemoteViews(c.getPackageName(), R.layout.widget_tl_line);
            e.setViewLayoutHeight(R.id.tl_line, hgt, TypedValue.COMPLEX_UNIT_DIP);
            v.addView(R.id.tl_grid, e);
        }

        /* ---- 「现在」红线：**整层已删除**（用户 2026-10-14：不要任何
           「现在几点」的体现 —— 刻度标红和这条红线一起去掉，
           连 widget_schedule.xml 里的 tl_now 容器也删了） ---- */

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
        int cursor = -m.lineOff;
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
            int spanDp = Math.max(m.minBlock, Math.round((clE - clS) * dpPerMin));
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
                    int hDp = Math.max(m.minBlock, Math.round((ev.e - ev.s) * dpPerMin));
                    if (sDp - inner > 0) colv.addView(R.id.tl_col, spacer(c, sDp - inner));
                    colv.addView(R.id.tl_col, taskBlock(c, ev.t, hDp, m));
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

    private static RemoteViews taskBlock(Context c, WTask t, int hDp, Metrics m) {
        RemoteViews block = new RemoteViews(c.getPackageName(), R.layout.widget_task_block);
        /* 给不给第二行，看**这块有多高**（8sp 两行 ≈ 24dp，见 NOTE_LINE_MIN_DP）。
           块矮时硬塞两行会把两行的头尾一起切掉 —— 那是比只画标题更糟的读法。
           15 分钟的小块本来就只够放一个名字。 */
        boolean roomy = hDp >= m.noteMin;
        CharSequence text = label(t, roomy);
        // 完成态整块是灰的，不需要再分色
        if (!t.done) text = dimTimePrefix(text, t);
        block.setTextViewText(R.id.task_block, text);
        block.setViewLayoutHeight(R.id.task_block, hDp, TypedValue.COMPLEX_UNIT_DIP);
        // ⚠️ 字号**不按块高变化**（用户 2026-10-13），但**随缩放系数走**
        //（2026-11-03：字号档位 + 组件尺寸同比）—— 基准 8sp 写在
        // widget_task_block.xml 里，这里乘 k 覆盖。
        font(block, R.id.task_block, 8, m.k);
        if (t.done) {
            // 完成后**整块退色**：底变浅灰、字转灰。
            // **不用删除线** —— 用户明确反感过，那东西在本来就不宽的任务块里太吵。
            block.setInt(R.id.task_block, "setBackgroundResource",
                    R.drawable.widget_task_bg_done);
            block.setTextColor(R.id.task_block, 0xFF7E8F84);
        } else {
            // 未完成：与未完成打卡同一主绿（#27795A）+ 白字，做到「未完成的任务和
            // 未完成的打卡」同一色系（用户 2026-10-14：两类未完成要同色）。
            block.setInt(R.id.task_block, "setBackgroundResource",
                    R.drawable.widget_task_bg);
            block.setTextColor(R.id.task_block, 0xFF1B3A2A);
        }
        block.setOnClickPendingIntent(R.id.task_block,
                WidgetIntent.of(c, ACTION_TASK, "t" + t.id).put(EXTRA_ID, t.id).build(c));
        return block;
    }

    /**
     * 十字面板**右上角**的未定时区。
     *
     * 用户 2026-10-13 定的形态：**不写「未定时」三个字** —— 左边的空白角
     * 就是这一行的标记（两者是同一块面板的四格之一，不是两块）。
     * 2026-10-25 改**两两一行**：每行两格半宽、行数随任务增加（最多 3 排 =
     * 6 格）；奇数落单时右半格留空（1A）；超过 6 个折成最后一格「+N」（2A）。
     * 空 n=0 时整区留空 —— 外层 minHeight 15dp 保住空白角与分割线常驻。
     */
    private static void renderUntimedBar(Context c, RemoteViews v, List<WTask> untimed, Metrics m) {
        v.removeAllViews(R.id.untimed_bar);
        int n = untimed.size();
        if (n == 0) return;

        boolean fold = n > UNTIMED_MAX;
        int shown = fold ? UNTIMED_MAX - 1 : n;   // 折叠时留一格给「+N」

        for (int i = 0; i < shown; i += 2) {
            RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_untimed_pair);
            // 行高随 k（XML 里 15dp 只是缺省；2026-11-03 同比缩放）
            row.setViewLayoutHeight(R.id.untimed_pair, m.untimedRow, TypedValue.COMPLEX_UNIT_DIP);
            row.addView(R.id.untimed_pair, untimedCard(c, untimed.get(i), m));
            if (i + 1 < shown) {
                row.addView(R.id.untimed_pair, untimedCard(c, untimed.get(i + 1), m));
            } else if (fold) {
                // 折叠：最后一个显示位旁边那格给「+N」
                row.addView(R.id.untimed_pair, untimedMore(c, n - shown, m));
            } else {
                // 奇数落单（1A）：右半格空占位，把左卡顶成半宽
                row.addView(R.id.untimed_pair,
                        new RemoteViews(c.getPackageName(), R.layout.widget_untimed_filler));
            }
            v.addView(R.id.untimed_bar, row);
        }
    }

    /** 一张未定时卡（样式与点击不变，从 renderUntimedBar 抽出来复用） */
    private static RemoteViews untimedCard(Context c, WTask t, Metrics m) {
        RemoteViews r = new RemoteViews(c.getPackageName(), R.layout.widget_untimed_row);
        r.setTextViewText(R.id.untimed_row, t.title);
        // 高度与字号随 k（2026-11-03）
        r.setViewLayoutHeight(R.id.untimed_row, m.untimedCard, TypedValue.COMPLEX_UNIT_DIP);
        font(r, R.id.untimed_row, 8, m.k);
        if (t.done) {
            r.setInt(R.id.untimed_row, "setBackgroundResource",
                    R.drawable.widget_task_bg_done);
            r.setTextColor(R.id.untimed_row, 0xFF7E8F84);
        } else {
            // 未完成：与未完成打卡同一浅绿 + 深绿字（未完成的任务/打卡同色系）。
            r.setInt(R.id.untimed_row, "setBackgroundResource",
                    R.drawable.widget_task_bg);
            r.setTextColor(R.id.untimed_row, 0xFF1B3A2A);
        }
        r.setOnClickPendingIntent(R.id.untimed_row,
                WidgetIntent.of(c, ACTION_TASK, "u" + t.id).put(EXTRA_ID, t.id).build(c));
        return r;
    }

    /** 「+N」折叠提示，占半格 */
    private static RemoteViews untimedMore(Context c, int more, Metrics m) {
        RemoteViews mv = new RemoteViews(c.getPackageName(), R.layout.widget_untimed_more);
        mv.setTextViewText(R.id.untimed_more, "+" + more);
        mv.setViewLayoutHeight(R.id.untimed_more, m.untimedCard, TypedValue.COMPLEX_UNIT_DIP);
        font(mv, R.id.untimed_more, 8, m.k);
        return mv;
    }

    /* ==================== 打卡写入（2026-11-04 迁往 HabitWidgetProvider） ====================
       toggleHabit / enqueueHabit 随打卡区整体移过去（那边只写「今天」，逻辑同
       一条路）。本组件不再有任何打卡写入；flushPending 的 habit 队列分支保留 ——
       打卡组件离线攒的 op 仍由这条共用队列代发。

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
     * 排队超过这么久还没发出去的意图就作废。
     *
     * 一周足够覆盖「出门断网几天」这种正常离线；再老的意图基本已经不是
     * 用户现在的意思了，重放只会制造错误数据。
     */
    private static final long PENDING_TTL_MS = 7L * 24 * 3600 * 1000;

    /**
     * 丢掉过期 / 历史遗留的排队操作。
     *
     * **2026-10-26 用户报「打卡点完又回绿、App 也不同步」的真凶之一**：
     * 上一版之前打卡根本发不出去（快照没带 log，usablePrefix 把整队挡住），
     * 于是那段时间每一次点打卡都进队列、只在本地显示。等这一版把 log 补上、
     * 队列解封，那些**几天前互相抵消的旧意图**就一起重放了 —— 新的打卡刚
     * 直连写成功，紧随其后的 flush 又把一条旧的「取消打卡」发上去，把勾抹掉。
     * 实证：一次点击在服务端留下 `{→true}` 紧跟 `{}` 两条相反写入。
     *
     * 判据是 {@code queuedAt}：没有它 = 这一版之前入队的老操作。这类只在
     * habit 上出现（task 一直能正常发），所以只丢 habit，别误伤任务改动。
     */
    private static List<JSONObject> dropStale(List<JSONObject> raw) {
        long now = System.currentTimeMillis();
        List<JSONObject> keep = new ArrayList<>();
        for (JSONObject p : raw) {
            long at = p.optLong("queuedAt", 0);
            if (at == 0) {
                if (!"habit".equals(p.optString("kind"))) keep.add(p);
                continue;
            }
            if (now - at > PENDING_TTL_MS) continue;
            keep.add(p);
        }
        return keep;
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
        List<JSONObject> pending = dropStale(dedupe(WidgetPrefs.pendingOps(c)));
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
        // 这批 op 碰到了哪些实体。回调里靠它们做**局部合并** —— 不能整表
        // replaceSnapshot，那会把还没发出去的乐观改动从桌面上抹掉
        // （见 WidgetPrefs.mergeEntities）。
        // create 的真 id 要等服务端，所以另攒一份「占位 id + 匹配字段」。
        final java.util.List<String> touchedTasks = new ArrayList<>();
        final java.util.List<String> touchedHabits = new ArrayList<>();
        final java.util.List<String[]> pendingCreates = new ArrayList<>();
        try {
            for (int i = 0; i < take; i++) {
                JSONObject p = pending.get(i);
                String kind = p.optString("kind");
                if ("habit".equals(kind)) {
                    WHabit h = snap.habitById(p.optString("habitId"));
                    if (h == null || h.log == null) return;   // usablePrefix 已挡过，纯兜底
                    touchedHabits.add(h.id);
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
                    touchedTasks.add(t.id);
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
                    // 编辑弹框存下的改动。2026-10-14（第十一轮）起**只带改动过的字段**
                    // （repeat 尤其不能无脑下发，否则会把 App 里的细节覆盖成简化档），
                    // 所以这里按白名单「有什么带什么」，不再无条件塞 title/time。
                    WTask t = snap.taskById(p.optString("taskId"));
                    if (t == null) return;
                    touchedTasks.add(t.id);
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", t.id);
                    op.put("calId", t.calId);
                    JSONObject fields = new JSONObject();
                    String[] keys = {"title", "date", "time", "duration", "done", "repeat", "reminder"};
                    for (String k : keys) {
                        if (p.has(k)) fields.put(k, p.get(k));
                    }
                    if (!fields.has("doneAt") && fields.has("done")) {
                        boolean d = fields.optBoolean("done");
                        fields.put("doneAt", d ? System.currentTimeMillis() : JSONObject.NULL);
                    }
                    if (fields.length() == 0) return;   // 空编辑，跳过
                    op.put("fields", fields);
                    ops.put(op);
                } else if ("delete".equals(kind)) {
                    // 删除不依赖本地快照里还有没有这条 —— 乐观删除之后
                    // taskById 就查不到了，但 calId 早就跟着队列存下来了
                    String delId = p.optString("taskId");
                    touchedTasks.add(delId);
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", delId);
                    op.put("calId", p.optString("calId"));
                    JSONObject fields = new JSONObject();
                    fields.put("deleted", true);
                    fields.put("deletedAt", p.optLong("deletedAt"));
                    op.put("fields", fields);
                    ops.put(op);
                } else if ("create".equals(kind)) {
                    // 新建的真 id 只有服务端知道，先把占位 id 和匹配字段攒着，
                    // 回调里用 adoptCreated 把占位换成服务端那条。
                    // **localId 为空就跳过** —— 那是这次改造之前攒下的老队列，
                    // 没有占位 id 可对，硬换会把服务端那条加成重复的一条。
                    // 老占位留着，下次 bootstrap 会整体纠正。
                    if (!p.optString("localId").isEmpty()) {
                        pendingCreates.add(new String[]{
                                p.optString("localId"),
                                p.optString("title"),
                                p.optString("date"),
                                p.isNull("time") ? "" : p.optString("time"),
                        });
                    }
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
                    // 重复 / 提醒（2026-10-14 新增的字段）。老队列里没有这两个键
                    // → 不下发，保持「不重复 / 不提醒」的默认语义。
                    JSONObject rep = p.optJSONObject("repeat");
                    if (rep != null) fields.put("repeat", rep);
                    if (p.has("reminder")) {
                        fields.put("reminder",
                                p.isNull("reminder") ? JSONObject.NULL : p.optString("reminder"));
                    }
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

        WidgetApi.op(c, ops, new WidgetApi.OpCallback() {
            @Override
            public void onAccepted(JSONObject body) {
                settle(body);
            }

            @Override
            public void onRejected(JSONObject body, String why) {
                // 服务端明确拒了这批 —— 原样重发一万次也不会成功，别留在队列里
                // 反复重试。局部合并 = 把被拒的乐观改动回滚到服务端返回的真相。
                Log.w("ScheduleWidget", "队列里一批 op 被服务端拒绝，已丢弃: " + why);
                Ui.toast(c, "有条待同步的改动服务端没有接受，已回到服务端的结果");
                settle(body);
            }

            @Override
            public void onUnreachable(String why) {
                // 问不出去：留在队列里，下次再试。不做重试 —— 网络不好时
                // 重试只会更费电
            }

            /** 三种「有答案」的结局共用：合并 + 扣队列 + 重绘 + 接着发下一批 */
            private void settle(JSONObject body) {
                WidgetPrefs.mergeEntities(c, body, "tasks", touchedTasks);
                WidgetPrefs.mergeEntities(c, body, "habits", touchedHabits);
                for (String[] cr : pendingCreates) {
                    WidgetPrefs.adoptCreated(c, body, cr[0], cr[1], cr[2], cr[3]);
                }
                WidgetPrefs.dropPending(c, take);   // 只扣掉真正发出去的这一批
                refresh(c);
                // 队列比一批长时接着发下一批
                if (WidgetPrefs.hasPending(c)) flushPending(c);
            }
        });
    }

    /* ============================ 小工具 ============================ */

    private static final String[] WD = {"一", "二", "三", "四", "五", "六", "日"};

    /**
     * 透明度（任意 40–100 的整数）→ 底板资源。
     *
     * 以前只有 5 档预置 drawable，滑杆看着连续、其实只能吸附到 5 档。
     * 2026-10-14：改成每 2% 一张（40/42/…/100，共 31 张，见 drawable/widget_bg_a*.xml），
     * 这里把任意值吸附到最近的偶数档，再用资源名动态查到对应 drawable，
     * 滑杆就能真正平滑过渡。
     */
    static int bgFor(Context c, int alpha) {
        int a = Math.max(40, Math.min(100, alpha));
        int even = (a % 2 == 0) ? a : a + 1;
        int id = c.getResources().getIdentifier("widget_bg_a" + even, "drawable", c.getPackageName());
        return id != 0 ? id : R.drawable.widget_bg;
    }

    /** 把颜色按百分比调透明。用于能用纯色背景的地方（打卡条） */
    static int withAlpha(int color, int pct) {
        int a = (color >>> 24) * Math.max(0, Math.min(100, pct)) / 100;
        return (a << 24) | (color & 0x00FFFFFF);
    }

    /**
     * 卡片上的文字。**第一行永远是「时间 + 标题」**，第二行才轮到详细内容 ——
     * 顺序不能倒：桌上一瞥要先看的是几点做什么，备注是辅助。
     *
     * @param roomy 这块够不够画两行（由调用方按实际高度算，见 NOTE_LINE_MIN_DP）
     */
    private static String label(WTask t, boolean roomy) {
        // 定时任务在卡片上直接显示「起止时段」（如 13:00-14:00），一眼看到几点到几点；
        // 详情里本来就有，现在面板上一瞥也该看到（用户 2026-10-14）。未定时没有时段，只放标题。
        String head = t.time != null ? rangeOf(t) + "  " + t.title : t.title;
        if (!roomy) return head;

        // 详细内容：**换行压成空格**再截断 —— 组件高度是按时间钉死的，多出来的行
        // 只会把这两行自己挤没了。完整内容在「点这一条」的弹窗里。
        String note = oneLine(t.note);
        return note.isEmpty() ? head : head + "\n" + note;
    }

    /** 任务卡上「时段」那一段的灰（用户 2026-10-25：中性灰，不带绿调） */
    private static final int C_TIME_DIM = 0xFF8A8D8B;

    /**
     * 把卡片第一行开头的「13:00-14:00」染成中性灰，标题仍用正文色。
     *
     * 卡片是**一个 TextView**（高度按分钟钉死，拆成两个视图会改行高），
     * 所以只能靠 span 分色。RemoteViews 传 CharSequence 时 SpannableString
     * 是 Parcelable、ForegroundColorSpan 是 ParcelableSpan，跨进程到 launcher
     * 依然保留 —— 万一某家桌面把 span 丢了，最多是「又变回一个颜色」，不会崩。
     */
    private static CharSequence dimTimePrefix(CharSequence text, WTask t) {
        if (t.time == null) return text;
        String range = rangeOf(t);
        String s = text.toString();
        if (range.isEmpty() || !s.startsWith(range)) return text;
        SpannableString sp = new SpannableString(s);
        sp.setSpan(new ForegroundColorSpan(C_TIME_DIM), 0, range.length(),
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return sp;
    }

    /** 压成一行的摘要：换行变空格、掐掉了首尾空白。null 当空串 */
    private static String oneLine(String s) {
        if (s == null) return "";
        return s.replace('\n', ' ').replace('\r', ' ').trim();
    }

    /** 定时任务的起止时段文字，如 "13:00-14:00"（时长取 durOf，缺省 60 分钟） */
    private static String rangeOf(WTask t) {
        int s = startMin(t);
        if (s < 0) return "";
        return hhmm(s) + "-" + hhmm(s + durOf(t));
    }

    /** 分钟数 → "HH:MM" */
    private static String hhmm(int min) {
        return String.format(Locale.US, "%02d:%02d", min / 60, min % 60);
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

    /**
     * 标题只显示**月份**（如「十月」），数字用中文。
     *
     * 用户 2026-10-14：以前显示整周范围（「10月12日 – 18日」），太占地方、信息也
     * 多余 —— 桌面标题一行就那么点宽，月份足够表明「现在看的是哪个月」。
     * 取**选中日**的月份（不是周一的），因为日期条高亮的是选中日，标题得跟它一致。
     */
    private static String monthTitle(String day) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(parse(day));
        return cnMonth(cal.get(Calendar.MONTH) + 1);
    }

    /** 1→一月 … 12→十二月（阿拉伯数字换成中文） */
    private static String cnMonth(int m) {
        String[] cn = {"一月", "二月", "三月", "四月", "五月", "六月",
                "七月", "八月", "九月", "十月", "十一月", "十二月"};
        return (m >= 1 && m <= 12) ? cn[m - 1] : (m + "月");
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
