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
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
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

    /** 「已经进了安装流程」防重入：广播和轮询可能同时报到，只许一个进 */
    private static volatile boolean sInstallStarted = false;

    /**
     * 2026-10-23 用户实锤：点「立即更新」后包下到了手机里，安装界面却永远
     * 不弹。根因是 {@code DOWNLOAD_COMPLETE} 这条广播会被 OEM 系统拦掉
     * （Android 12 起对清单里的静态接收器管得更严，ColorOS 尤甚）——
     * 广播一丢，包就静静躺着，没人去弹安装。三重保险：
     *   ① {@link #registerLiveReceiver} 前台动态接收器（App 活着时不会被拦）；
     *   ② {@link #startPolling} 主动轮询状态（不依赖任何广播）；
     *   ③ 下载任务记进 {@link #PREFS}，冷启动 {@link #recoverPending} 接着装
     *      —— 下到一半划掉 App 也不浪费那一次下载。
     */
    private static final Handler sUi = new Handler(Looper.getMainLooper());
    private static Context sPollContext;
    private static int sPollStep;
    private static BroadcastReceiver sLiveReceiver;

    private static final String KEY_PENDING_ID = "pendingId";
    private static final String KEY_PENDING_SHA = "pendingSha";
    private static final String KEY_PENDING_VC = "pendingVc";

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
        // 上次有没有「包下完了却没装上」的烂尾（广播被拦/中途划掉）—— 先接手
        recoverPending(activity);
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
     *
     * 另外每次回前台都接手一次烂尾下载（{@link #recoverPending}）：后台下载
     * 期间进程被杀的话，静态字段全没了，只有这里能把记录里的 id 捞回来。
     */
    static void onResume(final Activity activity) {
        recoverPending(activity);
        confirmInstalled(activity.getApplicationContext());
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
                        // 拉到了但内容不对（多半是服务端文件写坏了）。用户主动点的
                        // 必须给个回执 —— 2026-10-24 用户报「点了没任何反应」，
                        // 静默是病：网络/清单哪一层挂了都该说一声。
                        if (force) {
                            toast(c, "检查失败：版本清单异常，请稍后再试");
                        }
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
                    // 有 pending 的包还没装（用户上次在安装器点了取消/直接打开）→
                    // 不重新下载，直接用内部存储那份再唤起一次安装器。
                    // 之前是无条件走下载，filename 又是 schedule-<vc>.apk 固定名，
                    // DownloadManager 去重/覆盖行为各家不同，就会出现「下了却装旧包」。
                    if (force && m.versionCode == sPendingVersionCode) {
                        File pending = new File(c.getFilesDir(), "update/schedule.apk");
                        if (pending.exists() && pending.length() > 0) {
                            Log.i(TAG, "pending 包还在，直接重装 " + pending.length() + " 字节");
                            sInstallStarted = false;
                            installApk(c, pending);
                            return;
                        }
                        // 文件不在了（用户清数据/系统清了）→ 落到下面正常下载
                        Log.i(TAG, "pending 记录在但文件没了，重新下载");
                    }
                    if (!force && !shouldPrompt(c, m.versionCode)) {
                        Log.i(TAG, "有新版 " + m.versionCode + " 但 24h 内提示过了，跳过");
                        return;
                    }
                    showPrompt(activity, m);
                } catch (Exception e) {
                    Log.w(TAG, "检查更新失败: " + e);
                    // 网络不通 / 域名解析不了 / TLS 出错 —— force 时给回执，
                    // 否则按钮点了毫无动静，用户只能当它坏了
                    if (force) {
                        toast(c, "检查失败：网络不通或服务端没响应，请稍后再试");
                    }
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
        // **同版本去重**（2026-10-23）：连续点「立即更新」不再叠着下好几份 ——
        // 每次覆盖 sDownloadId，旧的那份下完了也会因为对不上号被扔掉
        if (sDownloadId >= 0 && sPendingVersionCode == m.versionCode) {
            int st = statusOf(c, sDownloadId);
            if (st == DownloadManager.STATUS_RUNNING || st == DownloadManager.STATUS_PENDING) {
                Toast.makeText(activity, "已经在下载了，下好会提示安装", Toast.LENGTH_SHORT).show();
                return;
            }
        }
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
        sInstallStarted = false;
        sDownloadId = dm.enqueue(req);
        sPendingSha256 = m.sha256;
        sPendingVersionCode = m.versionCode;
        savePending(c, sDownloadId, m.sha256, m.versionCode);
        Log.i(TAG, "开始下载 id=" + sDownloadId + " " + apkUrl);
        Toast.makeText(activity, "正在后台下载，下好会提示安装", Toast.LENGTH_SHORT).show();
        // 三重保险（见类注释）：广播会被 OEM 拦，所以 ①前台动态接收器 ②主动轮询
        registerLiveReceiver(c);
        startPolling(c);
    }

    /**
     * 下载完成。**在清单里注册**，不是动态注册 —— 用户下到一半退出 App
     * 也得能收到，不然那个包就白下了。
     *
     * ⚠️ 2026-10-23 实锤：这条广播在新系统上会被 OEM 拦掉（用户点了「立即更新」
     * 包下到了手机里，安装界面永远不弹）—— 所以它只是三重保险之一，
     * 前台动态接收器和轮询才是主力，见类注释。
     */
    public static class DownloadReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
            boolean ours = (id == sDownloadId && sDownloadId >= 0)
                    || id == pendingId(context.getApplicationContext());
            if (!ours) {
                return;
            }
            Log.i(TAG, "下载完成（清单广播） id=" + id);
            stopWatching(context.getApplicationContext());
            new Thread(() -> verifyAndInstall(context)).start();
        }
    }

    // ------------------------------------------------- 三重保险：前台接收 + 轮询 + 烂尾接手

    /**
     * 前台动态接收器。动态注册的不受「静态接收器被 OEM 拦广播」影响，
     * App 活着期间 DOWNLOAD_COMPLETE 一定送到。
     */
    private static void registerLiveReceiver(Context c) {
        if (sLiveReceiver != null) {
            return;   // 已经挂着
        }
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != sDownloadId || sDownloadId < 0) {
                    return;
                }
                Log.i(TAG, "下载完成（前台直收） id=" + id);
                stopWatching(context.getApplicationContext());
                new Thread(() -> verifyAndInstall(context)).start();
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                c.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED);
            } else {
                c.registerReceiver(r, f);
            }
            sLiveReceiver = r;
            Log.i(TAG, "已挂前台接收器");
        } catch (Exception e) {
            Log.w(TAG, "挂前台接收器失败: " + e);
        }
    }

    /** 轮询间隔（ms）：3s 起、逐步放长，整轮约 1 分钟，之后就交给广播/下次启动 */
    private static final long[] POLL_STEPS = {3000L, 5000L, 8000L, 10000L, 15000L, 15000L};

    /** 用 id 主动问 DownloadManager「下完没有」—— 不依赖任何广播 */
    private static void startPolling(Context c) {
        stopPolling();
        sPollContext = c.getApplicationContext();
        sPollStep = 0;
        sUi.postDelayed(sPollTick, POLL_STEPS[0]);
        Log.i(TAG, "开始轮询下载状态");
    }

    private static void stopPolling() {
        sUi.removeCallbacks(sPollTick);
    }

    private final static Runnable sPollTick = new Runnable() {
        @Override
        public void run() {
            Context c = sPollContext;
            if (c == null || sDownloadId < 0 || sInstallStarted) {
                return;
            }
            int st = statusOf(c, sDownloadId);
            if (st == DownloadManager.STATUS_SUCCESSFUL) {
                Log.i(TAG, "轮询逮到下载完成 id=" + sDownloadId);
                stopWatching(c);
                new Thread(() -> verifyAndInstall(c)).start();
                return;
            }
            if (st == DownloadManager.STATUS_FAILED) {
                Log.w(TAG, "轮询发现下载失败 id=" + sDownloadId);
                stopWatching(c);
                clearPending(c);
                sDownloadId = -1L;
                toast(c, "下载失败，请在「设置 → 关于」重试");
                return;
            }
            // 还在下（PENDING / RUNNING / PAUSED 等网络）—— 按 POLL_STEPS 放长间隔继续等
            sPollStep++;
            if (sPollStep >= POLL_STEPS.length) {
                Log.i(TAG, "轮询超时（还没下完），交给广播或下次启动接手");
                return;
            }
            sUi.postDelayed(sPollTick, POLL_STEPS[sPollStep]);
        }
    };

    /** 收摊：轮询停掉、前台接收器摘掉。三种「下载完成」来源只许第一个进安装 */
    private static void stopWatching(Context c) {
        stopPolling();
        if (sLiveReceiver != null) {
            try {
                c.unregisterReceiver(sLiveReceiver);
            } catch (Exception ignored) {
            }
            sLiveReceiver = null;
        }
    }

    /**
     * 冷启动 / 回前台时接手烂尾：上次「点过立即更新」但没装上的，按记录的 id
     * 问 DownloadManager —— 下完了直接接着装，还在下就把接收器和轮询挂回去，
     * 失败了清掉记录。用户不用再点一次、也不再白下载一份。
     */
    private static void recoverPending(Activity activity) {
        Context c = activity.getApplicationContext();
        long id = pendingId(c);
        if (id < 0) {
            return;
        }
        int st = statusOf(c, id);
        if (st == DownloadManager.STATUS_SUCCESSFUL) {
            sDownloadId = id;
            sPendingSha256 = pendingSha(c);
            sPendingVersionCode = pendingVc(c);
            Log.i(TAG, "接手烂尾：包其实下完了 id=" + id + "，继续安装");
            new Thread(() -> verifyAndInstall(c)).start();
        } else if (st == DownloadManager.STATUS_FAILED) {
            Log.w(TAG, "接手烂尾：上次下载失败 id=" + id + "，清掉记录");
            clearPending(c);
        } else if (st > 0 && sDownloadId < 0) {
            // 还在下：把上下文捡回来，接收器 + 轮询重新挂上
            sDownloadId = id;
            sPendingSha256 = pendingSha(c);
            sPendingVersionCode = pendingVc(c);
            sInstallStarted = false;
            registerLiveReceiver(c);
            startPolling(c);
        }
        // st <= 0（id 查不到，多半被系统清了任务）：缓存被清过一条下载记录就没了，
        // 但**内部那份安装包可能还在** —— 直接装它，别让用户白下一次。
        if (st <= 0) {
            File dst = new File(c.getFilesDir(), "update/schedule.apk");
            sPendingVersionCode = pendingVc(c);
            sPendingSha256 = pendingSha(c);
            if (dst.exists() && dst.length() > 0 && matchesPendingSha(dst)) {
                Log.i(TAG, "下载记录没了，但内部包还在（" + dst.length() + " 字节），直接装");
                sInstallStarted = false;
                installApk(c, dst);
                return;
            }
            clearPending(c);
            clearPromptCooldown(c);
        }
    }

    private static int statusOf(Context c, long id) {
        if (id < 0) {
            return -1;
        }
        DownloadManager dm = (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) {
            return -1;
        }
        Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id));
        if (cur == null) {
            return -1;
        }
        try {
            if (cur.moveToFirst()) {
                return cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            }
            return -1;
        } finally {
            cur.close();
        }
    }

    // ------------------------------------------------- 烂尾记录（SharedPreferences）

    private static void savePending(Context c, long id, String sha, int vc) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(KEY_PENDING_ID, id)
                .putString(KEY_PENDING_SHA, sha)
                .putInt(KEY_PENDING_VC, vc)
                .apply();
    }

    private static long pendingId(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_PENDING_ID, -1L);
    }

    private static String pendingSha(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING_SHA, null);
    }

    private static int pendingVc(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_PENDING_VC, 0);
    }

    /**
     * 内部那份是不是「就是要装的这一版」。
     *
     * 没记 sha 的老记录一律放过：宁可让安装器去报签名/版本不对，也不要
     * 因为缺个校验值就把一份完好的包丢掉（丢了的代价是重下 3.5MB 还不一定成功）。
     */
    private static boolean matchesPendingSha(File f) {
        String want = sPendingSha256;
        if (want == null || want.isEmpty()) {
            return true;
        }
        try {
            return want.equalsIgnoreCase(sha256(f));
        } catch (Exception e) {
            Log.w(TAG, "算内部包的 sha 失败: " + e);
            return false;
        }
    }

    /**
     * 清掉「这个版本 24 小时内别再弹」的冷却。
     *
     * 只在**这次更新彻底没成**时调（包没了 / 换了新版本号重来）。不清的话，
     * 用户会陷入「提示过一次 → 装不上 → 之后 24 小时静默」的死角，
     * 表现就是「更新功能坏了」。
     */
    private static void clearPromptCooldown(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_LAST_PROMPT_CODE).remove(KEY_LAST_PROMP_AT).apply();
    }

    private static void clearPending(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_PENDING_ID).remove(KEY_PENDING_SHA).remove(KEY_PENDING_VC)
                .apply();
    }

    /** 校验 sha256 → 拷进内部存储 → 唤起系统安装器。
     *  三种来源（清单广播 / 前台接收器 / 轮询）都可能叫它，{@code sInstallStarted} 挡重入。 */
    private static void verifyAndInstall(Context c) {
        c = c.getApplicationContext();
        if (sInstallStarted) {
            Log.i(TAG, "安装流程已在进行，跳过重入");
            return;
        }
        sInstallStarted = true;
        File tmp = new File(c.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                "schedule-" + sPendingVersionCode + ".apk");
        /* 内部目录那一份：**拷完外部那份就删掉了**（见下面拷贝那段）。
           所以「外部文件不在」根本不能推出「没下载成功」—— 上一次装到一半
           被用户取消 / 安装器自己退了，下次进来外部早没了，这里却当失败处理，
           把 pending 记录和内部那份好包一起扔掉。
           2026-10-26 用户实锤：连着几次更新都卡死在这儿，而且 cooldown 已经被
           标过，24 小时内连提示都不再弹，看起来就是「App 更新功能坏了」。 */
        File dst = new File(c.getFilesDir(), "update/schedule.apk");
        if (!tmp.exists()) {
            if (dst.exists() && dst.length() > 0 && matchesPendingSha(dst)) {
                Log.i(TAG, "外部包已删、内部那份还在（" + dst.length() + " 字节），直接重装");
                installApk(c, dst);
                return;
            }
            Log.w(TAG, "下载的文件不在（内部目录也没有）: " + tmp);
            toast(c, "安装包不见了，稍后会重新提示更新");
            sInstallStarted = false;
            clearPending(c);
            clearPromptCooldown(c);   // 否则 24h 内不再提示，用户只能以为它坏了
            sDownloadId = -1L;
            return;
        }
        String actual = sha256(tmp);
        if (sPendingSha256 != null && !sPendingSha256.isEmpty()
                && !sPendingSha256.equals(actual)) {
            Log.w(TAG, "sha256 不符：期望 " + sPendingSha256 + " 实际 " + actual);
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            toast(c, "安装包校验失败，已删除。请重新更新");
            sInstallStarted = false;
            clearPending(c);
            sDownloadId = -1L;
            return;
        }
        // 拷进内部存储再装 —— 见类注释第 2 条
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
            sInstallStarted = false;   // 包还在外部目录，下次启动还能接手重试
            return;
        }
        // 交给系统安装器了：这单结清。用户点「安装」是同签名覆盖安装。
        // 等安装器真正装上再清下载记录 —— 点「取消 / 直接打开」不算装完，
        // 保留 pendingId/pendingSha/pendingVc，下次自动提示安装而不是重新下载。
        // 之前是这里就 clearPending，旧包删了、新包没装，等于白下一次。
        // 装完的确认靠 selfVersionCode >= sPendingVersionCode（见 onResume）。
        installApk(c, dst);
    }

    /**
     * 安装器回来后的确认：pending 的包到底装上没有。
     *
     * 调用点：{@link #onResume}（每次回前台）。装上了 → 清记录 + toast 版本号；
     * 没装上（用户点了取消 / 直接打开）→ 留着记录和文件，toast 提示还有包没装。
     * 之前没有这一步：verifyAndInstall 里下完就清记录，用户取消一次就得重下。
     */
    private static void confirmInstalled(Context c) {
        if (sPendingVersionCode <= 0) {
            return;
        }
        long self = selfVersionCode(c);
        if (self >= sPendingVersionCode) {
            Log.i(TAG, "确认已装上 versionCode=" + self + "，清掉 pending");
            clearPending(c);
            sDownloadId = -1L;
            sInstallStarted = false;
            toast(c, "已更新到最新版本");
        } else {
            sInstallStarted = false;   // 允许下次重新唤起安装器
            Log.i(TAG, "还没装上（self=" + self + " pending=" + sPendingVersionCode + "）");
            toast(c, "新版本已下载，点「检查更新」继续安装");
        }
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
