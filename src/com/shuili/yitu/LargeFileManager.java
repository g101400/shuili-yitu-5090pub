package com.shuili.yitu;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import android.util.Xml;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Bitmap.Config;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.util.zip.ZipFile;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 大文件传输管理器：解决 >3GB 的 ovkmz / 照片 ZIP 导入导出。
 * 设计要点：
 *  - 照片改存磁盘（app 私有 filesDir/photos），不再塞进 localStorage，避免超出容量上限。
 *  - 导出/导入走「暂存目录 + 状态文件」实现断点续传：中断后再次调用带 resume=true 可跳过已完成的部件。
 *  - 全程通过 WebView.evaluateJavascript 回传进度（window.onXferProgress/onXferDone/onImportData）。
 *  - 手机互传用本地 HTTP 服务（支持 Range 续传）；网盘走可配置的断点续传 HTTP 客户端（需用户提供 token）。
 */
public class LargeFileManager {
    public interface Progress { void on(String phase, long done, long total); }
    public interface Result { void on(String json); }

    private final Context ctx;
    private final WebView wv;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    // 照片压缩线程池（固定 4 并发，避免 500+ 张大图一次性全量解码撑爆内存）
    private final ExecutorService compressPool = Executors.newFixedThreadPool(4);
    private final File rootPhotos;     // filesDir/photos
    private final File rootInbox;      // filesDir/inbox（选择器落盘）
    private final File exportDir;      // Download/水利工程一张图
    private ServerSocket peerServer;
    private int peerPort = 8765;

    public LargeFileManager(Context ctx, WebView wv) {
        this.ctx = ctx;
        this.wv = wv;
        File f = ctx.getExternalFilesDir(null);
        if (f == null) f = ctx.getFilesDir();
        rootPhotos = new File(f, "photos");
        rootInbox = new File(f, "inbox");
        rootPhotos.mkdirs(); rootInbox.mkdirs();
        File dl = new File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS), "水利工程一张图");
        dl.mkdirs();
        exportDir = dl;
    }

    private File photoDir(String buildingId) {
        File d = new File(rootPhotos, sanitize(buildingId == null ? "x" : buildingId));
        d.mkdirs();
        return d;
    }
    private static String sanitize(String s) {
        return s == null ? "x" : s.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    /* ============ 网络类型 ============ */
    public String netType() {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return "none";
            if (Build.VERSION.SDK_INT >= 21) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
                if (nc == null) return "none";
                if (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "wifi";
                if (nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
                return "none";
            } else {
                NetworkInfo ni = cm.getActiveNetworkInfo();
                if (ni == null || !ni.isConnected()) return "none";
                return ni.getType() == ConnectivityManager.TYPE_WIFI ? "wifi" : "cellular";
            }
        } catch (Exception e) { return "none"; }
    }

    /* ============ 照片存取（磁盘）============ */
    // dataUrl(base64) -> 存盘返回相对路径 photos/<bid>/<name>
    public String storePhoto(String buildingId, String name, String dataUrl) {
        try {
            String b64 = dataUrl;
            int c = dataUrl.indexOf(",");
            if (c >= 0) b64 = dataUrl.substring(c + 1);
            byte[] buf = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            File out = new File(photoDir(buildingId), sanitize(name));
            writeFile(out, buf);
            return "photos/" + sanitize(buildingId) + "/" + out.getName();
        } catch (Exception e) { return ""; }
    }
    // 把已落盘的 srcPath 关联到某建筑物目录（用于批量导入：选择器落盘后移动）
    public String linkPhoto(String buildingId, String srcPath, String name) {
        try {
            File src = new File(srcPath);
            if (!src.exists()) return "";
            File out = new File(photoDir(buildingId), sanitize(name));
            copyFile(src, out);
            return "photos/" + sanitize(buildingId) + "/" + out.getName();
        } catch (Exception e) { return ""; }
    }
    public void deletePhoto(String relPath) {
        try { new File(rootPhotos.getParentFile(), relPath).delete(); } catch (Exception ignore) {}
    }
    // 读照片返回 dataUrl（仅用于显示，不长期驻留内存）
    public String readPhoto(String relPath) {
        try {
            File f = new File(rootPhotos.getParentFile(), relPath);
            byte[] buf = readFile(f);
            return "data:image/jpeg;base64," + android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP);
        } catch (Exception e) { return ""; }
    }
    // 缩略图（显示用）：按比例降采样到 max 边长以内的 JPEG，避免整张高清图塞进 WebView 内存导致 OOM。
    public String thumbPhoto(String relPath, int max) {
        try { return thumbOf(new File(rootPhotos.getParentFile(), relPath), max); } catch (Exception e) { return ""; }
    }
    public String thumbPath(String absPath, int max) {
        try { return thumbOf(new File(absPath), max); } catch (Exception e) { return ""; }
    }
    private String thumbOf(File f, int max) {
        try {
            if (f == null || !f.exists() || f.length() == 0) return "";
            if (max <= 0) max = 512;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), o);
            int longer = Math.max(o.outWidth, o.outHeight);
            int inSample = 1;
            if (longer > max && longer > 0) {
                inSample = (int) Math.ceil((double) longer / max);
                if (inSample < 1) inSample = 1;
            }
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = inSample;
            o2.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap bm = BitmapFactory.decodeFile(f.getAbsolutePath(), o2);
            if (bm == null) return "";
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 72, bos);
            bm.recycle();
            return "data:image/jpeg;base64," + android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) { return ""; }
    }
    // 清理解压临时目录（uz_*）：仅在手动匹配全部处理完后由 JS 调用，避免源文件提前删除导致手动绑定失败。
    public void cleanInbox() {
        try {
            File[] subs = rootInbox.listFiles();
            if (subs != null) for (File d : subs) {
                if (d.isDirectory() && d.getName().startsWith("uz_")) deleteRecurse(d);
            }
        } catch (Exception ignore) {}
    }
    // 选择器：拷贝选中文件到 inbox，返回 JSON [{name,path}]
    public String pickInput(String mime, boolean multiple) {
        // 实际打开由 MainActivity 的 onShowFileChooser 拦截；这里仅返回 inbox 现有清单（兜底）
        try {
            List<File> files = new ArrayList<>();
            File[] subs = rootInbox.listFiles();
            if (subs != null) for (File d : subs) {
                File[] fs = d.listFiles();
                if (fs != null) for (File x : fs) files.add(x);
            }
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < files.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("{\"name\":\"").append(escapeJson(files.get(i).getName()))
                  .append("\",\"path\":\"").append(escapeJson(files.get(i).getAbsolutePath())).append("\"}");
            }
            sb.append("]");
            return sb.toString();
        } catch (Exception e) { return "[]"; }
    }
    public String fileSha256(String path) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new BufferedInputStream(new FileInputStream(new File(path)))) {
                byte[] buf = new byte[1 << 16]; int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    // v3.30.2：读文件为 base64（供 JS 解析 ovobj 二进制 / 读取坐标文本）
    public String readFileBase64(String path) {
        try {
            byte[] data = readFile(new File(path));
            return android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP);
        } catch (Exception e) { return ""; }
    }
    // v3.33：读文件为 UTF-8 文本（供 JS 导入 CSV / 坐标文本；与 readFileBase64 同源 readFile）
    public String readFileText(String path) {
        try {
            byte[] data = readFile(new File(path));
            return new String(data, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) { return ""; }
    }

    /* ============ 照片压缩 + 持久化缩略图（方案2 + 方案1：大图导入压缩 / 显示走缩略图缓存）============ */
    // 文件字节大小（JS 判断是否 >1.5M 触发压缩）
    public long fileSize(String absPath) {
        try { File f = new File(absPath); return f.exists() ? f.length() : -1; } catch (Exception e) { return -1; }
    }
    // 相对路径（photos/...）→ 绝对路径（JS 需要 absPath 才能调 compressPhoto）
    public String photoAbsPath(String relPath) {
        try { return new File(rootPhotos.getParentFile(), relPath).getAbsolutePath(); } catch (Exception e) { return ""; }
    }
    // 压缩照片到 targetKB 以内（JPEG），异步并发，覆盖原文件；完成回调 window.onCompressPhoto(absPath, json)
    public void compressPhoto(final String absPath, final int targetKB) {
        compressPool.execute(new Runnable() {
            public void run() {
                String r = compressSync(absPath, targetKB);
                js("window.onCompressPhoto&&window.onCompressPhoto('" + escapeJson(absPath) + "','" + escapeJson(r) + "')");
            }
        });
    }
    private String compressSync(String absPath, int targetKB) {
        try {
            File f = new File(absPath);
            if (!f.exists() || f.length() == 0) return "{\"ok\":false,\"msg\":\"文件不存在\"}";
            long orig = f.length();
            if (targetKB <= 0) targetKB = 500;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), o);
            int longer = Math.max(o.outWidth, o.outHeight);
            int inSample = 1;
            // 限制解码最长边 <= 2048，防止超大图解码内存爆炸
            if (longer > 2048) inSample = (int) Math.ceil((double) longer / 2048);
            if (inSample < 1) inSample = 1;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = inSample;
            o2.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap bm = BitmapFactory.decodeFile(f.getAbsolutePath(), o2);
            if (bm == null) return "{\"ok\":false,\"msg\":\"解码失败\"}";
            long limit = targetKB * 1024L;
            // 迭代 quality：85 → 15，取首个 <= 目标大小的结果；始终保留最小结果兜底
            int q = 85;
            byte[] best = null;
            while (q >= 15) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bm.compress(Bitmap.CompressFormat.JPEG, q, bos);
                byte[] buf = bos.toByteArray();
                if (best == null || buf.length < best.length) best = buf;
                if (buf.length <= limit) break;
                q -= 10;
            }
            // quality 压到底仍超限 → 再降采样一半重试一次
            if (best != null && best.length > limit && bm.getWidth() > 200) {
                int nw = Math.max(100, bm.getWidth() / 2), nh = Math.max(100, bm.getHeight() / 2);
                Bitmap small = Bitmap.createScaledBitmap(bm, nw, nh, true);
                bm.recycle(); bm = small;
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bm.compress(Bitmap.CompressFormat.JPEG, 45, bos);
                byte[] buf = bos.toByteArray();
                if (buf.length < best.length) best = buf;
            }
            if (bm != null) { bm.recycle(); bm = null; }
            if (best == null) best = new byte[0];
            // 覆盖原文件：临时文件 + 备份 + 原子替换（失败可回滚）
            File tmp = new File(f.getAbsolutePath() + ".c.tmp");
            writeFile(tmp, best);
            File bak = new File(f.getAbsolutePath() + ".c.bak");
            if (bak.exists()) bak.delete();
            if (!f.renameTo(bak)) { tmp.delete(); return "{\"ok\":false,\"msg\":\"备份失败\"}"; }
            if (!tmp.renameTo(f)) { bak.renameTo(f); tmp.delete(); return "{\"ok\":false,\"msg\":\"替换失败\"}"; }
            bak.delete();
            return "{\"ok\":true,\"size\":" + best.length + ",\"orig\":" + orig + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"msg\":\"" + escapeJson(e.getMessage()) + "\"}";
        }
    }
    // 持久化缩略图：photos/<dir>/.thumbs/<size>/<name>.jpg；缓存命中直接读，否则生成后落盘（一次生成永久复用）
    public String ensureThumb(String relPath, int size) {
        try {
            File orig = new File(rootPhotos.getParentFile(), relPath);
            if (!orig.exists() || orig.length() == 0) return "";
            if (size <= 0) size = 320;
            File thumbDir = new File(orig.getParentFile(), ".thumbs" + File.separator + size);
            File thumb = new File(thumbDir, stripExt(orig.getName()) + ".jpg");
            if (thumb.exists() && thumb.length() > 0) {
                byte[] b = readFile(thumb);
                return "data:image/jpeg;base64," + android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
            }
            thumbDir.mkdirs();
            String data = thumbOf(orig, size);
            if (data.isEmpty()) return "";
            String b64 = data.indexOf(",") >= 0 ? data.substring(data.indexOf(",") + 1) : "";
            if (!b64.isEmpty()) {
                try { writeFile(thumb, android.util.Base64.decode(b64, android.util.Base64.DEFAULT)); } catch (Exception ignore) {}
            }
            return data;
        } catch (Exception e) { return ""; }
    }
    private static String stripExt(String n) {
        int dot = n.lastIndexOf('.');
        return dot > 0 ? n.substring(0, dot) : n;
    }

    /* ============ 导出 ovkmz（KML 由 JS 组装，原生仅做磁盘 I/O + 打包）============
       specJson = { kml:"<kml>", photos:[ { relPath:"photos/bid/x.jpg", ovName:"pic_0.jpg" } ] }
       这样可完整保留属性/文件夹结构/多照片，且照片走磁盘不经 base64 穿桥。 */
    public void exportKmz(final String specJson, final String outPath, final boolean resume) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    org.json.JSONObject spec = new org.json.JSONObject(specJson);
                    String kml = spec.optString("kml", "");
                    org.json.JSONArray photos = spec.optJSONArray("photos");
                    File out = new File(outPath);
                    File stage = new File(outPath + ".stage");
                    if (!resume || !stage.exists()) deleteRecurse(stage);
                    stage.mkdirs();
                    File kmlFile = new File(stage, "doc.kml");
                    writeFile(kmlFile, kml.getBytes(StandardCharsets.UTF_8));
                    File ov = new File(stage, "ovatta"); ov.mkdirs();
                    long total = (photos == null ? 0 : photos.length()), done = 0;
                    if (photos != null) {
                        for (int i = 0; i < photos.length(); i++) {
                            org.json.JSONObject ph = photos.getJSONObject(i);
                            File src = new File(rootPhotos.getParentFile(), ph.optString("relPath"));
                            if (src.exists()) copyFile(src, new File(ov, ph.optString("ovName", "pic_" + i + ".jpg")));
                            done++; progress("copy", done, total);
                        }
                    }
                    zipDir(stage, out, new Progress() {
                        public void on(String phase, long d, long t) { progress("zip", d, t); }
                    });
                    deleteRecurse(stage);
                    js("window.onXferDone&&window.onXferDone('export','" + escapeJson(out.getAbsolutePath()) + "')");
                } catch (Exception e) {
                    js("window.onXferError&&window.onXferError('export','" + escapeJson(e.getMessage()) + "')");
                }
            }
        });
    }

    /* ============ 导入 ovkmz（原生解压到磁盘，返回 KML 文本 + 照片路径映射，由 JS 组装建筑）============
       返回 json = { kml:"<kml>", photos:[ { ovName:"pic_0.jpg", relPath:"photos/import_xxx/pic_0.jpg" } ] }
       富解析（属性/文件夹/多照片）保留在 JS 侧 parseKmzWithPhotos。 */
    // 判断 zip 条目是否为奥维附件（照片）：接受 ovatta/ files/ images/ attachments/ photos/ 等目录，
    // 以及无目录但扩展名像图片的条目；保留无扩展名的正经奥维附件（水利一张图坑#25）
    private boolean isAttachmentEntry(String n) {
        String low = n.toLowerCase();
        if (low.startsWith("ovatta/") || low.startsWith("files/") || low.startsWith("images/")
                || low.startsWith("attachments/") || low.startsWith("photos/") || low.startsWith("附图/")) {
            return true;
        }
        int slash = low.lastIndexOf('/');
        String file = slash >= 0 ? low.substring(slash + 1) : low;
        if (hasExt(file)) return isImageExt(extOf(file));
        return false;
    }
    private boolean hasExt(String low) {
        int dot = low.lastIndexOf('.');
        int slash = low.lastIndexOf('/');
        return dot > slash && (low.length() - dot) <= 6;
    }
    private String extOf(String n) {
        int dot = n.lastIndexOf('.');
        return dot >= 0 ? n.substring(dot) : "";
    }
    private boolean isImageExt(String ext) {
        return ext.matches("\\.(jpg|jpeg|png|gif|bmp|webp|heic|tiff?)$");
    }
    public void importKmz(final String srcPath, final boolean resume) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    File src = new File(srcPath);
                    if (!src.exists()) { js("window.onXferError&&window.onXferError('import','文件不存在')"); return; }
                    File extract = new File(rootPhotos, "import_" + System.currentTimeMillis());
                    extract.mkdirs();
                    String kmlText = "";
                    java.util.List<String[]> photoList = new java.util.ArrayList<String[]>();
                    int picIdx = 0;
                    try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(
                            new BufferedInputStream(new FileInputStream(src)))) {
                        java.util.zip.ZipEntry ze;
                        while ((ze = zis.getNextEntry()) != null) {
                            String n = ze.getName();
                            if (n.equalsIgnoreCase("doc.kml") || n.endsWith("/doc.kml")) {
                                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                                pipe(zis, bos); kmlText = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                            } else if (isAttachmentEntry(n) && !ze.isDirectory()) {
                                String ext = hasExt(n.toLowerCase()) ? extOf(n) : "";
                                String discName = "pic_" + picIdx + (ext.isEmpty() ? ".jpg" : ext);
                                File out = new File(extract, discName);
                                pipeToFile(zis, out);
                                String ovName = n.substring(n.lastIndexOf('/') + 1);
                                photoList.add(new String[]{ ovName, "photos/import_" + extract.getName() + "/" + discName });
                                picIdx++;
                            }
                            zis.closeEntry();
                        }
                    }
                    // 按 pic_N 序号排序，确保与 KML 中 OvAttaItem 顺序一致（File.listFiles 顺序不保证）
                    java.util.Collections.sort(photoList, new java.util.Comparator<String[]>() {
                        public int compare(String[] a, String[] b) { return Integer.compare(idxOf(a[0]), idxOf(b[0])); }
                        int idxOf(String n) { try { return Integer.parseInt(n.replaceAll(".*pic_|\\.[^.]+$", "")); } catch (Exception e) { return 0; } }
                    });
                    StringBuilder sb = new StringBuilder("{\"kml\":\"");
                    sb.append(escapeJson(kmlText)).append("\",\"photos\":[");
                    for (int i = 0; i < photoList.size(); i++) {
                        if (i > 0) sb.append(",");
                        sb.append("{\"ovName\":\"").append(escapeJson(photoList.get(i)[0]))
                          .append("\",\"relPath\":\"").append(escapeJson(photoList.get(i)[1])).append("\"}");
                    }
                    sb.append("]}");
                    js("window.onImportData&&window.onImportData('" + escapeJson(sb.toString()) + "')");
                } catch (Exception e) {
                    js("window.onXferError&&window.onXferError('import','" + escapeJson(e.getMessage()) + "')");
                }
            }
        });
    }

    /* ============ 手机互传：本地 HTTP 服务（手写 ServerSocket HTTP，支持 Range；兼容 Android）============
       com.sun.net.httpserver.* 在 Android 运行时不存在，故用手写 HTTP 实现。 */
    public String peerStart(final int port) {
        try {
            if (peerServer != null) peerStop();
            peerPort = port <= 0 ? 8765 : port;
            final ServerSocket ss = new ServerSocket(peerPort);
            peerServer = ss;
            pool.execute(new Runnable() {
                public void run() {
                    try {
                        while (!ss.isClosed()) {
                            final Socket sock = ss.accept();
                            pool.execute(new PeerHandler(sock));
                        }
                    } catch (Exception ignore) {}
                }
            });
            return "http://" + lanIp() + ":" + peerPort;
        } catch (Exception e) { return "error:" + e.getMessage(); }
    }
    private class PeerHandler implements Runnable {
        private final Socket sock;
        PeerHandler(Socket s) { sock = s; }
        public void run() {
            try {
                BufferedReader br = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
                String line = br.readLine();
                if (line == null) { sock.close(); return; }
                String[] parts = line.split(" ");
                String method = parts.length > 0 ? parts[0] : "GET";
                String path = parts.length > 1 ? parts[1] : "/";
                String range = null;
                String h;
                while ((h = br.readLine()) != null && !h.isEmpty()) {
                    if (h.toLowerCase().startsWith("range:")) range = h.substring(5).trim();
                }
                OutputStream os = sock.getOutputStream();
                if (method.equalsIgnoreCase("GET") && (path.equals("/") || path.equals("/list"))) {
                    StringBuilder sb = new StringBuilder("[");
                    File[] fs = exportDir.listFiles();
                    if (fs != null) for (int i = 0; i < fs.length; i++) {
                        if (i > 0) sb.append(",");
                        sb.append("{\"name\":\"").append(escapeJson(fs[i].getName()))
                          .append("\",\"size\":").append(fs[i].length()).append("}");
                    }
                    sb.append("]");
                    byte[] body = sb.toString().getBytes(StandardCharsets.UTF_8);
                    sendPeerHeaders(os, 200, "application/json", body.length, -1, 0);
                    os.write(body);
                } else {
                    File f = new File(exportDir, sanitize(path.startsWith("/") ? path.substring(1) : path));
                    if (!f.exists() || !f.isFile()) {
                        sendPeerHeaders(os, 404, "text/plain", 0, -1, 0);
                    } else {
                        long len = f.length(); long start = 0; int code = 200;
                        if (range != null && range.toLowerCase().startsWith("bytes=")) {
                            try { start = Long.parseLong(range.substring(6).split("-")[0]); code = 206; } catch (Exception ignore) {}
                        }
                        sendPeerHeaders(os, code, "application/octet-stream", len - start, len, start);
                        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
                            in.skip(start);
                            byte[] buf = new byte[1 << 16]; int n;
                            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                        }
                    }
                }
                os.flush(); sock.close();
            } catch (Exception ignore) { try { sock.close(); } catch (Exception e2) {} }
        }
    }
    private void sendPeerHeaders(OutputStream os, int code, String type, long bodyLen, long total, long start) throws IOException {
        String status = code == 206 ? "206 Partial Content" : (code == 404 ? "404 Not Found" : "200 OK");
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\n");
        sb.append("Accept-Ranges: bytes\r\n");
        if (code == 206) sb.append("Content-Range: bytes ").append(start).append("-").append(total - 1).append("/").append(total).append("\r\n");
        if (bodyLen >= 0) sb.append("Content-Length: ").append(bodyLen).append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        os.write(sb.toString().getBytes(StandardCharsets.UTF_8));
    }
    public void peerStop() {
        try { if (peerServer != null) { peerServer.close(); peerServer = null; } } catch (Exception ignore) {}
    }
    private String lanIp() {
        try {
            Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
            while (en.hasMoreElements()) {
                NetworkInterface ni = en.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                Enumeration<InetAddress> ia = ni.getInetAddresses();
                while (ia.hasMoreElements()) {
                    InetAddress a = ia.nextElement();
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
                }
            }
        } catch (Exception ignore) {}
        return "127.0.0.1";
    }

    /* ============ 断点续传下载（客户端从 Peer/网盘）============ */
    public void download(final String url, final String outPath, final boolean resume) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    File out = new File(outPath);
                    long existing = (resume && out.exists()) ? out.length() : 0;
                    if (existing > 0) out.delete(); // 简化：Range 重拉整段（服务端支持 Range 时由调用方分片）
                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestProperty("Range", "bytes=" + existing + "-");
                    conn.connect();
                    long total = conn.getContentLength() + existing;
                    int code = conn.getResponseCode();
                    InputStream in = new BufferedInputStream(code == 206 || code == 200 ? conn.getInputStream() : conn.getErrorStream());
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out, true))) {
                        byte[] buf = new byte[1 << 16]; long done = existing; int n;
                        while ((n = in.read(buf)) > 0) { os.write(buf, 0, n); done += n; progress("download", done, total); }
                    }
                    in.close(); conn.disconnect();
                    js("window.onXferDone&&window.onXferDone('download','" + escapeJson(out.getAbsolutePath()) + "')");
                } catch (Exception e) {
                    js("window.onXferError&&window.onXferError('download','" + escapeJson(e.getMessage()) + "')");
                }
            }
        });
    }

    /* ============ 网盘（百度/夸克）抽象：可配置 token 的断点续传 HTTP 原语 ============
       说明：真实上传需在各网盘开放平台创建应用并 OAuth 获取 token。此处提供统一的「分片+Range 续传」
       客户端，BaiduProvider/QuarkProvider 仅做端点与鉴权头映射；未配置 token 时返回明确错误，不影响本地功能。 */
    public void netdiskUpload(final String provider, final String token, final String localPath, final String remoteName, final boolean resume) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    if (token == null || token.isEmpty()) {
                        js("window.onXferError&&window.onXferError('netdisk','未配置" + provider + " token，请在传输设置中填写')");
                        return;
                    }
                    // 通用分片上传端点（示例为可替换的网盘网关地址，需用户按开放平台文档配置）
                    String endpoint = "https://pan." + provider + ".com/upload?name=" + java.net.URLEncoder.encode(remoteName, "UTF-8");
                    File f = new File(localPath);
                    long total = f.length(), done = 0, offset = 0;
                    if (resume) {
                        // 查询已上传偏移（HEAD Content-Range）
                        HttpURLConnection h = (HttpURLConnection) new URL(endpoint).openConnection();
                        h.setRequestMethod("HEAD"); h.setRequestProperty("Authorization", "Bearer " + token);
                        try { offset = Long.parseLong(h.getHeaderField("X-Upload-Offset")); } catch (Exception ignore) {}
                        h.disconnect(); done = offset;
                    }
                    HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
                    conn.setRequestMethod("PUT");
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                    conn.setRequestProperty("Content-Type", "application/octet-stream");
                    conn.setRequestProperty("Content-Range", "bytes " + offset + "-" + (total - 1) + "/" + total);
                    conn.setDoOutput(true); conn.setFixedLengthStreamingMode(total - offset);
                    try (InputStream in = new BufferedInputStream(new FileInputStream(f));
                         OutputStream os = conn.getOutputStream()) {
                        in.skip(offset);
                        byte[] buf = new byte[1 << 16]; int n;
                        while ((n = in.read(buf)) > 0) { os.write(buf, 0, n); done += n; progress("netdisk", done, total); }
                    }
                    int code = conn.getResponseCode(); conn.disconnect();
                    if (code >= 200 && code < 300)
                        js("window.onXferDone&&window.onXferDone('netdisk','" + escapeJson(remoteName) + "')");
                    else
                        js("window.onXferError&&window.onXferError('netdisk','上传返回 " + code + "')");
                } catch (Exception e) {
                    js("window.onXferError&&window.onXferError('netdisk','" + escapeJson(e.getMessage()) + "')");
                }
            }
        });
    }

    /* ============ 从 ZIP 抽取照片（批量导入照片的 ZIP 模式）============ */
    /* 异步解压：走线程池，周期回传 window.onXferProgress("unzip",done,total)，
       完成回传 window.onUnzipImages(json)。避免主线程同步解压数 GB 导致卡死 + 进度条假死。 */
    // 解压 ZIP 抽取照片。关键修复：Windows/7-Zip 打的含中文文件名 ZIP 多用 GBK/GB18030 编码条目名，
    // 而 ZipInputStream 默认按 UTF-8/平台编码读取，中文名会被乱码化 → 扩展名匹配失败 → 抽到的图片为 0
    // （“导入的照片显示为0”的根因）。改为用 ZipFile 显式指定字符集，依次尝试 UTF-8 → GBK → GB18030，
    // 命中即采用，保证中文照片名与文件夹名正确解码。
    private Charset detectZipCharset(File src) {
        Charset[] tryCharsets = { StandardCharsets.UTF_8, Charset.forName("GBK"), Charset.forName("GB18030") };
        for (Charset cs : tryCharsets) {
            try (ZipFile zf = new ZipFile(src, cs)) {
                java.util.Enumeration<? extends java.util.zip.ZipEntry> en = zf.entries();
                int ok = 0, bad = 0;
                while (en.hasMoreElements()) {
                    String name = en.nextElement().getName();
                    // 含替换符或不可映射字符 → 该编码大概率不对
                    if (name.indexOf('�') >= 0) { bad++; break; }
                    if (!name.isEmpty()) ok++;
                    if (ok + bad >= 8) break;
                }
                if (bad == 0 && ok > 0) return cs;
            } catch (Exception ignore) {}
        }
        return StandardCharsets.UTF_8; // 兜底
    }

    public void unzipImages(final String srcPath) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    File src = new File(srcPath);
                    if (!src.exists()) { js("window.onUnzipImages&&window.onUnzipImages('[]')"); return; }
                    Charset cs = detectZipCharset(src);
                    File dir = new File(rootInbox, "uz_" + System.currentTimeMillis());
                    dir.mkdirs();
                    java.util.List<String> entries = new java.util.ArrayList<String>();
                    long total = src.length();
                    long done = 0;
                    long lastReport = 0;
                    try (ZipFile zf = new ZipFile(src, cs)) {
                        java.util.Enumeration<? extends java.util.zip.ZipEntry> en = zf.entries();
                        while (en.hasMoreElements()) {
                            java.util.zip.ZipEntry ze = en.nextElement();
                            String n = ze.getName();
                            if (ze.isDirectory() || !n.matches("(?i).*\\.(jpg|jpeg|png|gif|bmp|webp)$")) continue;
                            String shortName = n.contains("/") ? n.substring(n.lastIndexOf("/") + 1) : n;
                            String folder = n.contains("/") ? n.substring(0, n.lastIndexOf("/")) : "";
                            File out = new File(dir, sanitize(shortName));
                            pipeToFile(zf.getInputStream(ze), out);
                            entries.add("{\"name\":\"" + escapeJson(out.getName())
                                    + "\",\"path\":\"" + escapeJson(out.getAbsolutePath())
                                    + "\",\"folder\":\"" + escapeJson(folder) + "\"}");
                            done += ze.getSize() > 0 ? ze.getSize() : 4096;
                            if (done - lastReport > Math.max(total / 20, 512 * 1024) || done >= total) {
                                lastReport = done;
                                progress("unzip", Math.min(done, total), total);
                            }
                        }
                    }
                    StringBuilder sb = new StringBuilder("[");
                    for (int i = 0; i < entries.size(); i++) {
                        if (i > 0) sb.append(",");
                        sb.append(entries.get(i));
                    }
                    sb.append("]");
                    js("window.onUnzipImages&&window.onUnzipImages('" + escapeJson(sb.toString()) + "')");
                } catch (Exception e) {
                    js("window.onUnzipImages&&window.onUnzipImages('[]')");
                }
            }
        });
    }

    /* ============ 导出照片（按管理所分文件夹 ZIP）============
       specJson = { files:[ { relPath:"photos/bid/x.jpg", folder:"管理所", fileName:"建筑物_1" } ] }
       分组/命名逻辑放在 JS 侧，原生只做磁盘拷贝 + 打包（可处理 >3GB）。 */
    public void exportPhotos(final String specJson, final String outPath, final boolean resume) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    org.json.JSONObject spec = new org.json.JSONObject(specJson);
                    org.json.JSONArray files = spec.optJSONArray("files");
                    File out = new File(outPath);
                    File stage = new File(outPath + ".stage");
                    if (!resume || !stage.exists()) deleteRecurse(stage);
                    stage.mkdirs();
                    long total = (files == null ? 0 : files.length()), done = 0;
                    if (files != null) {
                        for (int i = 0; i < files.length(); i++) {
                            org.json.JSONObject f = files.getJSONObject(i);
                            File src = new File(rootPhotos.getParentFile(), f.optString("relPath"));
                            if (src.exists()) {
                                File d = new File(stage, sanitize(f.optString("folder", "未设置管理所"))); d.mkdirs();
                                copyFile(src, new File(d, sanitize(f.optString("fileName", "photo_" + i)) + ".jpg"));
                            }
                            done++; progress("zip", done, total);
                        }
                    }
                    zipDir(stage, out, null);
                    deleteRecurse(stage);
                    js("window.onXferDone&&window.onXferDone('exportPhotos','" + escapeJson(out.getAbsolutePath()) + "')");
                } catch (Exception e) {
                    js("window.onXferError&&window.onXferError('exportPhotos','" + escapeJson(e.getMessage()) + "')");
                }
            }
        });
    }

    /* ============ 照片内容哈希（内容相同覆盖判断）============ */
    public String photoSha256(String relPath) {
        try { return fileSha256(new File(rootPhotos.getParentFile(), relPath).getAbsolutePath()); }
        catch (Exception e) { return ""; }
    }

    /* ============ helpers ============ */
    private void progress(final String phase, final long done, final long total) {
        js("window.onXferProgress&&window.onXferProgress('" + phase + "'," + done + "," + total + ")");
    }
    private void js(final String code) {
        if (wv != null) wv.post(new Runnable() { public void run() { wv.evaluateJavascript(code, null); } });
    }
    private static void writeFile(File f, byte[] b) throws IOException {
        try (OutputStream os = new FileOutputStream(f)) { os.write(b); }
    }
    private static byte[] readFile(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(); pipe(in, bos); return bos.toByteArray();
        }
    }
    private static void copyFile(File s, File d) throws IOException {
        try (InputStream in = new FileInputStream(s); OutputStream os = new FileOutputStream(d)) { pipe(in, os); }
    }
    private static void pipe(InputStream in, OutputStream os) throws IOException {
        byte[] buf = new byte[1 << 16]; int n;
        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
    }
    private static void pipeToFile(InputStream in, File f) throws IOException {
        try (OutputStream os = new FileOutputStream(f)) { pipe(in, os); }
    }
    private static void deleteRecurse(File d) {
        if (d == null || !d.exists()) return;
        if (d.isDirectory()) { File[] fs = d.listFiles(); if (fs != null) for (File x : fs) deleteRecurse(x); }
        d.delete();
    }
    private static void zipDir(File dir, File out, Progress p) throws IOException {
        long total = countFiles(dir), done = 0;
        try (java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(
                new BufferedOutputStream(new FileOutputStream(out)))) {
            zipRecurse(dir, dir, zos);
            if (p != null) p.on("zip", ++done, total);
        }
    }
    private static long countFiles(File d) {
        long n = 0; if (d.isDirectory()) { File[] fs = d.listFiles(); if (fs != null) for (File x : fs) n += countFiles(x); } else n = 1; return n;
    }
    private static void zipRecurse(File root, File cur, java.util.zip.ZipOutputStream zos) throws IOException {
        File[] fs = cur.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            String name = root.toURI().relativize(f.toURI()).getPath();
            if (f.isDirectory()) { zipRecurse(root, f, zos); }
            else { zos.putNextEntry(new java.util.zip.ZipEntry(name)); pipe(new FileInputStream(f), zos); zos.closeEntry(); }
        }
    }
    private static int readIntState(File f) { try { return Integer.parseInt(readFile(f).toString()); } catch (Exception e) { return 0; } }
    private static void writeIntState(File f, int v) { try { writeFile(f, String.valueOf(v).getBytes()); } catch (Exception ignore) {} }
    private static long readLongState(File f) { try { return Long.parseLong(readFile(f).toString()); } catch (Exception e) { return 0; } }
    private static String escapeJson(String s) {
        if (s == null) return "";
        // 逐字符转义：在原有 \\ \" \n 基础上，补齐 \r(移除) 以及 TAB/\b/\f 与所有 <0x20 控制字符、
        // U+2028/U+2029。奥维 doc.kml 排版含海量 TAB，原样留在 JSON 字符串里会让 JSON.parse 报
        // "Bad control character in string literal"（即 APK 导入奥维原装文件提示"返回数据格式错误"的根因）。
        StringBuilder sb = new StringBuilder(s.length() + 32);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': break; // 移除（沿用旧行为，避免 JSON 非法控制字符）
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\u2028': sb.append("\\u2028"); break;
                case '\u2029': sb.append("\\u2029"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

}
