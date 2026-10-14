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
 *
 * 2026-10-13：单一的「时间」按钮改成开始 / 结束两个表盘。
 * 2026-10-14（第十轮）：
 *   · **只设开始时间** —— 去掉结束。「时间段」交给**编辑弹窗**（那边有开始+结束）。
 *     存的是 time + duration；这里没结束 → duration 发 null（App 语义：默认一小时卡高）。
 *   · **重复**升级成「预设 + 结束条件」：
 *       预设：不重复 / 每天 / 工作日(周一~五) / 每周 / 每月 / 每年
 *       结束：不结束 / 按次数 / 按日期
 *     写出的仍是标准 RepeatRule（weekdays 用 App 口径 0=周日…6=周六）。
 *   · **提醒**：选 HH:mm，写入 reminder 字段。
 *
 * ⚠️ 时长字段名必须是 **duration** —— 旧代码写的是 `dur`，服务端和 App 读的
 * 都是 duration。
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
    /** 重复预设：none / day / workday / week / month / year */
    private String repeatUnit = "none";
    /** 重复结束：never / count / date */
    private String repeatEndType = "never";
    /** 「按次数」的次数 */
    private int repeatCount = 10;
    /** 「按日期」的截止日 yyyy-MM-dd */
    private String repeatEndDate = null;
    /** 提醒时刻 HH:mm，null = 不提醒 */
    private String pickedRemind = null;

    private Button dateBtn;
    private Button startBtn;
    private Button repeatBtn;
    private Button remindBtn;
    private TextView durHint;

    private static final String[] REPEAT_LABELS = {"不重复", "每天", "工作日（周一~五）", "每周", "每月", "每年"};
    private static final String[] REPEAT_VALUES = {"none", "day", "workday", "week", "month", "year"};
    private static final String[] END_LABELS = {"不结束", "按次数", "按日期"};
    private static final String[] END_VALUES = {"never", "count", "date"};

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_create);

        // 弹框一打开就把焦点给标题、并唤起软键盘 —— 点「+」后要直接能打字
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);

        pickedDate = getIntent().getStringExtra("date");
        if (pickedDate == null || pickedDate.isEmpty()) pickedDate = todayIso();
        final EditText title = findViewById(R.id.c_title);
        title.requestFocus();
        title.post(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(title, InputMethodManager.SHOW_IMPLICIT);
        });

        dateBtn = findViewById(R.id.c_date);
        startBtn = findViewById(R.id.c_start);
        repeatBtn = findViewById(R.id.c_repeat);
        remindBtn = findViewById(R.id.c_remind);
        durHint = findViewById(R.id.c_durhint);
        Button save = findViewById(R.id.c_save);
        Button cancel = findViewById(R.id.c_cancel);

        updateDateLabel();
        updateStartLabel();
        updateRepeatLabel();
        updateRemindLabel();

        dateBtn.setOnClickListener(v -> pickDate());
        startBtn.setOnClickListener(v -> pickStart());
        repeatBtn.setOnClickListener(v -> pickRepeat());
        remindBtn.setOnClickListener(v -> pickRemind());

        save.setOnClickListener(v -> {
            String t = title.getText().toString().trim();
            if (t.isEmpty()) { title.setError("总得写点什么"); return; }
            final String date = pickedDate;
            final String tm = pickedStart;
            final String calId = defaultCalId(this);

            // ① 乐观更新：本地造一条（id 是临时的，服务端返回真 id 后再换掉）
            final String localId = "t_local_" + System.currentTimeMillis();
            try {
                JSONObject f = new JSONObject();
                f.put("title", t);
                f.put("date", date);
                f.put("time", tm == null ? JSONObject.NULL : tm);
                f.put("dur", JSONObject.NULL);       // 只设开始 → 时长不设（默认一小时）
                f.put("done", false);
                f.put("calId", calId);
                f.put("repeat", buildRepeat(pickedDate));
                f.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
                WidgetPrefs.patchEntity(this, "tasks", localId, f, true);
            } catch (Exception ignored) {
            }

            // ② 立刻重画桌面
            ScheduleWidgetProvider.refresh(this);

            // ③ 有票就直连；否则入队等 App 启动后补发
            if (WidgetPrefs.canDirect(this) && !calId.isEmpty()) {
                try {
                    JSONArray ops = new JSONArray();
                    ops.put(createOp(t, date, tm, calId));
                    WidgetApi.op(this, ops, new WidgetApi.OpCallback() {
                        @Override
                        public void onAccepted(JSONObject body) {
                            String realId = WidgetPrefs.adoptCreated(CreateTaskActivity.this, body,
                                    localId, t, date, tm);
                            ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                            // 重复任务：**在原生侧直接**把后续几次建出来。
                            // 只靠 App 那边的 ensureRepeatOccurrences 是不够的 ——
                            // 用户在小组件上设完重复就走了 App，根本没打开，
                            // 于是「设了重复但一条新任务都没有」。
                            if (realId != null && !"none".equals(repeatUnit)) {
                                try {
                                    RepeatSpawn.spawn(new RepeatSpawn.ContextWrapper(CreateTaskActivity.this),
                                            realId, t, calId, date, buildRepeat(pickedDate), pickedRemind);
                                } catch (Exception ignored) {
                                }
                            }
                        }

                        @Override
                        public void onRejected(JSONObject body, String why) {
                            WidgetPrefs.removeEntity(CreateTaskActivity.this, "tasks", localId);
                            ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                            Ui.toast(CreateTaskActivity.this, "新建没有成功，服务端没有接受");
                        }

                        @Override
                        public void onUnreachable(String why) {
                            enqueueCreate(t, date, tm, localId);
                        }
                    });
                } catch (Exception e) {
                    enqueueCreate(t, date, tm, localId);
                }
            } else {
                enqueueCreate(t, date, tm, localId);
            }
            finish();
        });
        cancel.setOnClickListener(v -> finish());
    }

    /* ==================== 日期 ==================== */

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
        dateBtn.setText("日期：" + (pickedDate == null ? "不设置" : pickedDate + " " + weekdayOf(pickedDate)));
    }

    /* ==================== 开始时间 ==================== */

    private void pickStart() {
        int h = 9, m = 0;
        if (pickedStart != null) {
            int[] hm = hhmm(pickedStart);
            h = hm[0];
            m = hm[1];
        }
        TimePickerDialog d = new TimePickerDialog(this, (view, hh, mm) -> {
            pickedStart = String.format(Locale.US, "%02d:%02d", hh, mm);
            updateStartLabel();
        }, h, m, true);
        d.show();
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不设置", (dlg, which) -> {
            pickedStart = null;
            updateStartLabel();
        });
    }

    private void updateStartLabel() {
        if (startBtn == null) return;
        startBtn.setText("开始时间：" + (pickedStart == null ? "不设置" : pickedStart));
        if (durHint == null) return;
        durHint.setText(pickedStart == null
                ? "不设时间就落到「未定时」里；时长/时间段可在编辑里设"
                : "时长默认 1 小时；要设时间段请点开该任务编辑");
    }

    /* ==================== 重复 ==================== */

    /** 两步：先选预设，非「不重复」再选结束条件。 */
    private void pickRepeat() {
        int cur = 0;
        for (int i = 0; i < REPEAT_VALUES.length; i++) {
            if (REPEAT_VALUES[i].equals(repeatUnit)) { cur = i; break; }
        }
        new AlertDialog.Builder(this)
                .setTitle("重复")
                .setSingleChoiceItems(REPEAT_LABELS, cur, (dlg, which) -> {
                    repeatUnit = REPEAT_VALUES[which];
                    dlg.dismiss();
                    if ("none".equals(repeatUnit)) {
                        repeatEndType = "never";
                        repeatEndDate = null;
                        updateRepeatLabel();
                    } else {
                        pickRepeatEnd();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void pickRepeatEnd() {
        int cur = 0;
        for (int i = 0; i < END_VALUES.length; i++) {
            if (END_VALUES[i].equals(repeatEndType)) { cur = i; break; }
        }
        new AlertDialog.Builder(this)
                .setTitle("结束")
                .setSingleChoiceItems(END_LABELS, cur, (dlg, which) -> {
                    repeatEndType = END_VALUES[which];
                    dlg.dismiss();
                    if ("count".equals(repeatEndType)) pickRepeatCount();
                    else if ("date".equals(repeatEndType)) pickRepeatEndDate();
                    else { repeatEndDate = null; updateRepeatLabel(); }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** 按次数：弹一个数字输入框（用系统 AlertDialog + EditText） */
    private void pickRepeatCount() {
        final EditText input = new EditText(this);
        input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        input.setText(String.valueOf(repeatCount));
        input.setSelection(input.getText().length());
        new AlertDialog.Builder(this)
                .setTitle("重复多少次")
                .setView(input)
                .setPositiveButton("确定", (dlg, w) -> {
                    try {
                        repeatCount = Math.max(1, Integer.parseInt(input.getText().toString().trim()));
                    } catch (Exception ignored) {
                        repeatCount = 10;
                    }
                    updateRepeatLabel();
                })
                .setNegativeButton("取消", (dlg, w) -> {
                    repeatEndType = "never";
                    updateRepeatLabel();
                })
                .show();
    }

    /** 按日期：弹日历选截止日（默认 = 任务日期 +1 个月） */
    private void pickRepeatEndDate() {
        Calendar cal = Calendar.getInstance();
        int[] ymd = ymdOf(repeatEndDate != null ? repeatEndDate : pickedDate);
        if (ymd != null) {
            cal.set(ymd[0], ymd[1] - 1, ymd[2]);
            cal.add(Calendar.MONTH, 1);
        }
        DatePickerDialog d = new DatePickerDialog(this, (view, y, m, day) -> {
            repeatEndDate = String.format(Locale.US, "%04d-%02d-%02d", y, m + 1, day);
            updateRepeatLabel();
        }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH));
        d.show();
    }

    private void updateRepeatLabel() {
        if (repeatBtn == null) return;
        String name = "不重复";
        for (int i = 0; i < REPEAT_VALUES.length; i++) {
            if (REPEAT_VALUES[i].equals(repeatUnit)) { name = REPEAT_LABELS[i]; break; }
        }
        if (!"none".equals(repeatUnit)) {
            if ("count".equals(repeatEndType)) name += " · " + repeatCount + " 次";
            else if ("date".equals(repeatEndType) && repeatEndDate != null) name += " · 至 " + repeatEndDate.substring(5);
        }
        repeatBtn.setText("重复：" + name);
    }

    /**
     * 拼一份标准 RepeatRule（与 App 的 domain/types/RepeatRule.ts 同形）。
     *
     * 预设 → unit 映射：
     *   每天   → unit=day
     *   工作日 → unit=week, weekdays=[1,2,3,4,5]  （App 口径 0=周日）
     *   每周   → unit=week, weekdays=[任务那天星期]
     *   每月   → unit=month, monthday=任务那天几号
     *   每年   → unit=year,  yearMonth+monthday
     */
    private JSONObject buildRepeat(String baseDate) throws Exception {
        String unit = repeatUnit;
        JSONArray wd = new JSONArray();
        Calendar cal = Calendar.getInstance();
        int[] ymd = ymdOf(baseDate);
        if (ymd != null) cal.set(ymd[0], ymd[1] - 1, ymd[2]);

        if ("workday".equals(unit)) {
            unit = "week";
            for (int d = 1; d <= 5; d++) wd.put(d);   // 周一~周五
        } else if ("week".equals(unit)) {
            wd.put(cal.get(Calendar.DAY_OF_WEEK) - 1); // Calendar 1=周日 → App 0=周日
        }

        JSONObject r = new JSONObject();
        r.put("unit", unit);
        r.put("n", 1);
        r.put("weekdays", wd);
        r.put("monthday", cal.get(Calendar.DAY_OF_MONTH));
        r.put("yearMonth", cal.get(Calendar.MONTH) + 1);

        if (!"none".equals(repeatUnit) && "count".equals(repeatEndType)) {
            JSONObject e = new JSONObject();
            e.put("type", "count");
            e.put("count", repeatCount);
            r.put("end", e);
        } else if (!"none".equals(repeatUnit) && "date".equals(repeatEndType) && repeatEndDate != null) {
            JSONObject e = new JSONObject();
            e.put("type", "date");
            e.put("date", repeatEndDate);
            r.put("end", e);
        } else {
            r.put("end", JSONObject.NULL);
        }
        return r;
    }

    /* ==================== 提醒 ==================== */

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
        remindBtn.setText("提醒：" + (pickedRemind == null ? "不提醒" : pickedRemind));
    }

    /* ==================== 重复：在原生侧派生子任务 ==================== */

    /** 预生成未来几次（与 App 的 REPEAT_LOOKAHEAD 保持一致） */
    private static final int REPEAT_LOOKAHEAD = 4;

    /**
     * 重复任务建完之后，把后续几次**真的建出来**（本地先画 + 发 op）。
     *
     * id 用 `系列根id#发生日` —— 和 App 的 instanceId() 同一套派生规则，
     * 两边算出来必然一致，同一次不会被建两遍。
     *
     * 结束条件：count 用满 / 到期日，就少建几条。
     */
    private void spawnOccurrences(String rootId, String title, String calId) {
        try {
            JSONArray ops = new JSONArray();
            int made = 0;
            Calendar cur = Calendar.getInstance();
            int[] ymd = ymdOf(pickedDate);
            if (ymd == null) return;
            cur.set(ymd[0], ymd[1] - 1, ymd[2]);

            for (int i = 0; i < REPEAT_LOOKAHEAD; i++) {
                if ("count".equals(repeatEndType) && made + 1 >= Math.max(1, repeatCount)) break;
                cur = advanceRepeat(cur);
                if (cur == null) return;
                String d = String.format(Locale.US, "%04d-%02d-%02d",
                        cur.get(Calendar.YEAR), cur.get(Calendar.MONTH) + 1, cur.get(Calendar.DAY_OF_MONTH));
                if ("date".equals(repeatEndType) && repeatEndDate != null && d.compareTo(repeatEndDate) > 0) break;

                String oid = rootId + "#" + d;
                JSONObject lf = new JSONObject();
                lf.put("calId", calId);
                lf.put("title", title);
                lf.put("date", d);
                lf.put("dur", JSONObject.NULL);
                lf.put("done", false);
                lf.put("repeat", buildRepeat(d));
                lf.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
                WidgetPrefs.patchEntity(this, "tasks", oid, lf, true);

                JSONObject op = new JSONObject();
                op.put("entity", "task");
                op.put("entityId", oid);
                op.put("calId", calId);
                op.put("fields", lf);
                ops.put(op);
                made++;
            }
            if (made == 0) return;
            ScheduleWidgetProvider.refresh(this);
            if (WidgetPrefs.canDirect(this)) {
                WidgetApi.op(this, ops, new WidgetApi.OpCallback() {
                    @Override public void onAccepted(JSONObject body) { }
                    @Override public void onRejected(JSONObject body, String why) {
                        // 派生的实例没被接受 → 撤掉本地占位，别留幽灵
                        for (int i = 0; i < ops.length(); i++) {
                            WidgetPrefs.removeEntity(CreateTaskActivity.this, "tasks",
                                    ops.optJSONObject(i).optString("entityId"));
                        }
                        ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                    }
                    @Override public void onUnreachable(String why) { }
                });
            }
            // 离线时不入队：等 App 同步后由 ensureRepeatOccurrences 补齐，
            // id 规则一致，不会重复。
        } catch (Exception ignored) {
        }
    }

    /** 按当前预设档推进一步。工作日要跳过周末。 */
    private Calendar advanceRepeat(Calendar cur) {
        Calendar c = (Calendar) cur.clone();
        if ("day".equals(repeatUnit)) {
            c.add(Calendar.DAY_OF_MONTH, 1);
        } else if ("workday".equals(repeatUnit)) {
            do {
                c.add(Calendar.DAY_OF_MONTH, 1);
            } while (c.get(Calendar.DAY_OF_WEEK) == Calendar.SATURDAY
                    || c.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY);
        } else if ("week".equals(repeatUnit)) {
            c.add(Calendar.WEEK_OF_YEAR, 1);
        } else if ("month".equals(repeatUnit)) {
            c.add(Calendar.MONTH, 1);
        } else if ("year".equals(repeatUnit)) {
            c.add(Calendar.YEAR, 1);
        } else {
            return null;
        }
        return c;
    }

    /* ==================== 下发 ==================== */

    /** ⚠️ 字段名 duration（服务端字段），不是 dur。这里没有结束时间 → 发 null */
    private JSONObject createOp(String t, String date, String tm, String calId)
            throws Exception {
        JSONObject op = new JSONObject();
        op.put("entity", "task");
        op.put("entityId", "@new");
        op.put("calId", calId);
        JSONObject fields = new JSONObject();
        fields.put("title", t);
        fields.put("date", date);
        fields.put("time", tm == null ? JSONObject.NULL : tm);
        fields.put("duration", JSONObject.NULL);
        fields.put("done", false);
        fields.put("doneAt", JSONObject.NULL);
        fields.put("repeat", buildRepeat(pickedDate));
        fields.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
        op.put("fields", fields);
        return op;
    }

    /** 默认集：从现有任务里借一个 calId（快照一定带） */
    private static String defaultCalId(android.content.Context c) {
        WidgetSnapshot s = WidgetPrefs.snapshot(c);
        if (!s.tasks.isEmpty()) return s.tasks.get(0).calId;
        return "";
    }

    private void enqueueCreate(String t, String date, String tm, String localId) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "create");
            op.put("localId", localId);
            op.put("title", t);
            op.put("date", date);
            op.put("time", tm == null ? JSONObject.NULL : tm);
            op.put("duration", JSONObject.NULL);
            op.put("repeat", buildRepeat(pickedDate));
            op.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }

    /* ==================== 小工具 ==================== */

    private static String todayIso() {
        return String.format(Locale.US, "%04d-%02d-%02d",
                Calendar.getInstance().get(Calendar.YEAR),
                Calendar.getInstance().get(Calendar.MONTH) + 1,
                Calendar.getInstance().get(Calendar.DAY_OF_MONTH));
    }

    private static int[] hhmm(String hm) {
        int i = hm.indexOf(':');
        return new int[]{
                Integer.parseInt(hm.substring(0, i)),
                Integer.parseInt(hm.substring(i + 1))
        };
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
