/**
 * RichNote.tsx —— 「详细内容」的富文本编辑器
 *
 * 为什么用 Tiptap（2026-10-26 选型，结论留给下一个人）：
 *   · MIT、React 官方绑定、**headless** —— 引擎给你，按钮全自己搭，
 *     所以能做「第一排直点 + 三组下拉」这种本项目要求的分层；
 *   · 表格 / 待办 / 图片 / 自动识别链接全是官方扩展，不用自己拼；
 *   · 约 123KB gzip。Lexical 更小，但上面那几样都得自己写。
 *
 * 三条和这个仓库强相关的约束：
 *
 *   1. **不设受控 value。** 每敲一个字都 `setContent` 回去会让光标跳到行首
 *      （旧版 textarea 踩过一模一样的坑，见 Drawer.tsx 里那段注释）。
 *      这里只在**挂载时**灌一次内容，之后靠 400ms 防抖写回 store，
 *      失焦 / 卸载时补一次 flush。
 *   2. **没有 `dangerouslySetInnerHTML`。** 渲染永远走 Tiptap 自己的 schema
 *      解析，不认识的标签和属性当场被丢掉 —— 共享日程集里 editor 写的脏 HTML
 *      到 viewer 这儿就只剩白名单内的节点。这条线不要破，破了就得自己写
 *      清洗器。
 *   3. **进出编辑器各做一次图片地址替换**（见 mediaUrl.ts）。库里只存相对
 *      路径，域名换了图也不会死。
 */

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Placeholder } from '@tiptap/extensions';
import { X } from 'lucide-react';

import { toEditorHtml } from '../../domain/model/richText.ts';
import { uploadImage } from '../../data/api/media.ts';
import { mediaHref, resolveMedia, stripMedia } from './mediaUrl.ts';
import { useIsNarrow } from '../hooks.ts';
import { NoteToolbar } from './Toolbar.tsx';
import './note.css';

/** 写回 store 的节流间隔。400ms 是「打字不会每个字都发一条同步 op」和
 *  「松手就存住」之间的平衡；关抽屉/失焦都会立刻 flush，不会丢字。 */
const SAVE_MS = 400;

function normalizeUrl(v: string): string {
  const s = v.trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

export function RichNote({ initial, onChange, labelledBy }: {
  /** 打开时库里的值（纯文本或 HTML 都行，toEditorHtml 会兼容） */
  initial: string;
  /** 内容变了（已节流）。空内容回空串，不是 `<p></p>` */
  onChange: (html: string) => void;
  /** 「详细内容」那行标题的 id。contenteditable 用 `for` 关联不了 `<label>`，
   *  只能靠 `aria-labelledby` 指向它 —— 读屏和「点小字标签聚焦」都靠这个。 */
  labelledBy?: string;
}) {
  const narrow = useIsNarrow();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');

  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<string>(initial || '');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** 打开链接输入框前先记下选区：输入框一聚焦，编辑器选区在 DOM 上就没了 */
  const linkSel = useRef<{ from: number; to: number } | null>(null);
  /** 给 handlePaste / handleDrop 用的插入函数（它们在 useEditor 里定义，
   *  拿不到后面才声明的函数，只能走 ref 转一道） */
  const insertFile = useRef<(f: File) => void>(() => {});

  const flush = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    onChangeRef.current(pending.current);
  };

  const schedule = (e: Editor) => {
    pending.current = e.isEmpty ? '' : stripMedia(e.getHTML());
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_MS);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        /* 自动识别链接：粘贴网址、或敲完网址敲空格/回车，当场变成 <a>。
           这是「链接放到第一排」之外实际上最常用的那条路 —— 用户压根不用点按钮。 */
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: '补充说明、注意事项…' }),
    ],
    content: toEditorHtml(resolveMedia(initial || '')),
    /* v3 默认「事务不触发重渲染」（省性能），但工具条的按下态是靠 isActive
       读出来的 —— 关掉它按钮就永远不变色。这个编辑器很小，开着无所谓。 */
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: labelledBy
        ? { class: 'note-prose', 'aria-labelledby': labelledBy }
        : { class: 'note-prose', 'aria-label': '详细内容' },
      /** 截图直接 Ctrl+V 粘进来 —— 这是手机上最顺的一条路 */
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files || []);
        const img = files.find((f) => f.type.startsWith('image/'));
        if (!img) return false;
        insertFile.current(img);
        return true;
      },
      /** 拖图进来同理 */
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        const img = files.find((f) => f.type.startsWith('image/'));
        if (!img) return false;
        event.preventDefault();
        insertFile.current(img);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => schedule(e),
    onBlur: () => flush(),
  });

  /* 关抽屉 / 切任务时把没来得及写回的那一段补上。
     ⚠️ 依赖数组必须是空 —— cleanup 只在卸载时跑一次。 */
  useEffect(() => () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
      onChangeRef.current(pending.current);
    }
  }, []);

  const insertImage = async (file: File) => {
    if (!editor) return;
    setError(null);
    setUploading(true);
    try {
      const url = await uploadImage(file);
      editor.chain().focus().setImage({ src: mediaHref(url), alt: '' }).run();
      schedule(editor);
    } catch (e) {
      setError(e instanceof Error ? e.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  };
  insertFile.current = (f) => { void insertImage(f); };

  const openLink = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    linkSel.current = { from, to };
    const href = (editor.getAttributes('link').href as string) || '';
    setLinkValue(href);
    setLinkOpen(true);
  };

  const applyLink = (remove = false) => {
    if (!editor) return;
    const sel = linkSel.current;
    let c = editor.chain().focus();
    if (sel) c = c.setTextSelection(sel);
    if (remove || !linkValue.trim()) c.unsetLink().run();
    else c.extendMarkRange('link').setLink({ href: normalizeUrl(linkValue) }).run();
    setLinkOpen(false);
    schedule(editor);
  };

  if (!editor) return null;

  return (
    <div className="note-edit">
      {/* 点图放大。编辑态下点一下是「选中图片」，所以只在图片上直接开预览 —— */}
      <div
        className="note-edit-surface"
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t && t.tagName === 'IMG') setPreview((t as HTMLImageElement).src);
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {linkOpen && (
        <div className="note-link-row">
          <input
            className="note-link-input"
            autoFocus
            inputMode="url"
            placeholder="粘贴或输入网址"
            value={linkValue}
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink(false); }
              if (e.key === 'Escape') { e.preventDefault(); setLinkOpen(false); }
            }}
          />
          <button type="button" className="note-link-ok" onClick={() => applyLink(false)}>确定</button>
          <button type="button" className="note-link-x" onClick={() => applyLink(true)} aria-label="移除链接">移除</button>
        </div>
      )}

      {error && <div className="note-err">{error}</div>}

      <NoteToolbar
        editor={editor}
        narrow={narrow}
        uploading={uploading}
        onPickImage={() => fileRef.current?.click()}
        onOpenLink={openLink}
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          /* 清空 value：不然选同一张图第二次不触发 change */
          e.target.value = '';
          if (f) void insertImage(f);
        }}
      />

      {preview && (
        <div className="note-lightbox" role="dialog" aria-label="查看图片" onClick={() => setPreview(null)}>
          <button type="button" className="note-lightbox-x" aria-label="关闭" onClick={() => setPreview(null)}>
            <X size={18} />
          </button>
          <img src={preview} alt="" />
        </div>
      )}
    </div>
  );
}
