package space.xiaokubao.schedule;

import android.app.Activity;
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
 * 任务**编辑**弹框。点时间轴上的任务块就打开它。
 *
 * 以前这里只是张只读卡片（标题 + 时间 + 一个「标记完成」）—— 用户在桌面上
 * 看到写错的任务，只能开 App 改。现在标题能改、时间能改，跟新建弹框同一套交互。
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
    /** 编辑中的时间，null = 不设置 */
    private String pickedTime;
    private EditText titleBox;
    private Button timeBtn;

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
        pickedTime = found.time;

        titleBox = findViewById(R.id.d_title);
        timeBtn = findViewById(R.id.d_time);
        TextView when = findViewById(R.id.d_when);
        Button toggle = findViewById(R.id.d_toggle);

        titleBox.setText(found.title);
        titleBox.setSelection(found.title.length());

        StringBuilder meta = new StringBuilder(found.date);
        if (found.dur > 0) {
            meta.append(found.dur >= 60 ? "  ·  时长 " + found.dur / 60 + " 小时" : "  ·  时长 " + found.dur + " 分");
            if (found.dur % 60 > 0) meta.append(" ").append(found.dur % 60).append(" 分");
        }
        when.setText(meta.toString());
        toggle.setText(found.done ? "取消完成" : "标记完成");
        updateTimeLabel();

        timeBtn.setOnClickListener(v -> pickTime());
        // 「标记完成」会先把编辑框里的改动一起存下来 —— 否则用户改完标题顺手
        // 点个完成，改动就悄悄丢了
        // 用字段 task 而不是局部变量 found —— lambda 只捕获 effectively final 的局部量
        toggle.setOnClickListener(v -> save(!task.done));
        findViewById(R.id.d_save).setOnClickListener(v -> save(null));
        findViewById(R.id.d_close).setOnClickListener(v -> finish());
    }

    /**
     * 存下来并关掉。
     *
     * @param doneOverride 非 null 时同时改「完成」状态；null 表示保持原样。
     *                     和标题 / 时间合成**一条** op 发出去，省一次往返。
     */
    private void save(Boolean doneOverride) {
        final String newTitle = titleBox.getText().toString().trim();
        if (newTitle.isEmpty()) {
            titleBox.setError("总得写点什么");
            return;
        }
        final boolean done = (doneOverride != null) ? doneOverride : task.done;
        final String tm = pickedTime;
        final long now = System.currentTimeMillis();

        // ① 乐观更新本地快照，弹框一关桌面就是新样子
        try {
            JSONObject f = new JSONObject();
            f.put("title", newTitle);
            f.put("time", tm == null ? JSONObject.NULL : tm);
            if (doneOverride != null) {
                f.put("done", done);
            }
            WidgetPrefs.patchEntity(this, "tasks", task.id, f, false);
        } catch (Exception ignored) {
        }
        // 立刻重画：以前要等网络返回才画，用户点完「保存」/「标记完成」
        // 看到的还是原样（跟打卡那边一个毛病）
        ScheduleWidgetProvider.refresh(this);

        enqueueOrSend(newTitle, tm, doneOverride, done, now);
        finish();
    }

    /** 有票就直连（B 方案），否则入队等 App 启动后补发 */
    private void enqueueOrSend(String newTitle, String tm, Boolean doneOverride,
                               boolean done, long now) {
        if (!WidgetPrefs.canDirect(this)) {
            enqueueEdit(newTitle, tm, doneOverride, done);
            return;
        }
        try {
            JSONArray ops = new JSONArray();
            JSONObject op = new JSONObject();
            op.put("entity", "task");
            op.put("entityId", task.id);
            op.put("calId", task.calId);
            JSONObject fields = new JSONObject();
            fields.put("title", newTitle);
            fields.put("time", tm == null ? JSONObject.NULL : tm);
            if (doneOverride != null) {
                fields.put("done", done);
                fields.put("doneAt", done ? now : JSONObject.NULL);
            }
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
                    enqueueEdit(newTitle, tm, doneOverride, done);
                }
            });
        } catch (Exception e) {
            enqueueEdit(newTitle, tm, doneOverride, done);
        }
    }

    private void enqueueEdit(String newTitle, String tm, Boolean doneOverride, boolean done) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "edit");
            op.put("taskId", task.id);
            op.put("title", newTitle);
            op.put("time", tm == null ? JSONObject.NULL : tm);
            // null 表示「这次不改完成状态」—— 跟 false 是两回事，别混
            op.put("done", doneOverride == null ? JSONObject.NULL : done);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }

    /** 表盘选时。24 小时制，跟小组件上显示的一致 */
    private void pickTime() {
        int h = 9;
        int m = 0;
        if (pickedTime != null) {
            int i = pickedTime.indexOf(':');
            try {
                h = Integer.parseInt(pickedTime.substring(0, i));
                m = Integer.parseInt(pickedTime.substring(i + 1));
            } catch (Exception ignored) {
            }
        }
        TimePickerDialog d = new TimePickerDialog(this, (view, hh, mm) -> {
            pickedTime = String.format(Locale.US, "%02d:%02d", hh, mm);
            updateTimeLabel();
        }, h, m, true);
        d.show();
        // setButton 必须在 show 之后调 —— AlertDialog 的按钮是 show 时创建的
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不设置", (dlg, which) -> {
            pickedTime = null;
            updateTimeLabel();
        });
    }

    private void updateTimeLabel() {
        timeBtn.setText(pickedTime == null ? "不设置时间" : "时间  " + pickedTime);
    }
}
