package space.xiaokubao.schedule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 小组件快照的内存形态。
 *
 * 字段与 {@code app/src/domain/widgetSnapshot.ts} 的 {@code WidgetSnapshot}
 * **一一对应** —— 那边改了形状，这边要跟着改，否则原生侧读到 null 还不报错，
 * 表现是「桌面上一片空白」，最难查的一种。
 */
class WTask {
    final String id;
    /** 这个任务属于哪个集。写操作（勾完成）要把它带给服务端 */
    final String calId;
    final String date;
    /** null = 未定时 */
    final String time;
    /** 分钟。0 = 未设 */
    final int dur;
    final String title;
    final boolean done;
    /** 提醒时刻 "HH:mm"（同一天）。null = 不提醒。由 ReminderScheduler 排闹钟 */
    final String reminder;

    WTask(String id, String calId, String date, String time, int dur, String title, boolean done,
          String reminder) {
        this.id = id;
        this.calId = calId;
        this.date = date;
        this.time = time;
        this.dur = dur;
        this.title = title;
        this.done = done;
        this.reminder = reminder;
    }

    /** 一天内排序用：未定时的排在最后（跟 App 的列表语义一致） */
    int sortKey() {
        if (time == null) return 24 * 60 + 1;
        int c = time.indexOf(':');
        return Integer.parseInt(time.substring(0, c)) * 60 + Integer.parseInt(time.substring(c + 1));
    }
}

class WHabit {
    final String id;
    /** 属于哪个集。打卡写操作要用 */
    final String calId;
    final String title;
    final boolean done;
    final int streak;

    /**
     * 完整的打卡记录：{ "2026-10-13": true } 这样的**稀疏表**。
     *
     * ⚠️ 为什么要整个表而不是只知道「今天打没打」：服务端的 applyOps 是
     * **字段整值替换**（见 server/lib/sync.js），改打卡就得把整个 log 回写。
     * 手里只有 done 的话只能瞎猜一个空表发上去，那会把这个人过去所有的
     * 打卡记录一次抹干净。
     *
     * {@code null} 表示**服务端没给这个字段**（老版本服务端只返回 done/streak）。
     * 这时候宁可先把改动入队等着，也不能冒险发。
     */
    final org.json.JSONObject log;

    WHabit(String id, String calId, String title, boolean done, int streak,
           org.json.JSONObject log) {
        this.id = id;
        this.calId = calId;
        this.title = title;
        this.done = done;
        this.streak = streak;
        this.log = log;
    }
}

class WidgetSnapshot {
    final long at;
    final String from;
    final String to;
    /** 服务端的「今天」—— 设备时间可能不准，判今天/红线都以它为准 */
    final String today;
    final List<WTask> tasks = new ArrayList<>();
    final List<WHabit> habits = new ArrayList<>();

    private WidgetSnapshot(long at, String from, String to, String today) {
        this.at = at;
        this.from = from;
        this.to = to;
        this.today = today;
    }

    static WidgetSnapshot parse(String json) throws Exception {
        JSONObject o = new JSONObject(json);
        WidgetSnapshot s = new WidgetSnapshot(
                o.optLong("at"), o.optString("from"), o.optString("to"), o.optString("today"));
        JSONArray ts = o.optJSONArray("tasks");
        if (ts != null) {
            for (int i = 0; i < ts.length(); i++) {
                JSONObject t = ts.optJSONObject(i);
                if (t == null) continue;
                // 墓碑（软删除）不画。服务端快照本来就不带 deleted 的条，这里挡的是
                // **本地乐观删除**：用户点删除后我们先在本地这份打上 deleted=true，
                // 解析时就剔掉 → 桌面立刻不见，不必等一个网络往返。
                if (t.optBoolean("deleted")) continue;
                s.tasks.add(new WTask(
                        t.optString("id"),
                        t.optString("calId"),
                        t.optString("date"),
                        t.isNull("time") ? null : t.optString("time", null),
                        t.optInt("dur"),
                        t.optString("title"),
                        t.optBoolean("done"),
                        t.isNull("reminder") ? null : t.optString("reminder", null)));
            }
        }
        JSONArray hs = o.optJSONArray("habits");
        if (hs != null) {
            for (int i = 0; i < hs.length(); i++) {
                JSONObject h = hs.optJSONObject(i);
                if (h == null) continue;
                s.habits.add(new WHabit(
                        h.optString("id"), h.optString("calId"), h.optString("title"),
                        h.optBoolean("done"), h.optInt("streak"),
                        // 老服务端没有这个字段 → null（= 「不敢写打卡」），
                        // 新服务端至少返回 {}（= 「可以写，表是空的」）
                        h.optJSONObject("log")));
            }
        }
        return s;
    }

    /** 空快照：还没同步到数据时用它，至少别崩 */
    static WidgetSnapshot empty() {
        return new WidgetSnapshot(0, "", "", "");
    }

    List<WTask> tasksOf(String iso) {
        List<WTask> out = new ArrayList<>();
        for (WTask t : tasks) if (iso.equals(t.date)) out.add(t);
        out.sort((a, b) -> Integer.compare(a.sortKey(), b.sortKey()));
        return out;
    }

    WTask taskById(String id) {
        for (WTask t : tasks) if (t.id.equals(id)) return t;
        return null;
    }

    WHabit habitById(String id) {
        for (WHabit h : habits) if (h.id.equals(id)) return h;
        return null;
    }
}
