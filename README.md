# 水利工程一张图（离线 WebView）

水利工程基础信息一张图（离线 WebView App），package `com.shuili.yitu`，当前版本 v3.58。
作者：小七。支持 Android / Windows(WebView2) / UOS(Linux deb) / iOS(PWA) 四端，数据离线内置。

## 工程结构

```
shuili-v329/
├── assets/                 # Web 前端源码（核心）
│   ├── index.html          # 入口
│   ├── app.js / data.js    # 主逻辑与数据
│   ├── ai_module.js        # AI 能力（智能助手/知识库）
│   ├── ai_seed.js          # ⚠️ 本地 OpenRouter Key（内部版含，公开版已脱敏排除）
│   ├── ai_seed.demo.js     # 脱敏占位（公开版所见）
│   ├── leaflet/ ocr/       # 地图与 OCR 依赖
│   └── ...
├── AndroidManifest.xml src/ res/   # Android 原生壳
├── build_apk.sh gen_kb_seed.js     # 构建 / 知识库种子脚本
└── tools/
    └── gh_sync.py          # GitHub 推送脚本（API 方式，规避 git 直连被拦）
```

> 注：本仓库当前纳入「Web 源码 + Android 原生壳」。Win/UOS/iOS 原生壳如需并入，
> 参照同一套流程把各平台壳目录收进本仓库即可（与 git 管理无关，纯文件组织）。

## 公开版 vs 内部版

本应用在两个 GitHub 仓库同步发布：

| 版本 | 仓库 | 可见性 | 密钥处理 |
|------|------|--------|----------|
| 内部版 | `g101400/shuili-yitu5090` | **私有** | 保留 `assets/ai_seed.js`（密钥不变） |
| 公开版 | `g101400/shuili-yitu-5090pub` | **公开** | 自动排除 `ai_seed.js`（脱敏，仅留 `ai_seed.demo.js`） |

内部版仓库名末尾带 `5090`、设为私有；公开版以 `-5090pub` 结尾、设为公开、不含密钥（方案 C 命名，避免与内部版撞名）。

## 发布安装包到 GitHub（Release）与 App 内升级

两仓库都用 **GitHub Releases** 承载各自渠道的四平台可部署安装包（Android APK / Windows MSI·EXE / 统信 UOS deb×4架构 / iOS PWA 托管 zip）。App「设置 → GitHub 升级（检测新版）」会查询本应用**当前渠道**（公开版查 `-5090pub`、内部版查 `5090` 私有仓）的最新 Release，比对版本并列出各平台下载。

发新版时按渠道各跑一次（从仓库根，token 已配好）：
```bash
# 公开版（奇数版本，如 v3.59）
python3 tools/gh_release.py --repo g101400/shuili-yitu-5090pub --tag v3.59 --name "水利工程一张图 v3.59（公开测试版）" \
  --notes "本次更新说明" \
  --asset "D:/Users/Claw/出包_<日期>/android/xxx.apk" \
  --asset "D:/Users/Claw/出包_<日期>/ios/xxx_可托管.zip" \
  --asset "D:/Users/Claw/出包_<日期>/uos-shuili" \
  --asset "D:/Users/Claw/出包_<日期>/win/xxx_Setup.exe" \
  --asset "D:/Users/Claw/出包_<日期>/win/xxx_Setup.msi"

# 内部版（偶数版本，如 v3.60）→ 仓库名换 shuili-yitu5090，其余同上
```
脚本自动：打 tag → 建/更新 Release → 上传全部四平台安装包（同名自动替换）。下载页：`https://github.com/g101400/shuili-yitu5090/releases`（内部）与 `.../shuili-yitu-5090pub/releases`（公开）。

## 同步到 GitHub

本环境 git 直连被代理拦截，统一用 `tools/gh_sync.py`（GitHub REST API 推送，增量同步）。

**方式 A：正常机器（有 git 出网）**

```bash
git add -A && git commit -m "更新" && git push
```

**方式 B：本环境（git 连不上 github.com）**

```bash
# 1) 准备好 token（被 .gitignore 忽略，绝不入库）
cp .gujian_token.example .gujian_token
#   编辑 .gujian_token 填入你的 GitHub PAT

# 2) 推送本应用的两个仓库（内部版全量 + 公开版脱敏，一次完成）
python3 tools/gh_sync.py
```

脚本会自动按目录识别应用，把「内部版（全量含密钥）」和「公开版（排除 ai_seed.js）」
分别推到对应仓库。换机器克隆后，`.gujian_token.example` 随代码下载，照着填即可。

## 从 GitHub 下载 / 克隆

```bash
git clone https://github.com/g101400/shuili-yitu-5090pub.git # 公开版
 git clone https://github.com/g101400/shuili-yitu5090.git       # 内部版（需私有仓库权限）
```

## 密钥安全管理

- `assets/ai_seed.js`（含真实 OpenRouter Key）只在**内部版私有仓库**出现；公开版已排除。
- 本地 GitHub PAT 放在被忽略的 `.gujian_token`（不入库）；公开版仓库里只有空模板 `.gujian_token.example`。
- 切勿把真实 token 写进任何会被提交的脚本 / 文档。
