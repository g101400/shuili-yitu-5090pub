#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
怀柔区离线瓦片下载器（天地图 CGCS2000 / 经纬度投影 vec_w）

产出目录结构（与 App 端 offline_tiles/{z}/{x}/{y}.png 约定一致）：
    offline_tiles/{z}/{x}/{y}.png
    offline_manifest.json        # App 端可选清单（范围/层级/张数/体积）

使用：
    python3 download_tiles.py                  # 默认：怀柔 bbox, z8-z14
    python3 download_tiles.py --zmin 6 --zmax 13
    python3 download_tiles.py --bbox 116.28,40.30,117.03,41.05 --out ./my_tiles

注意：
    - 天地图瓦片为 Web Mercator 墨卡托切片（与 Leaflet 默认一致），经纬度 bbox 需转墨卡托再算 x/y 范围。
    - TOKEN 用服务器端 token（TOKEN_SERVER），避免 WebView 跨域限制（本脚本在开发机直接跑）。
    - 大范围高缩放级会抓取数万张、体积几百 MB；先用 --dry 估算再实抓。
"""

import argparse
import json
import math
import os
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

TOKEN = "61691764ff68bf341c4c9c4770b24b5f"  # 浏览器端 token（服务器端 token 直连被 403 拦截）
TILE_URL = "https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=" + TOKEN
SUBDOMAINS = ["0", "1", "2", "3", "4", "5", "6", "7"]
# 默认怀柔区行政范围（东经,北纬 西南-东北）
DEFAULT_BBOX = [116.28, 40.30, 117.03, 41.05]
UA = "Mozilla/5.0 (compatible; offline-tile-fetcher/1.0)"
REFERER = "http://www.tianditu.gov.cn/"


def lonlat_to_tile(lon, lat, z):
    """经纬度 → 瓦片 x/y（Web Mercator 切片）"""
    n = 2 ** z
    xt = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    yt = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return xt, yt


def tile_to_lonlat(x, y, z):
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    lat = math.degrees(lat_rad)
    return lon, lat


def bbox_tiles(bbox, z):
    x0, y1 = lonlat_to_tile(bbox[0], bbox[3], z)  # 西南角 → (x_min, y_min)
    x1, y0 = lonlat_to_tile(bbox[2], bbox[1], z)  # 东北角 → (x_max, y_max)
    xs = list(range(min(x0, x1), max(x0, x1) + 1))
    ys = list(range(min(y0, y1), max(y0, y1) + 1))
    return [(z, x, y) for x in xs for y in ys]


def fetch_tile(args):
    z, x, y, out_dir = args
    path = os.path.join(out_dir, str(z), str(x), f"{y}.png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return (path, "skip")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = TILE_URL.format(s=SUBDOMAINS[(x + y) % len(SUBDOMAINS)], x=x, y=y, z=z)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        if len(data) < 100:  # 天地图空瓦片通常很小（纯色），保留但标记
            with open(path, "wb") as f:
                f.write(data)
            return (path, "tiny")
        with open(path, "wb") as f:
            f.write(data)
        return (path, "ok")
    except (urllib.error.URLError, OSError) as e:
        return (path, f"err:{e}")


def main():
    ap = argparse.ArgumentParser(description="怀柔区离线瓦片下载器（天地图）")
    ap.add_argument("--bbox", default=",".join(map(str, DEFAULT_BBOX)),
                    help="经纬度范围 西,南,东,北（默认怀柔）")
    ap.add_argument("--zmin", type=int, default=8)
    ap.add_argument("--zmax", type=int, default=14)
    ap.add_argument("--out", default=None, help="输出目录（默认 ./offline_tiles）")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--dry", action="store_true", help="只估算瓦片数与体积，不下载")
    ap.add_argument("--limit", type=int, default=0, help="最多下载 N 张（调试用）")
    args = ap.parse_args()

    bbox = [float(v) for v in args.bbox.split(",")]
    assert len(bbox) == 4, "bbox 必须是 西,南,东,北"
    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "offline_tiles")
    out_dir = os.path.abspath(out_dir)

    tasks = []
    for z in range(args.zmin, args.zmax + 1):
        tasks.extend(bbox_tiles(bbox, z))

    total = len(tasks)
    est_mb = total * 0.02  # 平均每张约 20KB 粗估
    print(f"[估算] 层级 z{args.zmin}-z{args.zmax}，共 {total} 张瓦片，预计约 {est_mb:.1f} MB")
    print(f"[输出] {out_dir}")
    if args.dry:
        return

    if args.limit and args.limit < total:
        print(f"[限制] 仅下载前 {args.limit} 张（调试）")
        tasks = tasks[:args.limit]

    ok = skip = err = 0
    done = 0
    bar_len = 40
    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        futures = [ex.submit(fetch_tile, (z, x, y, out_dir)) for (z, x, y) in tasks]
        for fu in as_completed(futures):
            _, status = fu.result()
            if status == "ok":
                ok += 1
            elif status == "skip":
                skip += 1
            else:
                err += 1
                if err <= 10:
                    print("  失败:", status)
            done += 1
            if done % 500 == 0 or done == total:
                pct = done / total
                bar = "#" * int(bar_len * pct) + "-" * (bar_len - int(bar_len * pct))
                sys.stdout.write(f"\r[{bar}] {done}/{total}  ok={ok} skip={skip} err={err}")
                sys.stdout.flush()
    print()

    # 写清单
    manifest = {
        "source": "tianditu vec_w (CGCS2000)",
        "bbox": bbox,
        "zmin": args.zmin,
        "zmax": args.zmax,
        "tiles": ok + skip,
        "errors": err,
        "path": "offline_tiles/{z}/{x}/{y}.png"
    }
    with open(os.path.join(out_dir, "..", "offline_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[完成] 下载 {ok} 张，跳过 {skip} 张，失败 {err} 张")
    print(f"[清单] offline_manifest.json")


if __name__ == "__main__":
    main()
