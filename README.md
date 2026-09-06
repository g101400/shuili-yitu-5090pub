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
| 公开版 | `g101400/shuili-yitu`      | **公开** | 自动排除 `ai_seed.js`（脱敏，仅留 `ai_seed.demo.js`） |

内部版仓库名末尾带 `5090`，且设为私有；公开版公开、不含密钥。

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
git clone https://github.com/g101400/shuili-yitu.git        # 公开版
git clone https://github.com/g101400/shuili-yitu5090.git     # 内部版（需私有仓库权限）
```

## 密钥安全管理

- `assets/ai_seed.js`（含真实 OpenRouter Key）只在**内部版私有仓库**出现；公开版已排除。
- 本地 GitHub PAT 放在被忽略的 `.gujian_token`（不入库）；公开版仓库里只有空模板 `.gujian_token.example`。
- 切勿把真实 token 写进任何会被提交的脚本 / 文档。
