package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.TimePickerDialog;
import android.content.DialogInterface;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * 新建任务弹框。
 *
 * 同样是对话框主题的 Activity —— 用户不离开桌面就能建一条。
 * **只有标题和时间**：备注 / 时长 / 重复这些留给 App，桌面上只做
 * 「快速记一笔」。
 *
 * 时间是**按钮 + 表盘**，不是输入框（用户明确要求过）：手打「09:30」
 * 要切键盘、要记格式，快速记一笔时最烦的就是这一步。
 */
public class CreateTaskActivity extends Activity {

    static void start(android.content.Context c, String dateIso) {
        android.content.Intent i = new android.content.Intent(c, CreateTaskActivity.class);
        i.putExtra("date", dateIso);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    /** 选中的时间，null = 不设置 */
    private String pickedTime = null;
    private Button timeBtn;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_create);

        final String date = getIntent().getStringExtra("date");
        final EditText title = findViewById(R.id.c_title);
        timeBtn = findViewById(R.id.c_time);
        Button save = findViewById(R.id.c_save);
        Button cancel = findViewById(R.id.c_cancel);

        updateTimeLabel();
        timeBtn.setOnClickListener(v -> pickTime());

        save.setOnClickListener(v -> {
            String t = title.getText().toString().trim();
            if (t.isEmpty()) { title.setError("总得写点什么"); return; }
            final String tm = pickedTime;
            final String calId = defaultCalId(this);

            // ① 乐观更新：本地造一条（id 是临时的，服务端返回真值后会整体覆盖）
            final String localId = "t_local_" + System.currentTimeMillis();
            try {
                JSONObject f = new JSONObject();
                f.put("title", t);
                f.put("date", date);
                f.put("time", tm == null ? JSONObject.NULL : tm);
                f.put("dur", 0);
                f.put("done", false);
                f.put("calId", calId);
                WidgetPrefs.patchEntity(this, "tasks", localId, f, true);
            } catch (Exception ignored) {
            }

            // ② 有票就直连（B 方案）。entityId 传 "@new" 由服务端发真 id。
            //    calId 拿不到时不能发 —— 服务端会因为缺 calId 整条丢掉（不报错）
            if (WidgetPrefs.canDirect(this) && !calId.isEmpty()) {
                try {
                    JSONArray ops = new JSONArray();
                    JSONObject op = new JSONObject();
                    op.put("entity", "task");
                    op.put("entityId", "@new");
                    op.put("calId", calId);
                    JSONObject fields = new JSONObject();
                    fields.put("title", t);
                    fields.put("date", date);
                    fields.put("time", tm == null ? JSONObject.NULL : tm);
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
        // 已经选过时间的多半是想改 → 给个「不设置」直接清掉。
        // setButton 必须在 show 之后调，AlertDialog 的按钮是 show 时创建的
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "不设置", (dlg, which) -> {
            pickedTime = null;
            updateTimeLabel();
        });
    }

    private void updateTimeLabel() {
        timeBtn.setText(pickedTime == null ? "不设置时间" : "时间  " + pickedTime);
    }

    /** 默认集：从现有任务里借一个 calId（快照一定带） */
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
            op.put("time", tm == null ? JSONObject.NULL : tm);
            WidgetPrefs.enqueuePending(this, op);
        } catch (Exception ignored) {
        }
    }
}
