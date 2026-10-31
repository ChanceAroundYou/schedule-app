package space.xiaokubao.schedule;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 提醒的接收端。两件事：
 *
 *  1. **到点发通知** —— 收到 {@link ReminderScheduler#ACTION_FIRE}
 *     （由 AlarmManager 发来）。
 *  2. **重排** —— 开机 / 应用更新 / 改时间 / 换时区，系统广播到这里，
 *     调 {@link ReminderScheduler#reschedule} 把闹钟恢复。
 *     **这一条不能少**：AlarmManager 的闹钟开机就没了，不重排等于提醒全部失效。
 *
 * 用系统框架的 Notification.Builder（不用 NotificationCompat）—— 少引一个
 * 依赖，minSdk 24 下 API 26 以上走 channel 构造、以下走无 channel 构造。
 */
public class ReminderReceiver extends BroadcastReceiver {

    private static final String CHANNEL_ID = "schedule_reminders";

    @Override
    public void onReceive(Context c, Intent i) {
        String action = i.getAction();

        // ---- 系统广播：重排 ----
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            ReminderScheduler.reschedule(c);
            // 小组件的「过 0 点重画」闹钟同样不会跨开机保留，一并补排（幂等）。
            ScheduleWidgetProvider.scheduleDaily(c);
            return;
        }

        // ---- 闹钟触发：发通知 ----
        if (!ReminderScheduler.ACTION_FIRE.equals(action)) return;

        String title = i.getStringExtra(ReminderScheduler.EXTRA_TITLE);
        String time = i.getStringExtra(ReminderScheduler.EXTRA_TIME);
        if (title == null || title.isEmpty()) title = "任务提醒";

        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "任务提醒", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("日程任务的到点提醒");
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pflags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) pflags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(c, 0, open, pflags);

        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(c, CHANNEL_ID)
                : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(time == null || time.isEmpty() ? "到提醒时间了" : time + " 提醒")
                .setAutoCancel(true)
                .setContentIntent(contentIntent);
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH);
        }

        try {
            nm.notify((title + "|" + time).hashCode(), b.build());
        } catch (Exception ignored) {
            // 没有通知权限（Android 13+ 用户拒绝）时静默失败，不崩
        }
    }
}
