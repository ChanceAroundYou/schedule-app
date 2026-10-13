package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.TimePickerDialog;
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

    /** 选中的开始时间，null = 不设置 */
    private String pickedStart = null;
    /** 选中的结束时间，null = 不设置 */
    private String pickedEnd = null;
    private Button startBtn;
    private Button endBtn;
    private TextView durHint;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_create);

        final String date = getIntent().getStringExtra("date");
        final EditText title = findViewById(R.id.c_title);
        startBtn = findViewById(R.id.c_start);
        endBtn = findViewById(R.id.c_end);
        durHint = findViewById(R.id.c_durhint);
        Button save = findViewById(R.id.c_save);
        Button cancel = findViewById(R.id.c_cancel);

        updateTimeLabels();
        startBtn.setOnClickListener(v -> pickStart());
        endBtn.setOnClickListener(v -> pickEnd());

        save.setOnClickListener(v -> {
            String t = title.getText().toString().trim();
            if (t.isEmpty()) { title.setError("总得写点什么"); return; }
            final String tm = pickedStart;
            final int dur = durationMinutes();
            final String calId = defaultCalId(this);

            // ① 乐观更新：本地造一条（id 是临时的，服务端返回真值后会整体覆盖）
            final String localId = "t_local_" + System.currentTimeMillis();
            try {
                JSONObject f = new JSONObject();
                f.put("title", t);
                f.put("date", date);
                f.put("time", tm == null ? JSONObject.NULL : tm);
                f.put("dur", dur);
                f.put("done", false);
                f.put("calId", calId);
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
                    WidgetApi.op(this, ops, new WidgetApi.Callback() {
                        @Override
                        public void onOk(JSONObject body) {
                            WidgetPrefs.replaceSnapshot(CreateTaskActivity.this, body);
                            ScheduleWidgetProvider.refresh(CreateTaskActivity.this);
                        }

                        @Override
                        public void onFail(String why) {
                            enqueueCreate(t, date, tm, dur);
                        }
                    });
                } catch (Exception e) {
                    enqueueCreate(t, date, tm, dur);
                }
            } else {
                enqueueCreate(t, date, tm, dur);
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
        op.put("fields", fields);
        return op;
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

    private void enqueueCreate(String t, String date, String tm, int dur) {
        try {
            JSONObject op = new JSONObject();
            op.put("kind", "create");
            op.put("title", t);
            op.put("date", date);
            op.put("time", tm == null ? JSONObject.NULL : tm);
            op.put("duration", dur);
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
}
