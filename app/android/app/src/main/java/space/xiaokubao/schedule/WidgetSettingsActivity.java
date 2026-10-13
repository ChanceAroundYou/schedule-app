package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.TimePickerDialog;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.TextView;

import java.util.Locale;

/**
 * 小组件设置弹框 —— 目前只有一项：时间轴的起止范围。
 *
 * 为什么要有它：时间轴以前写死 8:00–20:00，作息不同的人（早起 6 点、或者
 * 晚上 23 点还有安排）就看不到自己要的那些小时。现在让用户自己定。
 *
 * 同样用**对话框主题的 Activity** —— 观感是桌面弹出小卡片，不离开桌面。
 */
public class WidgetSettingsActivity extends Activity {

    static void start(android.content.Context c) {
        android.content.Intent i = new android.content.Intent(c, WidgetSettingsActivity.class);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    private Button startBtn;
    private Button endBtn;
    private TextView hint;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_settings);

        startBtn = findViewById(R.id.s_start);
        endBtn = findViewById(R.id.s_end);
        hint = findViewById(R.id.s_hint);

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

        findViewById(R.id.s_reset).setOnClickListener(v -> {
            WidgetPrefs.resetRange(this);
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
        hint.setText("共 " + lines + " 行。桌面上的组件拖大一些，能显示的小时更多。");
    }

    private static String hh(int h) {
        return String.format(Locale.US, "%02d:00", h);
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
