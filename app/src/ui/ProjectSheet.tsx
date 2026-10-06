/**
 * ProjectSheet.tsx —— 新建 / 编辑项目
 *
 * 放在 `ui/` 而不是 `views/` —— 与 Settings.tsx 同一个理由（见那个文件头）：
 * 它是普通表单，不是「会被拖拽重排换掉节点」的行。
 *
 * 这里**故意只放项目自己的字段**。「下一步」在泳道头上直接改（那是面板上
 * 最常用的一个动作，进浮层改等于白走一趟）；进度留一个空框表示「按任务自动算」，
 * 填了就是手改覆盖 —— 空 vs 0 是两回事，所以用 `''` 而不是 0 表达「自动」。
 */
import { useId, useState } from 'react';
import { Btn, Sheet, useConfirm } from './kit.tsx';
import * as store from '../data/store.ts';
import { STATUS_LABEL } from '../domain/model.ts';
import type { LocalState, ProjectStatus } from '../domain/types.ts';

const STATUSES: ProjectStatus[] = ['active', 'waiting', 'paused', 'done'];

export function ProjectSheet({ state, id, onClose }: {
  state: LocalState;
  /** `null` = 新建；有值 = 编辑那个项目。外层用 `open` 控制是否渲染 */
  id: string | null;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const fid = useId();
  const cur = id ? state.projects[id] : null;

  const [name, setName] = useState(cur ? cur.name : '');
  const [status, setStatus] = useState<ProjectStatus>(cur ? cur.status : 'active');
  const [note, setNote] = useState(cur ? cur.note : '');
  // '' = 自动（按关联任务算）；数字串 = 手改覆盖
  const [prog, setProg] = useState(cur && cur.progress !== null ? String(cur.progress) : '');

  /** 权限被挡时 store 那边已经计了数、App 会弹提示 —— 这里只管关掉浮层 */
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;   // 名字是唯一的必填项，空着就不提交，别造一个「未命名项目」
    const progress = prog.trim() === '' ? null : Math.max(0, Math.min(100, Number(prog) || 0));
    if (cur) store.patchProject(cur.id, { name: trimmed, status, note, progress });
    else store.addProject(trimmed);
    onClose();
  };

  const remove = async () => {
    if (!cur) return;
    const n = Object.values(state.tasks).filter((t) => t.projectId === cur.id).length;
    const ok = await confirm({
      title: `删除「${cur.name}」？`,
      // 连带后果必须写出来 —— 用户真正想知道的是「我的任务会不会一起没」
      body: n
        ? `项目本身会进垃圾箱。挂在它上面的 ${n} 条任务**不会被删**，只是不再属于任何项目。`
        : '项目会进垃圾箱，可以还原。它上面还没有任务。',
      confirmText: '删除项目', danger: true,
    });
    if (!ok) return;
    store.deleteProject(cur.id);
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title={cur ? '编辑项目' : '新建项目'}>
      <div className="flex flex-col gap-3">
        <div className="field">
          <label htmlFor={fid + '-n'}>名字</label>
          <input
            id={fid + '-n'} value={name} autoFocus
            placeholder="比如：星星包"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={fid + '-s'}>状态</label>
          <select id={fid + '-s'} value={status}
            onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor={fid + '-p'}>进度</label>
          <input
            id={fid + '-p'} type="number" min={0} max={100} value={prog}
            placeholder="留空 = 按关联的任务自动算"
            onChange={(e) => setProg(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={fid + '-t'}>备注</label>
          <textarea id={fid + '-t'} rows={4} value={note}
            placeholder="想得起来的都写这儿…"
            onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="drawer-foot">
          {cur && <Btn variant="danger" onClick={() => void remove()}>删除项目</Btn>}
          <Btn variant="primary" onClick={save} disabled={!name.trim()}>
            {cur ? '保存' : '创建'}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}
