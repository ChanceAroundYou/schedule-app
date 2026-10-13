package space.xiaokubao.schedule;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 小组件的原生 HTTP 客户端 —— **B 方案**：不打开 App 也能真正读写服务器。
 *
 * 为什么需要它：小组件是独立进程，读不到 IndexedDB、跑不了 React、
 * 也没有同步引擎。A 方案（待同步队列）只能把改动攒着，等下次打开 App
 * 才真正落库 —— 那等于还是得开 App。这里让小组件自己发请求。
 *
 * 三条设计约束：
 *
 * 1. **票由 App 提供。** 小组件不自己登录（那要存口令）。App 登录成功后
 *    把 token 写进 WidgetPrefs，小组件拿着用。票过期/被踢时 bootstrap 会
 *    返 401，此时小组件退回「只显示快照 + 提示打开 App」。
 *
 * 2. **写仍走服务端的 applyOps 闸门。** 我们只调 `/api/widget/op`，
 *    权限判断（roleOf + canWrite）和 LWW 合并在服务端原有逻辑里做，
 *    原生侧不多做一步判断。
 *
 * 3. **不在主线程发网络请求。** 全部丢到线程池，回调切回主线程。
 *    AppWidgetProvider 的 onReceive 就在主线程，直接发请求会
 *    NetworkOnMainThreadException。
 */
class WidgetApi {

    private static final String TAG = "WidgetApi";
    private static final int TIMEOUT_MS = 8000;

    interface Callback {
        void onOk(JSONObject body);
        void onFail(String why);
    }

    /** 拉一次数据。返回体就是快照形状，直接喂给 WidgetSnapshot.parse */
    static void bootstrap(Context c, Callback cb) {
        String token = WidgetPrefs.token(c);
        if (token == null || token.isEmpty()) {
            cb.onFail("no-token");
            return;
        }
        request(c, "GET", "/api/widget/bootstrap", null, token, cb);
    }

    /**
     * 发一批写操作。
     *
     * @param ops 简化 op 数组，元素形如
     *        { "entity":"task", "entityId":"t_xxx", "calId":"c_xxx",
     *          "fields": { "done": true, "doneAt": 1699999999999 } }
     *        entityId 传 "@new" 时服务端发一个新 id（新建任务用）
     */
    static void op(Context c, JSONArray ops, Callback cb) {
        String token = WidgetPrefs.token(c);
        if (token == null || token.isEmpty()) {
            cb.onFail("no-token");
            return;
        }
        try {
            JSONObject body = new JSONObject();
            body.put("deviceId", WidgetPrefs.deviceId(c));
            body.put("ops", ops);
            request(c, "POST", "/api/widget/op", body, token, cb);
        } catch (Exception e) {
            cb.onFail("build-body: " + e.getMessage());
        }
    }

    // ── 内部 ────────────────────────────────────────────────────────────

    private static void request(Context c, String method, String path,
                                JSONObject body, String token, Callback cb) {
        String base = WidgetPrefs.apiBase(c);
        // base 可能带尾斜杠，path 一定带前导斜杠 —— 拼一下，别出双斜杠
        String url = base.replaceAll("/+$", "") + path;
        Thread t = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                HttpURLConnection k = (HttpURLConnection) new URL(url).openConnection();
                conn = k;
                conn.setRequestMethod(method);
                conn.setConnectTimeout(TIMEOUT_MS);
                conn.setReadTimeout(TIMEOUT_MS);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                if (body != null) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                }

                int code = conn.getResponseCode();
                InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String text = readAll(is);

                if (code == 401) {
                    fail(cb, "unauthorized");
                    return;
                }
                if (code < 200 || code >= 300) {
                    fail(cb, "http-" + code);
                    return;
                }
                JSONObject out;
                try {
                    out = new JSONObject(text);
                } catch (Exception e) {
                    fail(cb, "bad-json");
                    return;
                }
                ok(cb, out);
            } catch (Exception e) {
                Log.w(TAG, method + " " + path + " 失败: " + e);
                fail(cb, "network: " + e.getClass().getSimpleName());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
        t.setPriority(Thread.MIN_PRIORITY);   // 别跟渲染抢
        t.start();
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.toString();
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static void ok(Callback cb, JSONObject body) {
        MAIN.post(() -> cb.onOk(body));
    }

    private static void fail(Callback cb, String why) {
        MAIN.post(() -> cb.onFail(why));
    }
}
