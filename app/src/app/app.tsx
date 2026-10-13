/**
 * app.ts —— 桶文件 + App 根组件
 */

import { useEffect, useState } from 'react';
import type { PublicUser } from '../domain/types.ts';
import * as store from '../data/store.ts';
import { ApiError, api, getCachedUser, getToken, setCachedUser, setToken } from '../data/api.ts';
import * as engine from '../sync/engine.ts';
import { readLegacy } from '../data/legacy.ts';
import { clearWidgetAuth, pushWidgetAuth } from '../data/widget.ts';
import * as T from '../ui/theme.ts';
import { ConfirmProvider, ToastHost } from '../ui/kit.tsx';
import { Auth } from '../ui/Auth.tsx';
import { Workbench } from './Workbench.tsx';

export { Workbench } from './Workbench.tsx';

/* ============================== 根组件 ============================== */

export default function App() {
  const [user, setUser] = useState<PublicUser | null>(() => getCachedUser());
  const [ready, setReady] = useState(false);

  // 启动：有 token 就先拉一次。401 说明失效了，退回登录页。
  useEffect(() => {
    store.load();
    // 首屏前先上一次色，别等 Workbench 那个 effect（它在这次 render 之后才跑）
    T.applyAppearance(store.get().ui);

    let alive = true;
    (async () => {
      if (getToken()) {
        // App 重装/升级后原生侧那份票会丢，这里补推一次，让小组件恢复直连
        void pushWidgetAuth(getToken() as string);
        try {
          await engine.bootstrap();
          engine.start();
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            setToken(null);
            setCachedUser(null);
            setUser(null);
          }
          // 其它错误（多半是断网）不进登录页 —— 本地数据照样能用，
          // 引擎会在网络恢复后自己补推
        }
      }
      if (alive) setReady(true);
    })();

    const onHide = () => store.flushPersist();
    window.addEventListener('pagehide', onHide);
    return () => { alive = false; window.removeEventListener('pagehide', onHide); engine.stop(); };
  }, []);

  if (!ready) return null;

  if (!getToken()) {
    return (
      <ConfirmProvider>
        <Auth
          onAuthed={(u) => {
            setCachedUser(u);
            setUser(u);
            // 首次登录：服务器账号是空的就把本机旧数据搬上去（旧 key 保留，可回滚）
            void engine.bootstrap().then(() => engine.start());
          }}
        />
        <ToastHost />
      </ConfirmProvider>
    );
  }

  const legacyLeft = !!readLegacy();

  return (
    <ConfirmProvider>
      <Workbench
        user={user}
        onLogout={async () => {
          engine.stop();
          try { await api.logout(); } catch (_) { /* 网络不通也要能退出去 */ }
          setToken(null);
          setCachedUser(null);
          setUser(null);
          // 顺手把原生侧那份票也清掉 —— 否则小组件还拿着旧票直连，
          // 而服务端已经把它作废了（logout 会吊销 jti）
          void clearWidgetAuth();
          // 退登录**不清本地数据** —— 清了就是「换个账户登录顺手把没同步的改动删了」
          void legacyLeft;
        }}
      />
      <ToastHost />
    </ConfirmProvider>
  );
}
