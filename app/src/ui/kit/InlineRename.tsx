/**
 * InlineRename —— 行内改名
 */

import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Input } from './Input.tsx';
import { MiniIconBtn } from './IconBtn.tsx';

/**
 * 行内改名 —— 项目里**所有**改名都走它，形状固定一套：
 *
 *   平时    [ 显示内容 ][ 铅笔 ][ 删除 ]    ← 第二格可选，见 extraAction
 *   编辑中  [ 输入框   ][ √ ][ ✕ ]
 *
 * **切换编辑态时左边那段内容一像素都不动**，这是这个组件存在的全部理由。
 * 做到它靠两条硬约束：
 *
 *   1. 动作槽**固定宽度**（`w-[52px]` = 24 + 4 + 24，正好两格）。两态都是
 *      两个按钮 —— 平时「铅笔 + 删除」，编辑中「√ + ✕」—— 槽宽一样，左边
 *      可用宽度就不变，显示内容（常常是一段会截断的文字）不会重新折行。
 *      只给铅笔、不给 `extraAction` 时**也照样占满 52px**：槽的右边缘是
 *      一切对齐的基准，它不能随内容伸缩。
 *   2. 行高交给**外层**：本组件自己不定高，由调用方给一个固定高度的容器
 *      （日程集 header 是 `h-[40px]`，输入框 `h-[28px]`、按钮 24px）。
 *      两态都落在同一个高度上，下面的东西才不会被顶一下。
 *
 * `display` 由调用方给 —— 它常常不是纯文字，而是「一段文字 + 星标 + 徽标」
 * 这种**里面还带按钮**的东西。给 ReactNode 而不是 `renderText` 就是为了
 * 这个：组件不去猜显示态长什么样，只负责把那几格摆稳。
 *
 * **编辑态整个 `display` 被输入框换掉** —— 所以塞在里面的按钮（星标那类）
 * 天然只在平时出现。想「编辑时隐藏」的东西放进去就行，外面不用再判一次
 * `editing`（也就不需要在两处各维护一份状态）。
 *
 * 反过来有一条调用方必须守的：**`display` 里可以有按钮，但别把 `display`
 * 整个包进 `<button>`** —— 按钮套按钮是非法 HTML，浏览器会把里层那个甩到
 * 外面去，「编辑态换成 input」也会当场失效（input 进不了 button）。
 * 需要「点整行展开」的话，那个开关得放在本组件**外面**。
 *
 * 编辑态里显示的是真 `<input>`，不是 `<span contenteditable>`：后者没有
 * 输入法、没有撤销栈、没有平台的读屏支持。
 */
export function InlineRename({ value, onSave, disabled, display, label, placeholder, extraAction, inputProps, confirmProps }: {
  /** 已保存的值。存好了会跟着变（所以外部改名成功后显示内容也会更新） */
  value: string;
  /** 提交。**空串也照传** —— 校验与提示由调用方决定（不同场景的话不一样） */
  onSave: (next: string) => void;
  /** 没有权限改：铅笔按钮禁用，输入框也进不去 */
  disabled?: boolean;
  /** 平时那一格。默认就是 `value` 的纯文字。里面可以放按钮（星标那类），编辑态会连它一起换掉 */
  display?: ReactNode;
  /** 输入框的可访问名字 */
  label: string;
  placeholder?: string;
  /**
   * 平时那一格**右边**再挂一个按钮（日程集 header 的「删除」走这里）。
   * 它和铅笔一起占满那 52px，编辑态被 √ / ✕ 顶掉 —— 所以传进来的东西
   * **只在平时出现**，不用自己判编辑态。
   */
  extraAction?: ReactNode;
  /** 透给输入框（探针抓手 `data-cal-name` 之类走这里） */
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
  /** 透给确认按钮（探针抓手 `data-cal-save` 走这里） */
  confirmProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  /* 存好了（或外面改了名）就同步草稿，免得下次点铅笔看到的是上一轮的字。
     `editing` 不在里面：正在改的时候外部刷新列表不该把用户打的字冲掉。 */
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const cancel = () => { setDraft(value); setEditing(false); };
  const commit = () => {
    setEditing(false);
    // 一模一样就别白跑一趟接口（服务端会把它当成一次真改名，触发同步）
    if (draft === value) return;
    onSave(draft);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {editing ? (
        <Input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 点铅笔就是要立刻改字
          autoFocus
          {...inputProps}
          value={draft}
          aria-label={label}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          /* 字号**不在这里写**：`Input` 本身就是 13px，而显示态那一行也是
             13px —— 两态同一号字，点铅笔不会让同一行字跳一下。
             `px` 从 12 收到 8：28px 高的框里 py-2 已经吃掉 14px，横向再留 12
             会让可用宽度比非编辑态窄一截。 */
          className="h-[28px] min-w-0 flex-1 px-2"
        />
      ) : (
        /* 显示态的容器和编辑态的输入框**同一个 flex-1 槽**，所以宽度一致 ——
           调用方塞进来的按钮填满它就行，不用管自己是几格。 */
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {display ?? <span className="truncate">{value}</span>}
        </div>
      )}

      {/* 右对齐的固定宽槽：平时「铅笔 + extraAction」，编辑中 √+✕，
          右边那条边一动不动。确认钮走 `primary` **prop** 而不是叠 `className`
          —— 叠了不生效（同特异度看生成顺序），实测拿到的是和 ✕ 一样的
          `--text-3`。见 `MiniIconBtn` 的注释。 */}
      <span className="flex w-[52px] shrink-0 items-center justify-end gap-1">
        {editing ? (
          <>
            <MiniIconBtn
              {...confirmProps}
              primary
              label="确认"
              onClick={commit}
            >
              <Check size={14} />
            </MiniIconBtn>
            <MiniIconBtn label="取消" onClick={cancel}>
              <X size={14} />
            </MiniIconBtn>
          </>
        ) : (
          <>
            <MiniIconBtn label="改名" disabled={disabled} onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </MiniIconBtn>
            {extraAction}
          </>
        )}
      </span>
    </div>
  );
}
