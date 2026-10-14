package space.xiaokubao.schedule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

/**
 * 重复任务的后续实例派生（原生侧）。
 *
 * 为什么原生也要做一遍：App 里的 ensureRepeatOccurrences() 只在**打开 App /
 * 同步**时才跑。用户大量操作是在桌面上完成的 —— 在小组件里给任务设了重复、
 * 然后就走开了，App 一直没开，那边永远不触发，表现就是「设了重复一条新的都没有」。
 *
 * id 规则与 App 的 instanceId() 完全一致（`系列根id#发生日`），所以两边同时跑
 * 也不会把同一次建成两条 —— 这是整个重复功能能收敛的根本。
 */
final class RepeatSpawn {

    /** 预生成未来几次（与 App 的 REPEAT_LOOKAHEAD 一致） */
    private static final int LOOKAHEAD = 4;

    private RepeatSpawn() {
    }

    /**
     * @param rootId   系列根 id（新建时是服务端真 id；编辑时就是任务自己的 id）
     * @param title    任务标题
     * @param calId    所属日程集
     * @param baseDate 本次发生日 yyyy-MM-dd（往后从它开始推）
     * @param rule     RepeatRule 对象（unit/n/weekdays/monthday/end）
     * @param reminder 提醒 HH:mm 或 null
     */
    static void spawn(ContextWrapper ctx, String rootId, String title, String calId,
                      String baseDate, JSONObject rule, String reminder) {
        if (ctx == null || rootId == null || rule == null) return;
        String unit = rule.optString("unit", "none");
        if ("none".equals(unit)) return;
        int[] ymd = ymdOf(baseDate);
        if (ymd == null) return;

        try {
            JSONArray ops = new JSONArray();
            Calendar cur = Calendar.getInstance();
            cur.set(ymd[0], ymd[1] - 1, ymd[2]);

            int n = Math.max(1, rule.optInt("n", 1));
            JSONArray wd = rule.optJSONArray("weekdays");
            JSONObject end = rule.optJSONObject("end");
            int made = 0;

            for (int i = 0; i < LOOKAHEAD; i++) {
                if (end != null && "count".equals(end.optString("type"))
                        && made + 1 >= Math.max(1, end.optInt("count", 1))) break;
                cur = advance(cur, unit, n, wd);
                if (cur == null) break;
                String d = String.format(Locale.US, "%04d-%02d-%02d",
                        cur.get(Calendar.YEAR), cur.get(Calendar.MONTH) + 1,
                        cur.get(Calendar.DAY_OF_MONTH));
                if (end != null && "date".equals(end.optString("type"))) {
                    String ed = end.optString("date", "");
                    if (!ed.isEmpty() && d.compareTo(ed) > 0) break;
                }

                String oid = rootId + "#" + d;
                JSONObject f = new JSONObject();
                f.put("title", title);
                f.put("date", d);
                f.put("time", JSONObject.NULL);
                f.put("duration", JSONObject.NULL);
                f.put("done", false);
                f.put("doneAt", JSONObject.NULL);
                f.put("repeat", rule);
                f.put("reminder", reminder == null ? JSONObject.NULL : reminder);

                JSONObject lf = new JSONObject(f.toString());
                lf.put("calId", calId);
                // 快照用的是 dur（不是 duration）
                lf.remove("duration");
                lf.put("dur", JSONObject.NULL);
                WidgetPrefs.patchEntity(ctx.context, "tasks", oid, lf, true);

                JSONObject op = new JSONObject();
                op.put("entity", "task");
                op.put("entityId", oid);
                op.put("calId", calId);
                op.put("fields", f);
                ops.put(op);
                made++;
            }
            if (made == 0) return;

            ScheduleWidgetProvider.refresh(ctx.context);
            if (WidgetPrefs.canDirect(ctx.context) && ops.length() > 0) {
                WidgetApi.op(ctx.context, ops, new WidgetApi.OpCallback() {
                    @Override public void onAccepted(JSONObject body) { }
                    @Override public void onRejected(JSONObject body, String why) {
                        for (int i = 0; i < ops.length(); i++) {
                            WidgetPrefs.removeEntity(ctx.context, "tasks",
                                    ops.optJSONObject(i).optString("entityId"));
                        }
                        ScheduleWidgetProvider.refresh(ctx.context);
                    }
                    @Override public void onUnreachable(String why) { }
                });
            }
            // 离线不入队：等 App 同步后由 ensureRepeatOccurrences 补，id 规则一致不会重复
        } catch (Exception ignored) {
        }
    }

    /** 推进一步。工作日跳过周末；周按 weekdays 命中（对齐 App 的 repeatAdvance）。 */
    private static Calendar advance(Calendar cur, String unit, int n, JSONArray wd) {
        Calendar c = (Calendar) cur.clone();
        if ("day".equals(unit)) {
            c.add(Calendar.DAY_OF_MONTH, n);
        } else if ("week".equals(unit)) {
            if (wd != null && wd.length() > 0) {
                for (int i = 1; i <= 7 * n; i++) {
                    c.add(Calendar.DAY_OF_MONTH, 1);
                    // Calendar: 1=周日 … 7=周六 → App: 0=周日 … 6=周六
                    if (has(wd, c.get(Calendar.DAY_OF_WEEK) - 1)) return c;
                }
                c.add(Calendar.WEEK_OF_YEAR, n);
            } else {
                c.add(Calendar.WEEK_OF_YEAR, n);
            }
        } else if ("month".equals(unit)) {
            c.add(Calendar.MONTH, n);
        } else if ("year".equals(unit)) {
            c.add(Calendar.YEAR, n);
        } else {
            return null;
        }
        return c;
    }

    private static boolean has(JSONArray a, int v) {
        for (int i = 0; i < a.length(); i++) if (a.optInt(i, -1) == v) return true;
        return false;
    }

    private static int[] ymdOf(String iso) {
        if (iso == null || iso.length() < 10) return null;
        try {
            return new int[]{
                    Integer.parseInt(iso.substring(0, 4)),
                    Integer.parseInt(iso.substring(5, 7)),
                    Integer.parseInt(iso.substring(8, 10))
            };
        } catch (Exception e) {
            return null;
        }
    }

    /** 极简 Context 包装，省得每个调用点都传两遍 context 和 activity */
    static final class ContextWrapper {
        final android.content.Context context;
        ContextWrapper(android.content.Context c) { this.context = c; }
    }
}