/**
 * SettingsView.tsx —— 设置页主组件（tab 外壳）
 *
 * 两个 tab 的内容拆去同目录：`AppearanceTab`（功能区 + 色板/风格/深浅 + 时间窗）、
 * `SecurityTab`（账号 + 同步备份）。这里只剩 tab 切换和关于卡 —— 那两段各自
 * 独立，跟「哪个 tab 开着」没有关系。
 */

import { useState } from 'react';
import { Info } from 'lucide-react';
import type { LocalState, PublicUser } from '../../domain/types.ts';
import { Card, Field } from '../kit.tsx';
import { cx } from '../cx.ts';
import { ChangePasswordSheet } from './ChangePasswordSheet.tsx';
import { AppearanceTab } from './AppearanceTab.tsx';
import { SecurityTab } from './SecurityTab.tsx';
import { CalsTab } from './CalsTab.tsx';

/** 构建期注入，见 vite-env.d.ts。取不到（比如被别的打包器吃掉）时不要显示空白 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * 描边走 **真令牌 `--border`**，不给兜底值。
 *
 * 老 surface（Calendars / Auth / kit）描边写的是一个**不存在的令牌**再配一个兜底值，
 * 而那个令牌在 styles/tokens.css 里根本没定义 —— 有兜底值所以不报错、不白屏，
 * 只是两套主题下都在用写死的浅色。**静默降级比直接坏掉难查得多。**
 * 这个文件是新的，别把这个坏习惯带过来。
 */

/* ================================ 页面 ================================ */

type SettingsTab = 'appearance' | 'security' | 'cals' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'security', label: '安全' },
  { key: 'cals', label: '日程集' },
  { key: 'about', label: '关于' },
];

export function SettingsView({ state, user, theme, onExport, onImport, onLogout, onInvites }: {
  state: LocalState;
  user: PublicUser | null;
  /** **实际生效**的那一档（auto 已解析）。色点要靠它才画得出暗色档的颜色 */
  theme: 'light' | 'dark';
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onInvites: () => void;
}) {
  const [pwOpen, setPwOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  return (
    <div className="mx-auto w-full max-w-[620px] pb-6">
      {/* 页名「设置」归**顶栏**（见 Shell.tsx 的 title 分支）—— 页面里不写第二遍，
          两行都是「设置」看着像两个 header。这张 tab 栏是页内的分段开关。 */}
      <div className="mb-4">
        <div className="flex gap-1 rounded-[var(--r-lg)] border-[length:var(--border-w)] border-[var(--border)] bg-[var(--panel-3)] p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-settings-tab={t.key}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
              className={cx(
                'flex-1 rounded-[var(--r-sm)] px-3 py-1.5 text-[13px] transition',
                tab === t.key
                  ? 'bg-[var(--primary)] text-[var(--on-primary)] font-medium'
                  : 'text-[var(--text-2)] hover:bg-[var(--panel)]',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'appearance' && <AppearanceTab state={state} theme={theme} />}

      {tab === 'security' && (
        <SecurityTab
          state={state}
          user={user}
          onExport={onExport}
          onImport={onImport}
          onLogout={onLogout}
          onChangePassword={() => setPwOpen(true)}
        />
      )}

      {tab === 'cals' && <CalsTab state={state} onInvites={onInvites} />}

      {tab === 'about' && (
        <Card
          icon={<Info size={14} />}
          title="关于"
          hint="个人任务与打卡管理。数据在服务器上，多设备通过日程集共享。"
        >
          <Field label="版本">
            <span data-about="version" className="text-[12.5px]">{VERSION}</span>
          </Field>
          <Field label="技术栈">
            <span className="text-[12.5px]">React + Node + SQLite</span>
          </Field>
        </Card>
      )}

      {pwOpen && <ChangePasswordSheet onClose={() => setPwOpen(false)} />}
    </div>
  );
}
