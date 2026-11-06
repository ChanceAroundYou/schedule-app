/**
 * probe-cal.mjs —— 真机探针专用的「一次性日程集」
 *
 * ## 为什么要有这个文件（2026-11-06 用户报障）
 *
 * 真机探针要在月视图里造一批超容量任务才能验「+N 溢出」。以前它直接用
 * **手机上登录着的那个账号的第一个集**（`me.cals[0]`）—— 而那正是用户
 * 自己每天在用的日程集。于是测试一失败，`e2e溢出探针-0…7` 就永远留在
 * 他的日历里（11 月 7 日那批重复任务就是这么来的：删除只写在成功路径的
 * 最后一步，中途任何一条断言红了它就跑不到）。
 *
 * 现在改成两件事，缺一不可：
 *   1. **造数据落在一个专用集里**，用户那个集一条都不碰；
 *   2. **收尾删掉整个集**（不是逐条删任务）—— 一次调用，跟成功失败无关，
 *      删集等于这个集对所有端一起消失，比「记得把每条都删干净」可靠得多。
 *
 * 开局还会先把**上一次残留的同名集**删掉：测试被硬杀（进程被中断）时
 * finally 也跑不到，不清理的话同名集会越攒越多。
 *
 * ⚠️ 这个集挂在那个登录账号名下、跑起来会短暂出现在「日程集」列表里 ——
 * 真机 App 登录的是谁我们就只能借谁的登录态写数据（换账号登录会把用户
 * 自己的票顶掉）。相比「往他每天用的那个集里写脏数据」，这是代价最小的那一种。
 */

export const PROBE_CAL_NAME = 'e2e探针专用';

/** 删掉同名残留集（有几个删几个）。返回删掉的个数 */
export async function dropStaleProbeCals({ apiMe, apiCall }) {
  const me = await apiMe();
  if (!me) return 0;
  const stale = (me.cals || []).filter((c) => c.name === PROBE_CAL_NAME && c.role === 'owner');
  for (const c of stale) await apiCall('DELETE', `/api/cals/${c.id}`);
  return stale.length;
}

/**
 * 建一个探针专用集，并把它**勾成显示**（不勾的话日程页看不见它，
 * 探针就测不到自己造的那批任务）。
 *
 * 勾选走真实用户那条路：更多抽屉 → 「日程集」→ 那一行。不直接改
 * localStorage 的 `ui.cals` —— 那份是启动时读进内存的，改了内存里还是旧的。
 */
export async function ensureProbeCal({ apiMe, apiCall, evalIn, tap, wait, pullSync, ok, bad }) {
  const stale = await dropStaleProbeCals({ apiMe, apiCall });
  if (stale) ok(`开局清掉上一次残留的探针集 ${stale} 个`);

  const r = await apiCall('POST', '/api/cals', { name: PROBE_CAL_NAME });
  const calId = r.body?.cal?.id;
  if (r.status !== 200 || !calId) {
    bad('能建探针专用日程集', JSON.stringify(r.body || r));
    return null;
  }
  ok('探针数据专用集已建好（用户自己那个集一条都不写）', calId);

  /* 服务端刚建的集要等一轮同步才会出现在 App 的集列表里（轮询 / focus 触发），
     不先拉一次的话下面那一行根本不存在。
     ⚠️ 查的是 `state.cals`（**有没有这个集**），不是 `ui.cals`（勾没勾）——
     第一次跑就是查错了那份：集已经同步进来了、只是没勾，于是下面照着
     一个还不存在的行去点，红成「多选里找不到那一行」。 */
  const hasCal = async () => evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
    return (s.cals||[]).some(function(c){return c.id===${JSON.stringify(calId)}});
  })()`);
  if (!await hasCal()) {
    /* 还不进来就轮着多拉几轮（每轮就是一次 focus → syncNow，页面事件触发，
       **不用 Page.reload** —— reload 会换掉执行上下文、把这条裸 WS 甩断。
       上一轮跑红就是栽在这里：查错了状态 + 只拉一轮，那一行根本不存在。 */
    for (let i = 0; i < 5 && !(await hasCal()); i++) await pullSync(2500);
  }
  if (!await hasCal()) {
    bad('刚建的探针专用集能同步进 App（连拉五轮仍然没有它）', calId);
    return null;
  }

  const shown = await evalIn(`(function(){var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;return (s.ui&&s.ui.cals)||[]})()`);
  if (Array.isArray(shown) && shown.includes(calId)) return calId;

  const more = await evalIn(`(function(){
    var el=Array.from(document.querySelectorAll('.tab, [data-nav]')).find(function(x){return (x.textContent||'').trim()==='更多'});
    if(!el) return 'no-more';
    var b=el.getBoundingClientRect();var x=b.x+b.width/2,y=b.y+b.height/2;
    var t=document.elementFromPoint(x,y);if(!t) return 'no-pt';
    var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
    t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));t.dispatchEvent(new MouseEvent('click',o));
    return 'clicked';
  })()`);
  if (more === 'clicked') {
    await wait(700);
    await tap('[data-cal-sheet-open]');
    /* 等的是**那个多选面板本身**，不是固定 700ms：Sheet 有开启动画，
       动画没落地就去点行，行还不存在。 */
    for (let i = 0; i < 8; i++) {
      const ready = await evalIn(`(function(){
        var d=document.querySelector('[role="dialog"]');
        return d && d.querySelector('[data-cal-row]') ? 1 : 0;
      })()`);
      if (ready) break;
      await wait(400);
    }
  }
  const row = await tap(`[data-cal-row="${calId}"]`);
  if (row === 'no-sel') {
    bad('能把探针集勾成显示（日程集多选里找不到那一行）',
      calId + ' / 抽屉=' + more + ' / 界面上有的行=' + JSON.stringify(await evalIn(
        `(function(){return Array.from(document.querySelectorAll('[data-cal-row]')).map(function(b){return b.dataset.calRow})})()`)));
    return null;
  }
  /* 勾完要**确认真的勾上了** —— 只点一下不核对，后面所有断言都会
     以「那天没有任务」的形式红，而根因是这一步。 */
  let picked = false;
  for (let i = 0; i < 6 && !picked; i++) {
    picked = !!(await evalIn(`(function(){
      var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
      return (s.ui&&s.ui.cals||[]).indexOf(${JSON.stringify(calId)})>=0;
    })()`));
    if (!picked) await wait(500);
  }
  if (!picked) { bad('勾上探针集后 ui.cals 真的有它', calId); return null; }
  ok('探针集已勾成显示（日程页能看见造的数据）');
  /* 关掉多选弹窗，别让它一直盖着界面（后面还要点视图切换）。
     更多抽屉也顺手收掉 —— 它俩是叠着的。 */
  await tap('[role="dialog"] [aria-label="关闭"]').catch(() => {});
  await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`).catch(() => {});
  await wait(400);
  return calId;
}

/** 收尾：删掉整个集。放在 finally 里，成功失败都执行 */
export async function dropProbeCal({ apiCall }, calId) {
  if (!calId) return;
  const r = await apiCall('DELETE', `/api/cals/${calId}`);
  if (r.status === 200) console.log('       收尾：探针专用集已删除（所有端一起消失）');
  else console.log('       ⚠️ 收尾：探针专用集没删掉（status ' + r.status + '），下次开局会清');
}
