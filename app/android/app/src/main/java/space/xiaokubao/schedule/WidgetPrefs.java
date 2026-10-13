package space.xiaokubao.schedule;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 小组件的原生侧状态存取。
 *
 * 读的东西放在 {@code CapacitorStorage} 这个 SharedPreferences 文件里 ——
 * 那是 {@code @capacitor/preferences} 默认用的文件名，**改这里两边就对不上了**。
 *
 * 分两类：
 *   · 快照（只读）—— App 写进来，小组件照着画
 *   · 选中的日期、待同步队列（读写）—— 小组件自己的状态和离线时攒下的改动
 */
class WidgetPrefs {

    /** 与 app/src/data/widget.ts 的 WIDGET_SNAPSHOT_KEY 对应 */
    static final String PREFS_FILE = "CapacitorStorage";
    static final String KEY_SNAPSHOT = "schedule_widget_snapshot";
    static final String KEY_DAY = "schedule_widget_day";
    /** 离线时攒下的改动，等 App 启动时读走并推送 */
    static final String KEY_PENDING = "schedule_widget_pending";

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE);
    }

    static WidgetSnapshot snapshot(Context c) {
        String json = sp(c).getString(KEY_SNAPSHOT, null);
        if (json == null) return WidgetSnapshot.empty();
        try {
            return WidgetSnapshot.parse(json);
        } catch (Exception e) {
            return WidgetSnapshot.empty();
        }
    }

    /** 用户选中的那天；没选过就是今天 */
    static String selectedDay(Context c) {
        String d = sp(c).getString(KEY_DAY, null);
        return (d == null || d.isEmpty()) ? today(c) : d;
    }

    static void setSelectedDay(Context c, String iso) {
        sp(c).edit().putString(KEY_DAY, iso).apply();
    }

    static String today(Context c) {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                .format(new java.util.Date());
    }

    /** 攒一条离线改动。**只追加不清空** —— 清空由 App 推送成功后做 */
    static void enqueuePending(Context c, JSONObject op) {
        SharedPreferences p = sp(c);
        JSONArray arr;
        try {
            arr = new JSONArray(p.getString(KEY_PENDING, "[]"));
        } catch (Exception e) {
            arr = new JSONArray();
        }
        arr.put(op);
        p.edit().putString(KEY_PENDING, arr.toString()).apply();
    }

    static List<JSONObject> pendingOps(Context c) {
        List<JSONObject> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(sp(c).getString(KEY_PENDING, "[]"));
            for (int i = 0; i < arr.length(); i++) out.add(arr.getJSONObject(i));
        } catch (Exception ignored) {
        }
        return out;
    }

    static void clearPending(Context c) {
        sp(c).edit().remove(KEY_PENDING).apply();
    }

    static int pendingCount(Context c) {
        return pendingOps(c).size();
    }
}
