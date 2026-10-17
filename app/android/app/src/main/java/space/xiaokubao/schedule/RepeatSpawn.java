package space.xiaokubao.schedule;

import android.content.Context;

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

    /**
     * 预生成未来几次。
     *
     * 2026-10-14 从 4 提到 14，与 App 的 REPEAT_LOOKAHEAD 对齐。原因一样：
     * 窗口太浅的话用户几天没操作就断档，而补齐的触发（组件每次刷新）并不频繁。
     */
    private static final int LOOKAHEAD = 14;

    private RepeatSpawn() {
    }

    /**
     * @param rootId   系列根 id（新建时是服务端真 id；编辑时就是任务自己的 id）
     * @param title    任务标题
     * @param calId    所属日程集
     * @param baseDate 本次发生日 yyyy-MM-dd（往后从它开始推）
     * @param rule     RepeatRule 对象（unit/n/weekdays/monthday/end）
     * @param reminder 提醒 HH:mm 或 null
     * @param note     详细内容（随标题一起派生给后面几次）。null / 空串 = 不写
     */
    static void spawn(ContextWrapper ctx, String rootId, String title, String calId,
                      String baseDate, JSONObject rule, String reminder, String note) {
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
                /* 详细内容跟着派生 —— 重复任务是同一件事重复发生，正文没道理
                   只有头一次有。空就不写：写了空串反而会在将来变成一条
                   「把内容改成空」的改动。 */
                if (note != null && !note.isEmpty()) f.put("note", note);
                // ⚠️ seriesId 必须写：refillAll 靠它区分「系列根」与「实例」。
                // 缺了它，下次扫描会把每个实例都当成一个新的系列根再派生一批。
                f.put("seriesId", rootId);

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

    /**
     * 这条任务的**系列真根**。与 App 的 `seriesRootOf` 同一口径（形状优先）：
     *   ① id 带 `#` → 真根是 `#` 前的部分。**这是 2026-10-17 的关键**：
     *      编辑实例 repeat 时若拿 task.id 当根去 spawn，整个家族会重新挂到
     *      实例 id 上，子嗣 id 变成两层日期段 —— 血脉从此裂开，
     *      「全部删除」就再也删不干净（用户实报）；
     *   ② 否则 seriesId 字段（它也带 `#` 时同样取前缀，兜住指向中间层的坏数据）；
     *   ③ 都没有 → 它自己就是根。
     */
    static String seriesRootOf(WTask t) {
        if (t == null) return null;
        if (t.id != null) {
            int hash = t.id.indexOf('#');
            if (hash > 0) return t.id.substring(0, hash);
        }
        if (t.seriesId != null && !t.seriesId.isEmpty()) {
            int hash = t.seriesId.indexOf('#');
            return hash > 0 ? t.seriesId.substring(0, hash) : t.seriesId;
        }
        return t.id;
    }

    /**
     * 扫描整个快照，把「窗口快用完」的重复系列补齐。
     *
     * 为什么需要这个（用户2026-10-14 报「每天只重复几天就断了」）：
     * 原来只有「新建/编辑那一刻」才派生一次。用户设完就走，之后既没建新任务、
     * 也没改任何字段 —— 于是那几次消费完之后就永远断档，App 和组件上都找不到。
     * App 侧靠「每轮同步都补」解决；组件这边不跑同步引擎，所以挂在
     * {@link ScheduleWidgetProvider#refresh} 上：组件每次刷新（切日期、改设置、
     * 定时刷新、开关通知等都会触发）都检查一遍。
     *
     * 幂等：已存在的实例 id 会被 patchEntity 跳过，且窗口够长时直接 return，
     * 不会反复发请求。
     *
     * ⚠️ 2026-10-17（用户报「全部删除只删了当天」）：根识别改成**形状优先**。
     * 旧判据是「seriesId 为空或指向自己 → 是根」，于是 seriesId 缺失的实例
     * （被改乱血脉的那批）每条都变成一个**新系列**的根，从这里各自再派生一批
     * id 更长的实例 —— 血脉越裂越多，删除自然永远删不干净。
     * 派生实例 id 一定是 `系列根id#发生日`，所以 **id 带 `#` 的一律不是根**。
     */
    static void refillAll(Context c) {
        try {
            WidgetSnapshot snap = WidgetPrefs.snapshot(c);
            String today = (snap.today != null && !snap.today.isEmpty()) ? snap.today : null;
            java.util.Set<String> roots = new java.util.LinkedHashSet<>();
            for (WTask t : snap.tasks) {
                if (t == null || t.done || t.deleted) continue;
                JSONObject r = t.repeat;
                if (r == null || "none".equals(r.optString("unit", "none"))) continue;
                // 形状优先：id 带 '#' 的一律是派生实例（含被改乱血脉的中间层），
                // 永远不当根。seriesId 那条判据留着，兜老数据里随机 id 的成员。
                if (t.id != null && t.id.indexOf('#') >= 0) continue;
                String sid = t.seriesId;
                if (sid != null && !sid.isEmpty() && !sid.equals(t.id)) continue;
                roots.add(t.id);
            }
            for (String rootId : roots) {
                WTask root = snap.taskById(rootId);
                if (root == null || root.repeat == null) continue;
                /* ⚠️ **已结束的系列直接跳过**（2026-10-14，用户报「App 卡在开屏页」）。
                 * 判据是根上的 `repeatUntil`（由「从这次起往后全部」写下）。
                 * 不跳的话：对一个已结束的系列，窗口永远是「不足」的
                 * （它结束日之后的实例都被删了）→ 这里补 → App 按同一个标记又删 →
                 * 下一轮再补。而 spawn 结尾会直接调 refresh（普通 Java 调用），
                 * 于是 refresh → refillAll → spawn → refresh 在主线程上无限递归，
                 * 首屏永远画不出来。
                 * 2026-10-17：改成**全家族**认标记 —— 标记不一定在根上
                 * （App 在根不在本机时会改写到存活成员身上），只认根会漏，
                 * 漏了就又长回来，那个递归也跟着回来。 */
                if (seriesEnded(snap, root)) continue;
                if (countFuture(snap, root, today) >= LOOKAHEAD) continue;
                // ⚠️ 起点用「已存在的最远日期」，不是根自己的日期。
                // 用根的日期会每次都从同一天重推一遍，生成的永远是同样那几条 ——
                // 窗口消费完后再补多少次也不出来（App 侧同一个坑，见
                // ensureRepeatOccurrences 的注释）。
                String from = furthestDate(snap, root);
                spawn(new ContextWrapper(c), rootId, root.title, root.calId,
                        from != null ? from : root.date, root.repeat, root.reminder, root.note);
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * 这个系列是不是已经被「从某天起全部删除」结束掉了。
     *
     * 全家族扫描：根或**任意成员**身上有 repeatUntil 都算。标记的落点有三类
     * （根墓碑 / 根不在本机时 App 改写的存活成员 / 被改乱血脉的旁支），
     * 只认根本身会漏 → 漏判的系列会被这里重新补出来 → 删了等于没删。
     */
    private static boolean seriesEnded(WidgetSnapshot snap, WTask root) {
        if (root == null) return false;
        for (WTask t : snap.tasks) {
            if (t == null) continue;
            if (t.repeatUntil == null || t.repeatUntil.isEmpty()) continue;
            if (sameSeries(t, root.id)) return true;
        }
        return false;
    }

    /**
     * 是不是同一个家族 —— **形状优先**，与 App 的 seriesRootOf 同一口径。
     *   ① id 等于根本人，或以 `根id#` 开头 → 是（seriesId 字段坏了也认亲，
     *      这是 2026-10-17「全部删除只删当天」的关键：旁支实例的 seriesId
     *      可能指向中间层、甚至整个缺失）；
     *   ② seriesId 字段指向根 → 是（老数据里随机 id 的成员只认这个）。
     * 包内可见：TaskDetailActivity 的「从这次起全部」也要按这个口径收集。
     */
    static boolean sameSeries(WTask t, String rootId) {
        if (t == null || t.id == null || rootId == null) return false;
        if (t.id.equals(rootId)) return true;
        if (t.id.startsWith(rootId + "#")) return true;
        String sid = t.seriesId;
        return sid != null && !sid.isEmpty() && sid.equals(rootId);
    }

    /** 这个系列已存在的实例里最远的那天（含根自己）；没有就返回 null */
    private static String furthestDate(WidgetSnapshot snap, WTask root) {
        String max = null;
        for (WTask t : snap.tasks) {
            if (t == null || t.deleted || t.date == null) continue;
            if (!sameSeries(t, root.id)) continue;
            if (max == null || t.date.compareTo(max) > 0) max = t.date;
        }
        return max;
    }

    /**
     * 这个系列从今天起还剩几次**未完成**的实例（用于判断窗口够不够）。
     *
     * ⚠️ 必须排除 done：已完成的表示「这一次已经消费掉了」，不该继续占着窗口。
     * 不排除的话，用户勾掉今天的重复任务后窗口仍算满，就永远补不出明天的 ——
     * 那正是「每天只重复几天就断了」的另一种表现。
     */
    private static int countFuture(WidgetSnapshot snap, WTask root, String today) {
        int n = 0;
        for (WTask t : snap.tasks) {
            if (t == null || t.deleted || t.done) continue;
            if (!sameSeries(t, root.id)) continue;
            if (today == null || t.date == null || t.date.compareTo(today) >= 0) n++;
        }
        return n;
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