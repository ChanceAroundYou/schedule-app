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

    /**
     * 底板透明度（百分比）。范围 40–100 的**任意整数**都行 —— 滑杆连续拖动，
     * 每个值都对应一张 drawable（每 2% 一张，见 ScheduleWidgetProvider.bgFor 和
     * res/drawable/widget_bg_a*.xml）。往右拉越透明（用户明确要的方向）。
     */
    static final String KEY_ALPHA = "schedule_widget_alpha";
    static final int MIN_ALPHA = 40;
    static final int MAX_ALPHA = 100;
    static final int DEFAULT_ALPHA = 100;

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

    /** 整队覆盖。用于去重之后写回，以及发送成功之后扣掉已发的那一批 */
    static void setPending(Context c, List<JSONObject> ops) {
        if (ops == null || ops.isEmpty()) {
            clearPending(c);
            return;
        }
        JSONArray arr = new JSONArray();
        for (JSONObject o : ops) arr.put(o);
        sp(c).edit().putString(KEY_PENDING, arr.toString()).apply();
    }

    /**
     * 把队首的 n 条移掉 —— 那一批已经成功发出去了。
     *
     * 为什么要按批扣而不是整个 clearPending：服务端一次最多收 50 条 op，
     * 队列更长时必须分批发，发完一批只能减去一批。以前整批发、整队清，
     * 一旦超过 50 就永远是 400，队列只进不出。
     */
    static void dropPending(Context c, int n) {
        List<JSONObject> rest = pendingOps(c);
        if (n >= rest.size()) {
            clearPending(c);
            return;
        }
        setPending(c, new ArrayList<>(rest.subList(n, rest.size())));
    }

    static int pendingCount(Context c) {
        return pendingOps(c).size();
    }

    /**
     * 有没有攒着没发出去的改动。
     *
     * **不解析 JSON** —— 只想问「有没有」的时候没必要把上百条逐个 parse。
     * {@code "[]"} 是空队列的字面量，长过它就说明有东西。
     */
    static boolean hasPending(Context c) {
        String s = sp(c).getString(KEY_PENDING, null);
        return s != null && s.length() > 4;
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

    /* ── 服务端视图的「局部合并」 ─────────────────────────────────────── */

    /**
     * 拿服务端返回的视图，**只覆盖本地快照里指定的那几条实体**，其余一律保留。
     *
     * 为什么不能整表 {@link #replaceSnapshot}：服务端视图里当然没有我们
     * **还没发出去**的乐观改动（刚点的打卡、刚建还没落库的任务）—— 整表覆盖
     * 会把它们从桌面上抹掉，等对应的 op 落地才重新出现，表现是
     * 「刚加的东西闪了一下没了」。只同步这一批 op 真正碰到的那几条，
     * 别的保持本地观感，等队列清空、下次 bootstrap 再自然对齐。
     *
     * 两个方向都靠它：
     *   · 服务端**接受**了 → 把这条换成服务端的值（顺带修掉乐观算错的 streak）
     *   · 服务端**拒绝**了 → 同样换成服务端的值 = 回到它返回的真相
     *
     * 服务端视图里**找不到**这个 id 时什么都不做 —— 那说明这条在服务端已经
     * 不存在（删除被接受），本地留着墓碑正好，别去动别的数据。
     *
     * @param entity "tasks" 或 "habits"
     * @param ids    这批 op 碰到的实体 id
     */
    static void mergeEntities(Context c, JSONObject serverView, String entity,
                              java.util.List<String> ids) {
        if (serverView == null || ids == null || ids.isEmpty()) return;
        String json = sp(c).getString(KEY_SNAPSHOT, null);
        if (json == null) return;
        try {
            JSONObject local = new JSONObject(json);
            JSONArray src = serverView.optJSONArray(entity);
            JSONArray dst = local.optJSONArray(entity);
            if (src == null || dst == null) return;
            for (String id : ids) {
                JSONObject srv = null;
                for (int i = 0; i < src.length(); i++) {
                    JSONObject e = src.optJSONObject(i);
                    if (e != null && id.equals(e.optString("id"))) { srv = e; break; }
                }
                if (srv == null) continue;      // 服务端没有这条 = 已删除，保持本地
                for (int i = 0; i < dst.length(); i++) {
                    JSONObject e = dst.optJSONObject(i);
                    if (e != null && id.equals(e.optString("id"))) {
                        // **逐字段覆盖**，不是整条替换。
                        //
                        // 2026-10-14：整条换掉时，凡是**服务端视图没带的字段**
                        // 都会被抹掉 —— 小组件的编辑弹窗刚改了 repeat / reminder，
                        // op 落地后拿服务端视图一回写，就因为视图里没有这两个字段
                        // 而「改了存不住」。服务端现已带上它们（routes/widget.js），
                        // 这里再逐字段合并兜一层：只覆盖服务端**明确给了**的键，
                        // 其余保留本地那份。
                        //
                        // 服务端明确给 null 的（如 time:null）仍以 null 落进来，
                        // 因为 names() 会带上这个键 —— 该清的还是会清。
                        JSONObject merged = new JSONObject(e.toString());
                        JSONArray names = srv.names();
                        if (names != null) {
                            for (int k = 0; k < names.length(); k++) {
                                String key = names.getString(k);
                                merged.put(key, srv.get(key));
                            }
                        }
                        dst.put(i, merged);
                        break;
                    }
                }
            }
            sp(c).edit().putString(KEY_SNAPSHOT, local.toString()).apply();
        } catch (Exception ignored) {
            // 合并失败不致命：下一个 bootstrap 会整体纠正
        }
    }

    /**
     * 新建任务的落地：把「假 id 占位」换成服务端返回的那条。
     *
     * 新建时本地先用 {@code t_local_xxx} 占位才能立刻画出来，服务端的真 id
     * 要等它返回。按「标题 + 日期 + 时间」在服务端视图里找那条**本地还没有**
     * 的任务来对接 —— 匹配不上就什么都不做（占位留着，下次 bootstrap 整体
     * 纠正），也绝不能整表覆盖（理由同 {@link #mergeEntities}）。
     */
    static void adoptCreated(Context c, JSONObject serverView, String localId,
                             String title, String date, String time) {
        if (serverView == null) return;
        String json = sp(c).getString(KEY_SNAPSHOT, null);
        if (json == null) return;
        try {
            JSONObject local = new JSONObject(json);
            JSONArray src = serverView.optJSONArray("tasks");
            JSONArray dst = local.optJSONArray("tasks");
            if (src == null || dst == null) return;

            // ① 撤掉占位
            for (int i = 0; i < dst.length(); i++) {
                JSONObject e = dst.optJSONObject(i);
                if (e != null && localId.equals(e.optString("id"))) { dst.remove(i); break; }
            }
            // ② 本地已有的 id —— 服务端多出来的那条才是刚建的
            java.util.HashSet<String> have = new java.util.HashSet<>();
            for (int i = 0; i < dst.length(); i++) {
                JSONObject e = dst.optJSONObject(i);
                if (e != null) have.add(e.optString("id"));
            }
            String t = time == null ? "" : time;
            for (int i = 0; i < src.length(); i++) {
                JSONObject e = src.optJSONObject(i);
                if (e == null) continue;
                if (have.contains(e.optString("id"))) continue;
                if (!title.equals(e.optString("title"))) continue;
                if (!date.equals(e.optString("date"))) continue;
                String st = e.optString("time", "");
                if (!t.equals(st == null ? "" : st)) continue;
                dst.put(new JSONObject(e.toString()));
                break;
            }
            sp(c).edit().putString(KEY_SNAPSHOT, local.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /**
     * 从本地快照里删掉一条。**新建被服务端拒绝时**用 —— 占位那条得撤掉，
     * 否则桌面一直挂着一条服务端并不存在的任务。
     */
    static void removeEntity(Context c, String entity, String id) {
        String json = sp(c).getString(KEY_SNAPSHOT, null);
        if (json == null) return;
        try {
            JSONObject local = new JSONObject(json);
            JSONArray arr = local.optJSONArray(entity);
            if (arr == null) return;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject e = arr.optJSONObject(i);
                if (e != null && id.equals(e.optString("id"))) { arr.remove(i); break; }
            }
            sp(c).edit().putString(KEY_SNAPSHOT, local.toString()).apply();
        } catch (Exception ignored) {
        }
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

    // ── 底板透明度 ───────────────────────────────────────────────────────

    static int alpha(Context c) {
        return normalizeAlpha(sp(c).getInt(KEY_ALPHA, DEFAULT_ALPHA));
    }

    static void setAlpha(Context c, int pct) {
        sp(c).edit().putInt(KEY_ALPHA, normalizeAlpha(pct)).apply();
    }

    /** 夹到合法区间 40–100 —— 免得旧版本存下的值或手改的值画出四不像 */
    private static int normalizeAlpha(int pct) {
        return Math.max(MIN_ALPHA, Math.min(MAX_ALPHA, pct));
    }

    private static int clampHour(int h) {
        return Math.max(0, Math.min(23, h));
    }
}
