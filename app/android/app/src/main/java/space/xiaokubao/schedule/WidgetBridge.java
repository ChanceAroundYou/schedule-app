package space.xiaokubao.schedule;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
