/**
 * DisplayTab.tsx —— 设置页「显示」tab 内容
 */
import { Eye } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import * as store from '../../data/store.ts';
import { Card, Chips, Field } from '../kit.tsx';
import { DayWindowCard } from './CalsTab.tsx';

export function DisplayTab({ state }: { state: LocalState }) {
  const ui = state.ui;
  return (
    <>
      <Card icon={<Eye size={14} />} title="显示">
        <Field label="来源标记" hint="别人建的任务，右上角显示创建者昵称的首字">
          <Chips<'on' | 'off'>
            value={ui.showCreatorTag ? 'on' : 'off'}
            options={['on', 'off']}
            onPick={(k) => store.setUi({ showCreatorTag: k === 'on' })}
            labelOf={(k) => (k === 'on' ? '显示' : '不显示')}
          />
        </Field>
        <Field label="重复标记" hint="带重复规则的任务挂循环图标：日历卡右上角和列表行标题末尾。关掉后「每天」「每周三」这类文字还在">
          <Chips<'on' | 'off'>
            value={ui.showRepeatMark ? 'on' : 'off'}
            options={['on', 'off']}
            onPick={(k) => store.setUi({ showRepeatMark: k === 'on' })}
            labelOf={(k) => (k === 'on' ? '显示' : '不显示')}
          />
        </Field>
        <Field label="现在时刻线">
          <Chips<'on' | 'off'>
            value={ui.showNowLine ? 'on' : 'off'}
            options={['on', 'off']}
            onPick={(k) => store.setUi({ showNowLine: k === 'on' })}
            labelOf={(k) => (k === 'on' ? '显示' : '不显示')}
          />
        </Field>
        <Field label="任务卡字号" hint="日历卡片上任务名的大小（中 = 现状）。勾选圈跟着任务名一起大一起小；列表行、详情抽屉、月视图那个日期数字不吃这一档">
          <Chips<'sm' | 'md' | 'lg'>
            value={ui.cardFontSize}
            options={['sm', 'md', 'lg']}
            onPick={(k) => store.setUi({ cardFontSize: k })}
            labelOf={(k) => ({ sm: '小', md: '中', lg: '大' }[k])}
          />
        </Field>
      </Card>
      <DayWindowCard ui={ui} />
    </>
  );
}
