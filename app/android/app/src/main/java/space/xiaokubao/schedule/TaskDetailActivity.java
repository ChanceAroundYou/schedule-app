package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.app.TimePickerDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

/**
 * 任务**编辑 / 删除**弹框。点时间轴上的任务块就打开它。
 *
 * 2026-10-14（第十一轮）：**字段结构与「新建任务」完全对齐** ——
 *   行2 任务名 / 行3 日期 / 行4 开始时间 / 行5 时长 / 行6 重复 / 行7 提醒。
 *   · 时间**只设开始**，不再显示「几点 至 几点」；一整天的时间段用
 *     **「时长」** 表达（15/30/45/60/90/120/180 分钟 或 不设置）。
 *   · 重复 / 提醒 会显示当前值并可修改。
 *
 * 保存 = **关窗即存**（{@link #finish()} → {@link #autoSave()}）；删除 = 第 1 行
 * 右侧的垃圾桶。**只下发真正改过的字段** —— 尤其是 repeat：用户没动它时
 * 绝不下发，否则会把 App 里设的细节（自定义 weekdays / end）用简化档覆盖掉。
 *
 * ⚠️ 时长字段名是 **duration**，不是 dur。
 */
public class TaskDetailActivity extends Activity {

    static void start(Context c, String taskId) {
        if (taskId == null) return;
        android.content.Intent i = new android.content.Intent(c, TaskDetailActivity.class);
        i.putExtra("taskId", taskId);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    private WTask task;
    /** 编辑中的「完成」状态 */
    private boolean pendingDone;
    /** 正在走删除流程 → 关窗时的自动保存要跳过 */
    private boolean deleteRequested;

    private String pickedDate;
    private String pickedStart;          // null = 不设置
    private int pickedDuration;          // 分钟，0 = 不设置
    private String pickedRemind;         // "HH:mm" 或 null

    /** 重复：用户有没有动过。没动过就绝不下发 repeat 字段 */
    private boolean repeatTouched;
    private String repeatUnit = "none";          // none/day/workday/week/month/year
    private String repeatEndType = "never";      // never/count/date
    private int repeatCount = 10;
    private String repeatEndDate;

    private EditText titleBox;
    private Button dateBtn;
    private Button startBtn;
    private Button durationBtn;
    private Button repeatBtn;
    private Button remindBtn;

    private static final String[] REPEAT_LABELS = {"不重复", "每天", "工作日（周一~五）", "每周", "每月", "每年"};
    private static final String[] REPEAT_VALUES = {"none", "day", "workday", "week", "month", "year"};
    private static final String[] END_LABELS = {"不结束", "按次数", "按日期"};
    private static final String[] END_VALUES = {"never", "count", "date"};
    private static final String[] DUR_LABELS = {"不设置", "15 分钟", "30 分钟", "45 分钟", "1 小时", "1.5 小时", "2 小时", "3 小时"};
    private static final int[] DUR_VALUES = {0, 15, 30, 45, 60, 90, 120, 180};

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_task);
        setFinishOnTouchOutside(true);

        String taskId = getIntent().getStringExtra("taskId");
        WidgetSnapshot snap = WidgetPrefs.snapshot(this);
        WTask found = null;
        for (WTask t : snap.tasks) if (t.id.equals(taskId)) found = t;
        if (found == null) {
            finish();
            return;
        }
        task = found;
        pickedDate = found.date;
        pickedStart = found.time;
        pickedDuration = Math.max(0, found.dur);
        pickedRemind = found.reminder;
        // 用当前规则反推预设档，供选择器初始高亮
        repeatUnit = presetOf(found.repeat);
        readEndOf(found.repeat);

        titleBox = findViewById(R.id.d_title);
        dateBtn = findViewById(R.id.d_date);
        startBtn = findViewById(R.id.d_start);
        durationBtn = findViewById(R.id.d_duration);
        repeatBtn = findViewById(R.id.d_repeat);
        remindBtn = findViewById(R.id.d_remind);

        ImageView doneBox = findViewById(R.id.d_done);
        pendingDone = found.done;
        doneBox.setImageResource(found.done ? R.drawable.ic_check_on : R.drawable.ic_check_off);
        doneBox.setOnClickListener(v -> {
            pendingDone = !pendingDone;
            doneBox.setImageResource(pendingDone ? R.drawable.ic_check_on : R.drawable.ic_check_off);
        });

        titleBox.setText(found.title);
        titleBox.setSelection(found.title.length());
        updateDateLabel();
        updateStartLabel();
        updateDurationLabel();
        updateRepeatLabel();
        updateRemindLabel();

        dateBtn.setOnClickListener(v -> pickDate());
        startBtn.setOnClickListener(v -> pickStart());
        durationBtn.setOnClickListener(v -> pickDuration());
        repeatBtn.setOnClickListener(v -> pickRepeat());
        remindBtn.setOnClickListener(v -> pickRemind());
        findViewById(R.id.d_trash).setOnClickListener(v -> confirmDelete());
    }

    /**
     * 关窗即自动保存。点弹窗外部 / 返回键都会走到这里。
     * 删除也走 finish()，所以用 {@link #deleteRequested} 把删除那一路排除掉。
     */
    @Override
    public void finish() {
        if (!deleteRequested) autoSave();
        super.finish();
    }

    /* ==================== 日期 ==================== */

    private void pickDate() {
        Calendar cal = Calendar.getInstance();
        int[] ymd = ymdOf(pickedDate);
        if (ymd != null) cal.set(ymd[0], ymd[1] - 1, ymd[2]);
        DatePickerDialog d = new DatePickerDialog(this, (view, y, m, day) -> {
            pickedDate = String.format(Locale.US, "%04d-%02d-%02d", y, m + 1, day);
            updateDateLabel();
        }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH));
        d.show();
    }

    private void updateDateLabel() {
        dateBtn.setText("日期：" + (pickedDate == null ? "不设置" : pickedDate + " " + weekdayOf(pickedDate)));
    }

    /* ==================== 开始时间 / 时长 ==================== */

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
        startBtn.setText("开始时间：" + (pickedStart == null ? "不设置" : pickedStart));
    }

    /** 时长：单选。替代原来的「至结束」 */
    private void pickDuration() {
        int cur = 0;
        for (int i = 0; i < DUR_VALUES.length; i++) {
            if (DUR_VALUES[i] == pickedDuration) { cur = i; break; }
        }
        new AlertDialog.Builder(this)
                .setTitle("时长")
                .setSingleChoiceItems(DUR_LABELS, cur, (dlg, which) -> {
                    pickedDuration = DUR_VALUES[which];
                    updateDurationLabel();
                    dlg.dismiss();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void updateDurationLabel() {
        durationBtn.setText("时长：" + (pickedDuration <= 0 ? "不设置" : fmtDuration(pickedDuration)));
    }

    /* ==================== 重复 ==================== */

    private void pickRepeat() {
        int cur = 0;
        for (int i = 0; i < REPEAT_VALUES.length; i++) {
            if (REPEAT_VALUES[i].equals(repeatUnit)) { cur = i; break; }
        }
        new AlertDialog.Builder(this)
                .setTitle("重复")
                .setSingleChoiceItems(REPEAT_LABELS, cur, (dlg, which) -> {
                    repeatUnit = REPEAT_VALUES[which];
                    repeatTouched = true;
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
        String label;
        if (!repeatTouched && task != null && task.repeat != null) {
            // 没动过 → 原样显示 App 里那条规则（可能比预设更细）
            label = repeatLabel(task.repeat);
        } else {
            label = "不重复";
            for (int i = 0; i < REPEAT_VALUES.length; i++) {
                if (REPEAT_VALUES[i].equals(repeatUnit)) { label = REPEAT_LABELS[i]; break; }
            }
            if (!"none".equals(repeatUnit)) {
                if ("count".equals(repeatEndType)) label += " · " + repeatCount + " 次";
                else if ("date".equals(repeatEndType) && repeatEndDate != null) label += " · 至 " + repeatEndDate.substring(5);
            }
        }
        repeatBtn.setText("重复：" + label);
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
        remindBtn.setText("提醒：" + (pickedRemind == null ? "不提醒" : pickedRemind));
    }

    /* ==================== 保存 / 删除 ==================== */

    /**
     * 关窗时把**真正改动过的字段**存下来。
     *
     * 只发改动字段有两个原因：少一次无谓请求；更重要的是 **repeat** ——
     * 用户没动重复时绝不下发，否则会把 App 里设的细节（自定义星期几、结束条件）
     * 用小组件这套简化档覆盖掉。
     */
    private void autoSave() {
        if (task == null || titleBox == null) return;
        final String newTitle = titleBox.getText().toString().trim();
        if (newTitle.isEmpty()) return;

        final String date = (pickedDate != null && !pickedDate.isEmpty()) ? pickedDate : task.date;
        final String tm = pickedStart;
        final int dur = tm == null ? 0 : pickedDuration;   // 没开始时间 → 时长无意义
        final boolean done = pendingDone;

        boolean titleCh = !newTitle.equals(task.title);
        boolean dateCh = !eqStr(date, task.date);
        boolean timeCh = !eqStr(tm, task.time);
        boolean durCh = dur != Math.max(0, task.dur);
        boolean doneCh = done != task.done;
        boolean repeatCh = repeatTouched;
        boolean remindCh = !eqStr(pickedRemind, task.reminder);

        if (!titleCh && !dateCh && !timeCh && !durCh && !doneCh && !repeatCh && !remindCh) return;

        final long now = System.currentTimeMillis();
        final JSONObject patch = new JSONObject();
        try {
            if (titleCh) patch.put("title", newTitle);
            if (dateCh) patch.put("date", date);
            if (timeCh) patch.put("time", tm == null ? JSONObject.NULL : tm);
            if (durCh) patch.put("duration", dur > 0 ? dur : JSONObject.NULL);
            if (doneCh) {
                patch.put("done", done);
                patch.put("doneAt", done ? now : JSONObject.NULL);
            }
            if (repeatCh) patch.put("repeat", buildRepeat());
            if (remindCh) patch.put("reminder", pickedRemind == null ? JSONObject.NULL : pickedRemind);
        } catch (Exception ignored) {
        }

        // 重复规则改了 → **当场派生后续几次**。只靠 App 那边的
        // ensureRepeatOccurrences 不够：用户在小组件上改完就走，App 一直没开。
        if (repeatCh) {
            try {
                RepeatSpawn.spawn(new RepeatSpawn.ContextWrapper(TaskDetailActivity.this),
                        task.id, newTitle, task.calId, date, buildRepeat(), pickedRemind);
            } catch (Exception ignored) {
            }
        }

        // ① 乐观更新本地快照 + 立刻重画
        try {
            WidgetPrefs.patchEntity(this, "tasks", task.id, patch, false);
        } catch (Exception ignored) {
        }
        ScheduleWidgetProvider.refresh(this);

        // ② 有票直连，否则入队
        sendEdit(patch, now);
    }

    private void sendEdit(JSONObject patch, long now) {
        if (!WidgetPrefs.canDirect(this)) {
            enqueueEdit(patch);
            return;
        }
        try {
            JSONArray ops = new JSONArray();
            ops.put(editOp(patch, now));
            WidgetApi.op(this, ops, new WidgetApi.OpCallback() {
                @Override
                public void onAccepted(JSONObject body) {
                    WidgetPrefs.mergeEntities(TaskDetailActivity.this, body, "tasks",
                            java.util.Collections.singletonList(task.id));
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                }

                @Override
                public void onRejected(JSONObject body, String why) {
                    WidgetPrefs.mergeEntities(TaskDetailActivity.this, body, "tasks",
                            java.util.Collections.singletonList(task.id));
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                    Ui.toast(TaskDetailActivity.this, "这次修改服务端没有接受，已回到原样");
                }

                @Override
                public void onUnreachable(String why) {
                    enqueueEdit(patch);
                }
            });
        } catch (Exception e) {
            enqueueEdit(patch);
        }
    }

    /** 拼一条编辑 op，字段就是 patch 里那几个（键名已是服务端口径） */
    private JSONObject editOp(JSONObject patch, long now) throws Exception {
        JSONObject op = new JSONObject();
        op.put("entity", "task");
        op.put("entityId", task.id);
        op.put("calId", task.calId);
        JSONObject fields = new JSONObject();
        java.util.Iterator<String> it = patch.keys();
        while (it.hasNext()) {
            String k = it.next();
            fields.put(k, patch.get(k));
        }
        op.put("fields", fields);
        return op;
    }

    private void enqueueEdit(JSONObject patch) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "edit");
            op.put("taskId", task.id);
            // patch 里的键就是最终字段（title/date/time/duration/done/repeat/reminder）
            java.util.Iterator<String> it = patch.keys();
            while (it.hasNext()) {
                String k = it.next();
                op.put(k, patch.get(k));
            }
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }

    /**
     * 删除：二次确认 → 软删除。
     *
     * 走 `deleted:true` + `deletedAt` —— 跟 App 的 deleteTask 同一套语义，
     * 服务端 `sync.applyOps` 的字段白名单接受，**不用改后端**；
     * App 的回收站还能找回。
     */
    private void confirmDelete() {
        new AlertDialog.Builder(this)
                .setTitle("删除任务")
                .setMessage("确定删除「" + task.title + "」？\nApp 的回收站里还能找回。")
                .setNegativeButton("取消", null)
                .setPositiveButton("删除", (dlg, which) -> doDelete())
                .show();
    }

    private void doDelete() {
        deleteRequested = true;
        final long now = System.currentTimeMillis();
        try {
            JSONObject f = new JSONObject();
            f.put("deleted", true);
            f.put("deletedAt", now);
            WidgetPrefs.patchEntity(this, "tasks", task.id, f, false);
        } catch (Exception ignored) {
        }
        ScheduleWidgetProvider.refresh(this);

        try {
            JSONObject fields = new JSONObject();
            fields.put("deleted", true);
            fields.put("deletedAt", now);
            if (!WidgetPrefs.canDirect(this)) {
                enqueueDelete(now);
                finish();
                return;
            }
            JSONArray ops = new JSONArray();
            JSONObject op = new JSONObject();
            op.put("entity", "task");
            op.put("entityId", task.id);
            op.put("calId", task.calId);
            op.put("fields", fields);
            ops.put(op);
            WidgetApi.op(this, ops, new WidgetApi.OpCallback() {
                @Override
                public void onAccepted(JSONObject body) {
                    WidgetPrefs.mergeEntities(TaskDetailActivity.this, body, "tasks",
                            java.util.Collections.singletonList(task.id));
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                }

                @Override
                public void onRejected(JSONObject body, String why) {
                    WidgetPrefs.mergeEntities(TaskDetailActivity.this, body, "tasks",
                            java.util.Collections.singletonList(task.id));
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                    Ui.toast(TaskDetailActivity.this, "删除没有成功，服务端没有接受");
                }

                @Override
                public void onUnreachable(String why) {
                    enqueueDelete(now);
                }
            });
        } catch (Exception e) {
            enqueueDelete(now);
        }
        finish();
    }

    private void enqueueDelete(long now) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "delete");
            op.put("taskId", task.id);
            op.put("calId", task.calId);
            op.put("deletedAt", now);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }

    /* ==================== 重复规则 ==================== */

    /**
     * 拼一份标准 RepeatRule（与 App 的 domain/types/RepeatRule.ts 同形）。
     * 预设 → unit 映射见 dialog_create 的同名方法。
     */
    private JSONObject buildRepeat() throws Exception {
        String unit = repeatUnit;
        JSONArray wd = new JSONArray();
        Calendar cal = Calendar.getInstance();
        int[] ymd = ymdOf(pickedDate);
        if (ymd != null) cal.set(ymd[0], ymd[1] - 1, ymd[2]);

        if ("workday".equals(unit)) {
            unit = "week";
            for (int d = 1; d <= 5; d++) wd.put(d);
        } else if ("week".equals(unit)) {
            wd.put(cal.get(Calendar.DAY_OF_WEEK) - 1);
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

    /** 现有规则 → 预设档（用于选择器初始高亮） */
    private static String presetOf(JSONObject r) {
        if (r == null) return "none";
        String unit = r.optString("unit", "none");
        if ("day".equals(unit)) return "day";
        if ("month".equals(unit)) return "month";
        if ("year".equals(unit)) return "year";
        if ("week".equals(unit)) {
            JSONArray wd = r.optJSONArray("weekdays");
            if (wd != null && wd.length() == 5) {
                boolean work = true;
                for (int i = 0; i < 5; i++) if (wd.optInt(i) != i + 1) work = false;
                if (work) return "workday";
            }
            return "week";
        }
        return "none";
    }

    /** 从现有规则里读出结束条件 */
    private void readEndOf(JSONObject r) {
        if (r == null) return;
        JSONObject end = r.optJSONObject("end");
        if (end == null) return;
        String t = end.optString("type");
        if ("count".equals(t)) {
            repeatEndType = "count";
            repeatCount = Math.max(1, end.optInt("count", 10));
        } else if ("date".equals(t)) {
            repeatEndType = "date";
            repeatEndDate = end.optString("date", null);
        }
    }

    /** RepeatRule → 中文标签（比预设更细，用于「没动过」时原样显示） */
    private static String repeatLabel(JSONObject r) {
        if (r == null) return "不重复";
        String unit = r.optString("unit", "none");
        if ("none".equals(unit)) return "不重复";
        int n = Math.max(1, r.optInt("n", 1));
        StringBuilder sb = new StringBuilder();
        if ("day".equals(unit)) {
            sb.append(n == 1 ? "每天" : "每 " + n + " 天");
        } else if ("week".equals(unit)) {
            JSONArray wd = r.optJSONArray("weekdays");
            String days = weekdaysLabel(wd);
            if (days.isEmpty()) sb.append(n == 1 ? "每周" : "每 " + n + " 周");
            else sb.append(n == 1 ? "每" + days : "每 " + n + " 周").append(n == 1 ? "" : " " + days);
        } else if ("month".equals(unit)) {
            sb.append(n == 1 ? "每月" : "每 " + n + " 个月");
            int md = r.optInt("monthday", 0);
            if (md > 0) sb.append(" ").append(md).append(" 号");
        } else if ("year".equals(unit)) {
            sb.append(n == 1 ? "每年" : "每 " + n + " 年");
            int ym = r.optInt("yearMonth", 0);
            int md = r.optInt("monthday", 0);
            if (ym > 0) sb.append(" ").append(ym).append(" 月");
            if (md > 0) sb.append(" ").append(md).append(" 号");
        } else {
            return "不重复";
        }
        JSONObject end = r.optJSONObject("end");
        if (end != null) {
            String et = end.optString("type");
            if ("count".equals(et)) sb.append(" · ").append(end.optInt("count")).append(" 次");
            else if ("date".equals(et)) {
                String d = end.optString("date", "");
                sb.append(" · 至 ").append(d.length() >= 10 ? d.substring(5) : d);
            }
        }
        return sb.toString();
    }

    /** 星期数组（App 口径 0=周日）→ 「周三」/「周一、三、五」/「工作日」 */
    private static String weekdaysLabel(JSONArray wd) {
        if (wd == null || wd.length() == 0) return "";
        boolean[] on = new boolean[7];
        for (int i = 0; i < wd.length(); i++) {
            int v = wd.optInt(i, -1);
            if (v >= 0 && v < 7) on[v] = true;
        }
        boolean work = on[1] && on[2] && on[3] && on[4] && on[5]
                && !on[0] && !on[6];
        if (work) return "工作日";
        String[] names = {"日", "一", "二", "三", "四", "五", "六"};
        StringBuilder sb = new StringBuilder("周");
        boolean first = true;
        for (int i = 0; i < 7; i++) {
            if (!on[i]) continue;
            if (!first) sb.append("、");
            sb.append(names[i]);
            first = false;
        }
        return sb.toString();
    }

    /* ==================== 小工具 ==================== */

    private static boolean eqStr(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    private static String fmtDuration(int minutes) {
        if (minutes <= 0) return "不设置";
        if (minutes < 60) return minutes + " 分钟";
        int h = minutes / 60;
        int m = minutes % 60;
        StringBuilder sb = new StringBuilder();
        sb.append(h == 1 ? "1 小时" : (h == 1.5 ? "1.5 小时" : h + " 小时"));
        if (m > 0) sb.append(" ").append(m).append(" 分");
        return sb.toString();
    }

    /** "HH:mm" → 从 0 点起的分钟数 */
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

    private static final String[] WD = {"", "周日", "周一", "周二", "周三", "周四", "周五", "周六"};

    private static String weekdayOf(String iso) {
        int[] ymd = ymdOf(iso);
        if (ymd == null) return "";
        Calendar cal = Calendar.getInstance();
        cal.set(ymd[0], ymd[1] - 1, ymd[2]);
        return WD[cal.get(Calendar.DAY_OF_WEEK)];
    }
}
