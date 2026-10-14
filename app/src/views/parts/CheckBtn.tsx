/**
 * CheckBtn.tsx —— 勾选圈（全应用唯一实现）
 */

/**
 * 勾选圈 —— 全应用**唯一**的实现。
 *
 * 这东西原先在六个地方各写了一遍，于是各自长歪了：月 / 周视图那个是 `<span>`
 * （Tab 进不去、没有按钮角色、读屏念不出），打卡页和时间轴那两个**没有可访问
 * 名字**，逾期行的标题写死成「标记完成」（已完成时也是这句，读屏听起来是反的）。
 * 收成一个组件，这些漂移就不可能再发生。
 *
 * 必须是 `<button>`：这是全应用点得最多的控件，得能 Tab 到、得能回车触发。
 * 尺寸 / 内外边距 / 边框 / 圆角全由 `.check-btn` 显式定死，不会带进 UA 默认样式。
 * 24×24 的命中区由 `styles/lists.css` 里 `.check-btn::before` 撑出来（视觉尺寸不变）。
 */
export function CheckBtn({ id, on, act = 'toggle', sm }: {
  id: string;
  on?: boolean;
  /** 'toggle' = 勾任务，'habit' = 勾打卡。决定 title 的文案 */
  act?: 'toggle' | 'habit';
  sm?: boolean;
}) {
  const label = act === 'habit'
    ? (on ? '取消今日打卡' : '今日打卡')
    : (on ? '取消完成' : '标记完成');
  return (
    <button
      type="button"
      className={'check-btn' + (sm ? ' sm' : '') + (on ? ' on' : '')}
      data-act={act}
      data-id={id}
      title={label}
      aria-label={label}
    />
  );
}

/**
 * 多选用的选择圈（2026-10-14）。
 *
 * 与 {@link CheckBtn} 分开而不是复用：**勾选圈点一下会让行从列表里让位**
 * （已完成就收进「已完成」），而选择圈点一下只是选中。复用同一个组件、
 * 靠外部改 data-act 的话，两件事的语义会混在一个按钮里，读屏文案也会打架。
 *
 * 点击同样走委托（`data-act="sel-toggle"`），所以这里零回调。
 */
export function SelDot({ id, on }: { id: string; on: boolean }) {
  const label = on ? '取消选择' : '选择';
  return (
    <button
      type="button"
      className={'sel-dot' + (on ? ' on' : '')}
      data-act="sel-toggle"
      data-id={id}
      title={label}
      aria-label={label}
      aria-pressed={on}
    />
  );
}
