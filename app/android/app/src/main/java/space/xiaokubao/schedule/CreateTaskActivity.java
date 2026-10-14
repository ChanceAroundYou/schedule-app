package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.app.TimePickerDialog;
import android.content.DialogInterface;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

/**
 * 新建任务弹框。
 *
 * 同样是对话框主题的 Activity —— 用户不离开桌面就能建一条。
 * **只有标题和时间**：备注 / 重复这些留给 App，桌面上只做「快速记一笔」。
 *
 * 2026-10-13：单一的「时间」按钮改成**开始 / 结束两个表盘**（用户要求任务能设
 * 起止时间）。服务端存的是「开始 time + 时长 duration」，所以这里把结束换算成
 * duration 下发。
 *
 * ⚠️ 时长字段名必须是 **duration** —— 旧代码写的是 `dur`，而服务端和 App
 * （widgetSnapshot.ts: `dur: t.duration`）读的都是 duration，于是小组件设的时间
 * 段长度从来没生效过。一并修掉。
 */
public class CreateTaskActivity extends Activity {

    static void start(android.content.Context c, String dateIso) {
        android.content.Intent i = new android.content.Intent(c, CreateTaskActivity.class);
        i.putExtra("date", dateIso);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    /** 选中的日期（yyyy-MM-dd）。默认 = 打开组件时那天 */
    private String pickedDate = null;
    /** 选中的开始时间，null = 不设置 */
    private String pickedStart = null;
    /** 选中的结束时间，null = 不设置 */
    private String pickedEnd = null;
    /** 重复单位：none / day / week / month / year（简化档位） */
    private String repeatUnit = "none";
    /** 提醒时刻 HH:mm，null = 不提醒（写在任务 reminder 字段上） */
    private String pickedRemind = null;
    private Button dateBtn;
    private Button repeatBtn;
    private Button remindBtn;
    private Button startBtn;
    private Button endBtn;
    private TextView durHint;

    /** 重复档位的显示名，下标与 REPEAT_VALUES 对齐 */
    private static final String[] REPEAT_LABELS = {"不重复", "每天", "每周", "每月", "每年"};
    private static final String[] REPEAT_VALUES = {"none", "day", "week", "month", "year"};

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_create);

        // 弹框一打开就把焦点给标题、并唤起软键盘 —— 用户点「+」后要**直接能打字**，
        // 不要再手动点一下输入框才出键盘（2026-10-14）。
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);

        pickedDate = getIntent().getStringExtra("date");
        final EditText title = findViewById(R.id.c_title);
        // 标题框立即拿到焦点并弹出键盘（见上方 setSoftInputMode），点「+」后直接能输入
        title.requestFocus();
        title.post(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(title, InputMethodManager.SHOW_IMPLICIT);
        });
        dateBtn = findViewById(R.id.c_date);
        repeatBtn = findViewById(R.id.c_repeat);
        remindBtn = findViewById(R.id.c_remind);
        startBtn = findViewById(R.id.c_start);
        endBtn = findViewById(R.id.c_end);
        durHint = findViewById(R.id.c_durhint);
        Button save = findViewById(R.id.c_save);
        Button cancel = findViewById(R.id.c_cancel);

        updateDateLabel();
        updateRepeatLabel();
        updateRemindLabel();
        updateTimeLabels();
        dateBtn.setOnClickListener(v -> pickDate());
        repeatBtn.setOnClickListener(v -> pickRepeat());
        remindBtn.setOnClickListener(v -> pickRemind());
        startBtn.setOnClickListener(v -> pickStart());
        endBtn.setOnClickListener(v -> pickEnd());

        save.setOnClickListener(v -> {
            String t = title.getText().toString().trim();
            if (t.isEmpty()) { title.setError("总得写点什么"); return; }
            final String date = pickedDate;
            final String tm = pickedStart;
            final int dur = durationMinutes();
            final String calId = defaultCalId(this);

            // ① 乐观更新：本地造一条（id 是临时的，服务端返回真 id 后再换掉）
            final String localId = "t_local_" + System.currentTimeMillis();
            try {
                JSONObject f = new JSONObject();
                f.put("title", t);
                f.put("date", date);
                f.put("time", tm == null ? JSONObject.NULL : tm);
                f.put("dur", dur);
                f.put("done", false);
                f.put("calId", calId);
                f.put("repeat", buildRepeat());
                f.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
                WidgetPrefs.patchEntity(this, "tasks", localId, f, true);
            } catch (Exception ignored) {
            }

            // ② **立刻重画桌面**。上一版只在网络返回之后才 refresh，于是用户
            //    点保存、弹框关掉，桌面上还得空等一个网络往返 —— 走公网慢的时候
            //    好几秒，观感就是「保存了但没反应」。
            ScheduleWidgetProvider.refresh(this);

            // ③ 有票就直连（B 方案）。entityId 传 "@new" 由服务端发真 id。
            //    calId 拿不到时不能发 —— 服务端会因为缺 calId 整条丢掉（不报错）
            if (WidgetPrefs.canDirect(this) && !calId.isEmpty()) {
                try {
                    JSONArray ops = new JSONArray();
                    ops.put(createOp(t, date, tm, dur, calId));
                    WidgetApi.op(this, ops, new WidgetApi.OpCallback() {
                        @Override
                        public void onAccepted(JSONObject body) {
                            // 把假 id 的占位换成服务端那条（真 id）。
                            // **不能整表 replaceSnapshot** —— 那会把还没发出去
                            // 的乐观改动一并抹掉，见 adoptCreated 的说明
                            WidgetPrefs.adoptCreated(CreateTaskActivity.this, body,
                                    localId, t, date, tm);
                            ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                        }

                        @Override
                        public void onRejected(JSONObject body, String why) {
                            // 服务端不答应 → 撤掉占位，桌面回到真相
                            WidgetPrefs.removeEntity(CreateTaskActivity.this, "tasks", localId);
                            ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                            Ui.toast(CreateTaskActivity.this, "新建没有成功，服务端没有接受");
                        }

                        @Override
                        public void onUnreachable(String why) {
                            // 离线/问不出去 → 保留本地那条，入队等下次
                            enqueueCreate(t, date, tm, dur, localId);
                        }
                    });
                } catch (Exception e) {
                    enqueueCreate(t, date, tm, dur, localId);
                }
            } else {
                enqueueCreate(t, date, tm, dur, localId);
            }
            finish();
        });
        cancel.setOnClickListener(v -> finish());
    }

    /** ⚠️ 字段名 duration（服务端字段），不是 dur */
    private JSONObject createOp(String t, String date, String tm, int dur, String calId)
            throws Exception {
        JSONObject op = new JSONObject();
        op.put("entity", "task");
        op.put("entityId", "@new");
        op.put("calId", calId);
        JSONObject fields = new JSONObject();
        fields.put("title", t);
        fields.put("date", date);
        fields.put("time", tm == null ? JSONObject.NULL : tm);
        fields.put("duration", dur);
        fields.put("done", false);
        fields.put("doneAt", JSONObject.NULL);
        fields.put("repeat", buildRepeat());
        fields.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
        op.put("fields", fields);
        return op;
    }

    /* ==================== 日期 ==================== */

    /** 点了日期行 → 弹日历选择器。默认停在当前选中的日期。 */
    private void pickDate() {
        Calendar cal = Calendar.getInstance();
        int[] ymd = ymdOf(pickedDate);
        if (ymd != null) {
            cal.set(ymd[0], ymd[1] - 1, ymd[2]);
        }
        DatePickerDialog d = new DatePickerDialog(this, (view, y, m, day) -> {
            pickedDate = String.format(Locale.US, "%04d-%02d-%02d", y, m + 1, day);
            updateDateLabel();
        }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH));
        d.show();
    }

    private void updateDateLabel() {
        if (dateBtn == null) return;
        dateBtn.setText(pickedDate == null
                ? "不设置日期"
                : pickedDate + " " + weekdayOf(pickedDate));
    }

    /* ==================== 重复 / 提醒 ==================== */

    /** 重复：单选 不重复 / 每天 / 每周 / 每月 / 每年 */
    private void pickRepeat() {
        int cur = 0;
        for (int i = 0; i < REPEAT_VALUES.length; i++) {
            if (REPEAT_VALUES[i].equals(repeatUnit)) { cur = i; break; }
        }
        new AlertDialog.Builder(this)
                .setTitle("重复")
                .setSingleChoiceItems(REPEAT_LABELS, cur, (dlg, which) -> {
                    repeatUnit = REPEAT_VALUES[which];
                    updateRepeatLabel();
                    dlg.dismiss();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void updateRepeatLabel() {
        if (repeatBtn == null) return;
        for (int i = 0; i < REPEAT_VALUES.length; i++) {
            if (REPEAT_VALUES[i].equals(repeatUnit)) {
                repeatBtn.setText(REPEAT_LABELS[i]);
                return;
            }
        }
        repeatBtn.setText("不重复");
    }

    /** 提醒：选 HH:mm（同一天）。「不设置」清空。 */
    private void pickRemind() {
        int h = 9, m = 0;
        if (pickedRemind != null) {
            int[] hm = hhmm(pickedRemind);
            h = hm[0];
            m = hm[1];
        }
        TimePickerDialog d = new TimePickerDialog(this, (view, hh, mm) -> {
            pickedRemind = String.format(Locale.US, "%02d:%02d", hh, mm);
            updateRemindLabel();
        }, h, m, true);
        d.show();
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不提醒", (dlg, which) -> {
            pickedRemind = null;
            updateRemindLabel();
        });
    }

    private void updateRemindLabel() {
        if (remindBtn == null) return;
        remindBtn.setText(pickedRemind == null ? "不提醒" : "提醒 " + pickedRemind);
    }

    /**
     * 拼一份标准 RepeatRule（和 App 的 domain/types/RepeatRule.ts 同形）。
     *
     * 小部件只做**简化档位**（n 恒为 1），但写出来的必须是合法规则，
     * App 打开后能继续细化：
     *   · week  → weekdays = [任务日期那天的星期]（App 用 0=周日…6=周六）
     *   · month → monthday = 任务日期那天的几号
     *   · year  → yearMonth + monthday
     */
    private JSONObject buildRepeat() throws Exception {
        JSONObject r = new JSONObject();
        r.put("unit", repeatUnit);
        r.put("n", 1);
        JSONArray wd = new JSONArray();
        Calendar cal = Calendar.getInstance();
        int[] ymd = ymdOf(pickedDate);
        if (ymd != null) cal.set(ymd[0], ymd[1] - 1, ymd[2]);
        if ("week".equals(repeatUnit)) {
            wd.put(cal.get(Calendar.DAY_OF_WEEK) - 1);   // Calendar: 1=周日 → App: 0=周日
        }
        r.put("weekdays", wd);
        r.put("monthday", cal.get(Calendar.DAY_OF_MONTH));
        r.put("yearMonth", cal.get(Calendar.MONTH) + 1);
        r.put("end", JSONObject.NULL);
        return r;
    }

    /* ==================== 时间 ==================== */

    private void pickStart() {
        int h = 9, m = 0;
        if (pickedStart != null) {
            int[] hm = hhmm(pickedStart);
            h = hm[0];
            m = hm[1];
        }
        TimePickerDialog d = new TimePickerDialog(this, (view, hh, mm) -> {
            pickedStart = String.format(Locale.US, "%02d:%02d", hh, mm);
            if (pickedEnd == null || minOf(pickedEnd) <= minOf(pickedStart)) {
                pickedEnd = timeOf((minOf(pickedStart) + 60) % 1440);
            }
            updateTimeLabels();
        }, h, m, true);
        d.show();
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不设置", (dlg, which) -> {
            pickedStart = null;
            pickedEnd = null;
            updateTimeLabels();
        });
    }

    private void pickEnd() {
        int h = 10, m = 0;
        if (pickedEnd != null) {
            int[] hm = hhmm(pickedEnd);
            h = hm[0];
            m = hm[1];
        }
        TimePickerDialog d = new TimePickerDialog(this, (view, hh, mm) -> {
            pickedEnd = String.format(Locale.US, "%02d:%02d", hh, mm);
            if (pickedStart == null) {
                pickedStart = timeOf((minOf(pickedEnd) + 1440 - 60) % 1440);
            }
            updateTimeLabels();
        }, h, m, true);
        d.show();
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不设置", (dlg, which) -> {
            pickedEnd = null;
            updateTimeLabels();
        });
    }

    private void updateTimeLabels() {
        startBtn.setText(pickedStart == null ? "不设置" : pickedStart);
        endBtn.setText(pickedEnd == null ? "不设置" : pickedEnd);
        if (pickedStart == null) {
            durHint.setText("未设置时间，将出现在「未定时」里");
            return;
        }
        int d = durationMinutes();
        StringBuilder sb = new StringBuilder("时长 ");
        if (d >= 60) {
            sb.append(d / 60).append(" 小时");
            if (d % 60 > 0) sb.append(" ").append(d % 60).append(" 分");
        } else {
            sb.append(d).append(" 分钟");
        }
        if (pickedEnd != null && minOf(pickedEnd) <= minOf(pickedStart)) {
            sb.append("（次日 ").append(pickedEnd).append("）");
        }
        durHint.setText(sb.toString());
    }

    private int durationMinutes() {
        if (pickedStart == null) return 0;
        if (pickedEnd == null) return 60;
        int d = (minOf(pickedEnd) - minOf(pickedStart) + 1440) % 1440;
        return d == 0 ? 60 : d;
    }

    /** 默认集：从现有任务里借一个 calId（快照一定带） */
    private static String defaultCalId(android.content.Context c) {
        WidgetSnapshot s = WidgetPrefs.snapshot(c);
        if (!s.tasks.isEmpty()) return s.tasks.get(0).calId;
        return "";
    }

    /**
     * 入队等下次补发。
     *
     * @param localId 乐观更新时那条占位的 id —— 补发成功后要靠它把占位换成
     *                服务端的真 id，所以必须一起存进队列
     */
    private void enqueueCreate(String t, String date, String tm, int dur, String localId) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "create");
            op.put("localId", localId);
            op.put("title", t);
            op.put("date", date);
            op.put("time", tm == null ? JSONObject.NULL : tm);
            op.put("duration", dur);
            op.put("repeat", buildRepeat());
            op.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }

    /* ==================== 小工具 ==================== */

    private static int minOf(String hm) {
        int i = hm.indexOf(':');
        return Integer.parseInt(hm.substring(0, i)) * 60 + Integer.parseInt(hm.substring(i + 1));
    }

    private static int[] hhmm(String hm) {
        int i = hm.indexOf(':');
        return new int[]{
                Integer.parseInt(hm.substring(0, i)),
                Integer.parseInt(hm.substring(i + 1))
        };
    }

    private static String timeOf(int minutes) {
        int m = ((minutes % 1440) + 1440) % 1440;
        return String.format(Locale.US, "%02d:%02d", m / 60, m % 60);
    }

    /** "yyyy-MM-dd" → {y, m, d}；解析不了返回 null */
    private static int[] ymdOf(String iso) {
        if (iso == null || iso.length() < 10) return null;
        try {
            return new int[]{
                    Integer.parseInt(iso.substring(0, 4)),
                    Integer.parseInt(iso.substring(5, 7)),
                    Integer.parseInt(iso.substring(8, 10))
            };
        } catch (Exception e) {
            return null;
        }
    }

    /** 下标 = Calendar.DAY_OF_WEEK（1 是周日） */
    private static final String[] WD = {"", "周日", "周一", "周二", "周三", "周四", "周五", "周六"};

    private static String weekdayOf(String iso) {
        int[] ymd = ymdOf(iso);
        if (ymd == null) return "";
        Calendar cal = Calendar.getInstance();
        cal.set(ymd[0], ymd[1] - 1, ymd[2]);
        return WD[cal.get(Calendar.DAY_OF_WEEK)];
    }
}
