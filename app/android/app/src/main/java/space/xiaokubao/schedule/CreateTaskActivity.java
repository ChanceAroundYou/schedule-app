package space.xiaokubao.schedule;

import android.app.Activity;
import android.os.Bundle;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;

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
            try {
                JSONObject op = new JSONObject();
                op.put("kind", "create");
                op.put("title", t);
                op.put("date", date);
                String tm = time.getText().toString().trim();
                op.put("time", tm.isEmpty() ? JSONObject.NULL : tm);
                WidgetPrefs.enqueuePending(this, op);
            } catch (Exception ignored) {
            }
            ScheduleWidgetProvider.refresh(this);
            finish();
        });
        cancel.setOnClickListener(v -> finish());
    }
}
