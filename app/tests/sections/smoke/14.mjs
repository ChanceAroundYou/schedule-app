export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, createServer, listenFree, track, ports } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十二、AI：假模型提一条改动 → 确认 → 服务器上真有');
  let modelCalls = 0;
  const modelSrv = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      modelCalls++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

      // 上一轮的工具执行过 → 对话里会多出 role:'tool' 那条（实测：
      // 第一轮是 [system,user]，第二轮是 [system,user,assistant,tool]）
      let afterTool = false;
      try { afterTool = (JSON.parse(body).messages || []).some((m) => m.role === 'tool'); } catch (_) { /* 不是 JSON 就当第一轮 */ }

      if (!afterTool) {
        // 第一轮：调 create_task。arguments 分片发，模拟真模型的流式
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_ai_1', type: 'function', function: { name: 'create_task', arguments: '' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"title":"买菜","date":"2026-10-08","time":"14:00"}' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // 第二轮：文本收尾
        send({ choices: [{ delta: { content: '好的，我给你建了一条任务。' }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  ports.model = await listenFree(modelSrv, ports.model);   // 抢走了就用它给回来的那个号
  track({ kill: () => modelSrv.close() });

  // 把 AI 设置指向假模型（token 从浏览器里读，Node 侧没有 localStorage）
  const aiToken = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  const aiSet = await fetch(`http://127.0.0.1:${apiPort}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiToken },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${ports.model}/v1`, model: 'fake-model' }),
  });
  ok(aiSet.status === 200, 'AI 设置已指向假模型');

  // 切到 AI 页
  await evalJs(page, `document.querySelector('[data-nav="ai"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.ai-wrap')`, 'AI 面板渲染出来', 8000);

  // AI 面板的输入框也要有名字 —— a11y() 原来从没扫过 AI 面板，
  // .ai-input 只有 placeholder 的漏洞就是这么漏掉的
  const aiA11y = await evalJs(page, `return { bad: ${a11y('.ai-wrap')},
    cands: document.querySelectorAll('.ai-wrap input, .ai-wrap textarea').length };`);
  ok(aiA11y.cands >= 1, 'AI 面板有 ' + aiA11y.cands + ' 个输入框可查');
  ok(aiA11y.bad.length === 0, 'AI 面板每个控件都有名字'
    + (aiA11y.bad.length ? '：\n      ' + aiA11y.bad.join('\n      ') : ''));

  // 发一句话。`.ai-input` 是 <textarea>，setter 必须取 HTMLTextAreaElement
  // 那个原型上的 —— 拿 HTMLInputElement 的来 call 会当场 `Illegal invocation`

  // 填字 → **等发送键变可点** → 再派发回车，不合成一步。
  // 发送键的 disabled 绑在 `!text.trim()` 上（见 AiPanel 的 .ai-compose），
  // 它一变可点就说明 React 确实吃到了这段文字。少了这一步，万一文字没进去，
  // 症状会显示成「等不到提案卡片」—— 指向完全错的地方。
  // （顺带验过：input 派发后**同一个任务内**按钮就已经可点，React 对离散事件
  // 是同步 flush 的，这里不是抢在重渲染之前。）
  await evalJs(page, `
    const inp = document.querySelector('.ai-input');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(inp, '帮我建一条买菜的任务');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await waitFor(page, `(() => { const b = document.querySelector('.ai-compose button'); return !!b && !b.disabled && b.textContent.includes('发送'); })()`, '发送键变可点', 8000);
  await evalJs(page, `
    const inp = document.querySelector('.ai-input');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);

  // **分两段等**：先等提问进了气泡（证明确实发出去了），再等提案卡片。
  // 合成一个条件的话，超时时分不清「回车没接上」和「往返慢」——
  // 同第「十」节那两段等（见 docs/测试.md）。
  // 15 秒不动：实测这一段往返只要 ~900ms（气泡 ~5ms），留着的余量已经两个数量级；
  // 真卡住时该红就红，别用更大的超时把它盖住。
  await waitFor(page, `!!document.querySelector('.ai-msg.user')`, '提问进了气泡', 8000);
  await waitFor(page, `!!document.querySelector('.ai-prop')`, '提案卡片出现', 15000);
  const propText = await evalJs(page, `return document.querySelector('.ai-prop-text').innerText;`);
  ok(propText.includes('买菜'), '卡片上写着「买菜」，实际 ' + JSON.stringify(propText));
  ok(propText.includes('新建'), '措辞是「新建」而不是「已建好」，实际 ' + JSON.stringify(propText));

  // 确认之前服务器上不能有这条任务。
  // `snapshot.tasks` 是**按 id 索引的对象**（见 server/lib/sync.js 的 snapshot），
  // 不是数组 —— 写 `.some(...)` 会当场 TypeError
  const syncNow = () => fetch(`http://127.0.0.1:${apiPort}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiToken },
    body: JSON.stringify({ cursor: 0 }),
  }).then((r) => r.json());

  const snapBefore = await syncNow();
  const findBuy = (s) => Object.values(s.snapshot?.tasks || {}).find((t) => t.title === '买菜');
  ok(!findBuy(snapBefore), '确认之前服务器上没有「买菜」');

  // 点确认
  await clickEl(page, `document.querySelector('.ai-prop button')`);
  await waitFor(page, `document.querySelector('.ai-prop') ? null : 1`, '确认后卡片消失', 8000);

  const made = findBuy(await syncNow());
  ok(!!made, '确认之后服务器上真有「买菜」这条任务');
  // `_dev` 是这一节真正要证的东西：这条不是别的路径写进去的，是 AI 那条路写的
  // （deviceId 固定 'ai'，见 server/lib/ai/confirm.js 的文件头）
  ok(made && made._dev?.title === 'ai', '它的写入设备是 ai（不是碰巧被别的路径建的）'
    + (made ? '，实际 ' + JSON.stringify(made._dev) : ''));
  ok(made && made.date === '2026-10-08' && made.time === '14:00',
    '日期和时间跟卡片上写的一致' + (made ? '，实际 ' + JSON.stringify([made.date, made.time]) : ''));

  collect();
  ok(errors.length === 0, 'AI 这一段没有 console 报错' + (errors.length ? '：\n      ' + fmt(errors) : ''));


}
