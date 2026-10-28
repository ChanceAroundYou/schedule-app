/**
 * CreatorTag.tsx —— 卡片右上角那个「这条不是我建的」小圆圈
 *
 * 里面只有一个字符：创建者昵称的首字（没昵称就用用户名首字，见 `domain/people.ts`）。
 * 颜色不在这儿定：`.creator-tag` 用的是 `--primary`（主题色，2026-10-28 用户指定），
 * 集颜色只体现在卡片左沿那条色带上 —— 这里不再引 `--cal-color`，
 * 免得同一张卡上出现第三套颜色。
 *
 * 与 `RepeatFlag` 分开两个文件、但共用卡片右上角那一格（`.rep-flag--corner` 那块）：
 * **有重复角标时这枚圈让到它左边**（`.creator-tag` 的 `right: calc(2px + 11px + 4px)` = 17px），
 * **没有重复角标时贴右沿**（`.task-el:not(:has(.rep-flag--corner)) > .creator-tag`）——
 * 判据在样式表里，不给 `views/` 加回调，组件自己不看邻居。
 * 标题可以从这枚圈底下穿过去（用户 2026-10-28：「我们和重复记号一样 允许标题在下面穿过」），
 * 所以这里也不给文字留位置。
 *
 * 里面为什么套一层 span：圆里的字要单独往下挪 0.3px 才落在圆心上（`.creator-tag > span`）。
 * 整枚圈一起挪等于没挪，**能挪的只有字形**，而文本节点挪不动 —— 数值与档位见样式表那段。
 *
 * 为什么它是纯展示组件（只吃 `initial` / `title` 两个字符串）：`views/` 不许有回调，
 * 「谁创建的、叫什么」由调用方从 `state.users` 里算好传进来（`state` 是 props）。
 */

export function CreatorTag({ initial, title }: {
  /** 一个字符（码点首字，大写） */
  initial: string;
  /** 悬停 / 读屏看到的完整名字 */
  title: string;
}) {
  return (
    <span className="creator-tag" title={title} aria-label={'创建者：' + title}>
      <span>{initial}</span>
    </span>
  );
}
