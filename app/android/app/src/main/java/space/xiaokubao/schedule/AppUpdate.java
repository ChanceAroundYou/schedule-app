package space.xiaokubao.schedule;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * AppUpdate —— APK 自更新。
 *
 * 为什么需要它：这个 App 是「网页打包 + 原生小组件」，改界面只要换 {@code dist/}，
 * 但**改小组件、改权限、改图标都得重打 APK**。每次都得 adb / 手动拷文件的体验
 * 太差，所以让 App 自己去服务器拉新包、唤起系统安装器。
 *
 * 分两层，别混：
 *   · 网页层（dist/）—— 不在这一管，刷新页面就好（nginx 直读）。
 *   · 原生层（本类）—— 只能靠换 APK。
 *
 * 流程：
 *   1. 启动 3 秒后拉 {@code /schedule/dl/version.json}，比 versionCode。
 *   2. 有新版且没在 24h 内提示过 → 弹框「立即更新 / 稍后」。
 *   3. DownloadManager 下载到 app 专属外部目录（不需要任何存储权限）。
 *   4. 收到 DOWNLOAD_COMPLETE → 校验 sha256 → 拷进内部存储 → FileProvider
 *      唤起系统安装器。用户点一下「安装」，数据保留（同签名覆盖安装）。
 *
 * 三个坑，都是这套流程里的硬约束：
 *
 * 1. **必须校验收敛的 sha256。** 公网下载的包不做校验 = 谁改得到那个文件谁就能
 *    往你手机里装任意代码。version.json 和 apk 在同一个目录，被篡改会一起改，
 *    所以这条只是兜底（防传输损坏、防 CDN 出错），不是威胁模型的全部。
 *
 * 2. **不能直接用外部目录里的文件安装。** 部分 OEM 的 Package Installer 读不了
 *    {@code /Android/data/<pkg>/files/…} 下的 uri（即使走了 FileProvider）。
 *    所以下完先拷到 {@code filesDir/update/} 再装 —— 内部存储一定读得到。
 *
 * 3. **安装未知应用权限要用户手动授。** Android 8 起 {@code REQUEST_INSTALL_PACKAGES}
 *    是特殊权限，装不了时先把用户送去设置页，别硬 startActivity（会崩）。
 *
 * 版本号约定：{@code versionCode} 必须**严格递增**，服务端 version.json 里的
 * 大于自己的才提示。改了原生代码但忘了加 = 永远收不到更新。
 */
class AppUpdate {

    private static final String TAG = "AppUpdate";

    /** 版本清单。与 {@link BuildConfig#UPDATE_BASE} 拼成完整地址 */
    private static final String MANIFEST_PATH = "/dl/version.json";

    /** 自己的偏好文件，不掺和 CapacitorStorage（那份是网页侧和小组件共用的） */
    private static final String PREFS = "app_update";
    private static final String KEY_LAST_PROMPT_CODE = "lastPromptCode";
    private static final String KEY_LAST_PROMP_AT = "lastPromptAt";
    /** 同一个版本 24 小时内不重复弹 */
    private static final long PROMPT_COOLDOWN_MS = 24 * 3600 * 1000L;

    /** 下载完成后等这个 id。{@link #DownloadReceiver} 里用 */
    static volatile long sDownloadId = -1L;
    static volatile String sPendingSha256;
    static volatile int sPendingVersionCode;

    /**
     * 已把用户送去「安装未知应用」设置页，等他回来补一次检查。
     * 见 {@link #onResume} —— 这是那类「点了却没做成」的自动补救。
     */
    private static volatile boolean sWaitingForPermission = false;

    // ---------------------------------------------------------------- 对外入口

    /**
     * 启动时检查一次。延迟 3 秒 —— 一进 App 就弹框太突兀，等界面稳下来。
     * 失败一律静默：没网、服务端没这文件、版本号写错，都不该打扰用户。
     */
    static void checkOnLaunch(final Activity activity) {
        activity.getWindow().getDecorView().postDelayed(new Runnable() {
            @Override
            public void run() {
                checkAndPrompt(activity, false);
            }
        }, 3000L);
    }

    /**
     * 检查一次并弹框。{@code force} 为 true 时**跳过 24 小时冷却**。
     *
     * 为什么要这个开关（用户 2026-10-17 报障）：以前点「立即更新」时是先
     * {@link #markPrompted} 再 {@link #startDownload}，而没授「安装未知应用」
     * 权限时后者直接送用户去设置页、**什么也不做**。标记已经写下 → 授权回来
     * 按钮消失，24 小时内再也不提示，等于那次更新**彻底丢了**。
     *
     * 关于页的「检查更新」按钮走 force = true —— 用户主动点的，不该被冷却挡着；
     * 「已是最新」也要给个回执（toast），否则按钮点了没反应，跟没做一样。
     */
    static void checkForced(final Activity activity) {
        checkAndPrompt(activity, true);
    }

    /**
     * 从「安装未知应用」设置页回来时调一次。
     *
     * 用户去授权前我们什么都没做成（见 {@link #startDownload} 的早退），
     * 所以回来得自动补上 —— 不然他会以为 App 坏了。
     * {@code sWaitingForPermission} 只有那一条路径会置 true。
     */
    static void onResume(final Activity activity) {
        if (!sWaitingForPermission) return;
        sWaitingForPermission = false;
        Log.i(TAG, "授权回来，补一次更新检查");
        checkForced(activity);
    }

    /** 检查更新。{@code force} = 跳过冷却 + 「已是最新」也给 toast */
    private static void checkAndPrompt(final Activity activity, final boolean force) {
        final Context c = activity.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Manifest m = fetchManifest();
                    if (m == null) {
                        return;
                    }
                    long self = selfVersionCode(c);
                    if (m.versionCode <= self) {
                        Log.i(TAG, "已是最新 versionCode=" + self);
                        if (force) {
                            toast(c, "已是最新版本（versionCode " + self + "）");
                        }
                        return;
                    }
                    if (!force && !shouldPrompt(c, m.versionCode)) {
                        Log.i(TAG, "有新版 " + m.versionCode + " 但 24h 内提示过了，跳过");
                        return;
                    }
                    showPrompt(activity, m);
                } catch (Exception e) {
                    Log.w(TAG, "检查更新失败: " + e);
                }
            }
        }).start();
    }

    // ---------------------------------------------------------------- 版本清单

    /** version.json 的内容 */
    static class Manifest {
        int versionCode;
        String versionName = "";
        /** apk 的地址，相对 {@link BuildConfig#UPDATE_BASE} 解析 */
        String url = "";
        String sha256 = "";
        String notes = "";
    }

    private static Manifest fetchManifest() throws Exception {
        String url = BuildConfig.UPDATE_BASE.replaceAll("/+$", "") + MANIFEST_PATH;
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "version.json -> HTTP " + code);
                return null;
            }
            String text = readAll(conn.getInputStream());
            JSONObject o = new JSONObject(text);
            Manifest m = new Manifest();
            m.versionCode = o.optInt("versionCode", 0);
            m.versionName = o.optString("versionName", "");
            m.url = o.optString("url", "");
            m.sha256 = o.optString("sha256", "").toLowerCase();
            m.notes = o.optString("notes", "");
            if (m.versionCode <= 0 || m.url.isEmpty()) {
                Log.w(TAG, "version.json 缺 versionCode/url: " + text);
                return null;
            }
            return m;
        } finally {
            conn.disconnect();
        }
    }

    // ---------------------------------------------------------------- 提示

    private static boolean shouldPrompt(Context c, int versionCode) {
        SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int last = sp.getInt(KEY_LAST_PROMPT_CODE, -1);
        long at = sp.getLong(KEY_LAST_PROMP_AT, 0L);
        if (last == versionCode && System.currentTimeMillis() - at < PROMPT_COOLDOWN_MS) {
            return false;
        }
        return true;
    }

    private static void markPrompted(Context c, int versionCode) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt(KEY_LAST_PROMPT_CODE, versionCode)
                .putLong(KEY_LAST_PROMP_AT, System.currentTimeMillis())
                .apply();
    }

    private static void showPrompt(final Activity activity, final Manifest m) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (activity.isFinishing() || activity.isDestroyed()) {
                    return;
                }
                String cur = selfVersionName(activity);
                String msg = "新版本 " + m.versionName + "（versionCode " + m.versionCode + "）"
                        + "\n当前 " + cur
                        + (m.notes.isEmpty() ? "" : "\n\n" + m.notes);
                new AlertDialog.Builder(activity)
                        .setTitle("发现新版本")
                        .setMessage(msg)
                        .setNegativeButton("稍后", null)
                        .setPositiveButton("立即更新", (d, w) -> {
                            // **先启动、后标记**（2026-10-17 修）：以前是
                            // markPrompted 在前、startDownload 在后，没权限时
                            // startDownload 早退去设置页，标记却已写下 ——
                            // 授权回来按钮消失，24h 内也不再提示。
                            startDownload(activity, m);
                        })
                        .show();
            }
        });
    }

    // ---------------------------------------------------------------- 下载与安装

    private static void startDownload(final Activity activity, final Manifest m) {
        // Android 8+ 的「安装未知应用」是特殊权限，弹不了系统安装器就先送设置页
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(activity, "请先允许本应用「安装未知应用」，回来会自动继续", Toast.LENGTH_LONG).show();
            sWaitingForPermission = true;      // 交给 onResume 补刀
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(i);
            return;
        }
        // 到这里才算「这次提示真的转化成了下载」，可以标记冷却了
        markPrompted(activity, m.versionCode);
        String apkUrl = BuildConfig.UPDATE_BASE.replaceAll("/+$", "") + "/dl/" + m.url;
        Context c = activity.getApplicationContext();
        DownloadManager dm = (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) {
            Toast.makeText(activity, "取不到下载服务", Toast.LENGTH_SHORT).show();
            return;
        }
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
        // app 专属外部目录 —— 不需要 WRITE_EXTERNAL_STORAGE，卸载跟着走
        req.setDestinationInExternalFilesDir(c, Environment.DIRECTORY_DOWNLOADS,
                "schedule-" + m.versionCode + ".apk");
        req.setTitle("日程清单 " + m.versionName);
        req.setDescription("正在下载新版本…");
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
        sDownloadId = dm.enqueue(req);
        sPendingSha256 = m.sha256;
        sPendingVersionCode = m.versionCode;
        Log.i(TAG, "开始下载 id=" + sDownloadId + " " + apkUrl);
        Toast.makeText(activity, "正在后台下载，下好会提示安装", Toast.LENGTH_SHORT).show();
    }

    /**
     * 下载完成。**在清单里注册**，不是动态注册 —— 用户下到一半退出 App
     * 也得能收到，不然那个包就白下了。
     */
    public static class DownloadReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
            if (id != sDownloadId || sDownloadId < 0) {
                return;
            }
            Log.i(TAG, "下载完成 id=" + id);
            new Thread(() -> verifyAndInstall(context)).start();
        }
    }

    /** 校验 sha256 → 拷进内部存储 → 唤起系统安装器 */
    private static void verifyAndInstall(Context c) {
        File tmp = new File(c.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                "schedule-" + sPendingVersionCode + ".apk");
        if (!tmp.exists()) {
            Log.w(TAG, "下载的文件不在: " + tmp);
            toast(c, "下载失败，文件不存在");
            return;
        }
        String actual = sha256(tmp);
        if (sPendingSha256 != null && !sPendingSha256.isEmpty()
                && !sPendingSha256.equals(actual)) {
            Log.w(TAG, "sha256 不符：期望 " + sPendingSha256 + " 实际 " + actual);
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            toast(c, "安装包校验失败，已删除。请重新更新");
            return;
        }
        // 拷进内部存储再装 —— 见类注释第 2 条
        File dst = new File(c.getFilesDir(), "update/schedule.apk");
        try {
            File dir = dst.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "建不了 " + dir);
            }
            try (InputStream in = new FileInputStream(tmp)) {
                byte[] buf = new byte[8192];
                int n;
                java.io.OutputStream out = new java.io.FileOutputStream(dst);
                try {
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                    }
                    out.flush();
                } finally {
                    out.close();
                }
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        } catch (Exception e) {
            Log.w(TAG, "拷贝安装包失败: " + e);
            toast(c, "准备安装包失败");
            return;
        }
        installApk(c, dst);
    }

    private static void installApk(Context c, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            Log.i(TAG, "已唤起系统安装器 " + uri);
        } catch (Exception e) {
            Log.w(TAG, "唤起安装器失败: " + e);
            toast(c, "无法唤起安装器：" + e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- 工具

    private static long selfVersionCode(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? pi.getLongVersionCode() : pi.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return -1;
        }
    }

    private static String selfVersionName(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "?";
        }
    }

    private static String sha256(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            Log.w(TAG, "算 sha256 失败: " + e);
            return "";
        }
    }

    private static String readAll(InputStream is) throws Exception {
        StringBuilder sb = new StringBuilder();
        InputStreamReader r = new InputStreamReader(is, StandardCharsets.UTF_8);
        char[] buf = new char[2048];
        int n;
        while ((n = r.read(buf)) > 0) {
            sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    private static void toast(final Context c, final String s) {
        // 从广播接收器的线程来，不一定有 Looper —— 主线程一定在，交给它
        new android.os.Handler(android.os.Looper.getMainLooper()).post(
                () -> Toast.makeText(c.getApplicationContext(), s, Toast.LENGTH_LONG).show());
    }
}
