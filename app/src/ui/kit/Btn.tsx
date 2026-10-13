/**
 * Btn.tsx —— 按钮组件
 */

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cx } from '../cx.ts';

/* 六种固定 variant，覆盖全应用所有按钮场景：
   primary  主操作（保存、确认、跳转）
   normal  普通操作（导航、切换、取消）
   ghost   极轻操作（关闭、清空）
   danger  危险操作（删除、退出）
   chip    标签式操作（筛选、选择）—— 未选中的那一档
   chipOn  **同一个胶囊的选中档**
   `chip` / `chipOn` 是一对，`Chips` 在这两档之间切。两者**边框都在**，
   选中只换颜色不换几何 —— 少一圈边框会让选中的那个缩 2px，一排胶囊
   点一下整体抖一下。
   **选中档不填充底色，只把描边和文字换成主色。** 原来填的是
   `bg-[var(--primary)]`，于是色板那一行的色点（它画的就是 `--primary`）
   整个消失在主色底上 —— 用户的原话是「颜色圆点完全看不见」。
   不填充之后色点在 `--panel` 上正常显色，选中态靠主色描边 + 主色文字，
   和 `normal` 是同一个形状（有描边、有底色面），只是换成主色。
   分成两档而不是给 chip 叠一层 className：Tailwind 里同特异度的工具类
   谁赢只看生成顺序，叠 className 会在某个值上静默失效，症状正是
   「切风格时这个按钮和别的不一致」。
   新增 variant 必须先在这里加，再在 语义样式模块 里加对应样式 —— 别在
   .tsx 里写死颜色，那等于把设计令牌绕过去。 */
export type Variant = 'primary' | 'normal' | 'ghost' | 'danger' | 'chip' | 'chipOn';

/* 变量名一律写 语义样式模块 里**真实存在**的那些，且**不给兜底值**。
   兜底值看着稳，其实是把「变量名写错了」变成静默降级：这里原先写的是
   --accent / --card / --line / --chip / --hover / --accent-soft 那一批，
   而 --accent / --accent-soft / --card / --chip / --hover / --line
   在 语义样式模块 里**一个都没有** —— 于是两套主题下全是写死的颜色，
   主按钮那个 #4f7cff 压白字只有 3.70:1，暗色也没跟着 --primary 走。
   没有兜底值时写错名字会当场看得见（声明失效→继承），不会悄悄糊过去。
   tests/contrast.mjs 末尾有一条扫描锁着这件事。
   变体集中进 cva（第 1 册 2.2）：variant/size 正交，改一处全部跟。 */
const btnVariants = cva(
  'btn inline-flex items-center justify-center gap-1.5 rounded-[var(--r-md)] font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-95 active:brightness-90',
        normal: 'border-[length:var(--border-w)] border-[var(--input)] bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)] hover:text-[var(--text)] hover:border-[var(--text-3)]',
        ghost: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)]',
        danger: 'border-[length:var(--border-w)] border-[var(--danger)] bg-transparent text-[var(--danger)] hover:bg-[var(--danger-soft)]',
        chip: 'border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel)] text-[var(--text-2)] hover:border-[var(--primary)] hover:text-[var(--primary)]',
        chipOn: 'border-[length:var(--border-w)] border-[var(--primary)] bg-[var(--panel)] font-medium text-[var(--primary)]',
      },
      size: {
        sm: 'h-[30px] px-2.5 text-[12.5px]',
        md: 'h-9 px-3.5 text-sm',
        lg: 'h-11 px-5 text-[15px]',
      },
    },
    defaultVariants: { variant: 'normal', size: 'md' },
  },
);

interface BtnProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof btnVariants> {}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { variant, size, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cx(btnVariants({ variant, size }), className)}
    />
  );
});
