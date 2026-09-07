#!/usr/bin/env python3
# 通过 GitHub REST API 发布版本：建/更新 tag + Release，并把「四平台可部署安装包」作为
# Release assets 上传（GitHub Releases 是存放 APK/MSI/EXE/deb/iOS 托管包的标准位置，
# 不受 git 25MB/100MB 限制，单文件最大 2GB，可被 App 内「GitHub 升级」拉取）。
#
# 用法：
#   python3 tools/gh_release.py --repo g101400/gujian-travel5090 --tag v3.7.4 \
#       --name "古建景点打卡 v3.7.4" --notes "说明文字" \
#       --asset "古建景点打卡V3.7.4_20260905.apk" --asset ".../ios.zip"
#   # 不带 --commit 时默认打在当前 main 最新提交上
#   # --asset 可重复；给目录会自动收集目录下全部文件
#
# token 三级读取：env TOK > 仓库根 .gujian_token(首行) > .env(GUJIAN_GITHUB_TOKEN)
# 需要 fine-grained PAT 对该仓库授予 Contents: Read/Write（建 tag/release/asset 均属 contents 写）
import os, sys, json, subprocess, argparse, glob, mimetypes, urllib.parse

_HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.environ.get("LOCAL") or os.path.dirname(_HERE)


def load_token():
    tok = os.environ.get("TOK")
    if tok:
        return tok.strip()
    for p in [os.path.join(LOCAL, ".gujian_token"),
              os.path.join(_HERE, ".env"),
              os.path.join(LOCAL, ".env")]:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            k, v = line.split("=", 1)
                            if k.strip() == "GUJIAN_GITHUB_TOKEN":
                                return v.strip()
                        else:
                            return line
            except Exception:
                continue
    return None


TOK = load_token()
if not TOK:
    print("缺少 GitHub Token。用 TOK=xxx 或写仓库根 .gujian_token")
    sys.exit(1)

API = "https://api.github.com"
UPLOAD = "https://uploads.github.com"


def curl(method, url, body=None, raw_file=None, content_type="application/json"):
    import tempfile
    cmd = (f'curl -s -w "\\n%{{http_code}}" -X {method} '
           f'-H "Authorization: Bearer {TOK}" -H "Accept: application/vnd.github+json" ')
    if raw_file:
        cmd += f'-H "Content-Type: {content_type}" --data-binary "@{raw_file}" '
    else:
        cmd += '-H "Content-Type: application/json" '
        if body is not None:
            fd, path = tempfile.mkstemp(suffix=".json"); os.close(fd)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(body, f)
            cmd += f'-d @{path} '
    cmd += f'"{url}"'
    out = subprocess.run(cmd, capture_output=True, text=True, shell=True).stdout
    out = out.strip()
    parts = out.rsplit("\n", 1)
    code = parts[1] if len(parts) == 2 else ""
    payload = parts[0]
    try:
        j = json.loads(payload) if payload else {}
    except Exception:
        j = {"_raw": payload[:300]}
    return int(code) if code.isdigit() else -1, j


def collect_assets(paths):
    out = []
    for p in paths:
        p = os.path.normpath(p)
        if not os.path.isabs(p):
            p = os.path.join(LOCAL, p)
        if os.path.isdir(p):
            for f in sorted(glob.glob(os.path.join(p, "*"))):
                if os.path.isfile(f):
                    out.append(f)
        elif os.path.isfile(p):
            out.append(p)
        else:
            print("  [警告] 找不到 asset:", p)
    # 去重保序
    seen, res = set(), []
    for f in out:
        if f not in seen:
            seen.add(f); res.append(f)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="g101400/xxx")
    ap.add_argument("--tag", required=True, help="版本 tag，如 v3.7.4")
    ap.add_argument("--name", help="Release 标题（默认用 tag）")
    ap.add_argument("--notes", default="", help="发布说明")
    ap.add_argument("--commit", help="打 tag 指向的 commit SHA（默认 main 最新）")
    ap.add_argument("--asset", action="append", default=[], help="要上传的文件或目录，可重复")
    ap.add_argument("--dry", action="store_true", help="只打印计划不上传")
    args = ap.parse_args()

    assets = collect_assets(args.asset)
    print(f"仓库: {args.repo}  tag: {args.tag}  assets: {len(assets)} 个")
    for f in assets:
        print(f"   + {os.path.basename(f)}  ({os.path.getsize(f)//1024}KB)")

    # 1) 取得目标 commit（默认 main 最新）
    sha = args.commit
    if not sha:
        code, j = curl("GET", f"{API}/repos/{args.repo}/git/refs/heads/main")
        if code == 200:
            sha = j["object"]["sha"]
        else:
            print("获取 main 失败:", code, j); sys.exit(1)
    print("目标 commit:", sha)

    # 2) 确保 tag 存在
    code, j = curl("GET", f"{API}/repos/{args.repo}/git/refs/tags/{args.tag}")
    if code != 200:
        code, j = curl("POST", f"{API}/repos/{args.repo}/git/refs",
                       {"ref": f"refs/tags/{args.tag}", "sha": sha})
        print("建 tag:", code, j.get("ref", j.get("message", "")))
        if code not in (200, 201):
            sys.exit(1)
    else:
        print("tag 已存在:", args.tag)

    # 3) 建/取 Release
    rel_id, rel = None, None
    code, j = curl("GET", f"{API}/repos/{args.repo}/releases/tags/{args.tag}")
    if code == 200:
        rel_id, rel = j["id"], j
        print("Release 已存在 id=", rel_id)
    else:
        if args.dry:
            print("[dry] 将创建 release"); return
        code, j = curl("POST", f"{API}/repos/{args.repo}/releases",
                       {"tag_name": args.tag, "name": args.name or args.tag,
                        "body": args.notes, "draft": False, "prerelease": False})
        print("建 release:", code, j.get("id", j.get("message", "")))
        if code not in (200, 201):
            sys.exit(1)
        rel_id = j["id"]

    # 4) 上传 assets（同名先删旧）
    for f in assets:
        name = os.path.basename(f)
        if rel:
            for a in rel.get("assets", []):
                if a["name"] == name:
                    curl("DELETE", f"{API}/repos/{args.repo}/releases/assets/{a['id']}")
                    print("  删除旧 asset:", name)
        if args.dry:
            print(f"  [dry] 上传 {name}"); continue
        ct = mimetypes.guess_type(f)[0] or "application/octet-stream"
        enc = urllib.parse.quote(name)
        code, j = curl("POST",
                       f"{UPLOAD}/repos/{args.repo}/releases/{rel_id}/assets?name={enc}",
                       raw_file=f, content_type=ct)
        if code in (200, 201) and "id" in j:
            print(f"  上传成功: {name}  ({os.path.getsize(f)//1024}KB)")
        else:
            print(f"  上传失败: {name}  code={code} {j}")
            sys.exit(1)

    print("== 完成 ==")
    print(f"https://github.com/{args.repo}/releases/tag/{args.tag}")


if __name__ == "__main__":
    main()
