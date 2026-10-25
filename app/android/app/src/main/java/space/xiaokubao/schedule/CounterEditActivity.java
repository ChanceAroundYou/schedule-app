package space.xiaokubao.schedule;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.TextView;

/**
 * 点桌面计数器上的**数字**弹出的输入小窗 —— 用来一次改好几百。
 *
 * 为什么不是长按菜单：桌面组件收不到长按。为什么不在组件里直接编辑：
 * RemoteViews 放不了真正能输的输入框，也弹不出键盘。
 *
 * 保存语义是「设成这个值」，不是「加这个值」。所以走的是 /api/widget/counter
 * 的 value 分支，并且会**清掉这个 id 在队列里的旧意图**（绝对值优先）——
 * 先点 +5 再手输 300，最后应该是 300，不是 305。
 */
public class CounterEditActivity extends Activity {

    static final String EXTRA_ID = "id";
    static final String EXTRA_NAME = "name";
    static final String EXTRA_VALUE = "value";

    static void start(Context c, String id, String name, int value) {
        if (id == null || id.isEmpty()) return;
        Intent i = new Intent(c, CounterEditActivity.class)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_NAME, name)
                .putExtra(EXTRA_VALUE, value)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    private String counterId = "";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.dialog_counter_edit);
        setFinishOnTouchOutside(true);

        // 弹窗默认按内容收缩，太窄。加宽到屏幕宽度的 90%，约一倍。
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        getWindow().setLayout((int) (dm.widthPixels * 0.9), android.view.ViewGroup.LayoutParams.WRAP_CONTENT);

        counterId = getIntent().getStringExtra(EXTRA_ID);
        String name = getIntent().getStringExtra(EXTRA_NAME);
        int value = getIntent().getIntExtra(EXTRA_VALUE, 0);
        if (counterId == null || counterId.isEmpty()) {
            finish();
            return;
        }
        if (name == null || name.isEmpty()) name = counterId;

        // 颜色跟着「哪一块」走：第一块粉（naonao）、第二块绿（Kutai）。
        // 用 id 判断而不是位置，改名之后仍然对得上。
        boolean pink = !"kutai".equalsIgnoreCase(counterId);

        TextView nameView = findViewById(R.id.ctr_edit_name);
        nameView.setText(name);
        nameView.setTextColor(getColor(pink ? R.color.ctrPinkName : R.color.ctrGreenName));

        TextView ok = findViewById(R.id.ctr_edit_ok);
        ok.setBackgroundResource(pink ? R.drawable.ctr_btn_ok_pink : R.drawable.ctr_btn_ok_green);

        final EditText box = findViewById(R.id.ctr_edit_value);
        box.setText(String.valueOf(value));
        box.setSelection(box.getText().length());
        box.requestFocus();
        // 键盘不会因为 requestFocus 自己出来（窗口是刚建的），这里显式弹一次
        box.post(new Runnable() {
            @Override
            public void run() {
                InputMethodManager im =
                        (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (im != null) im.showSoftInput(box, InputMethodManager.SHOW_IMPLICIT);
            }
        });

        findViewById(R.id.ctr_edit_cancel).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });

        ok.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                save(box);
            }
        });
    }

    private void save(EditText box) {
        String raw = box.getText() == null ? "" : box.getText().toString().trim();
        // 空着当「不改」：用户清空之后改主意的概率，高于真想清成 0 的概率
        if (raw.isEmpty()) {
            finish();
            return;
        }
        int v;
        try {
            v = Integer.parseInt(raw);
        } catch (Exception e) {
            finish();
            return;
        }
        v = CounterStore.clamp(v);

        Context app = getApplicationContext();
        CounterStore.localSet(app, counterId, v);   // 立刻生效
        CounterStore.queueSet(app, counterId, v);   // 断网也不丢（并作废该 id 的旧增量）
        CounterWidgetProvider.refreshAll(app);

        CounterStore.flush(app, new Runnable() {
            @Override
            public void run() {
                CounterWidgetProvider.refreshAll(getApplicationContext());
            }
        });
        finish();
    }
}
