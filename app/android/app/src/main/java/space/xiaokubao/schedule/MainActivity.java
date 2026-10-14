package space.xiaokubao.schedule;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // 必须在 super.onCreate 之前注册 —— 否则页面加载时插件还没就位，
    // 网页侧第一次调用会拿到「插件未找到」
    registerPlugin(WidgetBridge.class);
    super.onCreate(savedInstanceState);
    // 启动 3 秒后检查一次新版本。失败一律静默（没网/服务端没这文件都不打扰用户）
    AppUpdate.checkOnLaunch(this);
  }
}
