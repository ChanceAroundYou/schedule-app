package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.AlertDialog;
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

import java.util.Locale;

/**
 * 任务**编辑 / 删除**弹框。点时间轴上的任务块就打开它。
 *
 * 2026-10-13 扩充：
 *  · **起止时间**：开始 + 结束两个表盘。服务端只存「开始 time + 时长 duration」，
 *    所以这里把结束换算成 duration 再下发（结束早于开始 = 跨天，时长按 +24h 算）。
 *  · **删除**：二次确认后**软删除**（deleted / deletedAt 两个字段）—— 跟 App 的
 *    deleteTask 一个语义，App 回收站还能找回，服务端也不用改。
 *  · ⚠️ 时长字段名是 **duration**，不是 dur。旧代码写的是 dur，而服务端和
 *    App（widgetSnapshot.ts: `dur: t.duration`）读的都是 duration —— 于是
 *    小组件设的时长**从来没存进去过**，一直恒为默认 60 分钟。一并修掉。
 *
 * **用对话框主题的 Activity，不是打开 App**：RemoteViews 画不出模态框，
 * 只能借一个 Activity 的外壳，观感仍是桌面上弹出一张小卡片。
 *
 * 日期只能看、不能改：时间轴是按天翻的，要把任务挪到别的日子，切到那天新建
 * 更直接 —— 而且「改日期」会把这条从当前屏幕上挪走，容易让人以为删掉了。
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
    /** 编辑中的开始时间，null = 不设置 */
    private String pickedStart;
    /** 编辑中的结束时间，null = 不设置（时长退回默认 60 分钟） */
    private String pickedEnd;
    private EditText titleBox;
    private Button startBtn;
    private Button endBtn;
    private TextView durHint;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_task);

        String taskId = getIntent().getStringExtra("taskId");
        WidgetSnapshot snap = WidgetPrefs.snapshot(this);
        WTask found = null;
        for (WTask t : snap.tasks) if (t.id.equals(taskId)) found = t;
        if (found == null) {
            finish();
            return;
        }
        task = found;
        pickedStart = found.time;
        // 已有任务：把「开始 + 时长」还原成结束时间（没设时长按 60 分钟）
        pickedEnd = (found.time != null)
                ? timeOf((minOf(found.time) + durOf(found)) % 1440)
                : null;

        titleBox = findViewById(R.id.d_title);
        startBtn = findViewById(R.id.d_start);
        endBtn = findViewById(R.id.d_end);
        durHint = findViewById(R.id.d_durhint);
        TextView when = findViewById(R.id.d_when);
        Button toggle = findViewById(R.id.d_toggle);

        titleBox.setText(found.title);
        titleBox.setSelection(found.title.length());
        when.setText(found.date);
        toggle.setText(found.done ? "取消完成" : "标记完成");
        updateTimeLabels();

        startBtn.setOnClickListener(v -> pickStart());
        endBtn.setOnClickListener(v -> pickEnd());
        // 「标记完成」会先把编辑框里的改动一起存下来 —— 否则用户改完标题顺手
        // 点个完成，改动就悄悄丢了
        // 用字段 task 而不是局部变量 found —— lambda 只捕获 effectively final 的局部量
        toggle.setOnClickListener(v -> save(!task.done));
        findViewById(R.id.d_save).setOnClickListener(v -> save(null));
        findViewById(R.id.d_close).setOnClickListener(v -> finish());
        findViewById(R.id.d_delete).setOnClickListener(v -> confirmDelete());
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
     * @param doneOverride 非 null 时同时改「完成」状态；null 表示保持原样。
     *                     和标题 / 时间 / 时长合成**一条** op 发出去，省一次往返。
     */
    private void save(Boolean doneOverride) {
        final String newTitle = titleBox.getText().toString().trim();
        if (newTitle.isEmpty()) {
            titleBox.setError("总得写点什么");
            return;
        }
        final boolean done = (doneOverride != null) ? doneOverride : task.done;
        final String tm = pickedStart;
        final int dur = durationMinutes();
        final long now = System.currentTimeMillis();

        // ① 乐观更新本地快照，弹框一关桌面就是新样子
        try {
            JSONObject f = new JSONObject();
            f.put("title", newTitle);
            f.put("time", tm == null ? JSONObject.NULL : tm);
            f.put("duration", dur);
            if (doneOverride != null) {
                f.put("done", done);
            }
            WidgetPrefs.patchEntity(this, "tasks", task.id, f, false);
        } catch (Exception ignored) {
        }
        // 立刻重画：以前要等网络返回才画，用户点完「保存」/「标记完成」
        // 看到的还是原样（跟打卡那边一个毛病）
        ScheduleWidgetProvider.refresh(this);

        // ② 有票就直连（B 方案），否则入队等 App 启动后补发
        sendEdit(newTitle, tm, dur, doneOverride, done, now);
        finish();
    }

    private void sendEdit(String newTitle, String tm, int dur, Boolean doneOverride,
                          boolean done, long now) {
        if (!WidgetPrefs.canDirect(this)) {
            enqueueEdit(newTitle, tm, dur, doneOverride, done);
            return;
        }
        try {
            JSONArray ops = new JSONArray();
            ops.put(editOp(newTitle, tm, dur, doneOverride, done, now));
            WidgetApi.op(this, ops, new WidgetApi.Callback() {
                @Override
                public void onOk(JSONObject body) {
                    WidgetPrefs.replaceSnapshot(TaskDetailActivity.this, body);
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                }

                @Override
                public void onFail(String why) {
                    enqueueEdit(newTitle, tm, dur, doneOverride, done);
                }
            });
        } catch (Exception e) {
            enqueueEdit(newTitle, tm, dur, doneOverride, done);
        }
    }

    /** 拼一条编辑 op。字段名用 **duration**（服务端的字段），不是 dur */
    private JSONObject editOp(String newTitle, String tm, int dur, Boolean doneOverride,
                              boolean done, long now) throws Exception {
        JSONObject op = new JSONObject();
        op.put("entity", "task");
        op.put("entityId", task.id);
        op.put("calId", task.calId);
        JSONObject fields = new JSONObject();
        fields.put("title", newTitle);
        fields.put("time", tm == null ? JSONObject.NULL : tm);
        fields.put("duration", dur);
        if (doneOverride != null) {
            fields.put("done", done);
            fields.put("doneAt", done ? now : JSONObject.NULL);
        }
        op.put("fields", fields);
        return op;
    }

    private void enqueueEdit(String newTitle, String tm, int dur, Boolean doneOverride, boolean done) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "edit");
            op.put("taskId", task.id);
            op.put("title", newTitle);
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
            WidgetApi.op(this, ops, new WidgetApi.Callback() {
                @Override
                public void onOk(JSONObject body) {
                    WidgetPrefs.replaceSnapshot(TaskDetailActivity.this, body);
                    ScheduleWidgetProvider.refresh(TaskDetailActivity.this);
                }

                @Override
                public void onFail(String why) {
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
}
