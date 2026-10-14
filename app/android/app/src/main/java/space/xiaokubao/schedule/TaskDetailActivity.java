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
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

/**
 * 任务**编辑 / 删除**弹框。点时间轴上的任务块就打开它。
 *
 * 2026-10-14：
 *  · 收紧凑（252dp / padding 12dp / 字号降档），跟设置弹框一个密度
 *  · **日期可编辑** —— 点了弹日历选择器（DatePickerDialog）。改完**留在当前
 *    日期**不跳走（用户选的），任务会从眼前消失，切过去才看得到。
 *  · 底排按钮变成 **[完成|未完成] [保存] [删除]**，去掉「关闭」；
 *    关闭靠点弹框外部 / 返回键（setFinishOnTouchOutside）
 *  · 窗口背景换透明主题后，四个角的亮白小圆角消失（见 AppTheme.WidgetDialog）
 *
 * ⚠️ 时长字段名是 **duration**，不是 dur —— 服务端和 App 读的都是 duration。
 * 旧代码写的是 dur，于是小组件设的时长从来没存进去过。
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
    /** 编辑中的日期（yyyy-MM-dd） */
    private String pickedDate;
    /** 编辑中的开始时间，null = 不设置 */
    private String pickedStart;
    /** 编辑中的结束时间，null = 不设置（时长退回默认 60 分钟） */
    private String pickedEnd;
    private EditText titleBox;
    private Button dateBtn;
    private Button startBtn;
    private Button endBtn;
    private TextView durHint;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_task);
        // 没有「关闭」按钮了 → 必须能点弹框外部关掉
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
        // 已有任务：把「开始 + 时长」还原成结束时间（没设时长按 60 分钟）
        pickedEnd = (found.time != null)
                ? timeOf((minOf(found.time) + durOf(found)) % 1440)
                : null;

        titleBox = findViewById(R.id.d_title);
        dateBtn = findViewById(R.id.d_date);
        startBtn = findViewById(R.id.d_start);
        endBtn = findViewById(R.id.d_end);
        durHint = findViewById(R.id.d_durhint);
        Button toggle = findViewById(R.id.d_toggle);

        titleBox.setText(found.title);
        titleBox.setSelection(found.title.length());
        toggle.setText(found.done ? "未完成" : "完成");
        updateDateLabel();
        updateTimeLabels();

        dateBtn.setOnClickListener(v -> pickDate());
        startBtn.setOnClickListener(v -> pickStart());
        endBtn.setOnClickListener(v -> pickEnd());
        // 「完成 / 未完成」会先把编辑框里的改动一起存下来 —— 否则用户改完标题
        // 顺手点一下，改动就悄悄丢了
        // 用字段 task 而不是局部量 found —— lambda 只捕获 effectively final 的局部量
        toggle.setOnClickListener(v -> save(!task.done));
        findViewById(R.id.d_save).setOnClickListener(v -> save(null));
        findViewById(R.id.d_delete).setOnClickListener(v -> confirmDelete());
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
        dateBtn.setText(pickedDate == null ? "不设置日期" : pickedDate + " " + weekdayOf(pickedDate));
    }

    /* ==================== 时间 ==================== */

    /** 开始时间：选了之后，若结束时间缺失或不再晚于开始，自动补一个 +1 小时 */
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
        // 「不设置」= 整条都不定时。setButton 必须在 show 之后调
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不设置", (dlg, which) -> {
            pickedStart = null;
            pickedEnd = null;
            updateTimeLabels();
        });
    }

    /** 结束时间：若还没设开始，就按「结束 - 1 小时」倒推一个开始时间 */
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
            pickedEnd = null;   // 只清结束 → 时长回到默认 60 分钟
            updateTimeLabels();
        });
    }

    private void updateTimeLabels() {
        startBtn.setText(pickedStart == null ? "不设置" : pickedStart);
        endBtn.setText(pickedEnd == null ? "不设置" : pickedEnd);

        if (pickedStart == null) {
            durHint.setText("未设置时间，不会出现在时间轴上");
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
        // 跨天：结束在开始之前，说明是次日
        if (pickedEnd != null && minOf(pickedEnd) <= minOf(pickedStart)) {
            sb.append("（次日 ").append(pickedEnd).append("）");
        }
        durHint.setText(sb.toString());
    }

    /** 开始 → 结束的分钟数。没设结束 = 默认 60；结束不晚于开始 = 跨天 */
    private int durationMinutes() {
        if (pickedStart == null) return 0;
        if (pickedEnd == null) return 60;
        int d = (minOf(pickedEnd) - minOf(pickedStart) + 1440) % 1440;
        return d == 0 ? 60 : d;
    }

    /* ==================== 保存 / 删除 ==================== */

    /**
     * 存下来并关掉。
     *
     * **先本地改样式再发请求**：弹框一关桌面就得是新样子，不等服务端往返。
     * 三种结局分别处理，见 {@link WidgetApi.OpCallback}：
     *   · 接受 → 只把这一条换成服务端的值（不整表覆盖）
     *   · 拒绝 → 同样换成服务端的值 = 回到真相，并提示用户
     *   · 问不出去 → 保留本地结果，入队等下次
     *
     * @param doneOverride 非 null 时同时改「完成」状态；null 表示保持原样。
     *                     和标题 / 日期 / 起止时间合成**一条** op 发出去，省一次往返。
     */
    private void save(Boolean doneOverride) {
        final String newTitle = titleBox.getText().toString().trim();
        if (newTitle.isEmpty()) {
            titleBox.setError("总得写点什么");
            return;
        }
        final boolean done = (doneOverride != null) ? doneOverride : task.done;
        final String date = (pickedDate != null && !pickedDate.isEmpty()) ? pickedDate : task.date;
        final String tm = pickedStart;
        final int dur = durationMinutes();
        final long now = System.currentTimeMillis();

        // ① 乐观更新本地快照 + **立刻重画**，弹框一关桌面就是新样子
        try {
            JSONObject f = new JSONObject();
            f.put("title", newTitle);
            f.put("date", date);
            f.put("time", tm == null ? JSONObject.NULL : tm);
            f.put("duration", dur);
            if (doneOverride != null) {
                f.put("done", done);
            }
            WidgetPrefs.patchEntity(this, "tasks", task.id, f, false);
        } catch (Exception ignored) {
        }
        ScheduleWidgetProvider.refresh(this);

        // ② 有票就直连（B 方案），否则入队等 App 启动后补发
        sendEdit(newTitle, date, tm, dur, doneOverride, done, now);
        finish();
    }

    private void sendEdit(String newTitle, String date, String tm, int dur, Boolean doneOverride,
                          boolean done, long now) {
        if (!WidgetPrefs.canDirect(this)) {
            enqueueEdit(newTitle, date, tm, dur, doneOverride, done);
            return;
        }
        try {
            JSONArray ops = new JSONArray();
            ops.put(editOp(newTitle, date, tm, dur, doneOverride, done, now));
            WidgetApi.op(this, ops, new WidgetApi.OpCallback() {
                @Override
                public void onAccepted(JSONObject body) {
                    // 只同步这一条 —— 整表替换会把还没发出去的乐观改动抹掉
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
                    enqueueEdit(newTitle, date, tm, dur, doneOverride, done);
                }
            });
        } catch (Exception e) {
            enqueueEdit(newTitle, date, tm, dur, doneOverride, done);
        }
    }

    /** 拼一条编辑 op。时长字段名用 **duration**（服务端的字段），不是 dur */
    private JSONObject editOp(String newTitle, String date, String tm, int dur,
                              Boolean doneOverride, boolean done, long now) throws Exception {
        JSONObject op = new JSONObject();
        op.put("entity", "task");
        op.put("entityId", task.id);
        op.put("calId", task.calId);
        JSONObject fields = new JSONObject();
        fields.put("title", newTitle);
        fields.put("date", date);
        fields.put("time", tm == null ? JSONObject.NULL : tm);
        fields.put("duration", dur);
        if (doneOverride != null) {
            fields.put("done", done);
            fields.put("doneAt", done ? now : JSONObject.NULL);
        }
        op.put("fields", fields);
        return op;
    }

    private void enqueueEdit(String newTitle, String date, String tm, int dur,
                             Boolean doneOverride, boolean done) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "edit");
            op.put("taskId", task.id);
            op.put("title", newTitle);
            op.put("date", date);
            op.put("time", tm == null ? JSONObject.NULL : tm);
            op.put("duration", dur);
            // null 表示「这次不改完成状态」—— 跟 false 是两回事，别混
            op.put("done", doneOverride == null ? JSONObject.NULL : done);
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
        final long now = System.currentTimeMillis();
        // ① 本地打墓碑 —— WidgetData 解析时会剔掉 deleted 的条 → 桌面立刻不见
        try {
            JSONObject f = new JSONObject();
            f.put("deleted", true);
            f.put("deletedAt", now);
            WidgetPrefs.patchEntity(this, "tasks", task.id, f, false);
        } catch (Exception ignored) {
        }
        ScheduleWidgetProvider.refresh(this);

        // ② 下发
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
                    // 服务端视图里已经没有这条了 → mergeEntities 什么都不做，
                    // 本地那条墓碑正好留着，桌面继续保持「已删除」
                    WidgetPrefs.mergeEntities(TaskDetailActivity.this, body, "tasks",
                            java.util.Collections.singletonList(task.id));
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                }

                @Override
                public void onRejected(JSONObject body, String why) {
                    // 删除被拒 → 服务端视图里这条还在，合并即等于**撤销删除**
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
            // calId 一起存：乐观删除之后本地快照里已经查不到这条任务了，
            // 补发时只能靠队列里这份 calId 去查权限
            op.put("calId", task.calId);
            op.put("deletedAt", now);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }

    /* ==================== 小工具 ==================== */

    /** 时长（分钟）。跟 App 的 durOf 一致：没设的按 60 分钟算 */
    private static int durOf(WTask t) {
        return t.dur > 0 ? t.dur : 60;
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

    /**
     * 下标 = {@link Calendar#DAY_OF_WEEK}：**1 是周日**，2..7 依次是周一到周六。
     * （按字面顺序写「周一…周日」会和 Calendar 的编号错开一天。）
     */
    private static final String[] WD = {"", "周日", "周一", "周二", "周三", "周四", "周五", "周六"};

    private static String weekdayOf(String iso) {
        int[] ymd = ymdOf(iso);
        if (ymd == null) return "";
        Calendar cal = Calendar.getInstance();
        cal.set(ymd[0], ymd[1] - 1, ymd[2]);
        return WD[cal.get(Calendar.DAY_OF_WEEK)];
    }
}
