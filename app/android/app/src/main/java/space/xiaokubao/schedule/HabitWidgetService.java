package space.xiaokubao.schedule;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 打卡组件的 ListView 数据源（2026-11-04 第二轮加）。
 *
 * 为什么需要它：RemoteViews 不支持 ScrollView，装不下的内容只能靠 ListView +
 * RemoteViewsService 实现原生滚动（Android 桌面组件标准做法）。以前用 LinearLayout
 * 动态加行，装不下就折成「+N」—— 用户明确要改成滚动。
 *
 * 运行在**本 App 进程**（launcher 通过 bindRemoteViewsService 绑过来），所以能直接
 * 读 {@link WidgetPrefs#snapshot}，不需要跨进程传数据。
 *
 * 点击：Provider 在 ListView 上挂一个 {@code setPendingIntentTemplate}（ACTION_TOGGLE），
 * 每个 chip 在这里挂 {@code setOnClickFillInIntent}（带 EXTRA_ID），系统把两者合成
 * 最终 PendingIntent。比以前每颗 chip 各造一个 PendingIntent 简单得多。
 *
 * {@link #onDataSetChanged} 在 Provider 调 {@code notifyAppWidgetViewDataChanged}
 * 时触发——每次打卡 / 快照刷新 / 换日都会走到。
 */
public class HabitWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new HabitViewsFactory(getApplicationContext(),
                intent.getIntExtra(HabitWidgetProvider.EXTRA_WID,
                        AppWidgetManager.INVALID_APPWIDGET_ID));
    }

    /** 一颗 chip 的实用宽度（dp），与 HabitWidgetProvider.CHIP_CELL_DP 同值 */
    private static final int CHIP_CELL_DP = 62;

    static final class HabitViewsFactory implements RemoteViewsFactory {

        private final Context ctx;
        private final int widgetId;

        /** 扁平条目：组头行 + chip 行混在一起，顺序就是渲染顺序 */
        private List<Item> items = new ArrayList<>();

        private static final int TYPE_HEADER = 0;
        private static final int TYPE_ROW = 1;

        private static final class Item {
            final int type;
            final String headerName;       // TYPE_HEADER
            final List<WHabit> chips;       // TYPE_ROW
            Item(int type, String name, List<WHabit> chips) {
                this.type = type; this.headerName = name; this.chips = chips;
            }
            static Item header(String name) { return new Item(TYPE_HEADER, name, null); }
            static Item row(List<WHabit> chips) { return new Item(TYPE_ROW, null, chips); }
        }

        HabitViewsFactory(Context ctx, int widgetId) {
            this.ctx = ctx;
            this.widgetId = widgetId;
        }

        @Override
        public void onCreate() { }

        @Override
        public void onDataSetChanged() {
            items = buildItems();
        }

        @Override
        public void onDestroy() {
            items = new ArrayList<>();
        }

        @Override
        public int getCount() { return items.size(); }

        /** 每行最多几颗（= widget_habit_row4.xml 的槽位数，改布局要同步） */
        private static final int MAX_PER_ROW = 4;
        /** 四个预置槽位的 view id */
        private static final int[] SLOT_IDS = {
                R.id.habit_c1, R.id.habit_c2, R.id.habit_c3, R.id.habit_c4
        };

        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) return loadingView();
            Item it = items.get(position);
            String today = WidgetPrefs.today(ctx);
            float k = WidgetPrefs.fontScale(ctx) / 100f;

            if (it.type == TYPE_HEADER) {
                RemoteViews head = new RemoteViews(ctx.getPackageName(), R.layout.widget_habit_head);
                head.setTextViewText(R.id.habit_head, it.headerName);
                ScheduleWidgetProvider.font(head, R.id.habit_head, 8, k);
                return head;
            }

            /* ⚠️ 只能**改**预置槽位，绝不能 addView（RemoteViews.addView 是追加语义，
               ListView 复用列表项时会越叠越多 —— 2026-11-04 用户看到「一行重复 3 遍」
               就是这条）。四个槽位每次都被显式设成 VISIBLE / INVISIBLE / GONE，
               apply 多少次结果都一样。 */
            int perRow = perRow();
            RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_habit_row4);
            for (int i = 0; i < MAX_PER_ROW; i++) {
                int id = SLOT_IDS[i];
                if (i < perRow && i < it.chips.size()) {
                    bindChip(row, id, it.chips.get(i), today, k);
                } else if (i < perRow) {
                    // 本行没满：留空占位（INVISIBLE 仍吃宽度），
                    // 否则剩下几颗会被 weight 均分放大 —— 2026-11-03 踩过
                    row.setTextViewText(id, "");
                    row.setInt(id, "setBackgroundResource", 0);
                    row.setViewVisibility(id, View.INVISIBLE);
                } else {
                    // 超出本实例的每行颗数：整格不占宽
                    row.setTextViewText(id, "");
                    row.setInt(id, "setBackgroundResource", 0);
                    row.setViewVisibility(id, View.GONE);
                }
            }
            return row;
        }

        /** 单颗 chip 的四件事（文字 / 底色 / 字色 / 字号）+ 点击 fill-in */
        private void bindChip(RemoteViews row, int viewId, WHabit h, String today, float k) {
            row.setViewVisibility(viewId, View.VISIBLE);
            row.setTextViewText(viewId, h.title);
            boolean done = h.log != null && h.log.optBoolean(today, false);
            row.setInt(viewId, "setBackgroundResource",
                    done ? R.drawable.widget_habit_bg : R.drawable.widget_habit_bg_done);
            row.setTextColor(viewId, done ? 0xFF7E8F84 : 0xFF1B3A2A);
            row.setTextViewTextSize(viewId, TypedValue.COMPLEX_UNIT_SP, Math.max(1f, 8f * k));
            // fill-in：把 habitId 塞进 intent extras，Provider 的 template PendingIntent
            // 提供 action + component，系统合成最终 PendingIntent
            Intent fill = new Intent().putExtra(HabitWidgetProvider.EXTRA_ID, h.id);
            row.setOnClickFillInIntent(viewId, fill);
        }

        @Override
        public RemoteViews getLoadingView() { return null; }

        @Override
        public int getViewTypeCount() { return 2; }   // header + chip row

        @Override
        public long getItemId(int position) { return position; }

        @Override
        public boolean hasStableIds() { return true; }

        /* ============================ 构建 ============================ */

        private List<Item> buildItems() {
            List<Item> out = new ArrayList<>();
            WidgetSnapshot snap = WidgetPrefs.snapshot(ctx);
            if (snap.habits.isEmpty()) return out;   // 空态：ListView count=0 → 空视图自动显示

            int perRow = perRow();
            boolean grouped = !snap.groups.isEmpty();

            if (grouped) {
                Map<String, List<WHabit>> buckets = new LinkedHashMap<>();
                for (WGroup g : snap.groups) buckets.put(g.id, new ArrayList<>());
                List<WHabit> ungrouped = new ArrayList<>();
                for (WHabit h : snap.habits) {
                    List<WHabit> b = h.groupId == null ? null : buckets.get(h.groupId);
                    if (b == null) ungrouped.add(h);
                    else b.add(h);
                }
                for (WGroup g : snap.groups) {
                    List<WHabit> b = buckets.get(g.id);
                    if (b == null || b.isEmpty()) continue;
                    out.add(Item.header(g.name));
                    addChips(out, b, perRow);
                }
                if (!ungrouped.isEmpty()) {
                    out.add(Item.header("未分类"));
                    addChips(out, ungrouped, perRow);
                }
            } else {
                addChips(out, snap.habits, perRow);
            }
            return out;
        }

        private static void addChips(List<Item> out, List<WHabit> habits, int perRow) {
            for (int i = 0; i < habits.size(); i += perRow) {
                int end = Math.min(i + perRow, habits.size());
                out.add(Item.row(new ArrayList<>(habits.subList(i, end))));
            }
        }

        /** 每行几颗：按组件实测宽度反算（与 HabitWidgetProvider 同一套算法） */
        private int perRow() {
            if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return 2;
            try {
                AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
                Bundle o = mgr.getAppWidgetOptions(widgetId);
                if (o == null) return 2;
                int wDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
                if (wDp <= 0) wDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
                if (wDp <= 0) return 2;
                return wDp >= 4 * CHIP_CELL_DP ? 4 : (wDp >= 3 * CHIP_CELL_DP ? 3 : 2);
            } catch (Exception e) {
                return 2;
            }
        }

        private RemoteViews loadingView() {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_habit_head);
            v.setTextViewText(R.id.habit_head, "…");
            return v;
        }
    }
}
