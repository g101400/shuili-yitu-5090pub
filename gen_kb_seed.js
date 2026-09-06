// 构建期工具：从 data.js 抽取建筑骨干，生成 kb_building_seed.js（全局数组 window.KB_BUILDING_SEED）
// 该种子在 ai_module.js init() 时合并进本地知识库，实现"发行前预生成、安装即得本地 KB"。
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const data = fs.readFileSync(path.join(dir, "assets", "data.js"), "utf8");
const win = {};
const sandbox = { window: win, console: console };
const vm = require("vm");
vm.createContext(sandbox);
// 仅执行到赋值 window.SHUILI_DATA 即可（data.js 是纯数据赋值，无 DOM 依赖）
vm.runInContext(data, sandbox, { timeout: 5000 });
const arr = win.SHUILI_DATA || [];
if (!arr.length) { console.error("未找到 SHUILI_DATA"); process.exit(1); }
const t0 = new Date().toLocaleString("zh-CN");
const seed = arr.map(function (b) {
  var o = { id: b.id, name: b.name, office: b.office, station: b.station, btype: b.btype, chan: b.chan, path: b.path, ts: t0 };
  if (b.lon != null) o.lon = b.lon;
  if (b.lat != null) o.lat = b.lat;
  o.photos = Array.isArray(b.photos) ? b.photos : [];
  o.attrs = Array.isArray(b.attrs) ? b.attrs : [];
  return o;
});
const out = "// 自动生成（gen_kb_seed.js），请勿手改。建筑骨干预生成种子，ai_module.js init 时合并进本地 KB。\n" +
  "window.KB_BUILDING_SEED = " + JSON.stringify(seed) + ";\n";
fs.writeFileSync(path.join(dir, "assets", "kb_building_seed.js"), out, "utf8");
console.log("已生成 kb_building_seed.js：建筑骨干 " + seed.length + " 条，" + (out.length / 1024).toFixed(1) + " KB");
