package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.TimePickerDialog;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.ArrayAdapter;
import android.widget.TextView;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 小组件设置弹框。
 *
 * **日程模式**（默认）：时间轴范围 / 底板透明度 / 字体大小 / 立即刷新。
 * **打卡模式**（MODE_HABIT）：底板透明度 / 字体大小 / 立即刷新（打卡没有
 *   时间轴）。用 dialog_habit_settings.xml，视觉语言同一套。
 *   2026-11-06 用户：刷新两个组件必须统一，打卡的三点菜单也加了「数据」段。
 *
 * 透明度/字体是**全局共享**的（WidgetPrefs 里只有一份），改了之后两个组件
 * 都要 refresh —— 日程调 ScheduleWidgetProvider.refresh，打卡调
 * HabitWidgetProvider.refresh。
 *
 * ⚠️ 透明度那条是**真·连续**的滑杆：RemoteViews 调不到 View.setAlpha
 * （没标 @RemotableViewMethod），能安全改的只有 setBackgroundResource ——
 * 底下预先烤好了 40/42/…/100 共 31 张 drawable（每 2% 一张）。
 *
 * 用对话框主题的 Activity —— 观感是桌面弹出小卡片，不离开桌面。
 */
public class WidgetSettingsActivity extends Activity {

    static final String EXTRA_MODE = "mode";
    static final String MODE_HABIT = "habit";

    static void start(android.content.Context c) {
        start(c, null);
    }

    static void start(android.content.Context c, String mode) {
        android.content.Intent i = new android.content.Intent(c, WidgetSettingsActivity.class);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        if (mode != null) i.putExtra(EXTRA_MODE, mode);
        c.startActivity(i);
    }

    private Button startBtn;
    private Button endBtn;
    private TextView hint;
    private TextView status;
    private SeekBar alphaBar;
    private TextView alphaLabel;
    private SeekBar fontBar;
    private TextView fontLabel;
    private Spinner creatorSpinner;
    private java.util.List<String> creatorValues = new java.util.ArrayList<>();
    private boolean habitMode;

    private static final int[] FONT_STEPS = {85, 100, 115, 130};
    private static final String[] FONT_NAMES = {"偏小", "标准", "偏大", "特大"};

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        habitMode = MODE_HABIT.equals(getIntent().getStringExtra(EXTRA_MODE));
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(habitMode ? R.layout.dialog_habit_settings : R.layout.dialog_settings);
        setFinishOnTouchOutside(true);

        startBtn = findViewById(R.id.s_start);
        endBtn = findViewById(R.id.s_end);
        hint = findViewById(R.id.s_hint);
        status = findViewById(R.id.s_status);
        alphaBar = findViewById(R.id.s_alpha);
        alphaLabel = findViewById(R.id.s_alpha_label);
        fontBar = findViewById(R.id.s_font);
        fontLabel = findViewById(R.id.s_font_label);
        creatorSpinner = habitMode ? null : findViewById(R.id.s_creator);
        if (creatorSpinner != null) {
            bindCreatorOptions();
            creatorSpinner.post(this::refreshCreatorOptions);
        }

        refreshLabels();

        if (!habitMode) {
            startBtn.setOnClickListener(v -> pickHour(WidgetPrefs.startHour(this), h -> {
                WidgetPrefs.setRange(this, h, WidgetPrefs.endHour(this));
                afterChange();
            }));

            endBtn.setOnClickListener(v -> pickHour(WidgetPrefs.endHour(this), h -> {
                WidgetPrefs.setRange(this, WidgetPrefs.startHour(this), h);
                afterChange();
            }));
        }

        // 刷新**两个模式都有**（2026-11-06 用户：打卡组件也要能刷新，跟日程统一）
        findViewById(R.id.s_refresh).setOnClickListener(v -> doRefresh());

        alphaBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) return;
                WidgetPrefs.setAlpha(WidgetSettingsActivity.this, WidgetPrefs.MIN_ALPHA + progress);
                refreshLabels();
                refreshAll();
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {}
            @Override
            public void onStopTrackingTouch(SeekBar bar) {}
        });

        fontBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) return;
                WidgetPrefs.setFontScale(WidgetSettingsActivity.this, FONT_STEPS[progress]);
                refreshLabels();
                refreshAll();
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {}
            @Override
            public void onStopTrackingTouch(SeekBar bar) {}
        });
    }

    private void refreshCreatorOptions() {
        if (isFinishing() || isDestroyed()) return;
        WidgetApi.bootstrap(this, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                if (isFinishing() || isDestroyed()) return;
                WidgetPrefs.replaceSnapshot(WidgetSettingsActivity.this, body);
                bindCreatorOptions();
                refreshAll();
                refreshLabels();
            }

            @Override
            public void onFail(String why) {
                if (isFinishing() || isDestroyed()) return;
                if (status != null) status.setText("成员列表未更新，继续使用缓存");
            }
        });
    }

    private void bindCreatorOptions() {
        WidgetSnapshot snap = WidgetPrefs.snapshot(this);
        java.util.List<String> values = new java.util.ArrayList<>();
        java.util.List<String> labels = new java.util.ArrayList<>();
        if (snap.meId != null && !snap.meId.isEmpty()) {
            values.add("me");
            String meName = "我";
            for (WUser user : snap.users) if (snap.meId.equals(user.id)) meName = user.name;
            labels.add(meName);
        }
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (WUser user : snap.users) {
            if (user.id.isEmpty() || user.id.equals(snap.meId) || !seen.add(user.id)) continue;
            values.add(user.id);
            labels.add(user.name);
        }
        values.add(0, "all");
        labels.add(0, "全部成员");
        creatorValues = values;
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        creatorSpinner.setAdapter(adapter);
        String selected = WidgetPrefs.selectedCreator(this);
        int index = values.indexOf(selected);
        creatorSpinner.setSelection(Math.max(0, index), false);
        creatorSpinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent,
                    android.view.View view, int position, long id) {
                if (position < 0 || position >= creatorValues.size()) return;
                String next = creatorValues.get(position);
                if (!next.equals(WidgetPrefs.selectedCreator(WidgetSettingsActivity.this))) {
                    WidgetPrefs.setSelectedCreator(WidgetSettingsActivity.this, next);
                    ScheduleWidgetProvider.refresh(WidgetSettingsActivity.this);
                }
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
    }

    /** 透明度/字体是全局共享的 —— 改了之后日程和打卡组件都要刷 */
    private void refreshAll() {
        ScheduleWidgetProvider.refresh(this);
        HabitWidgetProvider.refresh(this);
    }

    private void afterChange() {
        refreshLabels();
        refreshAll();
    }

    private void refreshLabels() {
        if (!habitMode) {
            int a = WidgetPrefs.startHour(this);
            int b = WidgetPrefs.endHour(this);
            startBtn.setText(hh(a));
            endBtn.setText(hh(b));
            int lines = b - a + 1;
            hint.setText("共 " + lines + " 行，一屏显示完。行数多时刻度会自动缩小，"
                    + "把组件拖大一些会更舒展。");
        }

        int cur = WidgetPrefs.alpha(this);
        int prog = cur - WidgetPrefs.MIN_ALPHA;
        if (alphaBar.getProgress() != prog) alphaBar.setProgress(prog);
        alphaLabel.setText(cur + "%");

        int fs = WidgetPrefs.fontScale(this);
        int fi = 0;
        for (int i = 1; i < FONT_STEPS.length; i++) {
            if (Math.abs(FONT_STEPS[i] - fs) < Math.abs(FONT_STEPS[fi] - fs)) fi = i;
        }
        if (fontBar.getProgress() != fi) fontBar.setProgress(fi);
        fontLabel.setText(FONT_NAMES[fi] + "（" + fs + "%）");

        if (status != null) {
            long at = WidgetPrefs.snapshot(this).at;
            status.setText(at > 0 ? "数据更新于 " + clockOf(at) : "还没有同步过数据，打开 App 一次");
        }
    }

    private void doRefresh() {
        status.setText("正在刷新…");
        ScheduleWidgetProvider.flushPending(this);
        WidgetApi.bootstrap(this, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                if (isFinishing() || isDestroyed()) return;
                WidgetPrefs.replaceSnapshot(WidgetSettingsActivity.this, body);
                /* 服务端刚下发的成员目录要**立刻**反映到下拉里。
                   以前只 replaceSnapshot + refreshAll，用户点「立即刷新」后
                   下拉还是上次打开时那份（旧服务端没有 users 时只有「全部成员」），
                   看上去就像修了没生效，必须退出重进才更新。 */
                bindCreatorOptions();
                refreshAll();
                if (!isFinishing()) status.setText("已更新 " + hhmm());
            }

            @Override
            public void onFail(String why) {
                refreshAll();
                if (!isFinishing()) status.setText("刷新失败：" + whyText(why) + "（仍显示本地数据）");
            }
        });
    }

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

    private void pickHour(int current, OnHour cb) {
        TimePickerDialog d = new TimePickerDialog(
                this,
                (view, hourOfDay, minute) -> cb.on(hourOfDay),
                current, 0,
                true);
        d.show();
    }

    private interface OnHour {
        void on(int hour);
    }
}
