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

    /**
     * 写操作的回调 —— **三种结局分开报**，因为处理方式完全不同：
     *
     *   · {@link #onAccepted}  服务端认了（applied &gt; 0）
     *   · {@link #onRejected}  服务端明确拒了（HTTP 200 但 applied == 0）
     *   · {@link #onUnreachable} 根本没问出结果：断网、超时、非 2xx、票失效
     *
     * 为什么必须拆开：后两者都长着「失败的样子」，但一个是**已经有答案了**
     * （服务端说不行，界面该回到它返回的真相），一个是**还没有答案**
     * （界面该保留乐观结果、入队等下次）。以前合成一个 onFail，于是「被拒」
     * 也被当成「离线」处理 —— 一条永远不可能成功的 op 在队列里反复重发，
     * 桌面还一直显示着一个服务端并不承认的状态。
     */
    interface OpCallback {
        void onAccepted(JSONObject body);
        void onRejected(JSONObject body, String why);
        void onUnreachable(String why);
    }

    /** 拉一次数据。返回体就是快照形状，直接喂给 WidgetSnapshot.parse */
    static void bootstrap(Context c, Callback cb) {
        String token = WidgetPrefs.token(c);
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "bootstrap 跳过：本地还没有票（App 没登录过？）");
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
    static void op(Context c, JSONArray ops, OpCallback cb) {
        String token = WidgetPrefs.token(c);
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "op 跳过：本地还没有票（App 没登录过？）");
            cb.onUnreachable("no-token");
            return;
        }
        try {
            JSONObject body = new JSONObject();
            body.put("deviceId", WidgetPrefs.deviceId(c));
            body.put("ops", ops);
            // op 的结局有三类，这里用老的二态 Callback 接住再分流
            request(c, "POST", "/api/widget/op", body, token, new Callback() {
                @Override
                public void onOk(JSONObject resp) {
                    route(cb, resp);
                }

                @Override
                public void onFail(String why) {
                    cb.onUnreachable(why);
                }
            });
        } catch (Exception e) {
            cb.onUnreachable("build-body: " + e.getMessage());
        }
    }

    /**
     * 把一次 200 分成「接受」与「拒绝」。
     *
     * 服务端 `/api/widget/op` **永远是 200**：权限不够、实体不存在、时钟漂移
     * 被 applyOps 拒掉，全都体现在 body 的 {@code applied: 0} + {@code rejected}
     * 里，HTTP 状态码看不出任何区别。所以这里按 applied 分流。
     *
     * {@code applied} 键缺失（老服务端）时按接受算 —— 那时没有拒绝这个概念，
     * 别把正常响应当成失败把界面回滚了。
     */
    private static void route(OpCallback cb, JSONObject resp) {
        int applied = resp.optInt("applied", -1);
        if (applied != 0) {
            cb.onAccepted(resp);
            return;
        }
        String why = "服务端没有接受这次修改";
        JSONArray rejected = resp.optJSONArray("rejected");
        if (rejected != null && rejected.length() > 0) {
            JSONObject r0 = rejected.optJSONObject(0);
            if (r0 != null) {
                String reason = r0.optString("reason", "");
                why = reason.isEmpty() ? why : "服务端拒绝：" + reason;
            }
        }
        Log.w(TAG, "op 被拒绝（applied=0）: " + why);
        cb.onRejected(resp, why);
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
                    // ⚠️⚠️ setDoOutput(true) 只是「打开写通道」，**必须真的把正文写出去**。
                    // 这里以前漏了下面这几行 —— 请求确实发出去了、状态码也是
                    // 服务端回的，但正文是空的，于是每次 POST 都被打回
                    // 400「ops 不能为空」。
                    //
                    // 后果极难查：打卡、新建、勾完成**全部**失败，但走的是
                    // 静默入队那条路，界面照常乐观更新，日志一片干净。表现就是
                    // 「桌面点了半天，服务器一点没变」「新建的任务过很久才出现」
                    // —— 其实它永远不会自己出现，得等 App 打开后走网页侧同步。
                    OutputStream os = conn.getOutputStream();
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    os.flush();
                    os.close();
                }

                int code = conn.getResponseCode();
                InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String text = readAll(is);

                // ⚠️ 这四条日志是**必须**的。以前非 2xx 走的是「静默入队」：
                // 请求打不出去、日志里一个字都没有，表现只是「桌面点了半天，
                // 服务器没变」，无从查起。宁可刷屏也不能再瞎。
                if (code == 401) {
                    Log.w(TAG, method + " " + path + " -> 401 票无效/过期");
                    fail(cb, "unauthorized");
                    return;
                }
                if (code < 200 || code >= 300) {
                    Log.w(TAG, method + " " + path + " -> HTTP " + code + " "
                            + brief(text));
                    fail(cb, "http-" + code);
                    return;
                }
                JSONObject out;
                try {
                    out = new JSONObject(text);
                } catch (Exception e) {
                    Log.w(TAG, method + " " + path + " -> 返回不是 JSON: " + brief(text));
                    fail(cb, "bad-json");
                    return;
                }
                Log.i(TAG, method + " " + path + " -> 200");
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

    /** 截断响应体再进日志 —— 服务端的报错原文多半就在里面，但不值得刷一整屏 */
    private static String brief(String s) {
        if (s == null) return "";
        String one = s.replaceAll("\\s+", " ").trim();
        return one.length() > 180 ? one.substring(0, 180) + "…" : one;
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
