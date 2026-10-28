/**
 * SettingsView.tsx —— 设置页主组件（tab 外壳）
 *
 * 两个 tab 的内容拆去同目录：`AppearanceTab`（功能区 + 色板/风格/深浅 + 时间窗）、
 * `SecurityTab`（账号 + 同步备份）。这里只剩 tab 切换和关于卡 —— 那两段各自
 * 独立，跟「哪个 tab 开着」没有关系。
 */

import { useState, useEffect } from 'react';
import { Info } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import type { LocalState, PublicUser } from '../../domain/types.ts';
import { Card, Field, Btn } from '../kit.tsx';
import { cx } from '../cx.ts';
import { checkAppUpdate } from '../../data/widget.ts';
import { ChangePasswordSheet } from './ChangePasswordSheet.tsx';
import { AppearanceTab } from './AppearanceTab.tsx';
import { DisplayTab } from './DisplayTab.tsx';
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

type SettingsTab = 'appearance' | 'display' | 'security' | 'cals' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'display', label: '显示' },
  { key: 'security', label: '安全' },
  { key: 'cals', label: '日程集' },
  { key: 'about', label: '关于' },
];

export function SettingsView({ state, user, theme, onExport, onImport, onLogout, onInvites, onUserChange }: {
  state: LocalState;
  user: PublicUser | null;
  /** **实际生效**的那一档（auto 已解析）。色点要靠它才画得出暗色档的颜色 */
  theme: 'light' | 'dark';
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onInvites: () => void;
  onUserChange?: (u: PublicUser | null) => void;
}) {
  const [pwOpen, setPwOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [apkUrl, setApkUrl] = useState<string | null>(null);
  const [apkName, setApkName] = useState<string | null>(null);
  /** 检查更新的进行中态 —— 点了立刻有反馈，不让用户怀疑自己没点到 */
  const [checking, setChecking] = useState(false);
  const [updateHint, setUpdateHint] = useState('');
  const native = Capacitor.isNativePlatform();

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;

    // ⚠️ 时间戳不是装饰：这份清单**必须**每次都是网络上那一份。
    // Service Worker 曾经把它当普通同源 GET 缓存住（v3 的 staleWhileRevalidate），
    // 于是「下载 App」永远指向缓存那一天的那一版（用户拿到 2.1.4）。
    // sw.js 里已经把 dl/ 整个前缀排除了，加时间戳是给**还没换到新 worker**的
    // 浏览器兜一层：URL 都不一样了，旧缓存根本命中不了。
    void fetch(`/schedule/dl/version.json?v=${Date.now()}`)
      .then((response) => response.ok ? response.json() : null)
      .then((manifest: { url?: string; versionName?: string } | null) => {
        if (!manifest?.url) return;
        setApkUrl(`/schedule/dl/${manifest.url}`);
        setApkName(manifest.versionName ?? manifest.url);
      })
      // 下载入口不影响日程功能；服务暂不可用时不渲染该链接。
      .catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto w-full max-w-[620px] pb-6">
      {/* 页名「设置」归**顶栏**（见 Shell.tsx 的 title 分支）—— 页面里不写第二遍，
          两行都是「设置」看着像两个 header。这张 tab 栏是页内的分段开关。 */}
      <div className="mb-4">
        <div className="set-tabbar flex gap-1 border-[length:var(--border-w)] p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-settings-tab={t.key}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
              className={cx(
                'set-tab flex-1 px-3 py-1.5 text-[13px] transition',
                tab === t.key
                  ? 'set-tab-on font-medium'
                  : 'set-tab-off',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'appearance' && <AppearanceTab state={state} theme={theme} />}

      {tab === 'display' && <DisplayTab state={state} />}

      {tab === 'security' && (
        <SecurityTab
          state={state}
          user={user}
          onExport={onExport}
          onImport={onImport}
          onLogout={onLogout}
          onChangePassword={() => setPwOpen(true)}
          onUserChange={onUserChange}
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
          {/* 检查更新：只有 App 里有（更新提示是原生弹的，网页没有这一层）。
              点了之后是原生去干活，这里只做一个进行中态 —— 有没有新版本、
              弹不弹框，都由原生回答（含「已是最新」的回执）。 */}
          {native && (
            <Field label="更新">
              <Btn
                type="button"
                size="sm"
                variant="normal"
                data-about="check-update"
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  try {
                    const ok = await checkAppUpdate();
                    // 原生侧没接住（App 版本太旧 / 原生异常）才轮到网页说话 ——
                    // 检查成功了（含「已是最新」「发现新版本」）都由原生回执
                    setUpdateHint(ok ? '' : '这台 App 的版本太旧，检查不了更新 —— 请先用下方「下载 App」装一次最新版');
                  } finally {
                    // 延迟一小会儿再解除进行中态：原生是异步拉版本清单的，
                    // 立刻恢复会让按钮看起来「点了没反应」
                    window.setTimeout(() => setChecking(false), 800);
                  }
                }}
              >
                {checking ? '检查中…' : '检查更新'}
              </Btn>
              {updateHint && (
                <span data-about="update-hint" className="block text-[11px] mt-1"
                  style={{ color: 'var(--text-3)' }}>
                  {updateHint}
                </span>
              )}
            </Field>
          )}
          {/* 「技术栈」一整行已删（2026-10-22 用户：完全不写，连 Node + SQLite 也不留） */}
          {apkUrl && (
            <Field label="下载 App">
              <a
                href={apkUrl}
                className="text-[12.5px] underline"
                style={{ color: 'var(--primary)' }}
                data-about="apk-download"
              >
                Android 版 {apkName}
              </a>
            </Field>
          )}
        </Card>
      )}

      {pwOpen && <ChangePasswordSheet onClose={() => setPwOpen(false)} />}
    </div>
  );
}
