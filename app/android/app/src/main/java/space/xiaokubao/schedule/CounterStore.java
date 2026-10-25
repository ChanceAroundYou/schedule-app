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

    /** 用服务端返回的 counters 覆盖本地。**只在请求成功时调**，失败时本地才是唯一线索 */
    static void applyServer(Context c, JSONArray counters) {
        if (counters == null) return;
        List<Item> items = new ArrayList<>();
        for (int i = 0; i < counters.length(); i++) {
            JSONObject o = counters.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (id.isEmpty()) continue;
            items.add(new Item(id, o.optString("name", id), o.optInt("value", 0)));
        }
        if (!items.isEmpty()) save(c, items);
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
     * 把队列发出去。**逐条串行**，某一条失败就停在它那儿，后面的留到下次 ——
     * 乱序发送会让「+5 然后 =3」变成「=3 然后 +5」，数字凭空多出来。
     */
    static void flush(final Context c, final Runnable done) {
        final JSONArray q = queue(c);
        if (q.length() == 0) {
            if (done != null) done.run();
            return;
        }
        step(c, q, 0, done);
    }

    private static void step(final Context c, final JSONArray q, final int i, final Runnable done) {
        if (i >= q.length()) {
            clearQueue(c);
            if (done != null) done.run();
            return;
        }
        JSONObject one = q.optJSONObject(i);
        if (one == null) {
            step(c, q, i + 1, done);
            return;
        }
        final String id = one.optString("id", "");
        if (id.isEmpty()) {
            step(c, q, i + 1, done);
            return;
        }
        Integer delta = one.has("delta") ? Integer.valueOf(one.optInt("delta", 0)) : null;
        Integer value = one.has("value") ? Integer.valueOf(one.optInt("value", 0)) : null;

        WidgetApi.counterWrite(c, id, delta, value, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                applyServer(c, body.optJSONArray("counters"));
                step(c, q, i + 1, done);
            }

            @Override
            public void onFail(String why) {
                // 停在失败点：把 [i, end) 原样写回队列，下次继续
                JSONArray rest = new JSONArray();
                for (int k = i; k < q.length(); k++) {
                    JSONObject o = q.optJSONObject(k);
                    if (o != null) rest.put(o);
                }
                writeQueue(c, rest);
                Log.w(TAG, "补发失败（" + why + "），还有 " + rest.length() + " 条留在队列里");
                if (done != null) done.run();
            }
        });
    }

    /** 只拉不改：用服务端值校准本地显示 */
    static void pull(final Context c, final Runnable done) {
        WidgetApi.counters(c, new WidgetApi.Callback() {
            @Override
            public void onOk(JSONObject body) {
                applyServer(c, body.optJSONArray("counters"));
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
