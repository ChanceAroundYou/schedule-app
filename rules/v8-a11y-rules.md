# 编码规范第 8 册 · 交互与无障碍

> 状态：**长期规则**（实施另见 `v8-a11y-plan.md`）
> 依据：`docs/界面约定-无障碍.md`、`CLAUDE.md` 三、界面硬规则、
> `ui/hooks/overlay.ts`（useOutsideClose/useEscape/useFocusTrap）、
> `ui/hooks/modalFocus.ts`、`app/tests/browser-smoke.mjs`（`a11y()`/`nameOf()`）
> 不变量：本册只定交互与无障碍规矩，不动视觉（视觉归第 1 册）。

---

## 1. 现状审计（实测）

- 三 hook 已收敛：`useOutsideClose`（mousedown capture + trigger 豁免 + `[data-sheet-root]` 嵌套判）、
  `useEscape`（capture 截断，不连带关抽屉）、`useFocusTrap`（圈 Tab，不过滤不可见即卡死）。
  `useModalFocus` 只管焦点进出、不管 Esc（三个浮层 Esc 故意不同，见文件头）。
- 浮层四件套齐：`role="dialog"` + `aria-modal` + 名字、`useFocusTrap`、开时焦点进**面板本身**
  （不进输入框，不弹软键盘）、关时 `prevFocus` 还回（先 contains 再记）。
- 探针锁：`a11y()` 扫全文档（`span.check-btn` 即报）、`nameOf()` 不接受 placeholder；
  打卡页输入框曾因只扫待办箱/抽屉/浮层而漏网，现已补 `.habit-add` 断言。
- 键盘：只有时间轴两把手 `↑/↓` 一档 15 分钟（用户裁决"不做全套"），算法与鼠标拖拽共用 `nudgeEdge()`。
- 说明文字三条（2026-10-07）：默认不写、写就一句、不把人当傻子（`Clock.tsx` 表盘下那行已删为先例）。
- 断网说话：`useOnline()` 驱动 `CloudOff` + title，离线优先于加载圈；只读挡下弹提示并**点名集**（`deniedCals`）。

---

## 2. 规矩

### A1 每个控件有可访问名字，placeholder 不算

四种写法按场合挑（见无障碍文档表）：`<label htmlFor>`（有可见标签）/
`aria-label`（无可见标签的组）/ `<IconBtn label>`（纯图标）/ 可见文字即名字（有文字按钮）。
`placeholder` 只给格式示例，不当名字——探针 `nameOf()` 已锁，别加回去。

### A2 勾选圈只走 `<CheckBtn>`

全应用唯一实现（`views/parts`）。装饰性指示不用 `span.check-btn`
（探针见即报，盖住真问题）——用 lucide `Check` 图标或另起名。
命中区 ≥24×24 靠 `::before` 撑（视觉不变）；探针读到 23 是取整细节，不是 bug。

### A3 浮层四件套 + Esc 语义分离

- 盖整页的浮层四件套缺一不可：`role="dialog"+aria-modal+名字` / `useFocusTrap` /
  开时焦点进面板本身（`tabIndex={-1}+panel.focus()`）/ 关时还回原处。
- 遮罩 `aria-hidden`（纯鼠标目标）；焦点环关在 `responsive.css` 最末（Tailwind `outline-none` 压不住）。
- Esc **不统一**：Drawer 自挂、MoreSheet 交上层排顺序（more→search→jump→drawer）、Sheet 自挂带 `dismissable`；
  popover（DatePicker/TimePicker）用 `useEscape` capture 截断，不连带关抽屉。
- 嵌套浮层判据是"在**别的**浮层里"（`[data-sheet-root]` 比对），不是"在本面板外"；
  portal 出去的里层会被外层 `useOutsideClose` 误判，见踩坑 48。

### A4 状态语义三属性不混用

- `aria-current="page"` = 现在在哪页（侧栏 nav、底部 tab）。
- `aria-expanded`（+`aria-controls`）= 真折叠开关（今天已完成、日程集箭头）。
  日程集名字区不是按钮（内有星标 button，套嵌非法），展开只认最右箭头。
- `aria-haspopup="dialog"` = 按下弹浮层但开关状态在 App 层。
- 星标用 `aria-pressed` 不用 `disabled`（开关不是"不能点"，退出 Tab 顺序即丢信息）。

### A5 键盘一档微调，不做全套

- 仅时间轴两把手：`tabIndex={0}` + `aria-label`，`↑/↓` 一档 15 分钟，方向跟时间轴走（下=+1）。
  其余 `data-act` 全是真 `<button>`，Tab 即达，不补键位（用户裁决）。
- 焦点在把手上时只截方向键，`1/2/3` 切视图、`d/t` 跳页不受影响。

### A6 动效全站关，同步圈例外

- `responsive.css` 最末 `@media (prefers-reduced-motion: reduce)`：通配 `*` + `!important`
  压到 `.01ms`、`scroll-behavior` 复位——不挑"大动作"（漏一处等于没关）。
- 唯一例外 `.animate-spin`（正在同步的信号，停下传反话）。`!important` 必须压过内联 style 与 Tailwind 层。

### A7 说明文字三条 + 界面说话义务

- 默认不写；写就一句；不把人当傻子（不替用户下结论、不解释显而易见、不枚举没有的功能）。
- 该写：危险后果（删了找不回来）、反直觉行为（导入是合并）、不可逆（忘密码无法找回）。
- 断网必说话（`useOnline()`，离线优先于加载圈）；只读挡下必点名集（`deniedCals`）；
  界面不提"管理员"、无密码找回/邮箱/第三方登录、不回潮备忘录/清单/笔记本。

---

## 3. 判据

1. 探针 `a11y()` 全文档 0 报错；`nameOf()` 覆盖新增输入框（新输入框必配断言）。
2. 新增浮层四件套齐（review  checklist 一条）；Esc 归属在文件头注明（自挂/上层/截断三选一）。
3. `prefers-reduced-motion` 段仍在 `responsive.css` 最末（`rg` 定位抽查）。
4. 说明文字新增需过三条（一句话、非显而易见、非枚举缺失）。

---

