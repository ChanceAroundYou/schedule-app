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
import { useEffect, useId, useState } from 'react';
import { Btn, Chips, Input, Sheet, SheetPicker, Textarea, toast, useConfirm } from './kit.tsx';
import * as store from '../data/store.ts';
import { STATUS_LABEL, roleOf } from '../domain/model.ts';
import { canWrite } from '../domain/types.ts';
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

  /*
   * 项目落在哪个集 —— **不绑当前集**。
   *
   * 原先是 `makeProject(name, ui.cal)`：当前集是只读的时候，commitMany 会被
   * canWrite 挡下、**静默丢弃**，用户看到的是「点完创建浮层关了、项目没出现」。
   * 所以这里给一个选择器，让用户自己挑一个**能写**的集。
   *
   * 只列「能写 ∩ 正勾着」的：项目按集可见（useScopedState 按 p.calId 过滤），
   * 落在一个没勾的集里等于凭空消失 —— 跟 store.toggleCal 那条「归属不能没有
   * 显示的地方」是同一件事。
   */
  const writableShown = state.cals.filter(
    (c) => canWrite(c.role) && state.ui.cals.includes(c.id),
  );
  // 只有新建用得上它（编辑时选择器不渲染），默认当前集 —— 当前集能写就用当前集
  const [calId, setCalId] = useState<string>(
    () => (canWrite(roleOf(state, state.ui.cal)) ? state.ui.cal || ''
      : writableShown[0]?.id || ''),
  );

  /*
   * 一个能写的集都没有时，上面那个选择器是空的、创建按钮也是禁用的 ——
   * 而**禁用的按钮本身不解释任何事**，用户只看到「点不动」，不知道该去哪儿。
   * 这里补一句。
   *
   * 依赖写 `[cur, writableShown.length]` 两个原始值：`writableShown` 每次渲染
   * 都是新数组，拿它当依赖会每渲染弹一次。编辑模式不弹（那时没这个限制）。
   */
  useEffect(() => {
    if (cur || writableShown.length) return;
    toast('勾着的日程集都没有写权限，勾一个你能写的才能建项目。');
  }, [cur, writableShown.length]);

  /** 权限被挡时 store 那边已经计了数、App 会弹提示 —— 这里只管关掉浮层 */
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;   // 名字是唯一的必填项，空着就不提交，别造一个「未命名项目」
    const progress = prog.trim() === '' ? null : Math.max(0, Math.min(100, Number(prog) || 0));
    if (cur) store.patchProject(cur.id, { name: trimmed, status, note, progress });
    else if (calId) store.addProject(trimmed, calId);
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
          <Input
            id={fid + '-n'} value={name} autoFocus
            placeholder="比如：星星包"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* 只在新建时出现。编辑项目时藏掉 —— 不是忘了给，是**故意不给**：
            挪集在数据模型里是「目标集新建一条 + 源集留墓碑」（不变量 2），
            改不了 calId 这个字段；而一个「选中看着变了、存下去没变」的死控件
            比没有更坏（用户会以为挪成功了）。挪集是另一条专门的操作。 */}
        {!cur && (
          <div className="field">
            <label id={fid + '-c-l'}>日程集</label>
            <SheetPicker
              value={calId}
              options={writableShown.map((c) => ({ value: c.id, label: c.name }))}
              onPick={setCalId}
              label="日程集"
              labelledBy={fid + '-c-l'}
            />
          </div>
        )}

        <div className="field">
          <label id={fid + '-s-l'}>状态</label>
          <Chips<ProjectStatus>
            value={status}
            options={STATUSES}
            onPick={setStatus}
            labelOf={(s) => STATUS_LABEL[s]}
            label="状态"
          />
        </div>

        <div className="field">
          <label htmlFor={fid + '-p'}>进度</label>
          <Input
            id={fid + '-p'} type="number" min={0} max={100} value={prog}
            placeholder="留空 = 按关联的任务自动算"
            onChange={(e) => setProg(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={fid + '-t'}>备注</label>
          <Textarea id={fid + '-t'} rows={4} value={note}
            placeholder="想得起来的都写这儿…"
            onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="drawer-foot">
          {cur && <Btn variant="danger" onClick={() => void remove()}>删除项目</Btn>}
          <Btn variant="primary" onClick={save} disabled={!name.trim() || (!cur && !calId)}>
            {cur ? '保存' : '创建'}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}
