/**
 * SearchInput.tsx —— 顶栏搜索框（桌面常驻 / 移动端张开后共用）
 *
 * 从 `Topbar.tsx` 拆出来。搜索框自己有一组状态（`kw` + 防抖回调）和一段
 * 「三处同一个放大镜」的样式约定 —— 那段注释比代码长，而且跟顶栏的
 * 标题 / 状态点没有关系。
 *
 * **桌面端和移动端张开后是同一个东西**，不是「长得像」：同一个组件、同一套样式。
 * 放大镜 16px 也是**三处同一个尺寸**（桌面端 / 移动端收起时那个钮 / 移动端张开后
 * 框里这枚）—— 用户 2026-10-09：「请使用完全一致的放大镜图片，桌面端 移动端收起
 * 移动端打开一致」。这里原先写的是 14，和收起时那枚 16 对不上。
 * 移动端收起时那枚放大镜**就是这里这枚**：窄屏的 `.search-slot .search-box` 收成
 * 28px 宽、描边和底色全透明，露出来的正好是它 —— 所以「三处」其实是同一枚，
 * 尺寸和位置不可能对不上。
 */

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useDebounced } from '../hooks.ts';
import { Input } from '../kit.tsx';

/** 搜索输入框的共享逻辑：本地状态 + 防抖回调 */
export function useSearchValue(initial: string, onSearch: (kw: string) => void) {
  const [kw, setKw] = useState(initial);
  const debounced = useDebounced(kw, 180);
  useEffect(() => { onSearch(debounced); }, [debounced, onSearch]);
  return [kw, setKw] as const;
}

export function SearchInput({ kw, setKw, autoFocus }: {
  kw: string; setKw: (v: string) => void; autoFocus?: boolean;
}) {
  return (
    <div className="search-box">
      <span className="search-ico"><Search size={16} /></span>
      <Input
        type="text"
        value={kw}
        placeholder="搜索…"
        aria-label="搜索任务"
        autoFocus={autoFocus}
        onChange={(e) => setKw(e.target.value)}
      />
      {!!kw && (
        <button className="clear-search" title="清空" aria-label="清空" onClick={() => setKw('')}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}
