package space.xiaokubao.schedule;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

/**
 * 跨线程弹 toast。
 *
 * 为什么单开一个类：{@link WidgetApi} 的回调跑在**请求线程**上，那边直接
 * {@code Toast.makeText(...).show()} 会抛
 * 「Can't create handler inside thread that has not called Looper.prepare()」。
 * 而「服务端没接受这次修改」这类提示恰恰只能从回调里发 —— 那时候用户早
 * 关掉弹框了，Activity 的 UI 线程上下文也未必还在。
 */
final class Ui {
    private Ui() {}

    static void toast(Context c, String s) {
        new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(c.getApplicationContext(), s, Toast.LENGTH_LONG).show());
    }
}
