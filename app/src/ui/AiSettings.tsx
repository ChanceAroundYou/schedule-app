/**
 * AiSettings.tsx —— 模型配置浮层（Base URL / API key / 模型名）
 *
 * **key 只用不回显。** 服务器读接口只回 `hasKey: true/false`，永远不把 key
 * 发回浏览器（哪怕是自己刚填的）。所以这里保存时必须遵守服务端那个三态：
 *
 *   不传 apiKey  = 保留原值
 *   传空串       = 清空
 *   传值         = 覆盖
 *
 * 于是这个输入框每次打开都是空的，placeholder 写「已保存」——
 * 而提交时**只有用户真打了字才带上 `apiKey` 这个字段**。
 * 图省事把整份配置回传（`apiKey: ''`）会把 key 抹掉，而界面上看不出来，
 * 下次问问题才发现「API key 没了」。
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../data/api.ts';
import { Btn, Input, Sheet, toast } from './kit.tsx';
import type { AiSettings } from '../domain/ai.ts';

export function AiSettingsSheet({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  /** 保存成功后叫一声 —— 面板用它把「还没配置」那条提示收掉 */
  onSaved?: (s: AiSettings) => void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setKey('');
    setErr('');
    setLoading(true);
    api.aiSettings()
      .then((s) => {
        if (!alive) return;
        setBaseUrl(s.baseUrl);
        setModel(s.model);
        setHasKey(s.hasKey);
      })
      .catch((e: Error) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const save = async (patch: { baseUrl: string; model: string; apiKey?: string }) => {
    setBusy(true);
    setErr('');
    try {
      const s = await api.aiSaveSettings(patch);
      setHasKey(s.hasKey);
      setKey('');
      toast('模型配置已保存');
      onSaved?.(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const patch: { baseUrl: string; model: string; apiKey?: string } = {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
    };
    // 只在用户真打了字的时候才带 —— 空着提交等于「不改」，见文件头
    if (key.trim()) patch.apiKey = key.trim();
    void save(patch);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="AI 设置"
      footer={
        <>
          {hasKey && (
            <Btn
              variant="ghost"
              disabled={busy}
              onClick={() => void save({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey: '' })}
            >
              清除 key
            </Btn>
          )}
          <Btn variant="primary" disabled={busy || loading} onClick={submit}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : null} 保存
          </Btn>
        </>
      }
    >
      {loading ? (
        <div className="ai-set-load">正在读取配置…</div>
      ) : (
        <div className="ai-set">
          <label className="ai-field">
            <span className="ai-field-label">Base URL</span>
            <Input
              value={baseUrl}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:25001/v1"
            />
            <span className="ai-field-tip">
              任何 OpenAI 兼容的地址都行（本机网关 / Ollama / vLLM / LM Studio）。
              一般要带 <code>/v1</code>。
            </span>
          </label>

          <label className="ai-field">
            <span className="ai-field-label">模型名</span>
            <Input
              value={model}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-sonnet-5.5"
            />
          </label>

          <label className="ai-field">
            <span className="ai-field-label">API key</span>
            <Input
              value={key}
              type="password"
              spellCheck={false}
              autoComplete="new-password"
              onChange={(e) => setKey(e.target.value)}
              placeholder={hasKey ? '已保存在服务器上（留空 = 不改）' : '不用 key 的服务留空即可'}
            />
          </label>

          {err && <div className="ai-set-err">{err}</div>}
        </div>
      )}
    </Sheet>
  );
}
