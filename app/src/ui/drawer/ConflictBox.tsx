/**
 * ConflictBox.tsx —— 字段冲突提示
 */

import { History } from 'lucide-react';
import type { FieldConflict } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { plain } from '../../domain/model/richText.ts';

/** 冲突提示里那个字段叫什么。没列到的（将来加的）就直接显示字段名，不猜。 */
const FIELD_NAME: Record<string, string> = {
  title: '标题', note: '详细内容', date: '日期', time: '时间',
  duration: '时长', done: '完成状态', repeat: '重复',
};

/** 把值写成一句人话。null 在日期 / 时间 / 详细内容上是「清空」，得说出来 */
function showVal(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  if (field === 'date') return D.fmtMD(String(v));
  if (field === 'duration') return D.fmtDuration(Number(v));
  if (field === 'done') return v ? '已完成' : '未完成';
  /* 详细内容是富文本，这一行是给人读的 —— 标签得剥掉，
     否则会显示成「<p>开会</p>」，而且很容易把这一条挤成三行 */
  if (field === 'note') return plain(String(v));
  if (field === 'repeat' || field === 'time') return typeof v === 'string' ? v : JSON.stringify(v);
  return String(v);
}

/**
 * 「另一台设备也改过这里」。
 *
 * LWW 已经判完了，数据本身是一致的 —— 这一条**不是**要用户裁决什么，
 * 只是把静默合并的那一下说出来：不说的话，用户看到的是「我刚打的字变回
 * 旧的了」，他不知道为什么，只会以为程序坏了（跟权限那一条同一个道理）。
 *
 * 显示的是**输的那一方**的值 —— 赢的那一方的值就在上面那几个输入框里，
 * 再说一遍等于没说。
 */
export function ConflictBox({ list, onDismiss }: {
  list: FieldConflict[];
  onDismiss: (field: string) => void;
}) {
  if (!list.length) return null;
  return (
    <div className="conflict-box">
      <div className="cb-head"><History size={12} /> 另一台设备也改过这个任务</div>
      {list.map((c) => (
        <div className="cb-row" key={c.field}>
          <span className="cb-text">
            {c.winner === 'theirs'
              ? <>「{FIELD_NAME[c.field] || c.field}」以那边为准：{showVal(c.field, c.theirs)}（你改的「{showVal(c.field, c.mine)}」被盖住了）</>
              : <>「{FIELD_NAME[c.field] || c.field}」以你这版为准：那边是 {showVal(c.field, c.theirs)}</>}
          </span>
          <button className="cb-x" onClick={() => onDismiss(c.field)}>知道了</button>
        </div>
      ))}
    </div>
  );
}
