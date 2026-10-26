package space.xiaokubao.schedule;

/**
 * 桌面计数器 —— 4×1 独立入口（左右两块）。
 *
 * 为什么要第二个 receiver：桌面「添加小组件」列表按 receiver 列条目，
 * 只有一个 receiver 就只有一个入口（默认 2×2），用户拖不出 4×1 的预设。
 * 这个类零逻辑，全部继承 {@link CounterWidgetProvider} —— 渲染、点击、
 * 同步走同一套代码，{@link CounterWidgetProvider#refreshAll} 刷两个入口的实例。
 *
 * 布局选择不靠入口靠实测宽高比（见 CounterWidgetProvider.isWide）：4×1
 * 的实例自然落到 widget_counter_h，2×2 落到 widget_counter_v。
 * 点 −/+ 走广播回 CounterWidgetProvider（stepIntent 目标），那边 refreshAll
 * 会把两个入口一起重绘，所以点哪边两边都对得上。
 */
public class CounterWidgetWideProvider extends CounterWidgetProvider {
}
