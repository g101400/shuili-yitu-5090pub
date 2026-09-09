package com.shuili.yitu;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.provider.DocumentsContract;
import android.database.Cursor;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.webkit.DownloadListener;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private WebView wv;
    private LargeFileManager lfm;
    private static final int LOC_PERM = 1001;
    private static final int FILE_CHOOSER = 1002;
    private static final int PICK_FILES = 2001;
    private static final int FOLDER_PICKER = 2002;
    private ValueCallback<Uri[]> filePathCallback;
    private String folderExts;
    private ValueCallback<Uri> legacyCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        wv = new WebView(this);
        lfm = new LargeFileManager(this, wv);
        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);          // 地图交互需要 JS
        ws.setAllowFileAccess(true);            // 允许加载 android_asset 本地文件
        ws.setAllowUniversalAccessFromFileURLs(true); // 知识库内置 OCR（tesseract worker/训练数据/PDF 渲染）需从 file:// 读本地资源

        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setBuiltInZoomControls(false);       // 用地图自带缩放控件
        ws.setDisplayZoomControls(false);
        ws.setDomStorageEnabled(true);
        ws.setGeolocationEnabled(true);         // 启用 HTML5 地理定位

        // 暴露 JS 桥：跳转系统定位设置 / 打开第三方地图App
        wv.addJavascriptInterface(new JSBridge(), "Android");
        wv.setWebViewClient(new WebViewClient());
        // 自动授权 WebView 内的地理定位请求（系统级权限另在运行时申请）
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }

            // ★ 支持 <input type="file"> 文件选择（照片上传/导入）
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> cb, FileChooserParams params) {
                // 取消上一次未完成的回调
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = cb;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // ★ 下载监听：导出 ovkmz 时保存到 Download 目录
        wv.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                try {
                    // 从 contentDisposition 或 url 提取文件名
                    String fileName = "export.ovkmz";
                    if (contentDisposition != null && contentDisposition.contains("filename=")) {
                        int idx = contentDisposition.indexOf("filename=");
                        fileName = contentDisposition.substring(idx + 9).replace("\"", "").replace(";", "").trim();
                    } else if (url != null && url.contains("/")) {
                        fileName = url.substring(url.lastIndexOf("/") + 1);
                    }
                    // 保存到公共 Download 目录
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "水利工程一张图");
                    if (!dir.exists()) dir.mkdirs();
                    File file = new File(dir, fileName);
                    Toast.makeText(MainActivity.this, "导出中: " + fileName, Toast.LENGTH_SHORT).show();

                    // blob: URL 需要通过 JS 读取，这里处理普通 URL
                    if (url.startsWith("blob:")) {
                        // 对 blob URL，通过 JS 转为 base64 再保存
                        wv.evaluateJavascript(
                            "(function(){" +
                            "  var xhr = new XMLHttpRequest();" +
                            "  xhr.open('GET', '" + url + "', true);" +
                            "  xhr.responseType = 'blob';" +
                            "  xhr.onload = function(){" +
                            "    var r = new FileReader();" +
                            "    r.onload = function(){" +
                            "      window.Android.saveBlob(r.result, '" + fileName + "');" +
                            "    };" +
                            "    r.readAsDataURL(xhr.response);" +
                            "  };" +
                            "  xhr.send();" +
                            "})();",
                            null
                        );
                    } else {
                        // 普通 URL：直接下载
                        downloadFile(url, file);
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "导出失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        });

        // Android 6+ 运行时申请定位权限
        requestLocationPermission();

        // 离线：直接加载打包进 APK 的本地网页（无需联网）
        wv.loadUrl("file:///android_asset/index.html");
        setContentView(wv);
    }

    private void downloadFile(final String url, final File file) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    java.net.URL u = new java.net.URL(url);
                    java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                    conn.connect();
                    InputStream is = conn.getInputStream();
                    OutputStream os = new FileOutputStream(file);
                    byte[] buf = new byte[4096];
                    int len;
                    while ((len = is.read(buf)) > 0) os.write(buf, 0, len);
                    os.close(); is.close();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "已保存到: Download/水利工程一张图/" + file.getName(), Toast.LENGTH_LONG).show();
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "下载失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        } else if (requestCode == PICK_FILES) {
            // 大文件选择器：把选中文件拷贝到 inbox，回传 JSON 清单给 JS
            try {
                StringBuilder sb = new StringBuilder("[");
                boolean first = true;
                if (resultCode == RESULT_OK && data != null) {
                    java.util.List<Uri> uris = new java.util.ArrayList<>();
                    if (data.getClipData() != null) {
                        int cnt = data.getClipData().getItemCount();
                        for (int i = 0; i < cnt; i++) uris.add(data.getClipData().getItemAt(i).getUri());
                    } else if (data.getData() != null) {
                        uris.add(data.getData());
                    }
                    for (Uri u : uris) {
                        File f = copyUriToInbox(u);
                        if (f != null) {
                            if (!first) sb.append(",");
                            first = false;
                            sb.append("{\"name\":\"").append(escapeJson(f.getName()))
                              .append("\",\"path\":\"").append(escapeJson(f.getAbsolutePath())).append("\"}");
                        }
                    }
                }
                sb.append("]");
                final String json = sb.toString();
                wv.post(new Runnable() { public void run() { wv.evaluateJavascript("window.onPickFiles&&window.onPickFiles('" + json + "')", null); } });
            } catch (Exception e) {
                wv.post(new Runnable() { public void run() { wv.evaluateJavascript("window.onPickFiles&&window.onPickFiles('[]')", null); } });
            }
        } else if (requestCode == FOLDER_PICKER) {
            try {
                StringBuilder sb = new StringBuilder("[");
                boolean first = true;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    Uri treeUri = data.getData();
                    try { getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION); } catch (Exception ignore) {}
                    java.util.List<Uri> files = new java.util.ArrayList<>();
                    listTreeFiles(treeUri, files);
                    java.util.Set<String> extSet = new java.util.HashSet<>();
                    if (folderExts != null) { for (String e : folderExts.split(",")) { e = e.trim().toLowerCase(); if (!e.isEmpty()) extSet.add(e.startsWith(".") ? e : "." + e); } }
                    for (Uri u : files) {
                        String nm = android.webkit.URLUtil.guessFileName(u.toString(), null, null);
                        if (extSet.isEmpty() || extSet.contains(lowerExt(nm))) {
                            File f = copyUriToInbox(u);
                            if (f != null) {
                                if (!first) sb.append(",");
                                first = false;
                                sb.append("{\"name\":\"").append(escapeJson(f.getName())).append("\",\"path\":\"").append(escapeJson(f.getAbsolutePath())).append("\"}");
                            }
                        }
                    }
                }
                sb.append("]");
                final String json = sb.toString();
                wv.post(new Runnable() { public void run() { wv.evaluateJavascript("window.onPickFiles&&window.onPickFiles('" + json + "')", null); } });
            } catch (Exception e) {
                wv.post(new Runnable() { public void run() { wv.evaluateJavascript("window.onPickFiles&&window.onPickFiles('[]')", null); } });
            }
        }
    }

    // 递归枚举文档树下的所有文件（最多 6 层），收集到 out
    private void listTreeFiles(Uri treeUri, java.util.List<Uri> out) {
        java.util.ArrayDeque<String> q = new java.util.ArrayDeque<>();
        q.add(DocumentsContract.getTreeDocumentId(treeUri));
        int depth = 0;
        while (!q.isEmpty() && depth <= 6) {
            int sz = q.size();
            for (int i = 0; i < sz; i++) {
                String docId = q.poll();
                Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
                android.database.Cursor c = null;
                try {
                    c = getContentResolver().query(childrenUri,
                        new String[]{ DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_MIME_TYPE },
                        null, null, null);
                    if (c == null) continue;
                    while (c.moveToNext()) {
                        String childDocId = c.getString(0);
                        String mime = c.getString(1);
                        if ("vnd.android.document/directory".equals(mime)) {
                            q.add(childDocId);
                        } else if (childDocId != null) {
                            out.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocId));
                        }
                    }
                } catch (Exception ignore) { } finally { if (c != null) c.close(); }
            }
            depth++;
        }
    }
    private static String lowerExt(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i >= 0 ? name.substring(i).toLowerCase() : "";
    }

    // 把内容 URI 拷贝到 app 私有 inbox，返回落盘文件（供大文件管线读取，避免经 base64 穿桥）
    private File copyUriToInbox(Uri uri) {
        try {
            File dir = new File(getExternalFilesDir(null), "inbox/" + System.currentTimeMillis());
            dir.mkdirs();
            String name = "file";
            try { name = android.webkit.URLUtil.guessFileName(uri.toString(), null, null); } catch (Exception ignore) {}
            if (name == null || name.isEmpty()) name = "file";
            File out = new File(dir, name);
            try (InputStream in = getContentResolver().openInputStream(uri);
                 OutputStream os = new FileOutputStream(out)) {
                if (in == null) return null;
                byte[] buf = new byte[1 << 16]; int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            return out;
        } catch (Exception e) { return null; }
    }
    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("'", "\\'");
    }

    private void requestLocationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                }, LOC_PERM);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // 网页调用的原生桥
    private class JSBridge {
        // 跳转系统定位设置页（未授权时由 JS 调用）
        @JavascriptInterface
        public void openLocationSettings() {
            try {
                Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
                startActivity(intent);
            } catch (Exception ignored) {}
        }

        // 打开第三方地图App（导航链接由网页拼好，经系统选择器/浏览器唤起App）
        @JavascriptInterface
        public void openExternal(String url) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
            } catch (Exception ignored) {}
        }

        // 保存 blob 导出的文件（JS 通过 FileReader.readAsDataURL 传 base64 过来）
        @JavascriptInterface
        public void saveBlob(String dataUrl, String fileName) {
            try {
                String base64 = dataUrl;
                if (base64.contains(",")) base64 = base64.substring(base64.indexOf(",") + 1);
                byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "水利工程一张图");
                if (!dir.exists()) dir.mkdirs();
                File file = new File(dir, fileName);
                FileOutputStream fos = new FileOutputStream(file);
                fos.write(bytes);
                fos.close();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "已保存到: Download/水利工程一张图/" + fileName, Toast.LENGTH_LONG).show();
                    }
                });
            } catch (final Exception e) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "保存失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            }
        }

        // 保存到自定义文件夹（JS 指定 Download 下的子目录 + 文件名，用于升级备份导出）
        @JavascriptInterface
        public void saveBlobTo(String dataUrl, String folder, String fileName) {
            try {
                String base64 = dataUrl;
                if (base64.contains(",")) base64 = base64.substring(base64.indexOf(",") + 1);
                byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                String f = (folder == null || folder.trim().isEmpty()) ? "水利工程一张图" : folder.trim().replaceAll("[/:*?\"<>|]", "_");
                String n = (fileName == null || fileName.trim().isEmpty()) ? "backup.bak" : fileName.trim().replaceAll("[/:*?\"<>|]", "_");
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), f);
                if (!dir.exists()) dir.mkdirs();
                File file = new File(dir, n);
                FileOutputStream fos = new FileOutputStream(file);
                fos.write(bytes);
                fos.close();
                final String path = "Download/" + f + "/" + n;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "已保存到: " + path, Toast.LENGTH_LONG).show();
                    }
                });
            } catch (final Exception e) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "保存失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            }
        }

        /* ---- 大文件传输桥（>3GB 断点续传 / WiFi 检测 / 手机互传 / 网盘）---- */
        @JavascriptInterface
        public String netType() { return lfm.netType(); }

        @JavascriptInterface
        public String storePhoto(String buildingId, String name, String dataUrl) {
            return lfm.storePhoto(buildingId, name, dataUrl);
        }
        @JavascriptInterface
        public String readPhoto(String relPath) { return lfm.readPhoto(relPath); }
        @JavascriptInterface
        public void deletePhoto(String relPath) { lfm.deletePhoto(relPath); }
        @JavascriptInterface
        public String linkPhoto(String buildingId, String srcPath, String name) {
            return lfm.linkPhoto(buildingId, srcPath, name);
        }
        @JavascriptInterface
        public String thumbPhoto(String relPath, int max) { return lfm.thumbPhoto(relPath, max); }
        @JavascriptInterface
        public void cleanInbox() { lfm.cleanInbox(); }
        @JavascriptInterface
        public String fileSha256(String path) { return lfm.fileSha256(path); }
        @JavascriptInterface
        public String readFileBase64(String path) { return lfm.readFileBase64(path); }
        @JavascriptInterface
        public String readFileText(String path) { return lfm.readFileText(path); }
        @JavascriptInterface
        public long fileSize(String path) { return lfm.fileSize(path); }
        @JavascriptInterface
        public String photoAbsPath(String relPath) { return lfm.photoAbsPath(relPath); }
        @JavascriptInterface
        public void compressPhoto(String absPath, int targetKB) { lfm.compressPhoto(absPath, targetKB); }
        @JavascriptInterface
        public String ensureThumb(String relPath, int size) { return lfm.ensureThumb(relPath, size); }
        @JavascriptInterface
        public String bigPhotoUrl(String relPath, int size) {
            try { return lfm.bigPhotoUrl(relPath, size); } catch (Exception e) { return ""; }
        }
        @JavascriptInterface
        public String linkPhotoToBuilding(String buildingId, String srcRel, String name) {
            // v3.62：ovkmz 导入的照片临时落在 photos/import_<ts>/ 下，与原生添加照片的
            // photos/<buildingId>/ 规范不一致（APK 端出现过照片不显示）。这里把导入照片
            // 归位到建筑物目录，返回新的相对路径；失败返回空串由 JS 保留原路径并计数上报。
            try { String abs = lfm.photoAbsPath(srcRel); if (abs == null || abs.isEmpty()) return ""; return lfm.linkPhoto(buildingId, abs, name); } catch (Exception e) { return ""; }
        }
        @JavascriptInterface
        public String exportPath(String name) {
            File f = new File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS), "水利工程一张图");
            f.mkdirs();
            return new File(f, name).getAbsolutePath();
        }
        @JavascriptInterface
        public void exportKmz(String buildingsJson, String outPath, boolean resume) {
            lfm.exportKmz(buildingsJson, outPath, resume);
        }
        @JavascriptInterface
        public void importKmz(String srcPath, boolean resume) { lfm.importKmz(srcPath, resume); }
        @JavascriptInterface
        public void pickFiles(final String mime) {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.setType(mime == null || mime.isEmpty() ? "*/*" : mime);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    MainActivity.this.startActivityForResult(Intent.createChooser(intent, "选择大文件"), PICK_FILES);
                } catch (Exception e) {
                    wv.post(new Runnable() { public void run() { wv.evaluateJavascript("window.onPickFiles&&window.onPickFiles('[]')", null); } });
                }
            }});
        }
        // 选择文件夹（文档树）：枚举树内所有匹配扩展名的文件，落盘 inbox 后复用 onPickFiles 路由
        @JavascriptInterface
        public void pickFolder(final String exts) {
            folderExts = (exts == null ? "" : exts);
            runOnUiThread(new Runnable() { public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    MainActivity.this.startActivityForResult(intent, FOLDER_PICKER);
                } catch (Exception e) {
                    wv.post(new Runnable() { public void run() { wv.evaluateJavascript("window.onPickFiles&&window.onPickFiles('[]')", null); } });
                }
            }});
        }
        @JavascriptInterface
        public String peerStart(int port) { return lfm.peerStart(port); }
        @JavascriptInterface
        public void peerStop() { lfm.peerStop(); }
        @JavascriptInterface
        public void download(String url, String outPath, boolean resume) { lfm.download(url, outPath, resume); }
        @JavascriptInterface
        public void netdiskUpload(String provider, String token, String localPath, String remoteName, boolean resume) {
            lfm.netdiskUpload(provider, token, localPath, remoteName, resume);
        }
        @JavascriptInterface
        public void unzipImages(String srcPath) { lfm.unzipImages(srcPath); }
        @JavascriptInterface
        public void exportPhotos(String buildingsJson, String outPath, boolean resume) { lfm.exportPhotos(buildingsJson, outPath, resume); }
        @JavascriptInterface
        public String photoSha256(String relPath) { return lfm.photoSha256(relPath); }
    }

    @Override
    public void onBackPressed() {
        if (wv != null && wv.canGoBack()) {
            wv.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
