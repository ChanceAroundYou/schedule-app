/**
 * Toolbar.tsx —— 详细内容的工具条（两层：第一排直点，后面按组收）
 *
 * 布局为什么这么排（2026-10-26 用户定）：第一排只放**高频直点**的
 * 粗体 / 待办 / 图片 / 链接；斜体、下划线、标题、代码这些收进三组下拉。
 * 理由是手机上横排能站的按钮就 8 个左右（360px 宽），一旦折成两排，
 * 工具条会吃掉编辑区一大块高度。
 *
 * 两条实现上的硬要求：
 *
 *   1. **每个按钮都要 `onMouseDown → preventDefault`。** 不拦的话，按下按钮
 *      的瞬间 contenteditable 失焦、选区塌掉，`toggleBold()` 作用在一个空
 *      选区上 —— 表现就是「点了没反应」。这是所有 contenteditable 工具栏的
 *      通用坑，浮层里的菜单项同样要拦。
 *   2. 图标一律 lucide，不用字符画、不用 emoji（见 kit.tsx 顶部两条硬规则）。
 */

import { useRef, useState } from 'react';
import {
  ChevronDown, Check, Bold, ListChecks, Image as ImageIcon, Link2, Italic,
  Underline, Strikethrough, Highlighter, Eraser, List, ListOrdered,
  IndentIncrease, IndentDecrease, Heading1, Heading2, Heading3, Type, Quote, Braces, Minus,
  type LucideIcon,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { useAnchoredPosition, useEscape, useOutsideClose } from '../hooks.ts';

export type ToolItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  /** 当前选区已经是这个状态 → 画按下态 + 打勾 */
  on?: boolean;
  disabled?: boolean;
};

/** 按下按钮不许抢走编辑器焦点 */
function keepFocus(e: { preventDefault: () => void }) {
  e.preventDefault();
}

function ToolBtn({ label, on, disabled, onClick, children }: {
  label: string;
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={'note-btn' + (on ? ' on' : '')}
      title={label}
      aria-label={label}
      aria-pressed={on ? true : undefined}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 分组按钮：点开一层浮层，里面是这一组的全部命令 */
function GroupMenu({ label, items, anyOn }: {
  label: string;
  items: ToolItem[];
  /** 组里任一项处于激活态时，组按钮也画按下态 —— 否则用户不知道刚才点的效果在哪组里 */
  anyOn?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOutsideClose(panel, open, () => setOpen(false), btn);
  useEscape(open, () => setOpen(false));
  /* forceUp：工具条贴在编辑框底部，菜单往上弹才不会被屏幕下沿截掉 */
  const pos = useAnchoredPosition(btn, panel, open, [items.map((i) => i.on).join()], true);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={'note-btn note-btn--group' + (anyOn || open ? ' on' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onMouseDown={keepFocus}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <ChevronDown size={11} strokeWidth={2} />
      </button>
      {open && (
        <div
          ref={panel}
          className="note-menu"
          role="menu"
          aria-label={label}
          style={{
            top: pos ? pos.top : 0,
            left: pos ? pos.left : 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={'note-menu-item' + (it.on ? ' on' : '')}
              disabled={it.disabled}
              onMouseDown={keepFocus}
              onClick={() => { it.run(); setOpen(false); }}
            >
              <it.icon size={14} strokeWidth={1.8} />
              <span>{it.label}</span>
              {it.on && <Check size={13} className="note-menu-check" />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function NoteToolbar({ editor, onPickImage, onOpenLink, uploading, narrow }: {
  editor: Editor | null;
  onPickImage: () => void;
  onOpenLink: () => void;
  uploading: boolean;
  /** 窄屏把分组按钮上的字藏起来，只留箭头 —— 八个按钮才站得下 */
  narrow: boolean;
}) {
  if (!editor) return null;
  const e = editor;
  const chain = () => e.chain().focus();

  const fontItems: ToolItem[] = [
    { key: 'italic', label: '斜体', icon: Italic, run: () => chain().toggleItalic().run(), on: e.isActive('italic') },
    { key: 'underline', label: '下划线', icon: Underline, run: () => chain().toggleUnderline().run(), on: e.isActive('underline') },
    { key: 'strike', label: '删除线', icon: Strikethrough, run: () => chain().toggleStrike().run(), on: e.isActive('strike') },
    { key: 'highlight', label: '高亮', icon: Highlighter, run: () => chain().toggleHighlight().run(), on: e.isActive('highlight') },
    { key: 'clear', label: '清除格式', icon: Eraser, run: () => chain().unsetAllMarks().clearNodes().run() },
  ];

  /* 缩进要分两种列表：待办清单的节点是 taskItem，普通列表是 listItem。
     不带判断地两个命令串着调，在不匹配的那种里第一条就失败，第二条也被
     链式调用带着跑偏（表现是「点缩进什么也没发生」）。 */
  const indent = (dir: 1 | -1) => {
    const kind = e.isActive('taskList') ? 'taskItem' : 'listItem';
    const c = e.chain().focus();
    if (dir === 1) c.sinkListItem(kind).run();
    else c.liftListItem(kind).run();
  };

  const listItems: ToolItem[] = [
    { key: 'bullet', label: '无序列表', icon: List, run: () => chain().toggleBulletList().run(), on: e.isActive('bulletList') },
    { key: 'ordered', label: '有序列表', icon: ListOrdered, run: () => chain().toggleOrderedList().run(), on: e.isActive('orderedList') },
    { key: 'task', label: '待办清单', icon: ListChecks, run: () => chain().toggleTaskList().run(), on: e.isActive('taskList') },
    { key: 'indent', label: '增加缩进', icon: IndentIncrease, run: () => indent(1) },
    { key: 'outdent', label: '减少缩进', icon: IndentDecrease, run: () => indent(-1) },
  ];

  const paraItems: ToolItem[] = [
    { key: 'h1', label: '标题 1', icon: Heading1, run: () => chain().toggleHeading({ level: 1 }).run(), on: e.isActive('heading', { level: 1 }) },
    { key: 'h2', label: '标题 2', icon: Heading2, run: () => chain().toggleHeading({ level: 2 }).run(), on: e.isActive('heading', { level: 2 }) },
    { key: 'h3', label: '标题 3', icon: Heading3, run: () => chain().toggleHeading({ level: 3 }).run(), on: e.isActive('heading', { level: 3 }) },
    { key: 'p', label: '正文', icon: Type, run: () => chain().setParagraph().run(), on: e.isActive('paragraph') },
    { key: 'quote', label: '引用', icon: Quote, run: () => chain().toggleBlockquote().run(), on: e.isActive('blockquote') },
    { key: 'code', label: '代码块', icon: Braces, run: () => chain().toggleCodeBlock().run(), on: e.isActive('codeBlock') },
    { key: 'hr', label: '分割线', icon: Minus, run: () => chain().setHorizontalRule().run() },
  ];

  return (
    <div className="note-bar" role="toolbar" aria-label="详细内容格式">
      <ToolBtn label="粗体" on={e.isActive('bold')} onClick={() => chain().toggleBold().run()}>
        <Bold size={15} strokeWidth={2.2} />
      </ToolBtn>
      <ToolBtn label="待办清单" on={e.isActive('taskList')} onClick={() => chain().toggleTaskList().run()}>
        <ListChecks size={15} strokeWidth={2} />
      </ToolBtn>
      <ToolBtn label="插入图片" on={uploading} disabled={uploading} onClick={onPickImage}>
        <ImageIcon size={15} strokeWidth={2} />
      </ToolBtn>
      <ToolBtn label="链接" on={e.isActive('link')} onClick={onOpenLink}>
        <Link2 size={15} strokeWidth={2} />
      </ToolBtn>

      <span className="note-bar-sep" aria-hidden="true" />

      <GroupMenu label={narrow ? '' : '字体'} items={fontItems}
        anyOn={e.isActive('italic') || e.isActive('underline') || e.isActive('strike') || e.isActive('highlight')} />
      <GroupMenu label={narrow ? '' : '列表'} items={listItems}
        anyOn={e.isActive('bulletList') || e.isActive('orderedList') || e.isActive('taskList')} />
      <GroupMenu label={narrow ? '' : '段落'} items={paraItems}
        anyOn={e.isActive('heading') || e.isActive('blockquote') || e.isActive('codeBlock')} />
    </div>
  );
}
