/**
 * contentDispatch.ts —— 内容分发：根据 nav 选择视图
 */

import type { LocalState, PublicUser } from '../domain/types.ts';
import { SettingsView } from '../ui/Settings.tsx';
import { InboxView, TodayView, OverdueView, DoneView } from '../views/Lists.tsx';
import { HabitsView } from '../views/Habits.tsx';
import { TrashView } from '../views/Trash.tsx';
import { ProjectsView } from '../views/Projects.tsx';
import { AiPanel } from '../ui/AiPanel.tsx';
import { CalendarView } from '../views/Calendar.tsx';
import { CounterView } from '../views/Counter.tsx';
import { Empty } from '../views/parts.tsx';

/**
 * 内容分发：根据 nav 选择视图。
 *
 * 设置**放在日程集那道门禁之前**。它里面有「清空本机副本」和账户卡，
 * 而「一个集都没拿到」正是最需要点这两个的时候 —— 塞进 else 里就成了
 * 一个修不了东西的死角。传全量 state：cals / invites / outbox 都是跨集的。
 */
function contentDispatch(state: LocalState, scoped: LocalState, user: PublicUser | null, theme: 'light' | 'dark', callbacks: {
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onInvites: () => void;
  onAiConfirmed: () => void;
}): React.ReactNode {
  const {
    onExport, onImport, onLogout, onInvites, onAiConfirmed,
  } = callbacks;

  if (state.ui.nav === 'settings') {
    return (
      <SettingsView
        state={state}
        user={user}
        theme={theme}
        onExport={onExport}
        onImport={onImport}
        onLogout={onLogout}
        onInvites={onInvites}
      />
    );
  }
  /* 计数器**不属于任何日程集**（counters 表按 user_id），所以必须放在下面那道
     「一个集都没拿到」的门禁之前 —— 否则断网首启时看不见自己的数字。 */
  if (state.ui.nav === 'counter') return <CounterView />;

  if (!state.cals.length) {
    // 一个集都没有 = 还没跟服务器对上（首次离线启动）。服务器保证每个账号
    // 至少有一个集，所以这不是「空账号」而是「没同步到」，别在这里引导建集
    return (
      <Empty text="还没拿到你的日程集" sub="正在连接服务器，稍等一下；断网时本地内容照常显示" />
    );
  }

  switch (state.ui.nav) {
    // 跨集：清单不按集分家
    case 'inbox': return <InboxView state={state} />;
    case 'today': return <TodayView state={state} />;
    case 'overdue': return <OverdueView state={state} />;
    case 'trash': return <TrashView state={state} />;
    // 按集：这几页只画当前选中的那个集
    case 'done': return <DoneView state={scoped} />;
    // 按集：跟日程 / 打卡 / 已完成一样，看的是当前选中的那个集。
    // 新建 / 编辑 / 改「下一步」都走 data-act 委托（见 clickDispatch.ts），
    // 这里不再收回调 —— 行会被拖拽换掉，挂在行上的 handler 会跟着丢。
    case 'projects':
      return <ProjectsView state={scoped} />;
    case 'habits':
      return <HabitsView state={scoped} />;
    // AI 是跨集的，跟今天 / 逾期 / 待办箱一组：问的是「我这周排得怎么样」，
    // 按集切开的话它只看得见当前那个集，答出来的「空」是假的空。
    // 它自己按 `sync.snapshot(userId)` 读，权限仍然是服务器那一关说了算。
    //
    // onConfirmed 是「用户点了确认」之后要做的：把 AI 写进来的 op 拉回来。
    // 不传的话卡片照样能点，只是界面要等下一次轮询才看见新任务。
    case 'ai': return <AiPanel state={state} onConfirmed={onAiConfirmed} />;
    default: return <CalendarView state={scoped} />;
  }
}

export { contentDispatch };
