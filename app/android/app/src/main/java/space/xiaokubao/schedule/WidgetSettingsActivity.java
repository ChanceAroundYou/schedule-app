package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.TimePickerDialog;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.SeekBar;
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
 *   · 立即刷新 —— 小组件平时只在系统愿意调 onUpdate 时才更新；用户在 App 里
 *     改完数据，桌面上可能还是旧的。这里给一个手动拉的入口。
 *
 * ⚠️ 透明度那条是**滑杆的样子、档位的里子**：RemoteViews 调不到
 * {@code View.setAlpha}（没标 @RemotableViewMethod，反射会抛 ActionException），
 * 能安全改的只有 setBackgroundResource —— 所以底下是五张预置的 drawable，
 * 滑杆松手时吸附到最近的一张。看上去是连续拖动，实际只有五档。
 *
 * 同样用**对话框主题的 Activity** —— 观感是桌面弹出小卡片，不离开桌面。
 */
public class WidgetSettingsActivity extends Activity {

    static void start(android.content.Context c) {
        android.content.Intent i = new android.content.Intent(c, WidgetSettingsActivity.class);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    /** 五档各自的说法，下标与 WidgetPrefs.ALPHAS 一一对应 */
    private static final String[] ALPHA_NAMES = {"不透明", "微透", "半透明", "较透明", "很透明"};

    private Button startBtn;
    private Button endBtn;
    private TextView hint;
    private TextView status;
    private SeekBar alphaBar;
    private TextView alphaLabel;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_settings);
        // 2026-10-13：去掉了「完成」按钮，所以必须能靠点弹框外部关掉，
        // 否则用户只能按返回键 —— 那不像个「桌面小卡片」。
        setFinishOnTouchOutside(true);

        startBtn = findViewById(R.id.s_start);
        endBtn = findViewById(R.id.s_end);
        hint = findViewById(R.id.s_hint);
        status = findViewById(R.id.s_status);
        alphaBar = findViewById(R.id.s_alpha);
        alphaLabel = findViewById(R.id.s_alpha_label);

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

        alphaBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) return;      // refreshLabels() 里回写进度也会触发，别绕回来
                WidgetPrefs.setAlpha(WidgetSettingsActivity.this, WidgetPrefs.ALPHAS[progress]);
                refreshLabels();
                ScheduleWidgetProvider.refresh(WidgetSettingsActivity.this);
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
            }
        });

        findViewById(R.id.s_refresh).setOnClickListener(v -> doRefresh());
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
        hint.setText("共 " + lines + " 行，一屏显示完。行数多时刻度会自动缩小，"
                + "把组件拖大一些会更舒展。");

        int cur = WidgetPrefs.alpha(this);
        int idx = 0;
        for (int i = 0; i < WidgetPrefs.ALPHAS.length; i++) {
            if (WidgetPrefs.ALPHAS[i] == cur) { idx = i; break; }
        }
        if (alphaBar.getProgress() != idx) alphaBar.setProgress(idx);
        alphaLabel.setText(ALPHA_NAMES[Math.min(idx, ALPHA_NAMES.length - 1)]);

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
