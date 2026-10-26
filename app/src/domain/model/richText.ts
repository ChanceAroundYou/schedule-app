/**
 * richText.ts —— 详细内容（`note`）在「富文本」与「纯文本」之间的换算
 *
 * 2026-10-26：`note` 从纯文本升级成富文本（Tiptap 产出的 HTML）。
 * 但有三处**只能读纯文本**，它们不是渲染层，是拿这段字去做别的事：
 *
 *   - 搜索匹配（domain/model/tasks.ts）—— 拿 HTML 去比，`<p>` 这种标签会
 *     让「p」这个字母诡异地搜不到 / 搜得到；
 *   - 桌面小组件快照（domain/widgetSnapshot.ts）—— 原生侧只认纯文本，
 *     喂进去 `<p>开会</p>` 就会在桌面上原样显示成标签；
 *   - 冲突提示框（ui/drawer/ConflictBox.tsx）—— 要写成一句人话。
 *
 * 所以这里放的是**纯函数、不碰 DOM**：小组件的单测跑在 Node 里，引一个
 * 需要 DOMParser 的实现会当场跳过或用不了（见 domain/widgetSnapshot.test.ts）。
 *
 * 反过来「HTML → 干净 HTML」的活不在这里 —— 它靠 Tiptap 自己的 schema
 * 解析（未知标签和属性当场被丢掉），全应用**没有任何一处
 * `dangerouslySetInnerHTML`**，这条线不要破：破了就得自己写白名单清洗器。
 */

/** 这段字看起来是富文本吗。老数据（纯文本）判断出来的结果是 false */
export function looksHtml(s: string): boolean {
  return /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(s);
}

const ENTITY: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

/**
 * 富文本 → 纯文本。
 *
 * 块级标签和 `<br>` 一律换成换行，不然「第一段第二段」会连成
 * 「第一段第二段」（列表尤其明显：三条待办挤成一行）。
 */
export function plain(html: string): string {
  if (!html) return '';
  if (!looksHtml(html)) return html;   // 老数据本来就是纯文本，原样返回
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITY[m.toLowerCase()] ?? m)
    /* 空的 `<p></p>` 会在这里变成连续换行；三个以上压成两个 —— 段落间距
       是排版的事，纯文本里留一行空行就够。 */
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 存库的值 → 编辑器能吃的 HTML。**这一步只做兼容，不做清洗。**
 *
 * 老数据是纯文本：直接丢给 Tiptap 会把整段连成一行、换行全丢
 * （用户看到的是「我原来分好的行怎么黏一起了」）。所以没有标签的一律
 * 按 `\n` 切成段落。反过来有标签的原样交出去 —— 它已经是新格式了。
 */
export function toEditorHtml(value: string): string {
  const v = value || '';
  if (!v.trim()) return '';
  if (looksHtml(v)) return v;
  return v
    .split(/\n/)
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p></p>'))
    .join('');
}
