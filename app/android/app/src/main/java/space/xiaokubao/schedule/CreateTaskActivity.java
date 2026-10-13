package space.xiaokubao.schedule;

import android.app.Activity;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 新建任务弹框。
 *
 * 同样是对话框主题的 Activity —— 用户不离开桌面就能建一条。
 * **只有标题和时间是必填感最弱的两个字段**：备注 / 时长 / 重复这些留给 App，
 * 桌面上只做「快速记一笔」。真要细改，详情弹框里可以再加入口。
 */
public class CreateTaskActivity extends Activity {

    static void start(android.content.Context c, String dateIso) {
        android.content.Intent i = new android.content.Intent(c, CreateTaskActivity.class);
        i.putExtra("date", dateIso);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_create);

        final String date = getIntent().getStringExtra("date");
        final EditText title = findViewById(R.id.c_title);
        final EditText time = findViewById(R.id.c_time);
        Button save = findViewById(R.id.c_save);
        Button cancel = findViewById(R.id.c_cancel);

        save.setOnClickListener(v -> {
            String t = title.getText().toString().trim();
            if (t.isEmpty()) { title.setError("总得写点什么"); return; }
            final String tm = time.getText().toString().trim();

            // ① 乐观更新：本地造一条（id 是临时的，服务端返回真值后会整体覆盖）
            final String localId = "t_local_" + System.currentTimeMillis();
            try {
                JSONObject f = new JSONObject();
                f.put("title", t);
                f.put("date", date);
                f.put("time", tm.isEmpty() ? JSONObject.NULL : tm);
                f.put("dur", 0);
                f.put("done", false);
                f.put("calId", WidgetPrefs.snapshot(this).tasks.isEmpty()
                        ? "" : WidgetPrefs.snapshot(this).tasks.get(0).calId);
                WidgetPrefs.patchEntity(this, "tasks", localId, f, true);
            } catch (Exception ignored) {
            }

            // ② 有票就直连（B 方案）。entityId 传 "@new" 由服务端发真 id
            if (WidgetPrefs.canDirect(this)) {
                try {
                    JSONArray ops = new JSONArray();
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", "@new");
                    op.put("calId", defaultCalId(this));
                    JSONObject fields = new JSONObject();
                    fields.put("title", t);
                    fields.put("date", date);
                    fields.put("time", tm.isEmpty() ? JSONObject.NULL : tm);
                    fields.put("dur", 0);
                    fields.put("done", false);
                    fields.put("doneAt", JSONObject.NULL);
                    op.put("fields", fields);
                    ops.put(op);
                    WidgetApi.op(this, ops, new WidgetApi.Callback() {
                        @Override
                        public void onOk(JSONObject body) {
                            WidgetPrefs.replaceSnapshot(CreateTaskActivity.this, body);
                            ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                        }

                        @Override
                        public void onFail(String why) {
                            enqueueCreate(t, date, tm);
                        }
                    });
                } catch (Exception e) {
                    enqueueCreate(t, date, tm);
                }
            } else {
                enqueueCreate(t, date, tm);
            }
            finish();
        });
        cancel.setOnClickListener(v -> finish());
    }

    /** 默认集：从现有任务里随便借一个 calId（快照一定带） */
    private static String defaultCalId(android.content.Context c) {
        WidgetSnapshot s = WidgetPrefs.snapshot(c);
        if (!s.tasks.isEmpty()) return s.tasks.get(0).calId;
        return "";
    }

    private void enqueueCreate(String t, String date, String tm) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "create");
            op.put("title", t);
            op.put("date", date);
            op.put("time", tm.isEmpty() ? JSONObject.NULL : tm);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }
}
