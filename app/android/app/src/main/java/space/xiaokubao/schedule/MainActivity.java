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
  }
}
