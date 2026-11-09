package space.xiaokubao.schedule;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * AppUpdate —— APK 自更新。
 *
 * 分两层，别混：
 *   · 网页层（dist/）—— 不在这一管，刷新页面就好（nginx 直读）。
 *   · 原生层（本类）—— 只能靠换 APK。
 *
 * 流程：
 *   1. 启动 3 秒后拉 {@code /schedule/dl/version.json}，比 versionCode。
 *   2. 有新版且没在 24h 内提示过 → 弹框「立即更新 / 稍后」。
 *   3. **本进程自己**用 HttpURLConnection 把 APK 下到内部 {@code filesDir/update/}，
 *      边下边记进度，写完校验 Content-Length 与 sha256。
 *   4. 校验通过 → 核对包名/versionCode → FileProvider 唤起系统安装器。
 *
 * 2026-11-09 真机实锤的根因（OPPO PLJ110 / Android 17）：
 *   以前用系统 DownloadManager + {@code setDestinationInExternalFilesDir()}，
 *   把包写进 {@code Android/data/<pkg>/files/Download/}。新系统上
 *   DownloadProvider 会往 MediaProvider 插入这条记录，直接被拒：
 *     E DownloadManager: Error inserting into mediaProvider:
 *       java.lang.IllegalArgumentException: Inserting private file:
 *       Android/data/space.xiaokubao.schedule/files/Download/ is not allowed.
 *   于是下载任务当场作废（my_downloads 里查不到），磁盘上只留一个 0 字节的
 *   {@code schedule-<vc>.apk.oplusdownload}。而客户端的轮询把「任务查不到」
 *   当成「还在下」，一路打印「下载中 -1%」直到超时，既不重试、不提示、也不清
 *   24h 冷却 —— 用户看到的就是「点了更新永远没反应」，且此后一整天不再弹。
 *
 *   修法：**不再把下载交给系统下载服务**。清单能拉到说明本进程的 HTTPS 栈
 *   是通的，用同一条栈下 APK 即可；顺带把「外部目录 → 拷贝 → FileProvider」
 *   和「静态广播 + 动态接收器 + 轮询 + 烂尾接手」四套兜底一起删掉 ——
 *   它们全是在给 DownloadManager 的不可靠擦屁股，现在没有那个前提了。
 *
 * 两个保留的硬约束：
 * 1. **必须校验收敛的 sha256，且要核对 APK 身份。** sha256 证明字节没损坏，
 *    {@link #apkIdentityOk} 证明包里装的就是清单说的那个版本（包名 + versionCode）。
 *    两样都不对时不拉安装器，否则用户只会反复看到「应用未安装」。
 * 2. **安装未知应用权限要用户手动授。** Android 8 起 {@code REQUEST_INSTALL_PACKAGES}
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
    private static final String KEY_LAST_PROMPT_AT = "lastPromptAt";
    /** 同一个版本 24 小时内不重复弹 */
    private static final long PROMPT_COOLDOWN_MS = 24 * 3600 * 1000L;

    /* ---- 守护（watchdog，2026-11-09）----
       只在启动那 3 秒查一次是不够的：用户可能几天不重启 App，就永远收不到新版。
       再加三道：回前台超 6h 补查、下载总时长看门狗、检查/下载互斥防叠框空转。 */
    /** 回前台距上次成功检查超过这么久就静默补一次 */
    private static final long RECHECK_INTERVAL_MS = 6 * 3600 * 1000L;
    /** readTimeout 只管「两次读之间」，防不住极慢但一直有数据的流 */
    private static final long DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000L;
    private static final String KEY_LAST_CHECK_AT = "lastCheckAt";
    private static final Object CHECK_LOCK = new Object();
    /** 自动检查互斥：启动延时那次与前台守护那次会撞在同一帧 */
    private static volatile boolean sAutoCheckInFlight = false;
    /** 下载互斥：连点「立即更新」/ 重装路径与下载线程并发时只跑一条 */
    private static volatile boolean sDownloadInFlight = false;
    /** 正在显示的更新弹窗，防叠两个框 */
    private static volatile AlertDialog sPrompt = null;

    /** 本次要装的版本与它的 sha256。冷启动时字段会丢，从 {@link #PREFS} 捞回来 */
    static volatile String sPendingSha256;
    static volatile int sPendingVersionCode;

    /** 「已经进了安装流程」防重入：下载线程与回前台接手可能同时报到 */
    private static volatile boolean sInstallStarted = false;
    private static final Object INSTALL_LOCK = new Object();

    /**
     * 已把用户送去「安装未知应用」设置页，等他回来补一次检查。
     * 见 {@link #onResume} —— 这是那类「点了却没做成」的自动补救。
     */
    private static volatile boolean sWaitingForPermission = false;

    private static final String KEY_PENDING_SHA = "pendingSha";
    private static final String KEY_PENDING_VC = "pendingVc";

    // ------------------------------------------------------------ 检查结果回执

    /**
     * 一次「检查」的真实结局（2026-11-07）。
     *
     * 为什么需要它：以前网页点「检查更新」只能知道**原生接住了调用**，
     * 不知道后面是查到了新版、已是最新、还是网络挂了。用户看到按钮转一下就
     * 恢复，却不知道到底查没查 —— 于是「更新时好时坏」永远说不清卡在哪一步。
     */
    static final int R_LATEST = 0;        // 已是最新
    static final int R_FOUND = 1;         // 发现新版本（弹窗已出）
    static final int R_MANIFEST_BAD = 2;  // 清单拿到了但内容不对
    static final int R_NETWORK = 3;       // 网络不通 / 服务端没响应
    static final int R_INSTALLING = 4;    // 已有下载好的包，正在唤起安装器
    static final int R_BAD_APK = 5;       // 包已下载，但包名/版本号和当前 App 不符

    interface CheckResult {
        /** @param message 给人看的一句话（可能与 toast 相同）；成功时可为空 */
        void done(int status, Manifest m, String message);
    }

    // ---------------------------------------------------------------- 对外入口

    /**
     * 启动时检查一次。延迟 3 秒 —— 一进 App 就弹框太突兀，等界面稳下来。
     * 失败一律静默：没网、服务端没这文件、版本号写错，都不该打扰用户。
     */
    static void checkOnLaunch(final Activity activity) {
        // 上次有没有「下到一半 / 下完没装」的烂尾 —— 先接手
        recoverPending(activity);
        activity.getWindow().getDecorView().postDelayed(new Runnable() {
            @Override
            public void run() {
                checkAndPrompt(activity, false, null);
            }
        }, 3000L);
    }

    /** 关于页「检查更新」按钮走 force = true：用户主动点的，不该被冷却挡着。 */
    static void checkForced(final Activity activity) {
        checkAndPrompt(activity, true, null);
    }

    /** 带回执的强制检查：网页据此显示「已是最新 / 发现 vX / 网络不通」。 */
    static void checkForced(final Activity activity, CheckResult cb) {
        checkAndPrompt(activity, true, cb);
    }

    /**
     * 从「安装未知应用」设置页回来时调一次。
     * 顺序不能反：**先确认上一轮到底装上没有**，再谈接手烂尾。
     */
    static void onResume(final Activity activity) {
        confirmInstalled(activity.getApplicationContext());
        recoverPending(activity);
        if (sWaitingForPermission) {
            sWaitingForPermission = false;
            Log.i(TAG, "授权回来，补一次更新检查");
            checkForced(activity);
        }
        /* 前台守护：只在 onCreate 延时查一次的话，几天不重启的用户永远收不到新版。
           回前台且距上次**成功**检查超过 6 小时，静默补一次（force=false，失败不打扰）。
           注意不能在这里直接查完事 —— 启动那次延时检查也排在 3 秒后，两者由
           sAutoCheckInFlight 互斥，只会跑一条。 */
        final Context c = activity.getApplicationContext();
        long last = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getLong(KEY_LAST_CHECK_AT, 0L);
        if (System.currentTimeMillis() - last >= RECHECK_INTERVAL_MS) {
            Log.i(TAG, "前台守护：距上次检查超过 6 小时，补一次");
            activity.getWindow().getDecorView().postDelayed(new Runnable() {
                @Override public void run() { checkAndPrompt(activity, false, null); }
            }, 3000L);
        }
    }

    /**
     * 检查更新。{@code force} = 跳过冷却 + 「已是最新」也给 toast。
     *
     * {@code cb} 是「这次检查的结局」，**每条返回路径都必须调一次**（见 finish）。
     * 漏一条路的后果是网页那边的「检查中」永远不结束 —— 比不给回执更糟。
     */
    private static void checkAndPrompt(final Activity activity, final boolean force, final CheckResult cb) {
        /* 自动检查互斥（force 的用户主动检查不挡）：启动延时那次与前台守护那次
           会同时排到 3 秒后，不互斥就会起两条线程、叠两个弹窗。 */
        if (!force) {
            synchronized (CHECK_LOCK) {
                if (sAutoCheckInFlight) {
                    Log.i(TAG, "已有自动检查在跑，跳过这次");
                    return;
                }
                sAutoCheckInFlight = true;
            }
        }
        final Context c = activity.getApplicationContext();
        final boolean[] once = new boolean[1];
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Manifest m = fetchManifest();
                    if (m == null) {
                        if (force) {
                            toast(c, "检查失败：版本清单异常，请稍后再试");
                        }
                        report(once, cb, R_MANIFEST_BAD, null, "版本清单异常，请稍后再试");
                        return;
                    }
                    /* 清单真的拿到了才算「检查过」。网络挂了不清这个时间戳，
                       下次回前台守护会接着试，不会静默停摆一整天。 */
                    markChecked(c);
                    long self = selfVersionCode(c);
                    if (m.versionCode <= self) {
                        Log.i(TAG, "已是最新 versionCode=" + self);
                        if (force) {
                            toast(c, "已是最新版本（versionCode " + self + "）");
                        }
                        report(once, cb, R_LATEST, m, "已是最新版本");
                        return;
                    }
                    // 同一版本的包已经下好但没装（用户上次在安装器点了取消）——
                    // 不重下，直接再唤起一次安装器。
                    if (force && m.versionCode == sPendingVersionCode) {
                        File pending = pendingApkFile(c, m.versionCode);
                        if (pending.exists() && pending.length() > 0 && matchesPendingSha(pending)) {
                            Log.i(TAG, "pending 包还在，直接重装 " + pending.length() + " 字节");
                            if (!claimInstall()) {
                                report(once, cb, R_INSTALLING, m, "正在打开安装程序");
                                return;
                            }
                            boolean opened = installApk(c, pending);
                            report(once, cb, opened ? R_INSTALLING : R_BAD_APK,
                                    opened ? m : null,
                                    opened
                                            ? "已下载好新版本，正在打开安装程序"
                                            : "下载好的安装包和当前 App 不匹配，已删除，请重新检查更新");
                            return;
                        }
                        Log.i(TAG, "pending 记录在但文件没了，重新下载");
                    }
                    if (!force && !shouldPrompt(c, m.versionCode)) {
                        Log.i(TAG, "有新版 " + m.versionCode + " 但 24h 内提示过了，跳过");
                        report(once, cb, R_FOUND, m, "有新版本，24 小时内已提示过");
                        return;
                    }
                    showPrompt(activity, m);
                    report(once, cb, R_FOUND, m, "发现新版本 " + m.versionName);
                } catch (Exception e) {
                    Log.w(TAG, "检查更新失败: " + e);
                    if (force) {
                        toast(c, "检查失败：网络不通或服务端没响应，请稍后再试");
                    }
                    report(once, cb, R_NETWORK, null, "网络不通或服务端没响应，请稍后再试");
                } finally {
                    if (!force) sAutoCheckInFlight = false;
                }
            }
        }).start();
    }

    /** 记一次「检查真的完成」，供前台守护算 6 小时间隔 */
    private static void markChecked(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(KEY_LAST_CHECK_AT, System.currentTimeMillis()).apply();
    }

    /** 发回执，**只发一次**。布尔数组是因为匿名内部类只能捕获 final 局部变量。 */
    private static void report(boolean[] once, CheckResult cb, int status, Manifest m, String message) {
        if (cb == null || once[0]) return;
        once[0] = true;
        try {
            cb.done(status, m, message);
        } catch (Exception e) {
            Log.w(TAG, "回执抛错: " + e);
        }
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

    /** 清单拉取守护：一次瞬断不该让用户白等 6 小时（或以为功能坏了）。重试一次、短退避。 */
    private static Manifest fetchManifest() throws Exception {
        Exception last = null;
        for (int i = 0; i < 2; i++) {
            try {
                return fetchManifestOnce();
            } catch (Exception e) {
                last = e;
                Log.w(TAG, "拉清单第 " + (i + 1) + " 次失败: " + e);
                if (i == 0) {
                    try { Thread.sleep(600L); }
                    catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                }
            }
        }
        throw last == null ? new java.io.IOException("拉取版本清单失败") : last;
    }

    private static Manifest fetchManifestOnce() throws Exception {
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
        long at = sp.getLong(KEY_LAST_PROMPT_AT, 0L);
        return !(last == versionCode && System.currentTimeMillis() - at < PROMPT_COOLDOWN_MS);
    }

    private static void markPrompted(Context c, int versionCode) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt(KEY_LAST_PROMPT_CODE, versionCode)
                .putLong(KEY_LAST_PROMPT_AT, System.currentTimeMillis())
                .apply();
    }

    private static void showPrompt(final Activity activity, final Manifest m) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (activity.isFinishing() || activity.isDestroyed()) {
                    return;
                }
                /* 守护：授权回来补查 + 前台守护 + 启动检查三条路可能同时到达，
                   不挡就会叠两个「发现新版本」框，用户点一次其实发两次下载。 */
                if (sPrompt != null && sPrompt.isShowing()) {
                    Log.i(TAG, "更新弹窗已在显示，不叠框");
                    return;
                }
                String cur = selfVersionName(activity);
                Log.i(TAG, "弹更新提示: 新 " + m.versionCode + "(" + m.versionName
                        + ") / 当前 " + selfVersionCode(activity) + "(" + cur + ")");
                String msg = "新版本 " + m.versionName + "（versionCode " + m.versionCode + "）"
                        + "\n当前 " + cur
                        + (m.notes.isEmpty() ? "" : "\n\n" + m.notes);
                sPrompt = new AlertDialog.Builder(activity)
                        .setTitle("发现新版本")
                        .setMessage(msg)
                        .setNegativeButton("稍后", null)
                        .setPositiveButton("立即更新", (d, w) -> startDownload(activity, m))
                        .setOnDismissListener(dlg -> sPrompt = null)
                        .show();
            }
        });
    }

    // ---------------------------------------------------------------- 下载与安装

    /**
     * 点「立即更新」后的入口。**权限检查在前**，没权限时早退去设置页、不写冷却，
     * 交给 {@link #onResume} 补刀（2026-10-17 修的老问题：先标记后早退 = 那次更新
     * 彻底丢了，24h 内再也不提示）。
     */
    private static void startDownload(final Activity activity, final Manifest m) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            Log.i(TAG, "没有「安装未知应用」权限 → 先送设置页");
            Toast.makeText(activity, "请先允许本应用「安装未知应用」，回来会自动继续", Toast.LENGTH_LONG).show();
            sWaitingForPermission = true;
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(i);
            return;
        }
        /* 下载互斥守护：连点弹窗 / 强制重装路径与下载线程并发时，只跑一条。
           两条线程同时写同一个 .part 会把彼此的字节搅在一起，sha 必然不过。 */
        synchronized (INSTALL_LOCK) {
            if (sDownloadInFlight) {
                Log.i(TAG, "已有下载在跑，忽略重复触发");
                return;
            }
            sDownloadInFlight = true;
        }
        Context c = activity.getApplicationContext();
        sPendingSha256 = m.sha256;
        sPendingVersionCode = m.versionCode;
        sInstallStarted = false;
        savePending(c, m.sha256, m.versionCode);
        markPrompted(activity, m.versionCode);

        // 同版本已经有完好包（上次在安装器点了取消）—— 不重下
        File dst = pendingApkFile(c, m.versionCode);
        if (dst.exists() && dst.length() > 0 && matchesPendingSha(dst)) {
            Log.i(TAG, "同版本包已在，直接重装 " + dst.length() + " 字节");
            if (claimInstall()) {
                installApk(c, dst);
            }
            sDownloadInFlight = false;
            return;
        }
        Toast.makeText(activity, "正在下载新版本，下好会提示安装", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try { downloadAndInstall(c, m); }
            finally { sDownloadInFlight = false; }
        }, "app-update-download").start();
    }

    /**
     * 用本进程的 HTTPS 栈把 APK 直接下到内部目录。
     *
     * 为什么不再用 DownloadManager：见类注释 2026-11-09 根因。顺带说明这里
     * 「直接写内部目录」是刻意的 —— 系统安装器读得到 filesDir，且下载过程
     * 不经过外部存储 / MediaProvider，绕开了 OEM 的私有文件限制。
     *
     * 先写 {@code .part}，全部校验通过才 rename 成正式文件：中途被杀 / 断网
     * 只会留下一个不完整的 .part，{@link #recoverPending} 看见就会清记录重来，
     * 绝不会把一个坏包递给安装器。
     */
    private static void downloadAndInstall(Context c, Manifest m) {
        c = c.getApplicationContext();
        String apkUrl = BuildConfig.UPDATE_BASE.replaceAll("/+$", "") + "/dl/" + m.url;
        File dst = pendingApkFile(c, m.versionCode);
        File dir = dst.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) {
            failDownload(c, "建不了下载目录 " + dir);
            return;
        }
        File part = new File(dir, dst.getName() + ".part");
        HttpURLConnection conn = null;
        try {
            Log.i(TAG, "开始下载 " + apkUrl);
            conn = (HttpURLConnection) new URL(apkUrl).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("HTTP " + code);
            }
            long total = conn.getContentLengthLong();
            long done = 0;
            int nextLog = 10;
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[16384];
                int n;
                /* 看门狗：readTimeout 只保证「两次读之间不超过 20 秒」，
                   极慢但一直有数据的流能无限拖下去 —— 用户看到的就是
                   「点了更新一直在下」。超过 5 分钟一律中断并回滚（failDownload
                   会清 pending / 冷却，允许立刻重试）。 */
                final long startedAt = System.currentTimeMillis();
                while ((n = in.read(buf)) > 0) {
                    if (System.currentTimeMillis() - startedAt > DOWNLOAD_TOTAL_TIMEOUT_MS) {
                        throw new IOException("下载超过 5 分钟，看门狗已中断");
                    }
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct >= nextLog) {
                            Log.i(TAG, "下载 " + pct + "%（" + done + "/" + total + "）");
                            nextLog = pct + 10;
                        }
                    }
                }
                out.flush();
            }
            if (total > 0 && done != total) {
                throw new IOException("长度不符 " + done + "/" + total);
            }
            if (done <= 0) {
                throw new IOException("下载到 0 字节");
            }
            String actual = sha256(part);
            if (m.sha256 != null && !m.sha256.isEmpty() && !m.sha256.equalsIgnoreCase(actual)) {
                throw new IOException("sha256 不符 期望=" + m.sha256 + " 实际=" + actual);
            }
            // 目标位置可能有上一次没装成的同版本包，renameTo 不会覆盖已存在的文件
            if (dst.exists() && !dst.delete()) {
                throw new IOException("删不掉旧的 " + dst);
            }
            if (!part.renameTo(dst)) {
                throw new IOException("重命名失败 " + part);
            }
            /* ⚠️ 必须放在 rename **之后**：sweepOldApks 会清掉 update 目录里所有
               .apk / .apk.part，提前调用会把刚写完的 part 一起删掉 —— 2026-11-09
               真机上 3.65MB 已经 100% 下完、sha 也过了，最后一步却报
               「重命名失败 schedule-128.apk.part」，就是这么来的。 */
            sweepOldApks(c, dst);
            Log.i(TAG, "下载完成 " + dst.length() + " 字节，唤起安装器");
            sPendingSha256 = m.sha256;
            sPendingVersionCode = m.versionCode;
            if (claimInstall()) {
                installApk(c, dst);
            }
        } catch (Exception e) {
            Log.w(TAG, "下载安装包失败: " + e);
            failDownload(c, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /** 下载失败：删半成品、清 pending 与冷却，给一句人能看懂的原因。 */
    private static void failDownload(Context c, String why) {
        File dst = pendingApkFile(c, sPendingVersionCode);
        //noinspection ResultOfMethodCallIgnored
        new File(dst.getParentFile(), dst.getName() + ".part").delete();
        clearPending(c);
        clearPromptCooldown(c);   // 不清的话 24h 内不再提示，等于把功能关掉
        sInstallStarted = false;
        toast(c, "下载安装包失败：" + why + "，请稍后重试");
    }

    /**
     * 冷启动 / 回前台时接手烂尾：上次点了更新但没装上的，看内部那份完整包还在不在。
     * 不在（进程被杀 / 断网）就清记录 + 冷却，3 秒后的自动检查会重新弹窗下载。
     */
    private static void recoverPending(Activity activity) {
        Context c = activity.getApplicationContext();
        int vc = pendingVc(c);
        if (vc <= 0) {
            return;
        }
        if (selfVersionCode(c) >= vc) {
            Log.i(TAG, "已经装上 versionCode=" + vc + "，清掉 pending");
            clearPending(c);
            return;
        }
        sPendingVersionCode = vc;
        sPendingSha256 = pendingSha(c);
        File dst = pendingApkFile(c, vc);
        if (dst.exists() && dst.length() > 0 && matchesPendingSha(dst)) {
            Log.i(TAG, "接手烂尾：包其实下完了（" + dst.length() + " 字节），继续安装");
            if (claimInstall()) {
                installApk(c, dst);
            }
            return;
        }
        Log.i(TAG, "接手烂尾：包不完整，清记录等自动重检");
        clearPending(c);
        clearPromptCooldown(c);
    }

    /**
     * 安装器回来后的确认：pending 的包到底装上没有。
     * 装上了 → 清记录 + toast；包还在 → 提示继续装；包没了 → 别误导用户，
     * 清记录和冷却让自动检查重来（旧版这里一律说「已下载」，下载失败时也这么说）。
     */
    private static void confirmInstalled(Context c) {
        if (sPendingVersionCode <= 0) {
            sPendingVersionCode = pendingVc(c);
        }
        if (sPendingSha256 == null || sPendingSha256.isEmpty()) {
            sPendingSha256 = pendingSha(c);
        }
        if (sPendingVersionCode <= 0) {
            return;
        }
        long self = selfVersionCode(c);
        if (self >= sPendingVersionCode) {
            Log.i(TAG, "确认已装上 versionCode=" + self + "，清掉 pending");
            clearPending(c);
            sInstallStarted = false;
            toast(c, "已更新到最新版本");
            return;
        }
        File dst = pendingApkFile(c, sPendingVersionCode);
        if (dst.exists() && dst.length() > 0 && matchesPendingSha(dst)) {
            sInstallStarted = false;
            Log.i(TAG, "还没装上（self=" + self + " pending=" + sPendingVersionCode + "）");
            toast(c, "新版本已下载，点「检查更新」继续安装");
        } else {
            clearPending(c);
            clearPromptCooldown(c);
        }
    }

    // ------------------------------------------------- 烂尾记录（SharedPreferences）

    private static void savePending(Context c, String sha, int vc) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_PENDING_SHA, sha)
                .putInt(KEY_PENDING_VC, vc)
                .apply();
    }

    private static String pendingSha(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING_SHA, null);
    }

    private static int pendingVc(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_PENDING_VC, 0);
    }

    /**
     * 内部那一份安装包的路径。**文件名必须带版本号**。
     *
     * ⚠️ 2026-10-26 实锤的坑：FileProvider 给出的 URI 是
     * `…/fileprovider/app_update/<文件名>`，文件名固定成 `schedule.apk` 时
     * **每次升级都是同一个 URI**。OPPO 的安装器（appdetail）按 URI 缓存解析结果，
     * 会拿上一份包的缓存来判版本，死活不让装。换文件名 = 换 URI = 不吃旧缓存。
     */
    private static File pendingApkFile(Context c, int versionCode) {
        return new File(c.getFilesDir(), "update/schedule-" + versionCode + ".apk");
    }

    /** 清掉内部目录里其它版本的包，别每升一次就白留 3.5MB */
    private static void sweepOldApks(Context c, File keep) {
        File[] fs = new File(c.getFilesDir(), "update").listFiles();
        if (fs == null) {
            return;
        }
        for (File f : fs) {
            if (keep != null && f.getAbsolutePath().equals(keep.getAbsolutePath())) {
                continue;
            }
            if (f.getName().endsWith(".apk") || f.getName().endsWith(".apk.part")) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    /** 没记 sha 的老记录一律放过：宁可让安装器报错，也别把一份好包丢掉。 */
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

    /** 清掉「这个版本 24 小时内别再弹」的冷却，只在这次更新彻底没成时调。 */
    private static void clearPromptCooldown(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_LAST_PROMPT_CODE).remove(KEY_LAST_PROMPT_AT).apply();
    }

    private static void clearPending(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_PENDING_SHA).remove(KEY_PENDING_VC).apply();
    }

    /** 原子地抢「安装流程」标记，防止下载线程与回前台接手同时唤起安装器。 */
    private static boolean claimInstall() {
        synchronized (INSTALL_LOCK) {
            if (sInstallStarted) {
                return false;
            }
            sInstallStarted = true;
            return true;
        }
    }

    /**
     * 安装前核对 APK 的「身份」（2026-11-07）。
     * sha256 只能证明字节和清单一致，证明不了「这个包就是我要装的那个版本」。
     * 这里查包名 + versionCode；签名交给系统安装器（客户端校验自己没有额外收益）。
     */
    private static boolean apkIdentityOk(Context c, File apk) {
        try {
            int flags = android.os.Build.VERSION.SDK_INT >= 28
                    ? PackageManager.GET_META_DATA | 0x00000080   // GET_SIGNING_CERTIFICATES
                    : PackageManager.GET_META_DATA;
            PackageInfo pi = c.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            if (pi == null) {
                Log.w(TAG, "读不出 APK 的包信息：" + apk);
                return false;
            }
            if (!c.getPackageName().equals(pi.packageName)) {
                Log.w(TAG, "包名不符：期望 " + c.getPackageName() + " 实际 " + pi.packageName);
                return false;
            }
            long vc = android.os.Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            if (sPendingVersionCode > 0 && vc != sPendingVersionCode) {
                Log.w(TAG, "versionCode 不符：清单说 " + sPendingVersionCode + " 包里是 " + vc);
                return false;
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "核对 APK 身份失败: " + e);
            return false;
        }
    }

    /**
     * 唤起系统安装器。
     *
     * @return true = 安装器真的被拉起来了；false = 没拉起（包身份不对 / 唤起异常）。
     */
    private static boolean installApk(Context c, File apk) {
        if (!apkIdentityOk(c, apk)) {
            toast(c, "安装包和当前 App 不匹配（包名或版本号不对），已删除。请稍后重新更新");
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
            clearPending(c);
            clearPromptCooldown(c);
            sInstallStarted = false;
            return false;
        }
        try {
            Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            Log.i(TAG, "已唤起系统安装器 " + uri);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "唤起安装器失败: " + e);
            toast(c, "无法唤起安装器：" + e.getClass().getSimpleName());
            sInstallStarted = false;
            return false;
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
        // 从下载线程来，不一定有 Looper —— 主线程一定在，交给它
        new android.os.Handler(android.os.Looper.getMainLooper()).post(
                () -> Toast.makeText(c.getApplicationContext(), s, Toast.LENGTH_LONG).show());
    }
}
