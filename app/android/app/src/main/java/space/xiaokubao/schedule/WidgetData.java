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
    final String date;
    /** null = 未定时 */
    final String time;
    /** 分钟。0 = 未设 */
    final int dur;
    final String title;
    final boolean done;

    WTask(String id, String date, String time, int dur, String title, boolean done) {
        this.id = id;
        this.date = date;
        this.time = time;
        this.dur = dur;
        this.title = title;
        this.done = done;
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
    final String title;
    final boolean done;
    final int streak;

    WHabit(String id, String title, boolean done, int streak) {
        this.id = id;
        this.title = title;
        this.done = done;
        this.streak = streak;
    }
}

class WidgetSnapshot {
    final long at;
    final String from;
    final String to;
    final List<WTask> tasks = new ArrayList<>();
    final List<WHabit> habits = new ArrayList<>();

    private WidgetSnapshot(long at, String from, String to) {
        this.at = at;
        this.from = from;
        this.to = to;
    }

    static WidgetSnapshot parse(String json) throws Exception {
        JSONObject o = new JSONObject(json);
        WidgetSnapshot s = new WidgetSnapshot(o.optLong("at"), o.optString("from"), o.optString("to"));
        JSONArray ts = o.optJSONArray("tasks");
        if (ts != null) {
            for (int i = 0; i < ts.length(); i++) {
                JSONObject t = ts.optJSONObject(i);
                if (t == null) continue;
                s.tasks.add(new WTask(
                        t.optString("id"),
                        t.optString("date"),
                        t.isNull("time") ? null : t.optString("time", null),
                        t.optInt("dur"),
                        t.optString("title"),
                        t.optBoolean("done")));
            }
        }
        JSONArray hs = o.optJSONArray("habits");
        if (hs != null) {
            for (int i = 0; i < hs.length(); i++) {
                JSONObject h = hs.optJSONObject(i);
                if (h == null) continue;
                s.habits.add(new WHabit(
                        h.optString("id"), h.optString("title"),
                        h.optBoolean("done"), h.optInt("streak")));
            }
        }
        return s;
    }

    /** 空快照：还没同步到数据时用它，至少别崩 */
    static WidgetSnapshot empty() {
        return new WidgetSnapshot(0, "", "");
    }

    List<WTask> tasksOf(String iso) {
        List<WTask> out = new ArrayList<>();
        for (WTask t : tasks) if (iso.equals(t.date)) out.add(t);
        out.sort((a, b) -> Integer.compare(a.sortKey(), b.sortKey()));
        return out;
    }
}
