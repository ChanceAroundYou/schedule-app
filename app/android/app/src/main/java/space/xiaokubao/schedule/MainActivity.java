package space.xiaokubao.schedule;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  /** 通知权限的请求码（Android 13+ 才需要运行时申请） */
  private static final int REQ_NOTIFY = 1001;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // 必须在 super.onCreate 之前注册 —— 否则页面加载时插件还没就位，
    // 网页侧第一次调用会拿到「插件未找到」
    registerPlugin(WidgetBridge.class);
    super.onCreate(savedInstanceState);

    // 启动 3 秒后检查一次新版本。失败一律静默（没网/服务端没这文件都不打扰用户）
    AppUpdate.checkOnLaunch(this);

    // 提醒相关的两件事：
    //   ① Android 13+ 要运行时申请通知权限，否则到点发不出通知
    //   ② 每次打开 App 重排一遍闹钟（数据可能刚同步过，闹钟跟着最新快照走）
    askNotifyPermission();
    ReminderScheduler.reschedule(this);
  }

    private void askNotifyPermission() {
      if (Build.VERSION.SDK_INT < 33) return;   // 13 以下不需要
      if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
          == PackageManager.PERMISSION_GRANTED) return;
      requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }

    /**
     * 从设置页（比如「安装未知应用」授权）回到 App 时补一次更新检查。
     * 用户被送去授权时那次更新**并没有真正启动**（见 AppUpdate.startDownload
     * 的早退），不补的话他会以为点过的那次更新凭空消失了。
     */
  @Override
  public void onResume() {
    super.onResume();
    AppUpdate.onResume(this);
  }
}
