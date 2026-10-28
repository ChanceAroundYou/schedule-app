/**
 * display-switch.mjs —— 走到设置页「显示」那一排、点某一排芯片（on / off / sm / md / lg）
 *
 * 为什么单独一个文件：这一段动作有两个消费方 —— `card-geometry` 第九节（换任务卡字号、
 * 关三排开关）和 `browser-cards` 第四节（关「重复标记」看逾期行跟不跟着动）。
 * 它俩都不是被测行为本身，是**到达被测行为的那条路**；留在探针里就是两份会各自漂移的拷贝
 * —— 尤其「同一页三排开关都叫 on / off」那条坑（见 pickChip），不该各踩一遍。
 *
 * 边界：这里只管**导航与点击**，不做断言（断言留在各探针里）。
 */

/**
 * 进设置页。窄屏侧栏整个不渲染（Shell.tsx 的 narrow 分支），而 settings 恒不在
 * ui.tabs 里（CUSTOMIZABLE 排掉了它）→ 窄屏唯一的入口是底栏「更多」抽屉里那格。
 * 宽屏反过来在侧栏 footer。三条入口都试，别按当前屏猜：探针自己定视口，
 * 入口写死成一条的话，换视口跑就红在「等不到设置页」这种跟被测行为毫无关系的地方
 * （card-geometry 第九节上一版就栽在窄屏这一半）。
 */
async function openSettings({ page, evalJs, waitFor }) {
  const where = await evalJs(page, `
    const s = document.querySelector('.sidebar [data-nav="settings"]');
    if (s) { s.click(); return 'sidebar'; }
    const inSheet = document.querySelector('.more-sheet [data-nav="settings"]');
    if (inSheet) { inSheet.click(); return 'more-sheet'; }
    const more = [...document.querySelectorAll('.tabbar .tab')].find((b) => /更多/.test(b.textContent));
    if (more) { more.click(); return 'tabbar'; }
    return null;
  `);
  if (where === 'tabbar') {
    await waitFor(page, `!!document.querySelector('.more-sheet [data-nav="settings"]')`, '「更多」抽屉里的「设置」那格');
    await evalJs(page, `document.querySelector('.more-sheet [data-nav="settings"]').click(); return true;`);
  } else if (where === null) {
    throw new Error('进不去设置页：侧栏、底栏「更多」抽屉里都没有「设置」入口');
  }
  return where;
}

async function openDisplayTab({ page, evalJs, waitFor }) {
  await openSettings({ page, evalJs, waitFor });
  await waitFor(page, `!!document.querySelector('[data-settings-tab="display"]')`, '设置页的「显示」那一排 tab');
  await evalJs(page, `document.querySelector('[data-settings-tab="display"]').click(); return true;`);
}

/**
 * 按 Field 的文字认那一排再点芯片。
 * 「显示」页里「来源标记 / 重复标记 / 现在时刻线」三排都叫 on / off，
 * 所以 `[data-pick="off"]` 在这一页里有三个 —— 只按属性取会点错排。
 * Field 自己没有 data-*，靠外层 div 的文字里有标签认出 group。
 */
async function pickChip({ page, evalJs, waitFor }, labelText, key) {
  await openDisplayTab({ page, evalJs, waitFor });
  const hit = await evalJs(page, `
    const g = [...document.querySelectorAll('[role="group"]')].find((el) => {
      const owner = el.parentElement;
      return owner && owner.textContent.includes(${JSON.stringify(labelText)});
    });
    const btn = g && g.querySelector('[data-pick=${JSON.stringify(key)}]');
    if (!btn) return false;
    btn.click();
    return true;
  `);
  if (!hit) throw new Error('「显示」页里找不到「' + labelText + '」那一排的 ' + key);
}

/** 绑好上下文的三件套（探针侧只管传 page / evalJs / waitFor） */
export function makeDisplaySwitch({ page, evalJs, waitFor }) {
  return {
    openSettings: () => openSettings({ page, evalJs, waitFor }),
    openDisplayTab: () => openDisplayTab({ page, evalJs, waitFor }),
    pickChip: (labelText, key) => pickChip({ page, evalJs, waitFor }, labelText, key),
  };
}
