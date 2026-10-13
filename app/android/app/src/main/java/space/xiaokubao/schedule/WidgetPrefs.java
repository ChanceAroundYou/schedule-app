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

    /**
     * 登录票。**由 App（网页侧）登录成功后写进来**，小组件拿着它直连服务器。
     * 存在同一个文件里，所以原生侧读得到。
     */
    static final String KEY_TOKEN = "schedule_widget_token";
    /** 接口基址，App 启动时一并写下来（打包进 APK 的那个 VITE_API_BASE） */
    static final String KEY_API_BASE = "schedule_widget_api_base";
    /** 小组件自己的设备号，发 op 时要带（applyOps 校验 deviceId 非空且 <64 字符） */
    static final String KEY_DEVICE_ID = "schedule_widget_device_id";

    /** 时间轴显示范围（小时）。用户在「⋮ → 设置」里改 */
    static final String KEY_START_HOUR = "schedule_widget_start_hour";
    static final String KEY_END_HOUR = "schedule_widget_end_hour";
    static final int DEFAULT_START_HOUR = 8;
    static final int DEFAULT_END_HOUR = 20;

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

    /**
     * 回到今天。**清掉选中值**而不是写死今天 —— 写进去之后跨天了那个值就是
     * 昨天，用户第二天点「回到今天」会跳回昨天。没值时 selectedDay() 自然用今天。
     */
    static void clearSelectedDay(Context c) {
        sp(c).edit().remove(KEY_DAY).apply();
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

    /**
     * 乐观更新：改本地快照里某一条的字段，让桌面**立刻**变。
     *
     * 直连服务器成功后会拿新快照覆盖，这里只是抢那几百毫秒的观感。
     * 只认 done / title / date / time / dur / calId 这几个小组件画得出来的字段，
     * 别的（备注、重复规则）在快照里本来就没有。
     *
     * {@code insertIfMissing} 为 true 时，找不到这条就**新建**一条
     * （新建任务的乐观更新要靠这个 —— 服务端的真 id 要等它返回才知道）。
     */
    static void patchEntity(Context c, String entity, String id, JSONObject fields,
                            boolean insertIfMissing) {
        SharedPreferences p = sp(c);
        String json = p.getString(KEY_SNAPSHOT, null);
        if (json == null) return;
        try {
            JSONObject o = new JSONObject(json);
            JSONArray arr = o.optJSONArray(entity);
            if (arr == null) return;
            JSONObject hit = null;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject e = arr.optJSONObject(i);
                if (e != null && id.equals(e.optString("id"))) { hit = e; break; }
            }
            if (hit == null) {
                if (!insertIfMissing) return;
                hit = new JSONObject();
                hit.put("id", id);
                arr.put(hit);
            }
            JSONArray names = fields.names();
            for (int k = 0; k < names.length(); k++) {
                String key = names.getString(k);
                if (fields.isNull(key)) hit.remove(key);
                else hit.put(key, fields.get(key));
            }
            p.edit().putString(KEY_SNAPSHOT, o.toString()).apply();
        } catch (Exception ignored) {
            // 改不动就算了 —— 直连成功后会用服务端的真值覆盖
        }
    }

    /** 用服务端返回的新快照整体替换本地那份 */
    static void replaceSnapshot(Context c, JSONObject snap) {
        sp(c).edit().putString(KEY_SNAPSHOT, snap.toString()).apply();
    }

    // ── 直连服务器要用的三样 ──────────────────────────────────────────────

    static String token(Context c) {
        return sp(c).getString(KEY_TOKEN, null);
    }

    static void setToken(Context c, String t) {
        sp(c).edit().putString(KEY_TOKEN, t).apply();
    }

    /** 没有基址时给个默认值 —— 线上那个，宁可连不上也不能拼出半截 URL */
    static String apiBase(Context c) {
        String b = sp(c).getString(KEY_API_BASE, null);
        return (b == null || b.isEmpty()) ? "https://home.xiaokubao.space/schedule" : b;
    }

    static void setApiBase(Context c, String b) {
        if (b != null && !b.isEmpty()) sp(c).edit().putString(KEY_API_BASE, b).apply();
    }

    /** 一次生成、之后不变 —— op 里的 deviceId 稳定，服务端好追溯 */
    static String deviceId(Context c) {
        SharedPreferences p = sp(c);
        String id = p.getString(KEY_DEVICE_ID, null);
        if (id == null) {
            id = "widget-" + java.util.UUID.randomUUID().toString().substring(0, 12);
            p.edit().putString(KEY_DEVICE_ID, id).apply();
        }
        return id;
    }

    /** 是否已经具备直连条件（票 + 基址都在） */
    static boolean canDirect(Context c) {
        String t = token(c);
        return t != null && !t.isEmpty();
    }

    // ── 时间轴范围 ───────────────────────────────────────────────────────

    static int startHour(Context c) {
        return clampHour(sp(c).getInt(KEY_START_HOUR, DEFAULT_START_HOUR));
    }

    static int endHour(Context c) {
        return clampHour(sp(c).getInt(KEY_END_HOUR, DEFAULT_END_HOUR));
    }

    /**
     * 存范围。**保证 start < end** —— 用户把起点设到晚于终点时（比如
     * 22 点开始、6 点结束），渲染那边会算出一个负的行数，表现是整个
     * 时间轴消失。这里直接把顺序摆正，比在下游每处都防一遍省事。
     */
    static void setRange(Context c, int start, int end) {
        int a = clampHour(start);
        int b = clampHour(end);
        if (a >= b) {
            if (start <= end) b = Math.min(23, a + 1);
            else a = Math.max(0, b - 1);
        }
        sp(c).edit().putInt(KEY_START_HOUR, a).putInt(KEY_END_HOUR, b).apply();
    }

    static void resetRange(Context c) {
        setRange(c, DEFAULT_START_HOUR, DEFAULT_END_HOUR);
    }

    private static int clampHour(int h) {
        return Math.max(0, Math.min(23, h));
    }
}
