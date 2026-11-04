package space.xiaokubao.schedule;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.TypedValue;
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

            // chip 行：perRow 颗，不满补占位
            int perRow = perRow();
            RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_habit_row);
            for (int i = 0; i < perRow; i++) {
                if (i < it.chips.size()) {
                    row.addView(R.id.habit_row, chipView(it.chips.get(i), today, k));
                } else {
                    row.addView(R.id.habit_row, ScheduleWidgetProvider.emptyChip(ctx));
                }
            }
            return row;
        }

        /** 单颗 chip：完成态取**要显示的那一天**（恒为今天），点击挂 fill-in intent */
        private RemoteViews chipView(WHabit h, String today, float k) {
            RemoteViews chip = new RemoteViews(ctx.getPackageName(), R.layout.widget_habit_chip);
            chip.setTextViewText(R.id.habit_chip, h.title);
            boolean done = h.log != null && h.log.optBoolean(today, false);
            chip.setInt(R.id.habit_chip, "setBackgroundResource",
                    done ? R.drawable.widget_habit_bg : R.drawable.widget_habit_bg_done);
            chip.setTextColor(R.id.habit_chip, done ? 0xFF7E8F84 : 0xFF1B3A2A);
            ScheduleWidgetProvider.font(chip, R.id.habit_chip, 8, k);
            // fill-in：把 habitId 塞进 intent extras，Provider 的 template PendingIntent
            // 提供了 action + component，这里只补 extras，系统合成最终 PendingIntent
            Intent fill = new Intent().putExtra(HabitWidgetProvider.EXTRA_ID, h.id);
            chip.setOnClickFillInIntent(R.id.habit_chip, fill);
            return chip;
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
