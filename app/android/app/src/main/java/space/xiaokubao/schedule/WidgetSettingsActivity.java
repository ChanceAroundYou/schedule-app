package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.TimePickerDialog;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.TextView;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 小组件设置弹框。三组：时间轴范围 / 底板透明度 / 数据刷新。
 *
 * 为什么要有它：
 *   · 时间轴以前写死 8:00–20:00，作息不同的人（早起 6 点、或者晚上 23 点
 *     还有安排）就看不到自己要的那些小时。
 *   · 底板透明度 —— 壁纸好看的时候，实心绿底板很碍眼。
 *     ⚠️ **只能是四档**，不能做连续滑杆：RemoteViews 调不到 View.setAlpha
 *     （该方法没有 @RemotableViewMethod 标注，反射调用会抛 ActionException），
 *     透明度只能预先做成几档 drawable 来切。
 *   · 立即刷新 —— 小组件平时只在系统愿意调 onUpdate 时才更新；用户在 App 里
 *     改完数据，桌面上可能还是旧的。这里给一个手动拉的入口。
 *
 * 同样用**对话框主题的 Activity** —— 观感是桌面弹出小卡片，不离开桌面。
 */
public class WidgetSettingsActivity extends Activity {

    static void start(android.content.Context c) {
        android.content.Intent i = new android.content.Intent(c, WidgetSettingsActivity.class);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    /** 三个透明度按钮，下标与 WidgetPrefs.ALPHAS 一一对应 */
    private static final int[] ALPHA_IDS = {R.id.s_a100, R.id.s_a70, R.id.s_a45};

    private Button startBtn;
    private Button endBtn;
    private TextView hint;
    private TextView status;
    private Button[] alphaBtns;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_settings);

        startBtn = findViewById(R.id.s_start);
        endBtn = findViewById(R.id.s_end);
        hint = findViewById(R.id.s_hint);
        status = findViewById(R.id.s_status);
        alphaBtns = new Button[ALPHA_IDS.length];
        for (int i = 0; i < ALPHA_IDS.length; i++) alphaBtns[i] = findViewById(ALPHA_IDS[i]);

        refreshLabels();

        startBtn.setOnClickListener(v -> pickHour(WidgetPrefs.startHour(this), h -> {
            // 起点不留 >= 终点：downstream 会把顺序摆正，但这里先挡一下，
            // 免得用户设成 22→6 之后看到的是被改过的值却不知道为什么
            WidgetPrefs.setRange(this, h, WidgetPrefs.endHour(this));
            afterChange();
        }));

        endBtn.setOnClickListener(v -> pickHour(WidgetPrefs.endHour(this), h -> {
            WidgetPrefs.setRange(this, WidgetPrefs.startHour(this), h);
            afterChange();
        }));

        for (int i = 0; i < ALPHA_IDS.length; i++) {
            final int pct = WidgetPrefs.ALPHAS[i];
            alphaBtns[i].setOnClickListener(v -> {
                WidgetPrefs.setAlpha(this, pct);
                afterChange();
            });
        }

        findViewById(R.id.s_refresh).setOnClickListener(v -> doRefresh());

        findViewById(R.id.s_reset).setOnClickListener(v -> {
            WidgetPrefs.resetRange(this);
            WidgetPrefs.setAlpha(this, WidgetPrefs.DEFAULT_ALPHA);
            WidgetPrefs.resetViewTop(this);
            afterChange();
        });

        findViewById(R.id.s_done).setOnClickListener(v -> finish());
    }

    private void afterChange() {
        refreshLabels();
        ScheduleWidgetProvider.refresh(this);
    }

    private void refreshLabels() {
        int a = WidgetPrefs.startHour(this);
        int b = WidgetPrefs.endHour(this);
        startBtn.setText(hh(a));
        endBtn.setText(hh(b));

        int lines = b - a + 1;
        hint.setText("共 " + lines + " 行。一屏放不下时时间轴右侧会出现上下翻页箭头，"
                + "把组件拖大一些能一屏看到更多。");

        int cur = WidgetPrefs.alpha(this);
        for (int i = 0; i < alphaBtns.length; i++) {
            boolean sel = WidgetPrefs.ALPHAS[i] == cur;
            // 选中态复用打卡区那套语言：实心绿 + 白字
            alphaBtns[i].setBackgroundResource(
                    sel ? R.drawable.widget_habit_bg_done : R.drawable.widget_habit_bg);
            alphaBtns[i].setTextColor(sel ? 0xFFFFFFFF : 0xFF1B3A2A);
        }

        long at = WidgetPrefs.snapshot(this).at;
        status.setText(at > 0 ? "数据更新于 " + clockOf(at) : "还没有同步过数据，打开 App 一次");
    }

    /**
     * 立即刷新：先把离线期间攒的改动推上去，再拉一份最新的回来。
     *
     * 顺序不能反 —— 先拉会把服务端的旧值盖到本地，用户刚才在桌面上勾的
     * 那几下就白勾了（本地那份还没来得及推）。
     */
    private void doRefresh() {
        status.setText("正在刷新…");
        ScheduleWidgetProvider.flushPending(this);
        WidgetApi.bootstrap(this, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                WidgetPrefs.replaceSnapshot(WidgetSettingsActivity.this, body);
                ScheduleWidgetProvider.refresh(WidgetSettingsActivity.this);
                if (!isFinishing()) {
                    status.setText("已更新 " + hhmm());
                }
            }

            @Override
            public void onFail(String why) {
                ScheduleWidgetProvider.refresh(WidgetSettingsActivity.this);
                if (!isFinishing()) {
                    status.setText("刷新失败：" + whyText(why) + "（仍显示本地数据）");
                }
            }
        });
    }

    /** 把网络层的错误码翻成人话 —— 「network: UnknownHostException」没法看 */
    private static String whyText(String why) {
        if (why == null) return "未知原因";
        if (why.startsWith("no-token")) return "还没登录过，先打开 App 一次";
        if (why.startsWith("unauthorized")) return "登录已过期，重新打开 App";
        if (why.startsWith("network")) return "网络不通";
        return why;
    }

    private static String hh(int h) {
        return String.format(Locale.US, "%02d:00", h);
    }

    private static String hhmm() {
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date());
    }

    private static String clockOf(long ts) {
        if (ts <= 0) return "—";
        return new SimpleDateFormat("MM-dd HH:mm", Locale.US).format(new Date(ts));
    }

    /** 选小时。用系统表盘（clock 模式），比让人打字强 —— 跟 App 里那个转盘一个思路 */
    private void pickHour(int current, OnHour cb) {
        TimePickerDialog d = new TimePickerDialog(
                this,
                (view, hourOfDay, minute) -> cb.on(hourOfDay),
                current, 0,
                true);   // 24 小时制
        d.show();
    }

    private interface OnHour {
        void on(int hour);
    }
}
