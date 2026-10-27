package space.xiaokubao.schedule;

import android.appwidget.AppWidgetManager;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.ref.WeakReference;

/**
 * WidgetBridge —— 让网页侧能「通知桌面小组件刷新」
 *
 * 为什么需要它：小组件只在系统愿意调 {@link AppWidgetProvider#onUpdate} 时才刷新。
 * 但用户在 App 里改了数据，用户**期望**桌面立刻就变 —— 那个必须由我们主动发
 * 一次 {@code ACTION_APPWIDGET_UPDATE} 广播。广播只能从原生侧发，
 * Capacitor 没有现成 API，所以有这个薄薄一层。
 *
 * provider 的类名从 JS 传进来，而不是在这里写死 —— 写死会让这个插件依赖某个
 * 具体的小组件类，而小组件会有好几个（日程 / 打卡）。类名不存在的后果只是
 * {@code getAppWidgetIds} 返回空数组，广播无害。
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridge extends Plugin {

  /**
   * 活着的插件实例。桌面小组件与 WebView **在同一个进程**里，所以那边写完
   * 可以直接把消息塞回网页 —— 不需要轮询、也不需要推送通道。
   *
   * 用 WeakReference 而不是强引用：Activity 销毁后 Bridge 会被回收，
   * 抓住不放就是经典的内存泄漏。
   */
  private static WeakReference<WidgetBridge> sLive;

  /** 网页侧监听的事件名，与 useCounters.ts 的 NATIVE_EVENT 一致 */
  private static final String JS_COUNTERS_CHANGED =
      "window.dispatchEvent(new CustomEvent('schedule:counters-changed'))";

  @Override
  public void load() {
    sLive = new WeakReference<>(this);
  }

  /**
   * 告诉网页「计数器变了」。
   *
   * 由 {@link CounterStore} 在写成功之后调用（桌面上点了 + / −、手输数字）。
   * 网页侧收到后会重新读一次服务端 —— 这是「桌面点完立刻开 App 也是新的」
   * 的零延迟路径。
   *
   * 三重保护：没有活着的插件（App 没开）→ 什么都不做；WebView 已销毁 → 不动；
   * 一切异常都吞掉 —— 这只是一条通知，失败最多让网页晚 5 秒（有兜底轮询）。
   */
  static void notifyCountersChanged() {
    WidgetBridge p = sLive == null ? null : sLive.get();
    if (p == null) return;
    try {
      Bridge bridge = p.getBridge();
      if (bridge == null) return;
      final WebView web = bridge.getWebView();
      if (web == null) return;
      // evaluateJavascript 必须在 UI 线程
      web.post(new Runnable() {
        @Override
        public void run() {
          try {
            web.evaluateJavascript(JS_COUNTERS_CHANGED, null);
          } catch (Exception ignored) {
            // WebView 正在销毁 / 页面还没就绪，兜底轮询会补上
          }
        }
      });
    } catch (Exception ignored) {
      // 同上
    }
  }

  /**
   * 把登录票与接口基址交给原生侧存着。
   *
   * 这是 **B 方案的关键一步**：小组件要能「不打开 App 也读写服务器」，
   * 就得有票。而小组件不自己登录（那要在原生侧存口令，太危险），
   * 所以由 App 登录成功后把票推过来。
   *
   * 存在 {@code CapacitorStorage} 这个 SharedPreferences 文件里 ——
   * 原生侧和网页侧共用同一份，小组件进程也读得到。
   */
  @PluginMethod
  public void setAuth(PluginCall call) {
    String token = call.getString("token");
    String base = call.getString("base");
    if (token == null || token.isEmpty()) {
      call.reject("token 不能为空");
      return;
    }
    try {
      WidgetPrefs.setToken(getContext(), token);
      WidgetPrefs.setApiBase(getContext(), base);
      // 顺手触发一次刷新：票刚到手，桌面还是旧的
      refreshAll();
      JSObject ret = new JSObject();
      ret.put("ok", true);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("保存登录状态失败：" + e.getMessage());
    }
  }

  /** 登出 / 票失效时清掉。小组件会退回「只显示快照」 */
  @PluginMethod
  public void clearAuth(PluginCall call) {
    WidgetPrefs.setToken(getContext(), null);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void refresh(PluginCall call) {
    String cls = call.getString("provider");
    if (cls == null || cls.isEmpty()) {
      call.reject("provider 不能为空");
      return;
    }
    try {
      ComponentName cn = new ComponentName(getContext(), cls);
      AppWidgetManager mgr = AppWidgetManager.getInstance(getContext());
      int[] ids = mgr.getAppWidgetIds(cn);
      // **不 new Intent(ctx, ScheduleWidgetProvider.class)** —— 那样这个插件会
      // 在编译期依赖某个具体的小组件类，而小组件会有好几个。
      // 用类名字符串定向，类不存在时 ids 为空、广播无害。
      Intent intent = new Intent();
      intent.setComponent(cn);
      intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
      intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
      getContext().sendBroadcast(intent);

      JSObject ret = new JSObject();
      ret.put("ids", ids == null ? 0 : ids.length);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("刷新小组件失败：" + e.getMessage());
    }
  }

  /**
   * 立刻检查更新（网页侧「关于」页的「检查更新」按钮用）。
   *
   * 走 {@code force} 分支：**跳过 24 小时冷却**。用户主动点了按钮还被告知
   * 「24 小时内提示过了，跳过」，那按钮等于不存在。
   * 「已是最新」会给一句 toast 回执 —— 按钮点了没反应跟没做一样。
   */
  @PluginMethod
  public void checkUpdate(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("拿不到当前 Activity");
      return;
    }
    AppUpdate.checkForced(activity);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    call.resolve(ret);
  }

  /**
   * 把系统栏（状态栏 / 手势条 / 刘海）的**实际占用**交给网页侧，单位 CSS px。
   *
   * 为什么非要走原生（2026-10-14 用户报「标题和手机自带时间重合」）：
   *   · Android 15+ 对 targetSdk ≥ 35 的 App **强制 edge-to-edge**，
   *     内容会一直铺到状态栏底下；
   *   · Capacitor 的 `StatusBar.setOverlaysWebView` 在 Android 15+ 上
   *     **明确不可用**（插件自己的文档写着 "Not available on Android 15+"），
   *     所以 capacitor.config.ts 里那句 `overlaysWebView: false` 是空操作；
   *   · Capacitor 也不会给网页注入任何安全区变量；
   *   · 而 WebView 里的 `env(safe-area-inset-top)` 在安卓上恒为 0
   *     （那是 iOS 的机制，安卓这条不报状态栏）。
   *
   * 所以只能自己量：读 WindowInsets 的 systemBars，按 density 换算成 CSS px，
   * 网页侧写进 `--sat / --sab / --sal / --sar`，CSS 用它做内边距。
   * 这样**网页版不受影响**（不调这个插件时那几个变量是空的，CSS 里兜底成 0）。
   */
  @PluginMethod
  public void insets(PluginCall call) {
    JSObject ret = new JSObject();
    try {
      float d = getContext().getResources().getDisplayMetrics().density;
      Insets bars = readSystemBars();
      ret.put("top", bars.top / d);
      ret.put("bottom", bars.bottom / d);
      ret.put("left", bars.left / d);
      ret.put("right", bars.right / d);
    } catch (Exception e) {
      // 量不到就一律给 0 —— 网页侧的兜底值和这一样，没有内边距总比崩了好
      ret.put("top", 0);
      ret.put("bottom", 0);
      ret.put("left", 0);
      ret.put("right", 0);
    }
    call.resolve(ret);
  }

  /** 读系统栏 inset。API 30+ 用 WindowInsets.Type.systemBars()，更老的走废弃字段 */
  private Insets readSystemBars() {
    View decor = getActivity().getWindow().getDecorView();
    WindowInsets wi = decor.getRootWindowInsets();
    if (wi == null) {
      // 还没 attach 过，退回「状态栏高度」这个最常见的近似
      int id = getContext().getResources().getIdentifier("status_bar_height", "dimen", "android");
      int h = id > 0 ? getContext().getResources().getDimensionPixelSize(id) : 0;
      return Insets.of(0, h, 0, 0);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      return wi.getInsets(WindowInsets.Type.systemBars());
    }
    // 兜底（本项目 minSdk 远高于 30，这条只是防御）
    int id = getContext().getResources().getIdentifier("status_bar_height", "dimen", "android");
    int h = id > 0 ? getContext().getResources().getDimensionPixelSize(id) : 0;
    return Insets.of(0, h, 0, 0);
  }

  /** 给所有 provider 发一次刷新。setAuth 后用，免得桌面留着旧数据 */
  private void refreshAll() {
    try {
      Intent intent = new Intent();
      intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
      getContext().sendBroadcast(intent);
    } catch (Exception ignored) {
      // 刷新失败不影响票已存下这个事实
    }
  }
}
