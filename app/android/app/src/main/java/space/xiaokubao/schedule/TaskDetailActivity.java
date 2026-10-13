package space.xiaokubao.schedule;

import android.app.Activity;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * 任务详情弹框。
 *
 * **用对话框主题的 Activity，不是打开 App** —— 观感是桌面上弹出一个小卡片，
 * 用户不用离开桌面。这是 AppWidget 里做「弹框」的唯一路子：RemoteViews 画不出
 * 模态框，只能借一个 Activity 的外壳。
 */
public class TaskDetailActivity extends Activity {

    static void start(android.content.Context c, String taskId) {
        if (taskId == null) return;
        android.content.Intent i = new android.content.Intent(c, TaskDetailActivity.class);
        i.putExtra("taskId", taskId);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_task);

        String taskId = getIntent().getStringExtra("taskId");
        WidgetSnapshot snap = WidgetPrefs.snapshot(this);
        WTask task = null;
        for (WTask t : snap.tasks) if (t.id.equals(taskId)) task = t;
        if (task == null) { finish(); return; }
        /** lambda 里引用的局部变量必须实际 final —— 循环里那个 task 会被反复赋值 */
        final WTask theTask = task;

        TextView title = findViewById(R.id.d_title);
        TextView when = findViewById(R.id.d_when);
        TextView dur = findViewById(R.id.d_dur);
        Button toggle = findViewById(R.id.d_toggle);
        Button close = findViewById(R.id.d_close);

        title.setText(theTask.title);
        when.setText(theTask.date + (theTask.time != null ? "  " + theTask.time : "  未定时"));
        if (theTask.dur > 0) {
            dur.setVisibility(android.view.View.VISIBLE);
            dur.setText("时长 " + (theTask.dur / 60) + " 小时" + (theTask.dur % 60 > 0 ? " " + (theTask.dur % 60) + " 分" : ""));
        }
        toggle.setText(theTask.done ? "取消完成" : "标记完成");

        toggle.setOnClickListener(v -> {
            final boolean on = !theTask.done;
            final long now = System.currentTimeMillis();

            // ① 乐观更新本地，弹框关掉后桌面已经是新状态
            try {
                JSONObject f = new JSONObject();
                f.put("done", on);
                f.put("doneAt", on ? now : JSONObject.NULL);
                WidgetPrefs.patchEntity(this, "tasks", theTask.id, f, false);
            } catch (Exception ignored) {
            }

            // ② 有票就直连（B 方案）；没票/断网就入队等 App 启动后补发
            if (WidgetPrefs.canDirect(this)) {
                try {
                    JSONArray ops = new JSONArray();
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", theTask.id);
                    op.put("calId", theTask.calId);
                    JSONObject fields = new JSONObject();
                    fields.put("done", on);
                    fields.put("doneAt", on ? now : JSONObject.NULL);
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
                            enqueueToggle(theTask.id, on);
                        }
                    });
                } catch (Exception e) {
                    enqueueToggle(theTask.id, on);
                }
            } else {
                enqueueToggle(theTask.id, on);
            }
            finish();
        });
        close.setOnClickListener(v -> finish());
    }

    private void enqueueToggle(String taskId, boolean on) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "toggle");
            op.put("taskId", taskId);
            op.put("on", on);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }
}
