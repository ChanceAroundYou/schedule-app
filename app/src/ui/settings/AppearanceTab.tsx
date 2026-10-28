/**
 * AppearanceTab.tsx —— 设置页「外观」tab 内容
 *
 * 从 `SettingsView.tsx` 拆出来。这一段是**一整块**：功能区 + 色板 / 风格 /
 * 深浅三选 + 日视图时间窗，跟账号 / 同步那两张卡没有共享状态。
 *
 * `theme` 必须是**实际生效**的那一档（auto 已解析）—— 色点要靠它才画得出
 * 暗色档下提亮过的 --primary。
 */

import { Palette } from 'lucide-react';
import type { AccentKey, LocalState, StyleKey, ThemeMode } from '../../domain/types.ts';
import * as store from '../../data/store.ts';
import * as T from '../theme.ts';
import { Card, Chips, Field } from '../kit.tsx';
import { NavCard } from './NavCard.tsx';
import { DayWindowCard } from './CalsTab.tsx';

export function AppearanceTab({ state, theme }: {
  state: LocalState;
  /** **实际生效**的那一档（auto 已解析） */
  theme: 'light' | 'dark';
}) {
  const ui = state.ui;
  return (
    <>
      {/* 功能区放在最前面 —— 它改的是导航本身，比配色更「结构性」 */}
      <NavCard state={state} />
      <Card icon={<Palette size={14} />} title="外观">
        <Field label="色板">
          <Chips<AccentKey>
            value={ui.accent}
            options={['jade', 'azure', 'clay', 'plum', 'gold', 'slate']}
            onPick={(k) => store.setUi({ accent: k })}
            labelOf={(k) => T.ACCENTS[k].label}
            // 色点在**自己身上**带 data-accent + data-theme，于是它拿到的
            // --primary 就是选中那套（含暗色档那组提亮过的值）。
            // 不在 TS 里再存一份十六进制 —— 那两份一定会漂。
            render={(k) => (
              <span
                data-accent={k}
                data-theme={theme}
                className="apptab-dot inline-block h-3 w-3 shrink-0"
                style={{ background: 'var(--primary)' }}
              />
            )}
          />
        </Field>

        <Field label="风格">
          <Chips<StyleKey>
            value={ui.style}
            options={['soft', 'flat', 'notion']}
            onPick={(k) => store.setUi({ style: k })}
            labelOf={(k) => T.STYLES[k].label}
          />
        </Field>

        {/* 顶栏那个按钮是二元的（按下即离开「跟随系统」），三选一只有这里 */}
        <Field label="深浅">
          <Chips<ThemeMode>
            value={ui.theme}
            options={['auto', 'light', 'dark']}
            onPick={(k) => store.setUi({ theme: k })}
            labelOf={(k) => T.THEMES[k].label}
          />
        </Field>

        {/* 来源标记（别人建的任务在右上角给一枚首字圆圈）。
            只影响**画不画**这一枚，不影响数据 —— 关掉之后卡片颜色、
            抽屉里的创建者信息都还在。 */}
        <Field label="来源标记" hint="别人建的任务，右上角显示创建者昵称的首字（只在三日视图的宽屏档出现）">
          <Chips<'on' | 'off'>
            value={ui.showCreatorTag ? 'on' : 'off'}
            options={['on', 'off']}
            onPick={(k) => store.setUi({ showCreatorTag: k === 'on' })}
            labelOf={(k) => (k === 'on' ? '显示' : '不显示')}
          />
        </Field>
      </Card>

      <DayWindowCard ui={ui} />
    </>
  );
}
