package space.xiaokubao.schedule;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;

/**
 * 提醒排程。
 *
 * 数据来源是小组件快照里的 {@code WTask.reminder}（"HH:mm"，同一天）。
 * **数据一变就整体重排**：先把上一轮排的全部取消，再按当前快照重排。
 * 这样「改了提醒 / 删了任务 / 勾了完成」都不需要各自记得去动闹钟 ——
 * 少一类「忘了取消旧闹钟，到点响了个已经删掉的任务」的 bug。
 *
 * ⚠️ 精确闹钟：
 *   · API 31+ 用 setExactAndAllowWhileIdle 需要 SCHEDULE_EXACT_ALARM（用户可关）。
 *     申请不到会抛 SecurityException → 退化成不精确的 set()，可能晚几分钟，
 *     但总比完全不响强。
 *   · 重排过的 requestCode 记在 SharedPreferences 里，作为「上一轮排了哪些」的账本。
 *
 * 触发后由 {@link ReminderReceiver} 发通知；开机 / 换时区 / 改时间
 * 也会回调到它，重新排一遍（否则重启就丢）。
 */
final class ReminderScheduler {

    /** 闹钟触发的自定义 action（区别于 BOOT_COMPLETED 那些系统 action） */
    static final String ACTION_FIRE = "space.xiaokubao.schedule.REMIND";
    static final String EXTRA_TITLE = "rem_title";
    static final String EXTRA_TIME = "rem_time";

    private static final String PREF = "schedule_reminders";
    private static final String KEY_IDS = "scheduled_ids";

    private ReminderScheduler() {
    }

    /** 数据一变（刷新 / 新建 / 编辑 / 删除 / 勾完成）就调它，重排全部闹钟。 */
    static void reschedule(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        SharedPreferences sp = c.getSharedPreferences(PREF, Context.MODE_PRIVATE);

        // ① 取消上一轮排的全部
        String prev = sp.getString(KEY_IDS, "");
        if (prev != null && !prev.isEmpty()) {
            for (String s : prev.split(",")) {
                try {
                    int rc = Integer.parseInt(s.trim());
                    PendingIntent old = pending(c, rc, "", "");
                    if (old != null) am.cancel(old);
                } catch (Exception ignored) {
                }
            }
        }

        // ② 按当前快照重排
        WidgetSnapshot snap = WidgetPrefs.snapshot(c);
        long now = System.currentTimeMillis();
        StringBuilder ids = new StringBuilder();
        for (WTask t : snap.tasks) {
            if (t.reminder == null || t.reminder.isEmpty()) continue;
            if (t.date == null || t.date.isEmpty()) continue;
            if (t.done) continue;                       // 已完成的不再提醒
            long at = triggerAt(t.date, t.reminder);
            if (at <= now) continue;                    // 已经过了的跳过
            int rc = (t.id == null ? "" : t.id).hashCode();
            PendingIntent pi = pending(c, rc,
                    t.title == null ? "" : t.title, t.reminder);
            try {
                if (Build.VERSION.SDK_INT >= 23) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } catch (Exception e) {
                // 拿不到精确闹钟权限 → 退化成不精确（Doze 下可能晚几分钟）
                am.set(AlarmManager.RTC_WAKEUP, at, pi);
            }
            if (ids.length() > 0) ids.append(',');
            ids.append(rc);
        }
        sp.edit().putString(KEY_IDS, ids.toString()).apply();
    }

    /** "yyyy-MM-dd" + "HH:mm" → 触发时刻（毫秒）。解析失败返回 0。 */
    private static long triggerAt(String iso, String hhmm) {
        try {
            int y = Integer.parseInt(iso.substring(0, 4));
            int mo = Integer.parseInt(iso.substring(5, 7)) - 1;
            int d = Integer.parseInt(iso.substring(8, 10));
            int h = Integer.parseInt(hhmm.substring(0, 2));
            int mi = Integer.parseInt(hhmm.substring(3, 5));
            Calendar cal = Calendar.getInstance();
            cal.set(y, mo, d, h, mi, 0);
            cal.set(Calendar.MILLISECOND, 0);
            return cal.getTimeInMillis();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * 指向 ReminderReceiver 的 PendingIntent。
     *
     * ⚠️ 取消时传的 extras 可以随便 —— PendingIntent 的「是否同一个」只比
     * action / data / type / component / requestCode，不比 extras。
     */
    private static PendingIntent pending(Context c, int reqCode, String title, String time) {
        Intent i = new Intent(c, ReminderReceiver.class);
        i.setAction(ACTION_FIRE);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_TIME, time);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(c, reqCode, i, flags);
    }
}
