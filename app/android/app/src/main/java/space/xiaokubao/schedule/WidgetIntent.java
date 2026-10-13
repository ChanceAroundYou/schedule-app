package space.xiaokubao.schedule;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/**
 * 造回到小组件的 PendingIntent。
 *
 * 之所以包一层：**requestCode 必须每个目标不同**。共用一个 code 的话，
 * 后造的会把前一个顶掉（PendingIntent 按 code 缓存，extra 被合并覆盖），
 * 表现是「点哪天都跳同一天」「点哪个任务都弹同一个」。
 * 这里用目标 id 的 hashCode 当 code，稳定且互不冲突。
 *
 * 注意 {@link RemoteViews#setOnClickPendingIntent} 只收 (viewId, pi) 两个参数，
 * code 只能进 PendingIntent 自己，没有第三个位置可以放。
 */
class WidgetIntent {

    private final Intent intent;
    private final int code;

    private WidgetIntent(Intent intent, int code) {
        this.intent = intent;
        this.code = code;
    }

    /** codeKey 决定 requestCode，传目标对象的 id */
    static WidgetIntent of(Context c, String action, String codeKey) {
        return new WidgetIntent(
                new Intent(c, ScheduleWidgetProvider.class).setAction(action),
                codeKey == null ? action.hashCode() : codeKey.hashCode());
    }

    WidgetIntent put(String key, String value) {
        intent.putExtra(key, value);
        return this;
    }

    WidgetIntent put(String key, int value) {
        intent.putExtra(key, value);
        return this;
    }

    PendingIntent build(Context c) {
        return PendingIntent.getBroadcast(c, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
