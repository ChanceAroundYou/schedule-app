/**
 * navLabel.ts —— 导航标签（删除提示里要点名是从哪儿删的）
 */

function navLabel(nav: string): string {
  const m: Record<string, string> = {
    inbox: '待办箱', today: '今天', overdue: '逾期',
    calendar: '日程', habits: '打卡', done: '已完成', trash: '垃圾箱', ai: 'AI',
  };
  return m[nav] || '任务列表';
}

export { navLabel };
