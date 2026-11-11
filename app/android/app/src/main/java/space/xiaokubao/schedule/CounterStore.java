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
 * ## 三条不变量（2026-11-11 起按 rev 统一）
 * 1. **缓存只存服务端真值**（value + rev），点一下先入队、由 load() 投影出
 *    显示值，断网时按钮照样立刻动，而且不会把乐观值误当成真值写回缓存。
 * 2. **服务端是权威**。只接受 rev 不小于本地的快照；比本地旧的响应整条作废
 *    （弱网下 GET 比 POST 先到、连点的晚到中间值，都不会再把数字拉回去）。
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
    /**
     * 未发出的改动：[{id, delta, op}] 或 [{id, value, op}]。
     *
     * `op` 是这一次点击的凭据（2026-11-07）。服务端按 (user_id, op) 去重，
     * 所以「发出去、服务端加成功、响应丢了、再发一次」只会加一次。
     * **合并队列条目时必须保留原来的 op** —— 合并的是同一次还没确认的点击，
     * 换一个新 op 等于告诉服务端「这是新的一下」，去重就白做了。
     */
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
        /** 服务端单调值版本（2026-11-11）。旧缓存没有这个字段时按 0 处理。 */
        int rev;

        Item(String id, String name, int value) {
            this(id, name, value, 0);
        }

        Item(String id, String name, int value, int rev) {
            this.id = id;
            this.name = name;
            this.value = value;
            this.rev = rev;
        }
    }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(WidgetPrefs.PREFS_FILE, Context.MODE_PRIVATE);
    }

    /* ------------------------------------------------------------ 本地缓存 */

    /**
     * 读缓存里的**服务端快照**，不做投影。
     *
     * 2026-11-11 起缓存只存真值（值 + rev）：App 推缓存、applyServer、
     * 桌面点击三条路都往同一个 key 写，谁最后写都不会把别人的乐观值
     * 当成服务端真值。屏幕上要显示的数由 {@link #load} 现算。
     */
    private static List<Item> loadRaw(Context c) {
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
                    out.add(new Item(id, o.optString("name", id),
                            o.optInt("value", 0), o.optInt("rev", 0)));
                }
            } catch (Exception e) {
                Log.w(TAG, "缓存解析失败，按默认值走: " + e);
            }
        }
        if (out.isEmpty()) {
            for (String[] d : DEFAULTS) out.add(new Item(d[0], d[1], 0, 0));
        }
        return out;
    }

    /**
     * 屏幕上该显示的列表 = **服务端快照 + 还没确认的本地意图**。
     *
     * 两条意图都算：在途（已摘出队列、请求还没回）和队列里没发出的。
     * 在途的先发生、队列的后发生，各自按内部顺序应用；「设成 X」会作废
     * 之前的增量，之后的增量再叠到 X 上（与 queueSet 的语义一致）。
     *
     * 这样 App 每 5 秒推一次服务端真值、或 pull 回一份新快照，都只会换掉
     * 真值那一层，桌面上刚点还没确认的几下不会被抹掉 —— 以前「+1 后跳回
     * 旧值」和「网页一刷新桌面就闪一下」都是这两层混在一起造成的。
     */
    static List<Item> load(Context c) {
        List<Item> items = loadRaw(c);
        // 在途表是内存态，先拷一份出来再遍历，别在锁里改 Item
        java.util.List<String[]> inflight = new ArrayList<>();
        synchronized (sInflight) {
            for (java.util.Map.Entry<String, java.util.List<int[]>> e : sInflight.entrySet()) {
                for (int[] w : e.getValue()) {
                    inflight.add(new String[]{e.getKey(), String.valueOf(w[0]), String.valueOf(w[1])});
                }
            }
        }
        for (String[] w : inflight) {
            applyIntent(items, w[0], Integer.parseInt(w[1]), Integer.parseInt(w[2]));
        }
        JSONArray q = queue(c);
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (id.isEmpty()) continue;
            boolean hasValue = o.has("value");
            applyIntent(items, id, o.optInt("delta", 0),
                    hasValue ? o.optInt("value", 0) : NO_VALUE);
        }
        return items;
    }

    /** 把一条未确认意图按时间顺序投到显示值上。只改 value，不动 rev。 */
    private static void applyIntent(List<Item> items, String id, int delta, int value) {
        Item it = find(items, id);
        if (it == null) return;
        long v = value == NO_VALUE ? (long) it.value + delta : value;
        it.value = clamp(v);
    }

    static void save(Context c, List<Item> items) {
        JSONArray arr = new JSONArray();
        for (Item it : items) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", it.id);
                o.put("name", it.name);
                o.put("value", it.value);
                o.put("rev", it.rev);
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

    /* 点击 / 手输只入队，不再直接改缓存里的值（2026-11-11）。
       缓存是服务端真值，显示值由 load() 现算 —— 调用方 queueDelta/queueSet
       之后 refreshAll 就能立刻看到变化，见 CounterWidgetProvider.onReceive
       与 CounterEditActivity.save。 */

    /**
     * 用服务端返回的 counters 覆盖**真值那一层**。
     *
     * 2026-11-11 重写：缓存里只存服务端快照，显示值由 {@link #load} 叠上
     * 队列 / 在途现算，所以这里不用再猜「哪些点击还没发出去」，也不用靠
     * 时间窗。唯一要判的是 rev —— 比本地已知版本还旧的响应整条作废
     * （GET 比 POST 先到服务端、连点时晚到的中间值，都在这里被挡住）。
     *
     * @param stillQueued 历史参数，保留签名兼容调用方；投影已在 load() 统一做
     */
    static void applyServer(Context c, JSONArray counters, JSONArray stillQueued) {
        if (counters == null || counters.length() == 0) return;
        List<Item> cached = loadRaw(c);
        // 旧服务端（还没发到 v11）的响应里没有 rev：整份按 0 处理会误判成
        // 「全都过期」，桌面反而卡在旧值不动。没有 rev 字段时不做版本判据。
        boolean hasRev = counters.optJSONObject(0) != null
                && counters.optJSONObject(0).has("rev");
        List<Item> next = new ArrayList<>();
        for (int i = 0; i < counters.length(); i++) {
            JSONObject o = counters.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (id.isEmpty()) continue;
            int serverRev = o.optInt("rev", 0);
            Item old = find(cached, id);
            if (hasRev && old != null && serverRev < old.rev) {
                next.add(old);
                continue;
            }
            next.add(new Item(id, o.optString("name", id),
                    clamp(o.optInt("value", 0)), serverRev));
        }
        // 服务端这次没提到的 id 保持原样（计数器没有删除接口，这里只是防御）
        for (Item it : cached) {
            if (find(next, it.id) == null) next.add(it);
        }
        save(c, next);
    }

    /* ------------------------------------------------------------ 离线队列 */

    /** Clamp a signed pending increment independently of the counter's value range. */
    static int clampDelta(long delta) {
        return (int) Math.max(-10000L, Math.min(10000L, delta));
    }

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
                    o.put("delta", clampDelta((long) o.optInt("delta", 0) + delta));
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
            o.put("op", newOpId());
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
            o.put("op", newOpId());
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

    /* ------------------------------------------------------- 在途意图登记 */

    /**
     * 已发出但还没收到响应的意图。
     *
     * `next()` 发请求前先把队首从队列里摘掉，飞行期间这条既不在队列、
     * 服务端也还没确认 —— 不记下来就会在屏幕上凭空消失一瞬。
     *
     * 2026-11-11 起 `applyServer` 只覆盖真值那一层，`load()` 把在途和队列
     * 按顺序一起投影成显示值，所以这里不再需要「保留本地值」那套特判。
     *
     * 进程死了在途表就丢了 —— 可接受：那条已从队列摘掉，`resync` 里的 pull
     * 会拿服务端真值；请求真到了服务端就是新值，没到就少一次点击。
     */
    private static final java.util.Map<String, java.util.List<int[]>> sInflight = new java.util.HashMap<>();
    // 每个 int[] = {delta_or_0, value_or_NO_VALUE}
    private static final int NO_VALUE = Integer.MIN_VALUE;

    private static void addInflight(String id, Integer delta, Integer value) {
        int d = delta != null ? delta : 0;
        int v = value != null ? value : NO_VALUE;
        synchronized (sInflight) {
            java.util.List<int[]> list = sInflight.get(id);
            if (list == null) { list = new java.util.ArrayList<>(); sInflight.put(id, list); }
            list.add(new int[]{d, v});
        }
    }

    private static void removeInflight(String id, Integer delta, Integer value) {
        int d = delta != null ? delta : 0;
        int v = value != null ? value : NO_VALUE;
        synchronized (sInflight) {
            java.util.List<int[]> list = sInflight.get(id);
            if (list == null) return;
            java.util.Iterator<int[]> it = list.iterator();
            while (it.hasNext()) {
                int[] e = it.next();
                if (e[0] == d && e[1] == v) { it.remove(); break; }
            }
            if (list.isEmpty()) sInflight.remove(id);
        }
    }

    /**
     * 一次点击的凭据。UUID 足够（同一账号内几乎不可能撞），
     * 而 op 只在「未确认」这段时间里有意义。
     */
    private static String newOpId() {
        return java.util.UUID.randomUUID().toString();
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
        /* 老队列里可能没有 op（升级前入队的条目）：在这里补一个并写回 `one`，
           失败重排时它会跟着回队列 —— 这一次点击因此也具备去重能力。 */
        String op = one.optString("op", "");
        if (op.isEmpty()) {
            op = newOpId();
            try { one.put("op", op); } catch (Exception ignored) { }
        }
        final String opId = op;

        writeQueue(c, tail(q, 1));   // 先摘
        addInflight(id, delta, value);  // 记在途：请求飞行期间 applyServer 能看到它

        WidgetApi.counterWrite(c, id, delta, value, opId, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                // 先清在途：这条的响应已经到了，服务端值已经包含这次改动
                removeInflight(id, delta, value);
                // applyServer 内部会查 sInflight 剩下的在途 id，保留它们的本地值
                JSONArray counters = body.optJSONArray("counters");
                applyServer(c, counters, null);
                // 把这份带 rev 的真值一起推给网页：任意页面都能立刻对齐，
                // 不必再等一次 GET 或 5 秒轮询
                WidgetBridge.notifyCountersChanged(counters == null ? null : counters.toString());
                next(c);
            }

            @Override
            public void onFail(String why) {
                removeInflight(id, delta, value);   // 没发成功，清在途
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
     * 重发不会多记：条目带着自己的 `op`，服务端按 (user_id, op) 去重
     * （2026-11-07）。所以这里的语义是「至少一次投递、恰好一次生效」。
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
                // applyServer 内部查 sInflight：在途 id 保留本地值，
                // 不被服务端旧值盖掉（这就是修「+1 跳回」的关键）
                JSONArray counters = body.optJSONArray("counters");
                applyServer(c, counters, null);
                // 另一台设备（或网页版）改过时，App 那边也该知道（带数据）
                WidgetBridge.notifyCountersChanged(counters == null ? null : counters.toString());
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
