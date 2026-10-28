/**
 * CreatorTag.tsx —— 卡片右上角那个「这条不是我建的」小圆圈
 *
 * 里面只有一个字符：创建者昵称的首字（没昵称就用用户名首字，见 `domain/people.ts`）。
 * 颜色不在这儿定：`.creator-tag` 用的是 `--primary`（主题色，2026-10-28 用户指定），
 * 集颜色只体现在卡片左沿那条色带上 —— 这里不再引 `--cal-color`，
 * 免得同一张卡上出现第三套颜色。
 *
 * 与 `RepeatFlag` 分开两个文件、但同一个定位体系（`.rep-flag--corner` 的左边），
 * 两枚角标互不占位。
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
      {initial}
    </span>
  );
}
