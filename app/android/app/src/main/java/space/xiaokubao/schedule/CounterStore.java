package space.xiaokubao.schedule;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 桌面计数器（naonao / Kutai）的本地仓库、离线队列与同步。
 *
 * ## 为什么单独一个类，而不是塞进 WidgetPrefs / WidgetSnapshot
 * WidgetPrefs 是「日程快照 + 选中日期 + op 发件箱」的仓库，形状由 app 侧
 * 写进来的 JSON 决定；计数器是**另一类数据**（账号维度、不在日程集里、
 * 不参与 LWW），混进去会让那个文件的职责更糊。这里只借它的
 * SharedPreferences 文件名（同一个文件，才读得到同一张登录票）。
 *
 * ## 三条不变量
 * 1. **点一下先改本地、立刻重绘**，再谈网络。不然断网时按钮看起来是坏的。
 * 2. **服务端是权威**。请求成功就用它回的 counters 覆盖本地，本地算错了也能自愈。
 * 3. **失败不丢**。改动先落队列，每个 id 最多一条（delta 累加、set 覆盖），
 *    下次点击 / 组件刷新 / App 推刷新时补发。
 *
 * ## 并发为什么不是问题
 * 队列按 id 合并，最终只会发出「+N」或「=X」，服务端那边是原子自增
 * （见 server/lib/db/counters.js），不会出现「两台设备各自读 5 都写 6」。
 */
class CounterStore {

    private static final String TAG = "CounterStore";

    /** 本地缓存：[{id,name,value}]。与服务端同形，省掉两套解析 */
    private static final String KEY_LIST = "schedule_widget_counters";
    /** 未发出的改动：[{id, delta}] 或 [{id, value}] */
    private static final String KEY_QUEUE = "schedule_widget_counter_queue";

    /** 与服务端 db/counters.js 的 MIN_VALUE / MAX_VALUE 保持一致 */
    static final int MIN = 0;
    static final int MAX = 999999;

    /** 服务端没回过数据时的兜底，名字和后端 DEFAULTS 一致 */
    private static final String[][] DEFAULTS = {{"naonao", "naonao"}, {"kutai", "Kutai"}};

    static class Item {
        final String id;
        String name;
        int value;

        Item(String id, String name, int value) {
            this.id = id;
            this.name = name;
            this.value = value;
        }
    }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(WidgetPrefs.PREFS_FILE, Context.MODE_PRIVATE);
    }

    /* ------------------------------------------------------------ 本地缓存 */

    static List<Item> load(Context c) {
        List<Item> out = new ArrayList<>();
        String raw = sp(c).getString(KEY_LIST, null);
        if (raw != null && !raw.isEmpty()) {
            try {
                JSONArray arr = new JSONArray(raw);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    String id = o.optString("id", "");
                    if (id.isEmpty()) continue;
                    out.add(new Item(id, o.optString("name", id), o.optInt("value", 0)));
                }
            } catch (Exception e) {
                Log.w(TAG, "缓存解析失败，按默认值走: " + e);
            }
        }
        if (out.isEmpty()) {
            for (String[] d : DEFAULTS) out.add(new Item(d[0], d[1], 0));
        }
        return out;
    }

    static void save(Context c, List<Item> items) {
        JSONArray arr = new JSONArray();
        for (Item it : items) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", it.id);
                o.put("name", it.name);
                o.put("value", it.value);
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        sp(c).edit().putString(KEY_LIST, arr.toString()).apply();
    }

    static Item find(List<Item> items, String id) {
        for (Item it : items) {
            if (it.id.equals(id)) return it;
        }
        return null;
    }

    static int clamp(long v) {
        return (int) Math.max(MIN, Math.min(MAX, v));
    }

    /** 点击时先本地加，界面立刻动 */
    static void localDelta(Context c, String id, int delta) {
        List<Item> items = load(c);
        Item it = find(items, id);
        if (it == null) return;
        it.value = clamp((long) it.value + delta);
        save(c, items);
    }

    /** 手动输入的值 */
    static void localSet(Context c, String id, int value) {
        List<Item> items = load(c);
        Item it = find(items, id);
        if (it == null) return;
        it.value = clamp(value);
        save(c, items);
    }

    /**
     * 用服务端返回的 counters 校准本地。
     *
     * ⚠️ **不能直接照抄服务端的值。** 服务端回的是「它已经收到的那些改动」的结果，
     * 而队列里可能还躺着用户刚点、还没发出去的几下。直接覆盖的表现是：
     * 连点三下 → 第一下的请求回来 → 数字从 23 掉回 21 → 第二个请求回来再变 22。
     * 用户看到的是一次莫名其妙的回退。
     *
     * 所以规则是：
     *   · 队列里这个 id 还有「设置成 X」→ 本地就是 X，服务端的值作废（绝对值优先）
     *   · 否则 → 用 服务端值 + 队列里剩余的 delta
     *
     * @param stillQueued 此刻**还没发出去**的意图（已发成功的那几条调用方要先扣掉）
     */
    static void applyServer(Context c, JSONArray counters, JSONArray stillQueued) {
        if (counters == null) return;

        java.util.Map<String, Integer> pendDelta = new java.util.HashMap<>();
        java.util.Set<String> pendingSet = new java.util.HashSet<>();
        if (stillQueued != null) {
            for (int i = 0; i < stillQueued.length(); i++) {
                JSONObject o = stillQueued.optJSONObject(i);
                if (o == null) continue;
                String qid = o.optString("id", "");
                if (qid.isEmpty()) continue;
                if (o.has("value")) {
                    pendingSet.add(qid);
                } else {
                    int prev = pendDelta.containsKey(qid) ? pendDelta.get(qid) : 0;
                    pendDelta.put(qid, prev + o.optInt("delta", 0));
                }
            }
        }

        List<Item> local = load(c);
        List<Item> next = new ArrayList<>();
        for (int i = 0; i < counters.length(); i++) {
            JSONObject o = counters.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (id.isEmpty()) continue;
            String name = o.optString("name", id);
            int serverValue = o.optInt("value", 0);

            int v;
            if (pendingSet.contains(id)) {
                // 用户手输了一个绝对值还没发出去 —— 本地那个才是他想看到的
                Item mine = find(local, id);
                v = mine != null ? mine.value : clamp(serverValue);
            } else {
                Integer extra = pendDelta.get(id);
                v = clamp((long) serverValue + (extra == null ? 0 : extra.intValue()));
            }
            next.add(new Item(id, name, v));
        }
        if (!next.isEmpty()) save(c, next);
    }

    /* ------------------------------------------------------------ 离线队列 */

    /**
     * 入队一次加减。
     * 同 id 已经有「设置成 X」时，把 X 也加上 —— 用户先输 300 再点 +1，
     * 期望的是 301，不是「301 又被 300 盖回去」。
     */
    static void queueDelta(Context c, String id, int delta) {
        JSONArray q = queue(c);
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o == null || !id.equals(o.optString("id", ""))) continue;
            try {
                if (o.has("value")) {
                    o.put("value", clamp(o.optInt("value", 0) + (long) delta));
                } else {
                    o.put("delta", clamp(o.optInt("delta", 0) + (long) delta));
                }
                writeQueue(c, q);
            } catch (Exception ignored) {
            }
            return;
        }
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("delta", delta);
            q.put(o);
            writeQueue(c, q);
        } catch (Exception ignored) {
        }
    }

    /** 入队一次「设成某个值」。同 id 旧的意图一律作废 —— 绝对值优先 */
    static void queueSet(Context c, String id, int value) {
        JSONArray q = queue(c);
        JSONArray next = new JSONArray();
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o == null || id.equals(o.optString("id", ""))) continue;
            next.put(o);
        }
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("value", clamp(value));
            next.put(o);
        } catch (Exception ignored) {
        }
        writeQueue(c, next);
    }

    static JSONArray queue(Context c) {
        try {
            return new JSONArray(sp(c).getString(KEY_QUEUE, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static boolean hasQueue(Context c) {
        return queue(c).length() > 0;
    }

    static void clearQueue(Context c) {
        sp(c).edit().remove(KEY_QUEUE).apply();
    }

    private static void writeQueue(Context c, JSONArray arr) {
        if (arr == null || arr.length() == 0) {
            clearQueue(c);
            return;
        }
        sp(c).edit().putString(KEY_QUEUE, arr.toString()).apply();
    }

    /* -------------------------------------------------------------- 同步 */

    /**
     * 同一时刻只允许一轮 flush。
     *
     * 以前没有这把锁：点一下（600ms 后触发一轮）和组件刷新（`resync` 里也会
     * flush）撞在一起时，两轮都拿着同一份队列快照，同一条会被发两次 ——
     * 服务端多记一次，用户看到「点一下涨了两下」。
     */
    private static final Object FLUSH_LOCK = new Object();
    private static boolean sFlushing = false;
    /** 等这一轮跑完后要通知的回调。合并调用方（连点、组件刷新都会来排队） */
    private static final java.util.List<Runnable> sWaiting = new java.util.ArrayList<>();

    /**
     * 把队列发出去。**逐条串行**，某一条失败就停在它那儿，后面的留到下次 ——
     * 乱序发送会让「+5 然后 =3」变成「=3 然后 +5」，数字凭空多出来。
     *
     * 已经在跑的时候**排队等这一轮**，不另起一轮：那一轮每发完一条都会重新读
     * 队列，这期间新点的几下会被它带上。回调也等它跑完再叫 —— 立刻叫的话，
     * 调用方（`resync` 后面紧跟 `pull`）会拿一份还没包含在飞改动快照去覆盖界面。
     */
    static void flush(final Context c, final Runnable done) {
        java.util.List<Runnable> run = null;
        synchronized (FLUSH_LOCK) {
            if (done != null) sWaiting.add(done);
            if (sFlushing) return;
            if (queue(c).length() == 0) {
                run = drainWaiting();
            } else {
                sFlushing = true;
            }
        }
        if (run != null) runAll(run);
        else next(c);
    }

    private static void finish() {
        java.util.List<Runnable> run;
        synchronized (FLUSH_LOCK) {
            sFlushing = false;
            run = drainWaiting();
        }
        runAll(run);
    }

    /** 取出并清空待通知的回调。**必须在锁内调用**，返回值在外面跑（别在锁里跑回调） */
    private static java.util.List<Runnable> drainWaiting() {
        java.util.List<Runnable> out = new java.util.ArrayList<>(sWaiting);
        sWaiting.clear();
        return out;
    }

    private static void runAll(java.util.List<Runnable> list) {
        for (Runnable r : list) {
            try {
                r.run();
            } catch (Exception e) {
                Log.w(TAG, "flush 回调抛错: " + e);
            }
        }
    }

    /**
     * 处理队首这一条。
     *
     * ⚠️ **先把这条从队列里摘掉并落盘，再发请求。** 反过来（发完再按快照回写）
     * 会把「请求飞行期间新点的那些」一起覆盖掉 —— 本地数字涨了、队列里却没了，
     * 服务端永远收不到，表现就是「桌面点了几下，App 里少几下」。
     * 摘掉之后 `applyServer` 拿到的就是「真正还没发出去的那些」。
     */
    private static void next(final Context c) {
        final JSONArray q = queue(c);
        if (q.length() == 0) {
            finish();
            return;
        }
        final JSONObject one = q.optJSONObject(0);
        if (one == null) {
            writeQueue(c, tail(q, 1));
            next(c);
            return;
        }
        final String id = one.optString("id", "");
        if (id.isEmpty()) {
            writeQueue(c, tail(q, 1));
            next(c);
            return;
        }
        final Integer delta = one.has("delta") ? Integer.valueOf(one.optInt("delta", 0)) : null;
        final Integer value = one.has("value") ? Integer.valueOf(one.optInt("value", 0)) : null;

        writeQueue(c, tail(q, 1));   // 先摘

        WidgetApi.counterWrite(c, id, delta, value, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                // 队列此刻已经是「剩下的」，直接喂给 applyServer 就是它对
                // «还有哪些意图没发出去» 的完整视角
                applyServer(c, body.optJSONArray("counters"), queue(c));
                WidgetBridge.notifyCountersChanged();   // App 开着就让它立刻对齐
                next(c);
            }

            @Override
            public void onFail(String why) {
                requeueFront(c, one);
                Log.w(TAG, "补发失败（" + why + "），还有 " + queue(c).length() + " 条留在队列里");
                finish();
            }
        });
    }

    /** 队列里第 from 条之后的副本（用来「摘掉队首」而不用关心原始数组） */
    private static JSONArray tail(JSONArray q, int from) {
        JSONArray out = new JSONArray();
        for (int i = from; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o != null) out.put(o);
        }
        return out;
    }

    /**
     * 把发送失败的那条塞回队首。
     *
     * **必须回队首而不是队尾**：这一条在用户意图里排在前面，「+5」失败留在队列
     * 而后面的「=3」先发出去的话，最终值会变成 8 而不是 3。
     *
     * 已知取舍：如果请求其实到了服务端、只是响应丢了，重发会多记一次。
     * 计数器的语义下「多点一下」比「点了不算」轻，所以选 at-least-once。
     */
    private static void requeueFront(Context c, JSONObject item) {
        if (item == null) return;
        JSONArray q = queue(c);
        JSONArray next = new JSONArray();
        next.put(item);
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o != null) next.put(o);
        }
        writeQueue(c, next);
    }

    /** 只拉不改：用服务端值校准本地显示 */
    static void pull(final Context c, final Runnable done) {
        WidgetApi.counters(c, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                applyServer(c, body.optJSONArray("counters"), queue(c));
                // 另一台设备（或网页版）改过时，App 那边也该知道
                WidgetBridge.notifyCountersChanged();
                if (done != null) done.run();
            }

            @Override
            public void onFail(String why) {
                Log.w(TAG, "拉取计数器失败（" + why + "），继续用本地缓存");
                if (done != null) done.run();
            }
        });
    }
}
