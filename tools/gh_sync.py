#!/usr/bin/env python3
# 通过 GitHub Git Data REST API 推送（规避本环境 git 直连被代理拦截的问题）
#
# 用法：
#   cd <应用根目录>
#   python3 tools/gh_sync.py                 # 自动推该应用的「内部版(全量)+公开版(脱敏)」两个仓库
#   python3 tools/gh_sync.py --repo g101400/shuili-yitu --exclude assets/ai_seed.js  # 只推指定仓库
#
# token 三级读取：env TOK > 仓库根 .gujian_token(首行) > .env(GUJIAN_GITHUB_TOKEN)
import os, sys, json, base64, subprocess, tempfile, datetime, argparse

# 应用目录名 -> (公开仓库, 内部仓库) 映射
# 内部版仓库名末尾 5090、私有、保留密钥；公开版排除 ai_seed.js（脱敏）
APP_MAP = {
    "shuili-v329": {
        "pub": ("g101400/shuili-yitu-5090pub", ["assets/ai_seed.js"]),
        "int": ("g101400/shuili-yitu5090",      []),
    },
    "perc-v13": {
        "pub": ("g101400/ganzhi-yitu-5090pub", ["assets/ai_seed.js"]),
        "int": ("g101400/ganzhi-yitu5090",      []),
    },
}

_HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.environ.get("LOCAL") or os.path.dirname(_HERE)
APP = os.path.basename(os.path.normpath(LOCAL))


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
                            return line  # 纯 token 行（.gujian_token）
            except Exception:
                continue
    return None


TOK = load_token()
if not TOK:
    print("缺少 GitHub Token。请用以下任一方式提供：")
    print("  TOK=xxx python3 tools/gh_sync.py")
    print("  或把 token 写入仓库根 .gujian_token（已被 .gitignore 忽略，不会入库）")
    sys.exit(1)

MAX_BLOB = 25 * 1024 * 1024  # 跳过 >25MB 的文件


def curl(method, url, body=None):
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    if body is not None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(body, f)
        data_arg = f'-d @{path}'
    else:
        data_arg = ''
    cmd = (f'curl -s -w "\\n%{{http_code}}" -X {method} '
           f'-H "Authorization: Bearer {TOK}" '
           f'-H "Accept: application/vnd.github+json" '
           f'-H "Content-Type: application/json" '
           f'{data_arg} "{url}"')
    out = subprocess.run(cmd, capture_output=True, text=True, shell=True).stdout
    if body is not None:
        os.remove(path)
    out = out.strip()
    parts = out.rsplit("\n", 1)
    code = parts[1] if len(parts) == 2 else ""
    payload = parts[0]
    try:
        j = json.loads(payload) if payload else {}
    except Exception:
        j = {"_raw": payload}
    return int(code) if code.isdigit() else -1, j


def is_ignored(abspath):
    r = subprocess.run(["git", "-C", LOCAL, "check-ignore", "-q", abspath],
                       capture_output=True, shell=True)
    return r.returncode == 0


def extra_excluded(rel, excl):
    return any(rel == e or rel.endswith("/" + e) or rel.startswith(e + "/") for e in excl)


def collect_files(excl):
    out = []
    for dp, dns, fns in os.walk(LOCAL):
        dns[:] = [d for d in dns if d != ".git"]
        for fn in fns:
            ab = os.path.join(dp, fn)
            rel = os.path.relpath(ab, LOCAL).replace(os.sep, "/")
            if is_ignored(ab):
                continue
            if extra_excluded(rel, excl):
                print(f"  - 排除(脱敏) {rel}")
                continue
            sz = os.path.getsize(ab)
            if sz > MAX_BLOB:
                print(f"  [跳过超大] {rel} ({sz//1024//1024}MB)")
                continue
            out.append((rel, ab, sz))
    out.sort()
    return out


def push_repo(repo, excl, msg_prefix):
    print(f"\n########## 推送到 {repo} (脱敏排除: {excl or '无'}) ##########")
    files = collect_files(excl)
    total = sum(s for _, _, s in files)
    print(f"  共 {len(files)} 文件, {total//1024}KB")

    code, j = curl("GET", f"https://api.github.com/repos/{repo}/git/refs/heads/main")
    if code == 200 and "object" in j:
        base = j["object"]["sha"]
        print("  main 现有:", base)
    elif code in (404, 409):   # 空仓库 GET ref 返回 409
        readme = open(os.path.join(LOCAL, "README.md"), "r", encoding="utf-8").read()
        code, j = curl("PUT", f"https://api.github.com/repos/{repo}/contents/README.md",
                       {"message": "init: bootstrap", "content": base64.b64encode(readme.encode()).decode()})
        if code not in (200, 201) or "commit" not in j:
            print("  bootstrap 失败:", j)
            sys.exit(1)
        base = j["commit"]["sha"]
        print("  bootstrap:", base)
    else:
        print("  获取 main 失败:", code, j)
        sys.exit(1)

    entries = []
    for rel, ab, sz in files:
        with open(ab, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        code, j = curl("POST", f"https://api.github.com/repos/{repo}/git/blobs",
                      {"content": b64, "encoding": "base64"})
        if code not in (200, 201) or "sha" not in j:
            print("  blob 失败", rel, code, j)
            sys.exit(1)
        entries.append((rel, "100644", j["sha"]))
        print(f"  + {rel} ({sz//1024}KB)")

    tree = [{"path": p, "mode": m, "type": "blob", "sha": s} for (p, m, s) in entries]
    code, j = curl("POST", f"https://api.github.com/repos/{repo}/git/trees", {"tree": tree})
    print("  tree HTTP", code, j.get("sha"))
    if code not in (200, 201) or "sha" not in j:
        print("  tree 失败:", j)
        sys.exit(1)
    tree_sha = j["sha"]

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    msg = f"{msg_prefix} 同步（{len(files)} 文件）{now[:10]}"
    code, j = curl("POST", f"https://api.github.com/repos/{repo}/git/commits",
                  {"message": msg, "tree": tree_sha, "parents": [base],
                   "author": {"name": "g101400", "email": "g101400@users.noreply.github.com", "date": now},
                   "committer": {"name": "g101400", "email": "g101400@users.noreply.github.com", "date": now}})
    print("  commit HTTP", code, j.get("sha"))
    if code not in (200, 201) or "sha" not in j:
        print("  commit 失败:", j)
        sys.exit(1)
    commit_sha = j["sha"]

    code, j = curl("PATCH", f"https://api.github.com/repos/{repo}/git/refs/heads/main",
                  {"sha": commit_sha, "force": True})
    print("  ref HTTP", code, j.get("message", j.get("ref")))
    if code not in (200, 201):
        print("  ref 失败:", j)
        sys.exit(1)
    print("  完成 远程 main =", commit_sha)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", help="只推指定仓库，如 g101400/shuili-yitu")
    ap.add_argument("--exclude", action="append", default=[], help="额外排除路径，可重复")
    args = ap.parse_args()

    if args.repo:
        push_repo(args.repo, args.exclude, "chore:")
        return
    if APP not in APP_MAP:
        print(f"未知应用目录 {APP}，请用 --repo 指定目标仓库")
        sys.exit(1)
    pub = APP_MAP[APP]["pub"]
    int_ = APP_MAP[APP]["int"]
    push_repo(int_[0], int_[1], "chore: 内部版")
    push_repo(pub[0], pub[1], "chore: 公开版")


if __name__ == "__main__":
    main()
