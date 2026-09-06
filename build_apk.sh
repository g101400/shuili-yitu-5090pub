#!/usr/bin/env bash
# 手动用 aapt2 + d8 + zipalign + apksigner 构建并签名离线 APK
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-C:/Users/admin/.workbuddy/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
AAPT2="$BT/aapt2.exe"
D8="$BT/d8.bat"
ZIPALIGN="$BT/zipalign.exe"
APKSIGNER="$BT/apksigner.bat"

cd "$HERE"
# 清理上一轮可能残留的生成产物（TEMP 构建目录下 rm 可用）
rm -f res_compiled.zip app-unsigned.apk app-aligned.apk app-release.apk 2>/dev/null || true

PY0="${PY_EXE:-python3}"
echo "[0] 版本门禁：assets/version.json 为唯一真相源 -> 同步 AndroidManifest + 校验 app.js APP_VERSION"
if [ ! -f assets/version.json ]; then
  echo "[0][FATAL] 缺少 assets/version.json（版本唯一真相源），中止构建"; exit 1
fi
"$PY0" - <<'PYEOF'
import json, re, pathlib, sys
vj = json.loads(pathlib.Path('assets/version.json').read_text(encoding='utf-8'))
ver, code = str(vj['version']), int(vj['versionCode'])
appjs = pathlib.Path('assets/app.js').read_text(encoding='utf-8', errors='ignore')
m = re.search(r'APP_VERSION\s*=\s*["\']([^"\']+)["\']', appjs)
if not m:
    print('[0][FATAL] assets/app.js 未找到 APP_VERSION'); sys.exit(1)
if m.group(1).lstrip('vV') != ver.lstrip('vV'):
    print(f'[0][FATAL] 版本不一致：app.js APP_VERSION={m.group(1)} vs version.json version={ver}')
    print('           请先对齐（version.json 为真相源）再构建'); sys.exit(1)
mf = pathlib.Path('AndroidManifest.xml'); text = mf.read_text(encoding='utf-8')
t2 = re.sub(r'android:versionCode="\d+"', f'android:versionCode="{code}"', text, count=1)
t2 = re.sub(r'android:versionName="[^"]*"', f'android:versionName="{ver}"', t2, count=1)
if t2 != text:
    mf.write_text(t2, encoding='utf-8'); print(f'[0] manifest 已同步 -> code={code} name={ver}')
else:
    print(f'[0] manifest 已一致 (code={code} name={ver})')
print(f'[0] APP_VERSION={m.group(1)} 与 version.json 一致 OK')
PYEOF

echo "[1] 编译资源 res -> res_compiled.zip"
"$AAPT2" compile --dir res -o res_compiled.zip
echo "[2] 链接资源 + 打包 assets -> app-unsigned.apk"
"$AAPT2" link -o app-unsigned.apk -I "$PLATFORM" --manifest AndroidManifest.xml -A assets res_compiled.zip
echo "[3] 编译 Java"
mkdir -p obj
javac -encoding UTF-8 -cp "$PLATFORM" -d obj src/com/shuili/yitu/MainActivity.java src/com/shuili/yitu/LargeFileManager.java
echo "[4] 转 DEX"
mkdir -p dex
CLASSES=$(find obj -name "*.class")
"$D8" --lib "$PLATFORM" --output dex $CLASSES
echo "[5] 注入 classes.dex（以不压缩方式，Android 才加载）"
PY="${PY_EXE:-python3}"
"$PY" - app-unsigned.apk dex/classes.dex <<'PYEOF'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', compression=zipfile.ZIP_STORED) as z:
    # 避免重复写入
    if 'classes.dex' not in z.namelist():
        z.write(dex, 'classes.dex')
print('classes.dex injected; entries:', len(zipfile.ZipFile(apk).namelist()))
PYEOF
echo "[6] zipalign"
"$ZIPALIGN" -f -p 4 app-unsigned.apk app-aligned.apk
echo "[7] 签名 -> app-release.apk"
# 密钥口令走环境变量（APK_KS_PASS / APK_KEY_PASS），未设置时回退历史默认值以保持兼容
KS_ALIAS="${APK_KS_ALIAS:-xitian}"
KS_PASS="${APK_KS_PASS:-xitian123}"
KEY_PASS="${APK_KEY_PASS:-$KS_PASS}"
"$APKSIGNER" sign --ks keystore.jks --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" \
  --out app-signed.apk app-aligned.apk
# 避免旧 app-release.apk 残留导致后续步骤混乱：移动覆盖
mv -f app-signed.apk app-release.apk

echo "[8] 发布门禁：aapt2 badging 校验 versionCode/versionName/launchable-activity + 签名校验"
EXP_CODE=$("$PY0" -c "import json;print(json.load(open('assets/version.json',encoding='utf-8'))['versionCode'])")
EXP_NAME=$("$PY0" -c "import json;print(json.load(open('assets/version.json',encoding='utf-8'))['version'])")
BADGING=$("$AAPT2" dump badging app-release.apk 2>/dev/null)
echo "$BADGING" | grep -q "versionCode='$EXP_CODE'" || { echo "[8][FATAL] versionCode 应为 $EXP_CODE，实际：$(echo "$BADGING" | head -1)"; exit 1; }
echo "$BADGING" | grep -q "versionName='$EXP_NAME'" || { echo "[8][FATAL] versionName 应为 $EXP_NAME，实际：$(echo "$BADGING" | head -1)"; exit 1; }
echo "$BADGING" | grep -q "^launchable-activity:" || { echo "[8][FATAL] 无 launchable-activity（安装后无桌面图标，检查 manifest 是否写全 android.intent.category.LAUNCHER）"; exit 1; }
"$APKSIGNER" verify app-release.apk >/dev/null 2>&1 || { echo "[8][FATAL] apksigner verify 失败"; exit 1; }
echo "[8] 门禁全过：versionCode=$EXP_CODE versionName=$EXP_NAME launchable-activity OK 签名 OK"

echo "[完成] app-release.apk"
ls -la app-release.apk
