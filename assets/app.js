/* 水利工程基础信息一张图 — 离线 WebView 应用逻辑 */

(function () {

  "use strict";

  // 全局错误兜底：任何运行期错误都通过 toast 显示，避免“白屏/假死”无提示

  // v3.30.3：增强诊断——尽量抓 err.stack 与脚本 URL，跨域(Script error)时也能暴露更多线索

  window.onerror = function (msg, src, line, col, err) {

    var detail = String(msg || "");

    try {

      if (err && err.stack) detail += " | " + err.stack;

      else if (src) detail += " | @" + src + ":" + line + ":" + col;

    } catch (e2) {}

    var t = document.getElementById("toast");

    if (t) { t.textContent = "运行错误：" + detail; t.classList.add("show"); }

    try { window.__lastError = { msg: msg, src: src, line: line, col: col, stack: err ? err.stack : "" }; } catch (e3) {}

    return false;

  };

  // v3.30.3：ovobj 模块加载自检（ovobj_bridge.js 在 app.js 前引入；若缺失，点「导入 ovobj」会 ReferenceError → Script error）

  setTimeout(function () {

    try {

      if (typeof importOvobj !== "function" && typeof window.importOvobj !== "function") {

        toast("⚠ ovobj 模块未加载（ovobj_bridge.js 缺失或加载失败），导入奥维坐标功能不可用");

      }

    } catch (e) {}

  }, 1500);



  // v3.30.3：老 WebView 兼容 polyfill（安卓 5.x 系统 WebView / 老 WebKitGTK 缺 Array.prototype.find 等 ES6 API）

  // 根因：ovobj 导入路由用 list.find()，老 WebView 无此方法 → TypeError 未捕获 → Script error. @0:0

  if (typeof Array.prototype.find !== "function") {

    Array.prototype.find = function (pred) {

      for (var i = 0; i < this.length; i++) { if (pred(this[i], i, this)) return this[i]; }

      return undefined;

    };

  }

  if (typeof Array.prototype.findIndex !== "function") {

    Array.prototype.findIndex = function (pred) {

      for (var i = 0; i < this.length; i++) { if (pred(this[i], i, this)) return i; }

      return -1;

    };

  }

  if (typeof Array.from !== "function") {

    Array.from = function (arrLike) {

      var out = [];

      for (var i = 0; i < arrLike.length; i++) out.push(arrLike[i]);

      return out;

    };

  }

  if (typeof Object.assign !== "function") {

    Object.assign = function (t) {

      for (var i = 1; i < arguments.length; i++) {

        var s = arguments[i]; if (!s) continue;

        for (var k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; }

      }

      return t;

    };

  }

  // 天地图 Token（请根据使用环境选择）

  // v3.45：从 localStorage 读取用户配置的密钥（防过期/被风控后用户自换），缺省回退到内置值

  var TOKEN_BROWSER_DEFAULT = "61691764ff68bf341c4c9c4770b24b5f";

  // 服务器端脚本拉取瓦片用此 token（本应用为纯前端，不直接使用，仅备查）

  var TOKEN_SERVER = "d258e3622cb1755b59a59e4b7ac6d96e";

  // 本应用在 WebView 中运行，使用浏览器端 token；优先用户在「修改/添加天地图密钥」里配置的密钥

  function loadToken() {

    try { var k = localStorage.getItem("shuili_tdt_token"); return (k && k.trim()) ? k.trim() : TOKEN_BROWSER_DEFAULT; }

    catch (e) { return TOKEN_BROWSER_DEFAULT; }

  }

  function saveToken(k) {

    try { localStorage.setItem("shuili_tdt_token", String(k || "").trim()); } catch (e) {}

  }

  function clearToken() {

    try { localStorage.removeItem("shuili_tdt_token"); } catch (e) {}

  }

  var TOKEN = loadToken();

  var AUTHOR = "科技推广中心";

  var LS_KEY = "shuili_map_v2";

  var APPNAME = "水利工程基础信息一张图";

  var APP_VERSION = "v3.59";

  var APP_BUILD_DATE = "2026-09-07";

  // —— 双通道发版（防泄密）：版本末位奇偶决定发布通道 ——
  // 偶数(如 v3.50) = 内部版，保留单位内部数据；奇数(如 v3.49) = 公开/测试版，不含内部数据。
  function getReleaseChannel() {
    try {
      var seg = String(APP_VERSION || "").replace(/^v/i, "").split(".");
      var last = parseInt(seg[seg.length - 1], 10);
      if (isNaN(last)) return "internal";
      return (last % 2 === 0) ? "internal" : "public";
    } catch (e) { return "internal"; }
  }
  var RELEASE_CHANNEL = getReleaseChannel();
  window.SHUILI_RELEASE_CHANNEL = RELEASE_CHANNEL;

  // 传输设置（持久化到 localStorage）

  var XFER = loadXfer();

  function loadXfer() {

    try { return Object.assign({ source: "local", resume: true, overwriteSame: "ask", baiduToken: "", quarkToken: "" }, JSON.parse(localStorage.getItem("shuili_xfer") || "{}")); }

    catch (e) { return { source: "local", resume: true, overwriteSame: "ask", baiduToken: "", quarkToken: "" }; }

  }

  function saveXfer() { try { localStorage.setItem("shuili_xfer", JSON.stringify(XFER)); } catch (e) {} }



  // 运行维护设置：默认出发位置（F2）

  // v3.38：筛选默认值持久化种子——首次安装默认值，故意不为"全部"，避免打开即全量渲染卡顿

  //   水利→水库所；感知→水库所；古建→北京市（各自 app.js 内定义本常量）

  var DEFAULT_FILTER_SEED = { offices: ["水库所"], stations: [], types: [], photoStatus: "all", photoMin: 3, text: "" };

  function cloneSeed(s) { var o = {}; Object.keys(s).forEach(function (k) { o[k] = Array.isArray(s[k]) ? s[k].slice() : s[k]; }); return o; }

  var SETTINGS = loadSettings();

  function loadSettings() {

    try {

      var s = Object.assign({ startPos: null, defaultFilter: null }, JSON.parse(localStorage.getItem("shuili_settings") || "{}"));

      if (!s.defaultFilter) s.defaultFilter = cloneSeed(DEFAULT_FILTER_SEED);

      return s;

    } catch (e) { return { startPos: null, defaultFilter: cloneSeed(DEFAULT_FILTER_SEED) }; }

  }

  function saveSettings() { try { localStorage.setItem("shuili_settings", JSON.stringify(SETTINGS)); } catch (e) {} }

  // v3.38：筛选默认值持久化——打开时套用；每次筛选操作写回

  function applyDefaultFilter() {

    var d = SETTINGS.defaultFilter || cloneSeed(DEFAULT_FILTER_SEED);

    Object.keys(filters).forEach(function (k) {

      var v = d[k]; if (v == null) return;

      filters[k] = (filters[k] instanceof Set) ? new Set(Array.isArray(v) ? v : []) : v;

    });

  }

  function saveDefaultFilter() {

    var o = {};

    Object.keys(filters).forEach(function (k) { var v = filters[k]; o[k] = (v instanceof Set) ? Array.from(v) : v; });

    SETTINGS.defaultFilter = o; saveSettings();

  }

  // 运行维护计划（F3）：type ∈ 日常检查/例行维护/故障处理/应急响应/其他

  var MAINT_PLANS = loadMaintPlans();

  function loadMaintPlans() {

    try { var a = JSON.parse(localStorage.getItem("shuili_maint_plans")); return Array.isArray(a) ? a : []; } catch (e) { return []; }

  }

  function saveMaintPlans() { try { localStorage.setItem("shuili_maint_plans", JSON.stringify(MAINT_PLANS)); } catch (e) {} }



  var BUILDINGS = [];

  var MARKERS = {};

  var LINES = {};

  var filterLayer = null; // 筛选结果高亮层（倒水滴 + 绿色虚线圈）

  var map, baseVec, baseImg, labelVec, labelImg;

  var currentBase = "vec"; // "vec" or "img"

  var addMode = false;

  var pendingAdd = null;

  var editing = null;

  var filters = { guanchu: new Set(["京密引水管理处"]), offices: new Set(), stations: new Set(), types: new Set(), photoStatus: "all", photoMin: 3, text: "" };

  var pendingExportTarget = null; // 照片导出目标：local / baidu / quark / wechat / feishu / qq

  var listMode = false;

  var coordPickMode = false;



  /* ---------- v3.46：全局 script error 拦截 + 上报（用对排查线上静默 script error）----------

     把所有 window.onerror / unhandledrejection 收集到 localStorage("script_errors")（最多 50 条），

     用户在「信息与帮助 → 错误日志」可一键查看并复制反馈。

     同时把运行时异常也拦截并 toast，避免静默失败。 */

  function _logErr(kind, msg, src, lineno, col, err) {

    try {

      var arr = JSON.parse(localStorage.getItem("shuili_script_errors") || "[]");

      arr.push({ ts: Date.now(), kind: kind, msg: String(msg || "").slice(0, 500), src: src || "", lineno: lineno || 0, col: col || 0, stack: err && err.stack ? String(err.stack).slice(0, 800) : "" });

      if (arr.length > 50) arr = arr.slice(-50);

      localStorage.setItem("shuili_script_errors", JSON.stringify(arr));

    } catch (e) {}

  }

  if (typeof window !== "undefined") {

    var _prevOE = window.onerror;

    window.onerror = function (msg, src, lineno, col, err) {

      _logErr("onerror", msg, src, lineno, col, err);

      if (typeof _prevOE === "function") { try { return _prevOE.apply(this, arguments); } catch (e) {} }

      // 不阻断：但给个轻量 toast 提示，避免静默失败

      try { if (window.AIModule && AIModule.toast) AIModule.toast("⚠️ 运行错误（已记录到日志）"); } catch (e) {}

      return false; // 让浏览器继续默认处理（便于开发者工具看到）

    };

    window.addEventListener("unhandledrejection", function (e) {

      try { _logErr("promise", (e.reason && (e.reason.message || e.reason.toString())) || "unknown", "", 0, 0, e.reason); } catch (e2) {}

    });

  }

  // 帮助页暴露：查看错误日志

  window.viewScriptErrors = function () {

    var arr = []; try { arr = JSON.parse(localStorage.getItem("shuili_script_errors") || "[]"); } catch (e) {}

    var body = '<p style="font-size:13px;color:#555;margin-bottom:8px">最近 ' + arr.length + ' 条脚本错误（最多保留 50 条；可一键复制全部）</p>';

    if (!arr.length) body += '<p style="color:#2e8b57">暂无记录 ✓</p>';

    else {

      body += '<button class="tbtn" onclick="copyScriptErrors()" style="margin-bottom:8px">📋 复制全部为 JSON</button>';

      body += arr.slice(-50).reverse().map(function (e, i) {

        return '<div style="border:1px solid #ffe2b8;background:#fffaf0;border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px">' +

          '<b style="color:#c0392b">#' + (arr.length - i) + ' ' + esc(e.kind) + '</b> &nbsp; <span style="color:#888">' + new Date(e.ts).toLocaleString() + '</span><br>' +

          '<pre style="margin:6px 0 0;white-space:pre-wrap;font-family:monospace;color:#333">' + esc(e.msg) + '\n' + esc(e.src || "") + (e.lineno ? ':' + e.lineno : '') + (e.col ? ':' + e.col : '') + '</pre></div>';

      }).join("");

    }

    body += '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +

            '<button class="btn-cancel" onclick="if(confirm(\'确定清空错误日志？\')){localStorage.removeItem(\'shuili_script_errors\');viewScriptErrors();}">🧹 清空</button></div>';

    $("genTitle").textContent = "错误日志（script error 排查）";

    $("genBody").innerHTML = body;

    openSheet("sheetGen");

  };

  window.copyScriptErrors = function () {

    var arr = []; try { arr = JSON.parse(localStorage.getItem("shuili_script_errors") || "[]"); } catch (e) {}

    var txt = JSON.stringify(arr, null, 2);

    try { navigator.clipboard && navigator.clipboard.writeText(txt).then(function () { toast("已复制 " + arr.length + " 条错误日志"); }); }

    catch (e) { toast("复制失败，可手动从「信息与帮助」查看"); }

  };



  /* ---------- v3.49：全平台启动诊断（便于发现「装了新版却显示旧版」） ----------
     app 启动即在控制台打印 + 写入本地诊断缓冲当前版本/构建日期/运行平台。
     UOS 另由 server.py 写入 /opt/<pkg>/launch_err.log（版本号随 version.json 自动更新）。 */
  function logRuntime() {
    try {
      var ua = (navigator && navigator.userAgent) || "";
      var plat = "Web";
      if (/iPhone|iPad|iPod/i.test(ua)) plat = "iOS";
      else if (/Android/i.test(ua)) plat = "Android";
      else if (/Windows/i.test(ua)) plat = "Win";
      else if (/UOS|Deepin|UnionTech|Linux/i.test(ua)) plat = "UOS";
      var name = (window.SHUILI_META && window.SHUILI_META.appName) ? window.SHUILI_META.appName
                 : (typeof APP_NAME !== "undefined" ? APP_NAME : "app");
      var line = "▶ 启动 " + name + " " + APP_VERSION + " (build " + APP_BUILD_DATE + ") platform=" + plat;
      try { console.log(line); } catch (e) {}
      var arr = []; try { arr = JSON.parse(localStorage.getItem("yitu_runtime_log") || "[]"); } catch (e) {}
      arr.push({ ts: Date.now(), v: APP_VERSION, d: APP_BUILD_DATE, p: plat });
      if (arr.length > 20) arr = arr.slice(-20);
      localStorage.setItem("yitu_runtime_log", JSON.stringify(arr));
      window.__LAST_RUNTIME__ = line;
      if (RELEASE_CHANNEL === "public") {
        try { if (typeof toast === "function") setTimeout(function () { toast("📢 公开测试版 · 不含单位内部数据"); }, 700); } catch (e) {}
      }
    } catch (e) {}
  }
  try { logRuntime(); } catch (e) {}

  /* ---------- 工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {

    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {

      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];

    });

  }

  function toast(msg) {

    var t = $("toast");

    t.textContent = msg;

    t.classList.add("show");

    clearTimeout(toast._t);

    toast._t = setTimeout(function () { t.classList.remove("show"); }, 1900);

  }

  function nowLocalDateTime() {

    var d = new Date();

    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") +

      "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

  }



  /* ---------- v3.26：管理所名称统一 ----------

     规则：

     1) 去掉“管理”两字：温泉管理所 → 温泉所、埝头管理所 → 埝头所（导入/导出统一处理）

     2) 潮河管理所 / 潮河总干渠管理所 → 潮河所（导入/导出统一处理）

     3) 查询/筛选比较时忽略“管理”二字：史山所 与 史山管理所 视为同一管理所

     4) 站不是所：管理站(station) 是管理所(office) 的下一级，不参与合并

   */

  function normOffice(s) {

    s = String(s == null ? "" : s).trim();

    if (!s) return "";

    // 潮河特殊：潮河管理所 / 潮河总干渠 / 潮河总干渠管理所 → 潮河所

    if (/^潮河(总干渠)?(管理所)?$/.test(s)) return "潮河所";

    // 怀柔水库所 → 水库所（怀柔的水库管理所）

    if (/^怀柔水库所?$/.test(s)) return "水库所";

    // 通用：xxx管理所 → xxx所（去“管理”二字）

    return s.replace(/管理所$/, "所");

  }

  // 管理所完整选项：权威清单 + 数据实际出现的管理所，保证筛选/导出“管理所”选项不遗漏（需求⑤）

  var CANONICAL_OFFICES = ["地下水源所", "温泉所", "龙山所", "史山所", "埝头所", "水库所", "北台上所", "西田各庄所", "潮河所"];

  function officeOptions() {

    // v3.42：统一走五级组织体系（持久化清单 + 权威9所 + 数据实际值），设置里增删改后全端同步

    return levelOptions("suo");

  }

  // 周边/筛选/下拉共用的管理站选项（v3.42：同走五级组织体系）

  function stationOptions() {

    return levelOptions("zhan");

  }

  // 管理所/管理站自定义名称记录（持久化，满足“手动添加/修改并同步建筑”）

  function getCustomOffices() { try { return JSON.parse(localStorage.getItem("customOfficeList") || "[]"); } catch (e) { return []; } }

  function setCustomOffices(a) { try { localStorage.setItem("customOfficeList", JSON.stringify(a)); } catch (e) {} }

  function getCustomStations() { try { return JSON.parse(localStorage.getItem("customStationList") || "[]"); } catch (e) { return []; } }

  function setCustomStations(a) { try { localStorage.setItem("customStationList", JSON.stringify(a)); } catch (e) {} }

  // v3.45：管理处完整选项（持久化清单 + 权威默认值 + 数据实际出现值；与所/站复用同一套组织体系）

  var CANONICAL_GUANCHU = ["京密引水管理处", "潮白河管理处", "海河管理处", "永定河管理处", "北运河管理处"];

  function getCustomGuanchu() { try { return JSON.parse(localStorage.getItem("customGuanchuList") || "[]"); } catch (e) { return []; } }

  function setCustomGuanchu(a) { try { localStorage.setItem("customGuanchuList", JSON.stringify(a)); } catch (e) {} }

  function guanchuOptions() {

    var arr = getCustomGuanchu().slice();

    CANONICAL_GUANCHU.forEach(function (v) { if (v && arr.indexOf(v) < 0) arr.push(v); });

    var dataVals = [];

    BUILDINGS.forEach(function (b) { if (b.guanchu) dataVals.push(b.guanchu); });

    dataVals = uniq(dataVals);

    dataVals.forEach(function (v) { if (arr.indexOf(v) < 0) arr.push(v); });

    return arr;

  }



  /* ---------- v3.42：五级组织体系（局/管理处/所/站/段）+ 默认值 + 类型清单 ---------- */

  var ORG_LEVELS = [

    { k: "ju", t: "局" }, { k: "guanchu", t: "管理处" }, { k: "suo", t: "所" },

    { k: "zhan", t: "站" }, { k: "duan", t: "段" }

  ];

  var ORG_DEFAULT_NAMES = { ju: "水利工程管理中心", guanchu: "京密引水管理处", suo: "水库所" };

  function orgStore() {

    var def = { ju: [ORG_DEFAULT_NAMES.ju], guanchu: [ORG_DEFAULT_NAMES.guanchu], suo: CANONICAL_OFFICES.slice(), zhan: [], duan: [] };

    BUILDINGS.forEach(function (b) { if (b.station) def.zhan.push(b.station); if (b.chan) def.duan.push(b.chan); });

    def.zhan = uniq(def.zhan); def.duan = uniq(def.duan);

    var saved = null;

    try { saved = JSON.parse(localStorage.getItem("org_levels") || "null"); } catch (e) {}

    if (!saved) saved = {};

    ORG_LEVELS.forEach(function (lv) {

      if (!Array.isArray(saved[lv.k])) saved[lv.k] = def[lv.k];

      if (lv.k === "suo") CANONICAL_OFFICES.forEach(function (o) { if (saved[lv.k].indexOf(o) < 0) saved[lv.k].push(o); });

    });

    return saved;

  }

  function saveOrgStore(o) { try { localStorage.setItem("org_levels", JSON.stringify(o)); } catch (e) {} }

  function getOrgDefaults() {

    var d = { ju: ORG_DEFAULT_NAMES.ju, guanchu: ORG_DEFAULT_NAMES.guanchu, suo: ORG_DEFAULT_NAMES.suo, zhan: "", duan: "" };

    try { var s = JSON.parse(localStorage.getItem("org_defaults") || "null"); if (s) for (var k in d) if (s[k]) d[k] = s[k]; } catch (e) {}

    return d;

  }

  function setOrgDefaults(d) { try { localStorage.setItem("org_defaults", JSON.stringify(d)); } catch (e) {} }

  // 建筑物的局/管理处（老数据缺字段时回退默认值）

  function bJu(b) { return b.ju || getOrgDefaults().ju; }

  function bGuanChu(b) { return b.guanchu || getOrgDefaults().guanchu; }

  function orgVal(b, k) {

    if (k === "ju") return bJu(b);

    if (k === "guanchu") return bGuanChu(b);

    if (k === "suo") return normOffice(b.office) || "";

    if (k === "zhan") return b.station || "";

    if (k === "duan") return b.chan || "";

    if (k === "bname") return b.name || "";

    return "";

  }

  // 层级选项 = 持久化清单 + 数据实际出现值（筛选/下拉/导入导出全走这里）

  // v3.46（关键修复）：层级选项 = 持久化清单 + 自定义清单（getCustomOffices/getCustomStations）+ 数据实际出现值，

  //   保证筛选菜单 + 添加管理所/管理站 后立即出现在 chip 列表里（v3.42 漏了 getCustomOffices/getCustomStations 整合，

  //   导致筛选菜单里"＋ 添加"看似成功但 chip 不显示——因为 officeOptions 只读 org_levels + 数据实际值）。

  function levelOptions(k) {

    var set = {};

    orgStore()[k].forEach(function (v) { if (v) set[v] = 1; });

    // v3.46：把 customOfficeList / customStationList 也纳入（与 org_levels 同权展示）

    if (k === "suo") getCustomOffices().forEach(function (v) { if (v) set[v] = 1; });

    if (k === "zhan") getCustomStations().forEach(function (v) { if (v) set[v] = 1; });

    if (k === "suo") BUILDINGS.forEach(function (b) { var o = normOffice(b.office); if (o) set[o] = 1; });

    if (k === "zhan") BUILDINGS.forEach(function (b) { if (b.station) set[b.station] = 1; });

    if (k === "duan") BUILDINGS.forEach(function (b) { if (b.chan) set[b.chan] = 1; });

    return Object.keys(set).sort();

  }

  // 建筑物类型自定义清单（v3.42：可增删改，与权威清单同权展示）

  function getCustomTypes() { try { return JSON.parse(localStorage.getItem("org_types") || "[]"); } catch (e) { return []; } }

  function setCustomTypes(a) { try { localStorage.setItem("org_types", JSON.stringify(a)); } catch (e) {} }

  // 组织层级智能匹配（zip 照片导入三级匹配用）：史山→史山所、潮河→潮河所 等

  function stripOrgSuffix(s) { return String(s || "").replace(/(管理处|管理所|管理局|分所|分站)$/g, "").replace(/[所局站段]$/g, "").trim(); }

  function matchOrgLevel(text) {

    var t = stripOrgSuffix(text); if (!t) return null;

    var lv = orgStore();

    for (var i = 0; i < ORG_LEVELS.length; i++) {

      var k = ORG_LEVELS[i].k, arr = lv[k] || [];

      for (var j = 0; j < arr.length; j++) {

        var v = arr[j]; if (!v) continue;

        if (v === text || text.indexOf(v) >= 0 || stripOrgSuffix(v) === t || (t.length >= 2 && v.indexOf(t) === 0)) return { level: k, value: v };

      }

    }

    return null;

  }



  /* ---------- v3.42：导出 — 文件名组成 / 文件夹层次装配器 ----------

     组织五级（局/管理处/所/站/段）可选项之间用 _ 串接；文件夹层次（路径前缀）默认所；

     偏好持久化到 localStorage("exp_cfg_<kind>")，按导出类型分键，互不干扰。 */

  var EXPORT_FIELDS = ["ju", "guanchu", "suo", "zhan", "duan"]; // 文件名可用字段（不含 name）

  var EXPORT_PATH_FIELDS = ["ju", "guanchu", "suo", "zhan", "duan"]; // 文件夹可用字段（同上）

  var EXPORT_LABELS = { ju: "局", guanchu: "管理处", suo: "所", zhan: "站", duan: "段" };

  function expDefaultCfg(kind) {

    // 默认：文件名 = 所_建筑物名；文件夹层次 = 所

    var c = { nameFields: ["suo"], pathFields: ["suo"] };

    try {

      var saved = JSON.parse(localStorage.getItem("exp_cfg_" + kind) || "null");

      if (saved && Array.isArray(saved.nameFields)) c.nameFields = saved.nameFields.slice(0, 5);

      if (saved && Array.isArray(saved.pathFields)) c.pathFields = saved.pathFields.slice(0, 5);

    } catch (e) {}

    // 至少保留 1 个：默认「所」

    if (!c.nameFields.length) c.nameFields = ["suo"];

    if (!c.pathFields.length) c.pathFields = ["suo"];

    return c;

  }

  function expSaveCfg(kind, c) {

    try { localStorage.setItem("exp_cfg_" + kind, JSON.stringify(c)); } catch (e) {}

  }

  // v3.43：给建筑物取值（含自定义+默认值兜底；段默认可空）

    // v3.46 修复：defaultOffice 此前被 orgValOrDefault 调用却未定义，导致 导出建筑物表格/导出照片 打开即 ReferenceError（WebView 报 script error）

  function defaultOffice() { return getOrgDefaults().suo || ORG_DEFAULT_NAMES.suo || "水库所"; }

function orgValOrDefault(b, k) {

    if (!b) return "";

    if (k === "suo") return normOffice(b.office) || defaultOffice() || "";

    if (k === "ju") return b.ju || getOrgDefaults().ju || "";

    if (k === "guanchu") return b.guanchu || getOrgDefaults().guanchu || "";

    if (k === "zhan") return b.station || getOrgDefaults().zhan || "";

    if (k === "duan") return b.chan || getOrgDefaults().duan || "";

    return "";

  }

  // 组装导出文件名（不含扩展名）：字段_字段_建筑物名，过滤空值，无效字符替换

  function assembleExportName(b, cfg, fallbackBase) {

    if (!cfg || !cfg.nameFields || !cfg.nameFields.length) cfg = { nameFields: ["suo"] };

    var parts = cfg.nameFields.map(function (k) { return orgValOrDefault(b, k); }).filter(Boolean);

    var nm = b && b.name ? b.name : (fallbackBase || APPNAME);

    parts.push(nm);

    var raw = parts.filter(function (x) { return x && x !== "（未设置）"; }).join("_");

    raw = raw.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "");

    if (!raw) raw = (fallbackBase || APPNAME) + "_" + getTodayStr();

    return raw;

  }

  // 组装文件夹层次（路径段）：默认所。空段丢弃。返回数组（不含首尾分隔符）

  function assembleExportPath(b, cfg) {

    if (!cfg || !cfg.pathFields || !cfg.pathFields.length) cfg = { pathFields: ["suo"] };

    var segs = cfg.pathFields.map(function (k) { return orgValOrDefault(b, k); }).filter(Boolean);

    segs = segs.filter(function (s) { return s && s !== "（未设置）"; });

    return segs;

  }

  // 渲染导出选项（文件名组成 / 文件夹层次复选框）

  function renderExportOptions(kind, cfg) {

    function box(field, cur) {

      var html = '<fieldset style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin:8px 0">' +

        '<legend style="padding:0 6px;font-size:13px;color:#3a2e28">' +

        (field === "name" ? '📝 文件名组成（_ 连接，末尾自动追加「建筑物名」）' : '📂 文件夹层次（路径前缀，默认「所」）') +

        '</legend><div style="display:flex;flex-wrap:wrap;gap:8px">';

      EXPORT_FIELDS.forEach(function (k) {

        var on = cur.indexOf(k) >= 0;

        html += '<label style="display:inline-flex;align-items:center;gap:4px;font-size:13px;background:' + (on ? "#e8f4ea" : "transparent") + ';padding:3px 8px;border-radius:14px;cursor:pointer;border:1px solid ' + (on ? "#2e7d32" : "#d0d4d8") + '">' +

          '<input type="checkbox" class="exp-' + field + '-chk" data-k="' + k + '"' + (on ? " checked" : "") + '> ' + EXPORT_LABELS[k] + '</label>';

      });

      html += '</div></fieldset>';

      return html;

    }

    return box("name", cfg.nameFields) + box("path", cfg.pathFields);

  }

  // 对话框确定后回读勾选项

  function readExportOptions(body, kind) {

    var nameFields = [], pathFields = [];

    body.querySelectorAll(".exp-name-chk").forEach(function (c) { if (c.checked) nameFields.push(c.dataset.k); });

    body.querySelectorAll(".exp-path-chk").forEach(function (c) { if (c.checked) pathFields.push(c.dataset.k); });

    if (!nameFields.length) nameFields = ["suo"];

    if (!pathFields.length) pathFields = ["suo"];

    var cfg = { nameFields: nameFields, pathFields: pathFields };

    expSaveCfg(kind, cfg);

    return cfg;

  }

  // v3.42：批量导出后的智能分级（一张照片 / 一个建筑物 → 自动按所目录归集）

  function applyFolder(files, rootName) {

    // files: [{relPath, fileName, path?, b?}] → 修订 baseName 与 folder

    // 这里只标记 pathSegments，让导出侧自由组合

  }

  function safeName(s) { return String(s || "").replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, ""); }



  /* ---------- 通用多选确认对话框（v3.19：导入同名覆盖 / 重复文件二次导入等）----------

     用法：ask("标题", "<b>html</b>正文", [{t:"按钮文字", cls:"btn-confirm2", v:1}, ...], function(v){...});

     cls 取值见 .ask-btns 按钮样式：btn-confirm2（绿/确认）、btn-cancel2（灰）、btn-exit（红/退出）。

     三击空白也能关闭（见 closeTopLayer）。 */

  window.ask = function (title, msg, opts, cb) {

    var box = $("askBox");

    if (!box) return;

    box.querySelector(".ask-title").textContent = title || "提示";

    box.querySelector(".ask-msg").innerHTML = msg || "";

    var btns = box.querySelector(".ask-btns");

    btns.innerHTML = "";

    (opts || []).forEach(function (o) {

      var b = document.createElement("button");

      b.textContent = o.t;

      b.className = o.cls || "btn-cancel";

      b.onclick = function () { closeAsk(); if (cb) cb(o.v); };

      btns.appendChild(b);

    });

    box.classList.add("show");

  };

  window.closeAsk = function () {

    var box = $("askBox");

    if (box) box.classList.remove("show");

  };



  /* ============ 全局"执行中，请稍后"忙提示浮层（Req 2 / 优化要求 5）============

     用途：菜单命令、导入导出、批量匹配等可能耗时较长的操作，统一给出明确的等待提示，

     避免用户以为卡死而反复点击（反复点击本身还会叠加任务、真的把 WebView 拖死）。

     用法：busy("正在导入…"); ... idle();

       - busy(msg)            显示/更新提示文字

       - busyDetail(text)     更新第二行细节（如 3/120）

       - idle()               关闭

       - busyRun(msg, fn)     显示提示 → 下一帧执行 fn → 自动关闭（同步重活用这个，

                              保证提示先真正绘制出来，否则同步 JS 会阻塞渲染）

     期间用一层透明遮罩吃掉点击，防止重复触发。 */

  var BUSY = { n: 0, t0: 0 };

  function busy(msg) {

    var el = $("busyOverlay");

    if (!el) {

      el = document.createElement("div");

      el.id = "busyOverlay";

      el.innerHTML =

        '<div class="busy-box">' +

        '<div class="busy-spin"></div>' +

        '<div class="busy-msg" id="busyMsg"></div>' +

        '<div class="busy-sub" id="busySub">请稍后，勿重复点击或退出本页…</div>' +

        "</div>";

      document.body.appendChild(el);

    }

    var m = $("busyMsg");

    if (m) m.textContent = msg || "执行中，请稍后…";

    el.classList.add("show");

    BUSY.n++; BUSY.t0 = Date.now();

    return el;

  }

  function busyDetail(text) {

    var s = $("busySub");

    if (s) s.textContent = text || "请稍后，勿重复点击或退出本页…";

  }

  function idle() {

    var el = $("busyOverlay");

    if (el) el.classList.remove("show");

    BUSY.n = 0;

  }

  // 同步重活的标准包装：先绘制提示，再执行，最后一定关闭

  function busyRun(msg, fn) {

    busy(msg);

    setTimeout(function () {

      try { fn(); }

      catch (e) { toast("操作失败：" + (e && e.message ? e.message : e)); }

      finally { idle(); }

    }, 30);

  }

  // 仅当操作确实超过阈值才弹提示，避免快操作闪一下（Req：计算等候时间如果过长）

  function busyIfSlow(msg, ms) {

    clearTimeout(busyIfSlow._t);

    busyIfSlow._t = setTimeout(function () { busy(msg); }, ms == null ? 400 : ms);

  }

  function busyCancelPending() { clearTimeout(busyIfSlow._t); idle(); }

  window.busy = busy; window.idle = idle; window.busyDetail = busyDetail;



  // v3.31.x 作用域桥：ovobj_bridge.js 是独立「全局」<script>，无法访问本 IIFE 内的局部符号

  // （BUILDINGS/$/toast/pickExportScope/APPNAME/getTodayStr/save/render/buildLegend）。

  // 统一经 window.__shuili 暴露，否则导出 ovobj/obj 会因 ReferenceError 被 window.onerror 捕获成

  // “运行错误：script error”，导入时 $ 未定义被 try/catch 吞掉而“无任何提示”。

  // 注：BUILDINGS 会被 loadData/resetData 重新赋值，必须用闭包 getter 拿实时引用。

  window.__shuili = {

    getBuildings: function () { return BUILDINGS; },

    pickExportScope: pickExportScope,

    APPNAME: APPNAME,

    getTodayStr: getTodayStr,

    save: save,

    render: render,

    buildLegend: buildLegend,

    toast: toast,

    ask: ask,

    $: $

  };

  // 照片显示源：优先读磁盘文件（p.file 相对路径，经原生桥读取），否则内联 base64（旧数据兼容）

  // 显示用「缩略图」：原生 thumbPhoto 按比例降采样到 720px 内 JPEG，避免把整张高清图塞进 WebView 内存导致 OOM（2G 包导入后弹窗卡死的根因）。

  // 四端照片路径约定（统一）：photos/<管理所>/<建筑物>/<序号>.jpg（相对 webroot）

  // 安卓原生落盘与桌面/iOS 本地 HTTP 服务共用同一套相对路径；复制文件夹即可跨平台复用，无需重新导入（规避 UOS 8G 内存瓶颈）。

  function photoSrc(p) {

    // v3.31：优先走「持久化缩略图」ensureThumb(320)：首次生成 .thumbs 缓存文件，之后直接读缓存，

    // 避免每次显示都重新解码 7M 原图（500+ 建筑大图下筛选/弹窗卡顿根因之一）。

    if (p.file && window.Android && typeof window.Android.ensureThumb === "function") {

      try { return window.Android.ensureThumb(p.file, 320); } catch (e) {}

    }

    if (p.file && window.Android && typeof window.Android.thumbPhoto === "function") {

      try { return window.Android.thumbPhoto(p.file, 720); } catch (e) {}

    }

    if (p.file) {

      try { if (window.Android && typeof window.Android.readPhoto === "function") return window.Android.readPhoto(p.file); } catch (e) {}

      // Web 托管回退（Win11 / UOS / iOS 本地 HTTP 服务）：相对路径按当前 origin 解析为 HTTP URL，

      // 照片物理存在于 webroot/<相对路径> 即可跨平台显示（与安卓共享同一套相对路径约定）。

      try { return new URL(p.file, location.href).href; } catch (e) { return p.file; }

    }

    return p.data || "";

  }

  // 全分辨率（仅灯箱/保存时使用，一次一张，避免内存暴涨）

  function photoFullSrc(p) {

    if (p.file) {

      try { if (window.Android && typeof window.Android.readPhoto === "function") return window.Android.readPhoto(p.file); } catch (e) {}

      try { return new URL(p.file, location.href).href; } catch (e) { return p.file; }

    }

    return p.data || "";

  }



  /* ============ 照片压缩（方案2：>1.5M 大图导入时压缩，默认 500KB，只存压缩版）============ */

  var COMPRESS_THRESHOLD = 1.5 * 1024 * 1024; // 1.5MB

  var __compressPrefs = null;                 // null=未决定；0=不压缩；>0=目标KB

  var __compressQueue = [];                   // [{rel, abs, sz}] 待压缩的已落盘大图

  var __compressRunning = false;

  // base64 dataURL → 估算字节数

  function dataUrlSize(dataUrl) {

    try {

      var idx = dataUrl.indexOf(",");

      var b64 = idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl;

      return Math.floor(b64.length * 3 / 4);

    } catch (e) { return 0; }

  }

  function fmtMB(b) { return (b / 1048576).toFixed(1); }

  // JS canvas 压缩（base64 场景：单张添加 / 巡视 / 浏览器回退 ovkmz）

  function canvasCompress(dataUrl, targetKB, cb) {

    var img = new Image();

    img.onload = function () {

      try {

        var w = img.width, h = img.height, longer = Math.max(w, h);

        var scale = Math.min(1, 2048 / longer);

        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));

        var cv = document.createElement("canvas");

        cv.width = cw; cv.height = ch;

        cv.getContext("2d").drawImage(img, 0, 0, cw, ch);

        var q = 0.82, out = null, limit = targetKB * 1024;

        for (var i = 0; i < 8; i++) {

          var d = cv.toDataURL("image/jpeg", q);

          if (dataUrlSize(d) <= limit) { out = d; break; }

          q -= 0.09;

        }

        if (!out) out = cv.toDataURL("image/jpeg", 0.25);

        cb(out);

      } catch (e) { cb(dataUrl); }

    };

    img.onerror = function () { cb(dataUrl); };

    img.src = dataUrl;

  }

  // 压缩目标选择弹窗（每会话首次遇大图弹一次，之后沿用选择）

  function askCompressTarget(n, totalMB, estMB, cb) {

    var opts = [[200, "200KB（最省空间）"], [500, "500KB（推荐）"], [1024, "1MB（更清晰）"], [0, "不压缩"]].map(function (o) {

      var sel = o[0] === 500 ? " checked" : "";

      return '<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:14px"><input type="radio" name="cTarget" value="' + o[0] + '"' + sel + '> ' + o[1] + "</label>";

    }).join("");

    ask("检测到大尺寸照片",

      "共 <b>" + n + "</b> 张照片超过 1.5MB（合计约 <b>" + totalMB + "</b> MB）。<br>" +

      "压缩后<b>仅保留压缩版</b>，<b style='color:#c0392b'>原大图将被覆盖删除</b>（原始压缩包请自行备份）。<br><br>" +

      "请选择压缩目标（系统建议 500KB，压缩后约 <b>" + estMB + "</b> MB）：<br>" + opts,

      [{ t: "开始压缩", cls: "btn-confirm2", v: 1 }, { t: "不压缩直接导入", cls: "btn-cancel", v: 0 }],

      function (ok) {

        if (!ok) { __compressPrefs = 0; cb(0); return; }

        var rb = document.querySelector('input[name="cTarget"]:checked');

        __compressPrefs = rb ? parseInt(rb.value, 10) : 500;

        cb(__compressPrefs);

      });

  }

  // 已落盘照片排队压缩（原生并发 + 进度条）；>1.5M 才入队

  function queueCompress(rel) {

    if (!(window.Android && window.Android.photoAbsPath && window.Android.fileSize && window.Android.compressPhoto)) return;

    try {

      var abs = window.Android.photoAbsPath(rel);

      if (!abs) return;

      var sz = window.Android.fileSize(abs);

      if (sz <= COMPRESS_THRESHOLD) return;

      __compressQueue.push({ rel: rel, abs: abs, sz: sz });

    } catch (e) {}

  }

  // 统一压缩触发点：所有照片落盘完成后调用（finishPhotoMatch / 多匹配确认 / ovkmz 导入后）

  function flushCompress() {

    if (__compressRunning || !__compressQueue.length) return;

    if (!(window.Android && window.Android.compressPhoto)) { __compressQueue = []; return; }

    if (__compressPrefs === null) {

      // 首次：弹窗询问（此时队列已稳定，统计准确）

      var n = __compressQueue.length, totalB = 0;

      __compressQueue.forEach(function (q) { totalB += q.sz || 0; });

      askCompressTarget(n, fmtMB(totalB), Math.max(1, Math.round(totalB * 500 / 1048576 / 1024)), function (t) {

        __compressPrefs = t;

        if (t > 0) flushCompress(); else __compressQueue = [];

      });

      return;

    }

    if (__compressPrefs === 0) { __compressQueue = []; return; }

    __compressRunning = true;

    var jobs = __compressQueue.slice(); __compressQueue = [];

    var totalB = 0; jobs.forEach(function (q) { totalB += q.sz || 0; });

    openXferProgress("compress", "正在压缩 " + jobs.length + " 张大尺寸照片…");

    setXferTitle("正在压缩 " + jobs.length + " 张大尺寸照片（原图 " + fmtMB(totalB) + " MB → 目标 ≤" + __compressPrefs + "KB），仅保留压缩版…");

    window.__compressJobs = {};

    jobs.forEach(function (q) {

      window.__compressJobs[q.abs] = null;

      try { window.Android.compressPhoto(q.abs, __compressPrefs); }

      catch (e) { window.__compressJobs[q.abs] = { ok: false }; }

    });

    window.__compressDone = function (failedN) {

      __compressRunning = false;

      closeXferProgress();

      if (failedN > 0) toast(failedN + " 张照片压缩失败，已保留原图");

      if (__compressQueue.length && __compressPrefs > 0) flushCompress();

    };

  }

  // 原生压缩逐张回调（并发累积 + 进度）

  window.onCompressPhoto = function (absPath, json) {

    var o = null; try { o = JSON.parse(json); } catch (e) {}

    if (!window.__compressJobs || !(absPath in window.__compressJobs)) return;

    window.__compressJobs[absPath] = o || { ok: false };

    var doneN = 0, total = 0, failed = 0;

    Object.keys(window.__compressJobs).forEach(function (k) {

      total++;

      if (window.__compressJobs[k] !== null) { doneN++; if (!window.__compressJobs[k].ok) failed++; }

    });

    updateXferProgress("compress", doneN, total);

    if (window.__compressDone && doneN >= total) window.__compressDone(failed);

  };

  // base64 场景压缩（单张添加 / 巡视 / 浏览器回退 ovkmz）：>1.5M 走 canvas 压缩

  function compressDataUrlIfBig(data, done) {

    var sz = dataUrlSize(data);

    if (sz <= COMPRESS_THRESHOLD || __compressPrefs === 0) { done(data); return; }

    var cb = function (t) {

      if (t > 0) { busy("正在压缩大尺寸照片…"); canvasCompress(data, t, function (d) { idle(); done(d); }); }

      else done(data);

    };

    if (__compressPrefs !== null) cb(__compressPrefs);

    else askCompressTarget(1, fmtMB(sz), Math.max(1, Math.round(sz * 500 / 1048576 / 1024)), cb);

  }

  // 非 WiFi 流量警告：返回 true 表示可继续；非 WiFi 时弹确认

  function ensureWifi(action, cb) {

    var net = (window.Android && typeof window.Android.netType === "function") ? window.Android.netType() : "wifi";

    if (net !== "wifi") {

      ask("非 WiFi 网络", "当前不是 WiFi（" + (net === "cellular" ? "移动网络" : "无网络") + "），" + action + "可能消耗大量流量且耗时较长，是否继续？",

        [{ t: "继续", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel", v: 0 }],

        function (ok) { if (ok) cb(); });

      return;

    }

    cb();

  }

  /* ============ 大文件传输进度浮层 + 回调 ============ */

  function openXferProgress(kind, title) {

    closeXferProgress(true);

    var el = document.createElement("div");

    el.id = "xferOverlay";

    el.style.cssText = "position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:3px solid var(--primary);padding:14px 16px;z-index:3000;box-shadow:0 -2px 10px rgba(0,0,0,.25);font-size:14px;max-height:46vh;overflow:auto";

    el.innerHTML = '<div id="xferTitle" style="font-weight:600;margin-bottom:8px">' + esc(title) + '</div>' +

      '<div style="height:8px;background:var(--soft);border-radius:4px;overflow:hidden"><div id="xferBar" style="height:100%;width:0;background:var(--accent);transition:width .2s"></div></div>' +

      '<div id="xferPct" style="margin-top:6px;color:#555;font-size:12px">准备中…</div>' +

      '<button onclick="closeXferProgress()" style="margin-top:10px;width:100%;padding:8px;background:#eee;border:none;border-radius:8px">关闭（传输在后台继续）</button>';

    document.body.appendChild(el);

  }

  function closeXferProgress(silent) {

    var el = $("xferOverlay"); if (el) el.remove();

  }

  // 暴露到全局：传输进度弹层内的「关闭（传输在后台继续）」按钮使用 inline onclick="closeXferProgress()"

  window.closeXferProgress = closeXferProgress;

  function updateXferProgress(phase, done, total) {

    var bar = $("xferBar"), pct = $("xferPct");

    if (!bar) return;

    var p = total > 0 ? Math.min(100, Math.round(done * 100 / total)) : 0;

    bar.style.width = p + "%";

    var label = { copy: "复制照片", zip: "打包", unzip: "解压", download: "下载",

                  netdisk: "上传网盘", "import": "解压导入", match: "智能匹配", compress: "压缩照片" }[phase] || phase;

    if (pct) pct.textContent = label + "：" + p + "% （" + done + "/" + (total || 0) + "）执行中，请稍后…";

  }

  function setXferTitle(msg) { var t = $("xferTitle"); if (t) t.textContent = msg; }

  window.onXferProgress = function (phase, done, total) { updateXferProgress(phase, done, total); };

  window.onXferError = function (kind, msg) {

    closeXferProgress();

    if (window.idle) window.idle();   // 任何原生失败都要收起「执行中，请稍后」遮罩，避免卡死观感

    toast("传输失败(" + kind + ")：" + msg);

  };

  window.onXferDone = function (kind, path) {

    var name = (path || "").split("/").pop();

    if (kind === "export") {

      // Req 4：若设置了网盘，本地导出完成后自动上传

      if (XFER.source === "baidu" || XFER.source === "quark") {

        var token = XFER.source === "baidu" ? XFER.baiduToken : XFER.quarkToken;

        setXferTitle("正在上传到" + (XFER.source === "baidu" ? "百度网盘" : "夸克网盘") + "…");

        window.Android.netdiskUpload(XFER.source, token, path, name, XFER.resume);

        return;

      }

      closeXferProgress(); toast("已导出：" + name);

    } else if (kind === "exportPhotos") {

      closeXferProgress();

      var tgt = pendingExportTarget || "local"; pendingExportTarget = null;

      if (tgt === "baidu" || tgt === "quark") {

        var token = tgt === "baidu" ? XFER.baiduToken : XFER.quarkToken;

        setXferTitle("正在上传到" + (tgt === "baidu" ? "百度网盘" : "夸克网盘") + "…");

        if (window.Android && typeof window.Android.netdiskUpload === "function") window.Android.netdiskUpload(tgt, token, path, name, XFER.resume);

        else toast("网盘未连接，已导出到本地：" + name);

      } else if (tgt === "wechat" || tgt === "feishu" || tgt === "qq") {

        if (window.Android && typeof window.Android.shareFile === "function") {

          window.Android.shareFile(path, tgt);

          toast("已唤起" + ({ wechat: "微信", feishu: "飞书", qq: "QQ" }[tgt]) + "分享");

        } else { toast("分享需原生支持，已导出到本地：" + name); }

      } else {

        toast("照片已导出：" + name);

      }

    } else if (kind === "download") {

      closeXferProgress(); toast("下载完成：" + name);

    } else if (kind === "netdisk") {

      closeXferProgress(); toast("已上传到" + (XFER.source === "baidu" ? "百度" : "夸克") + "网盘：" + name);

    }

  };



  /* ============ 传输设置（WiFi / 网盘 / 续传 / 内容覆盖）============ */

  function openXferSettings() {

    var src = XFER.source, resume = XFER.resume ? "checked" : "", ov = XFER.overwriteSame;

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">大文件（&gt;3GB）导入导出相关设置。手机互传与网盘上传均支持断点续传。</p>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">' +

      '<div style="font-weight:600;margin-bottom:6px">导出目标</div>' +

      '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:14px"><input type="radio" name="xfSrc" value="local" ' + (src === "local" ? "checked" : "") + '> 本机（Download/水利工程一张图）</label>' +

      '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:14px"><input type="radio" name="xfSrc" value="baidu" ' + (src === "baidu" ? "checked" : "") + '> 百度网盘</label>' +

      '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:14px"><input type="radio" name="xfSrc" value="quark" ' + (src === "quark" ? "checked" : "") + '> 夸克网盘</label>' +

      '</div>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:10px">' +

      '<label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="xfResume" ' + resume + '> 启用断点续传（中断后可继续）</label>' +

      '<div style="margin-top:8px;font-size:13px;color:#555">内容相同（按 SHA-256，非文件名）时：</div>' +

      '<select id="xfOver" style="width:100%;margin-top:4px;padding:6px;border-radius:6px;border:1px solid var(--border)">' +

      '<option value="ask" ' + (ov === "ask" ? "selected" : "") + '>询问是否覆盖</option>' +

      '<option value="always" ' + (ov === "always" ? "selected" : "") + '>总是覆盖</option>' +

      '<option value="skip" ' + (ov === "skip" ? "selected" : "") + '>跳过</option></select>' +

      '</div>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:10px">' +

      '<div style="font-size:13px;color:#555;margin-bottom:4px">百度网盘 Token（开放平台 OAuth 获取）</div>' +

      '<input id="xfBaidu" value="' + esc(XFER.baiduToken) + '" placeholder="粘贴 Baidu token" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--border)">' +

      '<div style="font-size:13px;color:#555;margin:8px 0 4px">夸克网盘 Token（开放平台 OAuth 获取）</div>' +

      '<input id="xfQuark" value="' + esc(XFER.quarkToken) + '" placeholder="粘贴 Quark token" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--border)">' +

      '</div>' +

      '<div class="form-actions"><button class="btn-save" onclick="saveXferSettings()">保存设置</button></div>' +

      '<div id="xfMsg" style="margin-top:8px;font-size:12px;color:#2b8a5d"></div>';

    $("genTitle").textContent = "传输设置";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  window.saveXferSettings = function () {

    var src = document.querySelector('input[name="xfSrc"]:checked');

    XFER.source = src ? src.value : "local";

    XFER.resume = $("xfResume") ? $("xfResume").checked : true;

    XFER.overwriteSame = $("xfOver") ? $("xfOver").value : "ask";

    XFER.baiduToken = $("xfBaidu") ? $("xfBaidu").value.trim() : "";

    XFER.quarkToken = $("xfQuark") ? $("xfQuark").value.trim() : "";

    saveXfer();

    $("xfMsg").textContent = "已保存。当前导出目标：" + (XFER.source === "local" ? "本机" : (XFER.source === "baidu" ? "百度网盘" : "夸克网盘"));

    toast("传输设置已保存");

  };



  /* ============ v3.45：修改/添加天地图密钥（防过期 / 被风控后用户自换）============

   v3.46：当前密钥默认隐藏（type=password），点击 👁 切换显示；复制按钮 ask 输入密码 3305 验证后复制（防他人窃取密钥）。 */

  var TDT_PASSWORD = "3305";  // 复制/查看密钥的二次验证密码（4 位数字口令）

  function openTdtKeySettings() {

    var cur = loadToken();

    var isDefault = (cur === TOKEN_BROWSER_DEFAULT);

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">天地图（<code>tianditu.gov.cn</code>）瓦片密钥用于加载矢量/影像底图。密钥可能被服务器风控或到期失效，自换后下次打开底图即可生效。</p>' +

      '<label class="f" style="font-size:13px;color:#555">当前密钥（隐藏显示，复制需输密码）</label>' +

      '<div style="display:flex;gap:6px;align-items:center">' +

        '<input class="f" id="tdtCurVal" type="password" readonly value="' + esc(cur) + '" style="flex:1;font-family:monospace;font-size:12px">' +

        '<button class="tbtn" id="tdtToggleEye" onclick="tdtToggleVisible()" title="显示/隐藏当前密钥">👁</button>' +

        '<button class="tbtn" onclick="tdtPasteCur()" title="复制（需输密码 3305）">📋 复制</button>' +

      '</div>' +

      '<div style="font-size:12px;color:#888;margin:6px 0">' + (isDefault ? "⚠️ 当前为内置默认密钥" : "✅ 当前为用户自配密钥") + '</div>' +

      '<label class="f" style="font-size:13px;color:#555">新密钥（32 位十六进制，留空则恢复内置默认）</label>' +

      '<input class="f" id="tdtNewVal" placeholder="32位十六进制密钥（如 a1b2c3…，留空则恢复内置默认）" style="font-family:monospace;font-size:13px">' +

      '<div style="font-size:12px;color:#888;margin:6px 0">获取密钥：天地图开发者 → <a href="https://console.tianditu.gov.cn/api/key" target="_blank" style="color:#2e7d32">console.tianditu.gov.cn/api/key</a> → 「创建应用」→ 选择「浏览器端」</div>' +

      '<div class="form-actions">' +

      '<button class="btn-cancel" onclick="openTdtKeyReset()">恢复内置默认</button>' +

      '<button class="btn-save" onclick="openTdtKeySave()">保存并立即应用</button>' +

      '</div>';

    $("genTitle").textContent = "修改/添加天地图密钥";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  // 切换当前密钥明文/隐藏

  window.tdtToggleVisible = function () {

    var inp = $("tdtCurVal"); var btn = $("tdtToggleEye"); if (!inp) return;

    if (inp.type === "password") {

      // 显示前 ask 输密码 3305

      ask("👁 显示密钥", "为防他人窥屏，显示当前密钥需输入密码：", [{ t: "确定", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }], function (ok) {

        if (!ok) return;

        askPwd("请输入 4 位密码", function (pw) {

          if (pw === TDT_PASSWORD) { inp.type = "text"; btn.textContent = "🙈"; toast("已显示（30 秒后自动隐藏）"); setTimeout(function () { if (inp && inp.type === "text") { inp.type = "password"; btn.textContent = "👁"; toast("已自动隐藏"); } }, 30000); }

          else { toast("密码错误"); }

        });

      });

    } else {

      inp.type = "password";

      btn.textContent = "👁";

      toast("已隐藏");

    }

  };

  // askPwd：弹一个密码输入框（input type=password），确认后回调函数

  function askPwd(title, cb) {

    var box = $("askBox"); if (!box) { cb(""); return; }

    box.querySelector(".ask-title").textContent = title || "请输入密码";

    box.querySelector(".ask-msg").innerHTML = '<input id="askPwdInp" type="password" maxlength="20" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:16px;letter-spacing:4px;text-align:center" autofocus>';

    var btns = box.querySelector(".ask-btns"); btns.innerHTML = "";

    var ok = document.createElement("button"); ok.textContent = "确定"; ok.className = "btn-confirm2";

    ok.onclick = function () { var v = ($("askPwdInp") || {}).value || ""; closeAsk(); cb(v); };

    var cancel = document.createElement("button"); cancel.textContent = "取消"; cancel.className = "btn-cancel2";

    cancel.onclick = function () { closeAsk(); cb(""); };

    btns.appendChild(ok); btns.appendChild(cancel);

    box.classList.add("show");

    setTimeout(function () { var i = $("askPwdInp"); if (i) i.focus(); }, 100);

  }

  // 复制当前密钥到剪贴板（需输密码 3305）

  window.tdtPasteCur = function () {

    var inp = $("tdtCurVal"); if (!inp) return;

    var v = inp.value;

    askPwd("📋 复制需输密码（防窃取）", function (pw) {

      if (pw !== TDT_PASSWORD) { toast("密码错误"); return; }

      try {

        if (navigator.clipboard && navigator.clipboard.writeText) {

          navigator.clipboard.writeText(v).then(function () { toast("已复制（30 秒后密钥值会再次隐藏）"); }, function () { toast("剪贴板不可用，请手动选择"); });

        } else { toast("当前环境不支持剪贴板 API"); }

      } catch (e) { toast("复制失败：" + e.message); }

    });

  };

  // 保存新密钥并刷新当前会话 TOKEN

  window.openTdtKeySave = function () {

    var raw = ($("tdtNewVal").value || "").trim();

    if (!raw) { ask("未填写新密钥", "确定保存空值吗？这将恢复为内置默认密钥。", [{ t: "确定恢复", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }], function (ok) { if (ok) { TOKEN = TOKEN_BROWSER_DEFAULT; saveToken(""); toast("已恢复内置默认密钥"); openTdtKeySettings(); } }); return; }

    // 32 位十六进制校验（防止误粘了整段 URL）

    if (!/^[a-fA-F0-9]{32}$/.test(raw)) {

      ask("密钥格式校验", "天地图浏览器端密钥为 32 位十六进制字符。当前长度为 " + raw.length + "。\n是否仍要保存？\n\n如确认无误可直接保存；如粘贴了整段 URL，请只保留 tk= 后面的部分。",

        [{ t: "仍要保存", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }],

        function (ok) { if (ok) { saveToken(raw); TOKEN = raw; refreshTdtTileLayer(); toast("已保存新密钥，正在切换图层"); openTdtKeySettings(); } });

      return;

    }

    saveToken(raw); TOKEN = raw; refreshTdtTileLayer(); toast("已保存新密钥，正在切换图层"); openTdtKeySettings();

  };

  // 恢复内置默认

  window.openTdtKeyReset = function () {

    clearToken(); TOKEN = TOKEN_BROWSER_DEFAULT; refreshTdtTileLayer(); toast("已恢复内置默认密钥"); openTdtKeySettings();

  };

  // 重建图层使用新 TOKEN（不重启 App）

  function refreshTdtTileLayer() {

    try {

      var sub = "01234567";

      if (baseVec) map.removeLayer(baseVec);

      if (labelVec) map.removeLayer(labelVec);

      if (baseImg) map.removeLayer(baseImg);

      if (labelImg) map.removeLayer(labelImg);

      baseVec = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=" + TOKEN, { subdomains: sub, maxZoom: 18, attribution: "天地图" });

      labelVec = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=" + TOKEN, { subdomains: sub, maxZoom: 18, pane: "shadowPane" });

      baseImg = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=" + TOKEN, { subdomains: sub, maxZoom: 18, attribution: "天地图影像" });

      labelImg = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=cia_w&x={x}&y={y}&l={z}&tk=" + TOKEN, { subdomains: sub, maxZoom: 18, pane: "shadowPane" });

      baseVec.addTo(map); labelVec.addTo(map);

      if (currentBase === "img") { baseImg.addTo(map); labelImg.addTo(map); }

    } catch (e) { console.warn("refresh tdt layers failed:", e); }

  }



  /* ============ 手机互传（服务端 / 客户端）============ */

  function openPeer() {

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">两台安装本 APP 的手机接入同一 WiFi，一台开<b>服务端</b>、一台开<b>客户端</b>，客户端可从服务端下载 kmz / 照片（支持断点续传）。</p>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px">' +

      '<div style="font-weight:600;margin-bottom:6px">服务端</div>' +

      '<div id="peerSrvState" style="font-size:12px;color:#888;margin-bottom:6px">未启动</div>' +

      '<button class="tbtn" style="width:100%" onclick="peerStartServer()">▶ 启动服务端</button>' +

      '<button class="tbtn" style="width:100%;margin-top:6px" onclick="peerStopServer()">■ 停止服务端</button>' +

      '</div>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">' +

      '<div style="font-weight:600;margin-bottom:6px">客户端</div>' +

      '<input id="peerUrl" placeholder="服务端地址，如 http://192.168.1.20:8765" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--border)">' +

      '<div style="font-size:12px;color:#888;margin:6px 0">留空则列出服务端文件，输入「地址/文件名」直接下载。</div>' +

      '<button class="tbtn" style="width:100%" onclick="peerList()">📂 列出服务端文件</button>' +

      '<button class="tbtn" style="width:100%;margin-top:6px" onclick="peerDownload()">⬇ 下载</button>' +

      '<div id="peerList" style="margin-top:8px;font-size:12px;color:#555"></div>' +

      '</div>';

    $("genTitle").textContent = "手机互传";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  window.peerStartServer = function () {

    var url = ""; try { url = window.Android.peerStart(8765); } catch (e) {}

    if (!url || url.indexOf("error") === 0) { $("peerSrvState").textContent = "启动失败：" + (url || ""); return; }

    $("peerSrvState").innerHTML = '服务端已启动，地址：<b style="word-break:break-all">' + esc(url) + '</b><br>把该地址填到客户端。';

    toast("服务端已启动");

  };

  window.peerStopServer = function () { try { window.Android.peerStop(); } catch (e) {} $("peerSrvState").textContent = "已停止"; toast("服务端已停止"); };

  window.peerList = function () {

    var base = $("peerUrl").value.trim().replace(/\/$/, "");

    if (!base) { toast("请先填写服务端地址"); return; }

    fetch(base + "/list").then(function (r) { return r.json(); }).then(function (arr) {

      if (!arr.length) { $("peerList").textContent = "服务端没有可下载文件"; return; }

      $("peerList").innerHTML = arr.map(function (f) {

        return '<div style="padding:3px 0;border-bottom:1px solid #eee"><a style="color:#16324f" onclick="document.getElementById(\'peerUrl\').value=\'' + esc(base) + '/' + esc(f.name) + '\'">' + esc(f.name) + '</a> <span style="color:#999">(' + (f.size / 1048576).toFixed(1) + ' MB)</span></div>';

      }).join("");

    }).catch(function () { $("peerList").textContent = "获取列表失败（请确认服务端已启动且同一 WiFi）"; });

  };

  window.peerDownload = function () {

    var url = $("peerUrl").value.trim();

    if (!url) { toast("请填写要下载的文件地址"); return; }

    var name = url.split("/").pop();

    var outPath = window.Android.exportPath(name);

    ensureWifi("从服务端下载（可能超过 3GB）", function () {

      openXferProgress("download", "正在从服务端下载 " + name + " …");

      window.Android.download(url, outPath, XFER.resume);

    });

  };



  function colorForType(t) {

    var h = 0;

    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;

    return "hsl(" + h + ",62%,46%)";

  }

  // v3.25：形状维度——与颜色配合区分建筑物类型；取与颜色同源的哈希，保证类型→(色,形)映射稳定

  var SHAPE_GLYPHS = ["●", "■", "▲", "◆", "★", "⬢", "✚", "✖"];

  function shapeForType(t) {

    var h = 0;

    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % SHAPE_GLYPHS.length;

    return SHAPE_GLYPHS[h];

  }

  // v3.24：规范建筑物类型清单。主界面图例、筛选类型、编辑表单类型下拉统一以此为准，

  // 不再从数据动态拼出乱字段（移除被误当类型的 西田各庄段引渠 / 技术指标 / 挖填方统计表 /

  // 进水闸 部分缺少经纬度 等），并新增 泵站、溢洪道。

  // 已有建筑物仍保留在地图与列表中（不删数据），只是不再出现在类型列表/图例里。

  var CANONICAL_TYPES = [

    "进水闸", "节制闸", "分水闸", "泄洪闸", "扬水闸", "补水闸", "泵站", "溢洪道",

    "倒虹吸", "跌水", "过渠涵洞", "穿渠项目", "交通桥", "山洪桥", "工作桥", "清污机",

    "雨水口", "道路", "变压器"

  ];

  // 即使当前数据尚未有该类建筑，也始终在图例/筛选中展示（用户明确要求新增的字段）

  var ALWAYS_TYPES = { "泵站": true, "溢洪道": true };

  function canonicalTypes() {

    var present = new Set();

    BUILDINGS.forEach(function (b) { if (b.btype) present.add(b.btype); });

    // v3.42：自定义类型（设置→组织与类型管理）与权威清单同权——即使数据暂未出现也展示

    var base = uniq(CANONICAL_TYPES.concat(getCustomTypes()));

    var out = base.filter(function (t) { return present.has(t) || ALWAYS_TYPES[t] || getCustomTypes().indexOf(t) >= 0; });

    if (BUILDINGS.some(function (b) { return !b.btype; })) out.push("其他");

    return out;

  }

  function uniq(arr) { return Array.from(new Set(arr)).filter(Boolean); }

  function getTodayStr() {

    var d = new Date();

    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  }

  // 照片名规范化：去掉扩展名，并忽略末尾的数字（含括号），用于建筑物匹配

  // 例：“峰山口1.jpg”→“峰山口”；“峰山口(2).jpg”→“峰山口”

  function normalizePhotoName(s) {

    s = String(s == null ? "" : s).replace(/\.[^.]+$/, "").trim();

    s = s.replace(/[\s_]*[（(]?\d+[)）]?$/, "");

    return s.trim();

  }

  function addPhotoToBuilding(b, data, caption) {

    b.photos = b.photos || [];

    b.photos.push({ data: data, caption: caption || "" });

  }



  /* ---------- 存储 ---------- */

  function load() {

    var embedded = window.SHUILI_DATA || [];

    try {

      var s = localStorage.getItem(LS_KEY);

      if (s) { BUILDINGS = JSON.parse(s); return; }

    } catch (e) {}

    BUILDINGS = JSON.parse(JSON.stringify(embedded));

  }

  function save() {

    try { localStorage.setItem(LS_KEY, JSON.stringify(BUILDINGS)); } catch (e) { toast("本地存储失败（可能已满）"); }

  }

  function resetData() {

    ask("恢复初始数据", "确定恢复为初始数据？<b>所有新增/修改/删除将被清空</b>，且不可撤销。",

      [{ t: "恢复", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel", v: 0 }],

      function (ok) {

        if (!ok) return;

        BUILDINGS = JSON.parse(JSON.stringify(window.SHUILI_DATA || []));

        save(); render(); toast("已恢复初始数据");

      });

  }



  /* ---------- 地图 ---------- */

  function initMap() {

    // v3.19：关闭默认版权控件（默认前缀含可点击的 “Leaflet” 外链 → leafletjs.com，

    // 离线时误触会让整个 WebView 跳走并停在“网页无法打开”错误页）。改用无前缀的版权控件，

    // 仅保留“天地图/天地图影像”文字，离线不会触发任何外部跳转。

    map = L.map("map", { zoomControl: true, attributionControl: false }).setView([40.30, 116.70], 10);

    filterLayer = L.layerGroup().addTo(map);

    // 缩放控件移到右下，避免与顶栏/底图切换器重叠

    map.zoomControl.setPosition("bottomright");

    map.attributionControl = L.control.attribution({ prefix: false }).addTo(map);

    map.attributionControl.setPosition("bottomleft");

    var sub = "01234567";

    baseVec = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=" + TOKEN,

      { subdomains: sub, maxZoom: 18, attribution: "天地图" });

    labelVec = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=" + TOKEN,

      { subdomains: sub, maxZoom: 18, pane: "shadowPane" });

    baseImg = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=" + TOKEN,

      { subdomains: sub, maxZoom: 18, attribution: "天地图影像" });

    labelImg = L.tileLayer("https://t{s}.tianditu.gov.cn/DataServer?T=cia_w&x={x}&y={y}&l={z}&tk=" + TOKEN,

      { subdomains: sub, maxZoom: 18, pane: "shadowPane" });

    baseVec.addTo(map);

    labelVec.addTo(map);

    // 不使用 Leaflet 内置 layers control（在 WebView 中 checkbox 状态不同步）

    // 改用自定义底图切换器（见 buildBaseSwitcher）

    map.on("click", function (e) {

      if (nearbyPickMode) {

        nearbyPicked = { lat: e.latlng.lat, lon: e.latlng.lng, label: "地图选点" };

        nearbyPickMode = false;

        map._container.style.cursor = "";

        $("btnMenu").textContent = "☰ 菜单";

        toast("已选中心，请点击搜索");

        nearbySearch(true); // 重开面板并停留在「地图选点」模式

        return;

      }

      if (coordPickMode) {

        var lat = e.latlng.lat, lon = e.latlng.lng;

        L.popup({ closeButton: true })

          .setLatLng(e.latlng)

          .setContent('<div style="font-size:14px"><b>坐标信息</b><br>纬度：' + lat.toFixed(6) + '<br>经度：' + lon.toFixed(6) + '<br><button class="tbtn" style="margin-top:6px" onclick="copyCoord(' + lat + ',' + lon + ')">复制坐标</button></div>')

          .addTo(map);

        coordPickMode = false;

        map._container.style.cursor = "";

        $("btnMenu").textContent = "☰ 菜单";

        toast("坐标已获取");

        return;

      }

      if (measureMode) { onMeasureClick(e); return; }

      if (!addMode) return;

      openEdit({

        id: "b" + Date.now(),

        name: "新建筑物", office: "", station: "", chan: "", btype: "",

        path: "", attrs: [], photos: [], geom: "Point",

        lon: e.latlng.lng, lat: e.latlng.lat, _new: true

      });

    });

    map.on("dblclick", function () { if (measureMode) toggleMeasure(); });

    // v3.28 性能：平移/缩放后增量重渲染视窗内建筑（render 内部仅建视窗内 marker）

    var _mvTimer = null;

    function onViewChange() {

      clearTimeout(_mvTimer);

      _mvTimer = setTimeout(render, 120); // 平移结束后再渲染，避免拖动中频繁重建

    }

    map.on("moveend", onViewChange);

    map.on("zoomend", onViewChange);

    buildLegend();

    buildBaseSwitcher();

  }



  /* ---------- 自定义底图切换器 ---------- */

  function buildBaseSwitcher() {

    var el = document.getElementById("baseSwitcher");

    if (!el) {

      el = document.createElement("div");

      el.id = "baseSwitcher";

      el.className = "base-switcher";

      $("app").appendChild(el);

    }

    el.innerHTML =

      '<div class="bs-title">底图</div>' +

      '<label class="bs-opt"><input type="radio" name="baseOpt" value="vec" checked><span>矢量地图</span></label>' +

      '<label class="bs-opt"><input type="radio" name="baseOpt" value="img"><span>影像地图</span></label>';

    el.querySelectorAll('input[name="baseOpt"]').forEach(function (radio) {

      radio.onchange = function () { setBase(this.value); };

    });

  }

  function setBase(mode) {

    currentBase = mode;

    if (mode === "vec") {

      map.removeLayer(baseImg); map.removeLayer(labelImg);

      map.addLayer(baseVec); map.addLayer(labelVec);

    } else {

      map.removeLayer(baseVec); map.removeLayer(labelVec);

      map.addLayer(baseImg); map.addLayer(labelImg);

    }

    // 与悬浮面板单选框状态保持同步

    var r = document.querySelector('#baseSwitcher input[value="' + mode + '"]');

    if (r) r.checked = true;

  }

  function switchBaseMap() {

    setBase(currentBase === "vec" ? "img" : "vec");

    toast("底图已切换为：" + (currentBase === "vec" ? "矢量地图" : "影像地图"));

  }



  function makeIcon(color, glyph) {

    // 倒立水滴标记：填充色 = 建筑物类型颜色（colorForType）；中心白点内嵌该类型专属形状符号（shapeForType）

    var svg = '<svg width="32" height="44" viewBox="0 0 32 44">' +

      '<path d="M16 2 C8 2 2 8 2 16 C2 26 16 42 16 42 C16 42 30 26 30 16 C30 8 24 2 16 2 Z" fill="' + (color || "#1e6fbf") + '" stroke="#fff" stroke-width="2.5"/>' +

      '<circle cx="16" cy="16" r="8" fill="#fff"/>' +

      '<text x="16" y="20" text-anchor="middle" font-size="11" font-family="sans-serif" fill="' + (color || "#1e6fbf") + '">' + (glyph || "●") + '</text></svg>';

    return L.divIcon({ className: "drop-pin", html: svg, iconSize: [32, 44], iconAnchor: [16, 42], popupAnchor: [0, -38] });

  }

  // 筛选命中高亮标记：倒水滴（尖端朝上）+ 琥珀色，区别于默认蓝色水滴，便于一眼识别“选到的建筑”

  function makeFilterIcon() {

    var amber = "#e6922e";

    var svg = '<svg width="34" height="46" viewBox="0 0 34 46">' +

      '<path d="M17 44 C9 44 3 36 3 27 C3 15 17 2 17 2 C17 2 31 15 31 27 C31 36 25 44 17 44 Z" fill="' + amber + '" stroke="#fff" stroke-width="2.5"/>' +

      '<circle cx="17" cy="27" r="6.5" fill="#fff"/></svg>';

    // filter-anim / fd-anim：倒水滴标记淡入+缩放动画（错峰由调用处设置 animation-delay）；

    // 动画只作用在内层 .fd-anim，避免覆盖 Leaflet 对标记根元素的定位 transform

    return L.divIcon({ className: "drop-pin filter-anim", html: '<span class="fd-anim">' + svg + '</span>', iconSize: [34, 46], iconAnchor: [17, 23], popupAnchor: [0, -30] });

  }



  function passFilter(b) {

    // v3.45：管理处筛选（按局→管理处→所层次，前级筛选只在前级生效时按建筑物层级保留）

    if (filters.guanchu.size) {

      var bG = b.guanchu || getOrgDefaults().guanchu;

      if (!filters.guanchu.has(bG)) return false;

    }

    // v3.26：管理所筛选忽略"管理"二字（史山所 与 史山管理所 视为同一）

    if (filters.offices.size && !filters.offices.has(normOffice(b.office))) return false;

    if (filters.stations.size && !filters.stations.has(b.station || "")) return false;

    if (filters.types.size && !filters.types.has(b.btype)) return false;

    // Req 1：照片状态筛选：有照片 / 多张照片 / 无照片

    var np = (b.photos || []).length;

    if (filters.photoStatus === "has" && np <= 0) return false;

    if (filters.photoStatus === "many" && np < filters.photoMin) return false;

    if (filters.photoStatus === "none" && np > 0) return false;

    if (filters.text) {

      var t = filters.text.toLowerCase();

      // 查询时“管理”二字可忽略：史山所 与 史山管理所 均匹配

      // （hay 同时含原始名与统一名，输入“温泉管理所”或“温泉所”都能命中）

      var hay = (b.name + " " + b.btype + " " + b.office + " " + normOffice(b.office) + " " + (b.station || "") + " " +

        (b.attrs || []).map(function (a) { return a[0] + a[1]; }).join(" ")).toLowerCase();

      if (hay.indexOf(t) < 0 && hay.indexOf(t.replace(/管理所/g, "所")) < 0) return false;

    }

    return true;

  }



  /* ---------- 筛选作用域（Req 3：筛选完成后，导出默认导出筛选结果）---------- */

  // 是否处于"已筛选"状态（任一条件生效）

  function filterActive() {

    return !!(filters.guanchu.size || filters.offices.size || filters.stations.size || filters.types.size ||

      (filters.photoStatus && filters.photoStatus !== "all") || filters.text);

  }

  // 当前筛选命中的建筑列表

  function filteredList() {

    return BUILDINGS.filter(passFilter);

  }

  // 人类可读的当前筛选条件描述（供导出确认、筛选提示区、导出文件名等复用）

  function filterDesc() {

    var parts = [];

    if (filters.text) parts.push('关键词"' + filters.text + '"');

    if (filters.guanchu.size) parts.push("管理处：" + Array.from(filters.guanchu).join("、"));

    if (filters.offices.size) parts.push("管理单位：" + Array.from(filters.offices).join("、"));

    if (filters.stations.size) parts.push("管理站：" + Array.from(filters.stations).map(function (s) { return s || "(未设置)"; }).join("、"));

    if (filters.types.size) parts.push("类型：" + Array.from(filters.types).join("、"));

    if (filters.photoStatus === "has") parts.push("有照片");

    else if (filters.photoStatus === "many") parts.push("照片≥" + filters.photoMin + "张");

    else if (filters.photoStatus === "none") parts.push("无照片");

    return parts.join("；");

  }

  /* 统一的导出作用域选择：已筛选则默认导出筛选结果，并允许改为全部。

     cb(list, scopeLabel) */

  function pickExportScope(what, cb) {

    if (!filterActive()) { cb(BUILDINGS.slice(), "全部"); return; }

    var fl = filteredList();

    if (!fl.length) {

      toast("当前筛选结果为 0 个建筑，已改为导出全部");

      cb(BUILDINGS.slice(), "全部");

      return;

    }

    var msg = "检测到当前处于筛选状态：\n" + (filterDesc() || "(条件)") +

      "\n\n筛选结果：" + fl.length + " 个建筑（共 " + BUILDINGS.length + " 个）\n\n" +

      "确定 = 只导出筛选结果（" + fl.length + " 个，推荐）<br>取消 = 导出全部（" + BUILDINGS.length + " 个）";

    ask("导出范围", msg,

      [{ t: "只导出筛选结果", cls: "btn-confirm2", v: 1 }, { t: "导出全部", cls: "btn-cancel", v: 0 }],

      function (ok) { if (ok) cb(fl, "筛选结果"); else cb(BUILDINGS.slice(), "全部"); });

  }



  function popupHtml(b) {

    var html = '<div class="popup-title">' + esc(b.name) + "</div>";

    if (b.office) html += '<span class="badge">' + esc(b.office) + "</span>";

    if (b.btype) html += '<span class="badge">' + esc(b.btype) + "</span>";

    if (b.station) html += '<span class="badge">' + esc(b.station) + "</span>";

    if (b.attrs && b.attrs.length) {

      html += '<table class="param-table">';

      b.attrs.forEach(function (a) {

        if (a[0]) html += "<tr><td class=\"k\">" + esc(a[0]) + "</td><td>" + esc(a[1]) + "</td></tr>";

      });

      html += "</table>";

    }

    if (b.photos && b.photos.length) {

      html += '<div class="photos">';

      var maxShow = 18;

      var shown = Math.min(b.photos.length, maxShow);

      for (var pi = 0; pi < shown; pi++) {

        var p = b.photos[pi];

        var src = photoSrc(p);

        html += '<img src="' + esc(src) + '" loading="lazy" onclick="appLightbox(\'' + esc(b.id) + "'," + pi + ')" oncontextmenu="appPhotoAct(\'' + esc(b.id) + "'," + pi + ');return false;">';

      }

      html += "</div>";

      if (b.photos.length > maxShow) {

        html += '<div style="text-align:center;margin-top:6px"><button class="pop-close" onclick="appLightbox(\'' + esc(b.id) + "'," + maxShow + ')">查看全部 ' + b.photos.length + ' 张照片 ›</button></div>';

      }

    }

    if ((b.inspections || []).length) html += '<div style="font-size:12px;margin-top:4px;color:#b8862f">已巡视 ' + b.inspections.length + " 次</div>";

    html += '<div class="pop-actions"><button class="pop-detail" onclick="appDetail(\'' + esc(b.id) + '\')">详细</button>' +

      '<button class="pop-edit" onclick="appEdit(\'' + esc(b.id) + '\')">修改</button>' +

      '<button class="pop-nav" onclick="appNav(\'' + esc(b.id) + '\')">导航</button>' +

      // Req 1：把该建筑的信息（含照片）分享到微信 / QQ / 飞书

      '<button class="pop-share" onclick="appShareBuilding(\'' + esc(b.id) + '\')">分享</button>' +

      '<button class="pop-inspect" onclick="appInspect(\'' + esc(b.id) + '\')">巡视</button>' +

      '<button class="pop-del" onclick="appDel(\'' + esc(b.id) + '\')">删除</button></div>' +

      '<div style="text-align:center;margin-top:6px"><button class="pop-close" onclick="appClosePopup()">✕ 关闭</button></div>';

    return html;

  }



  // v3.47：建筑「详细」——完整参数（含未填写）可滚动抽屉，避免弹窗参数不全

  window.appDetail = function (id) {

    var b = BUILDINGS.filter(function (x) { return x.id === id; })[0];

    if (!b) { toast("未找到该建筑"); return; }

    function row(k, v) {

      var s = (v == null || v === "") ? "（未填写）" : (typeof v === "object" ? JSON.stringify(v) : String(v));

      if (s.length > 400) s = s.slice(0, 400) + " …";

      return "<tr><td class=\"k\">" + esc(k) + "</td><td>" + esc(s) + "</td></tr>";

    }

    var rows = [];

    ["id", "name", "office", "station", "chan", "btype", "geom", "code", "addr", "note"].forEach(function (k) {

      if (k in b) rows.push(row(k, b[k]));

    });

    if (b.geom === "Point") { rows.push(row("坐标(纬度,经度)", (b.lat != null ? (b.lat + ", " + b.lon) : ""))); }

    else if (b.geom === "Line" && b.line) {

      rows.push(row("起点(纬度,经度)", b.line[0] ? (b.line[0][1] + ", " + b.line[0][0]) : ""));

      rows.push(row("终点(纬度,经度)", b.line[1] ? (b.line[1][1] + ", " + b.line[1][0]) : ""));

    }

    if (b.attrs && b.attrs.length) b.attrs.forEach(function (a) { rows.push(row(a[0] || "（无标题）", a[1])); });

    if ((b.photos || []).length) rows.push(row("照片数", b.photos.length));

    if ((b.inspections || []).length) rows.push(row("巡视次数", b.inspections.length));

    var html = '<div style="max-height:74vh;overflow:auto;padding:2px 1px">'

      + '<table class="param-table" style="width:100%">' + rows.join("") + "</table>";

    if (b.photos && b.photos.length) {

      html += '<div class="photos">';

      b.photos.forEach(function (p, i) { html += '<img src="' + esc(photoSrc(p)) + '" loading="lazy" onclick="appLightbox(\'' + esc(b.id) + "'," + i + ')">'; });

      html += "</div>";

    }

    html += '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>'

      + '<button class="btn-save" onclick="appEdit(\'' + esc(b.id) + '\')">编辑</button></div></div>';

    if (window.openGen) window.openGen("建筑详情 · " + b.name, html);

    else toast("知识库模块未加载，无法打开详情");

  };



  function render() {

    if (filterLayer) filterLayer.clearLayers();

    // v3.30 性能：差量更新——只移除视窗外/不满足筛选的，只添加新进视窗的，

    // 避免每次 moveend/zoomend 全量销毁重建所有 marker（原 line 637-638 全删重建是卡顿主因）。

    // v3.30：筛选激活时关闭视窗裁剪（bnds 扩至全球），保证命中 marker 全建，蓝圈完整罩住；

    //        非筛选态仍走视窗裁剪，保持拖动流畅。

    var bnds = filterActive() ? L.latLngBounds([[-90, -180], [90, 180]]) : map.getBounds().pad(0.15);

    var keepIds = {};

    BUILDINGS.forEach(function (b) {

      if (!passFilter(b)) return;

      if (b.geom === "Point" && b.lat != null) {

        if (bnds.contains([b.lat, b.lon])) keepIds[b.id] = 1;

      } else if (b.geom === "Line" && b.line && b.line.length) {

        if (b.line.some(function (c) { return bnds.contains([c[1], c[0]]); })) keepIds[b.id] = 1;

      }

    });

    // 移除不再需要显示的

    Object.keys(MARKERS).forEach(function (k) {

      if (!keepIds[k]) { map.removeLayer(MARKERS[k]); delete MARKERS[k]; }

    });

    Object.keys(LINES).forEach(function (k) {

      if (!keepIds[k]) { map.removeLayer(LINES[k]); delete LINES[k]; }

    });

    // v3.28 性能：只对落在当前视窗（含 15% 缓冲）内的建筑建 marker

    var shown = 0, total = 0;

    BUILDINGS.forEach(function (b) {

      if (!passFilter(b)) return;

      total++;

      if (b.geom === "Point" && b.lat != null) {

        if (!bnds.contains([b.lat, b.lon])) return; // 视窗外跳过，不建图层

        if (MARKERS[b.id]) { shown++; return; } // 已存在，复用

        // 性能：popup 懒构造（点击时才生成 DOM，避免 557 个 marker 全量预构造）

        var m = L.marker([b.lat, b.lon], { icon: makeIcon(colorForType(b.btype || "其他"), shapeForType(b.btype || "其他")) })

          .bindPopup(function () { return popupHtml(b); });

        m.addTo(map); MARKERS[b.id] = m;

    if (window.CtxMenu) window.CtxMenu.onMarker(m, b); shown++;

      } else if (b.geom === "Line" && b.line && b.line.length) {

        var inside = b.line.some(function (c) { return bnds.contains([c[1], c[0]]); });

        if (!inside) return;

        if (LINES[b.id]) { shown++; return; } // 已存在，复用

        var ll = b.line.map(function (c) { return [c[1], c[0]]; });

        var pl = L.polyline(ll, { color: "#16324f", weight: 3, opacity: 0.85 })

          .bindPopup(function () { return popupHtml(b); });

        pl.addTo(map); LINES[b.id] = pl; shown++;

      }

    });

    $("count").textContent = "显示 " + shown + " / " + total + "（筛选）共 " + BUILDINGS.length;

    if (listMode) renderList();

  }



  /* ---------- 运行维护：默认出发位置（F2）---------- */

  window.openStartPosSheet = function () {

    var sp = SETTINGS.startPos;

    var cur = sp ? ("当前：" + (sp.name || "") + " (" + sp.lat.toFixed(5) + ", " + sp.lng.toFixed(5) + ")") : "尚未设置";

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:10px">' + esc(cur) + "</p>" +

      '<button class="btn-save" style="width:100%;margin-bottom:8px" onclick="startPosPickMap()">🗺️ 在地图上选点</button>' +

      '<button class="btn-cancel" style="width:100%;margin-bottom:8px" onclick="startPosFromBuilding()">🏢 从已有建筑物选</button>' +

      '<div style="display:flex;gap:6px;margin-bottom:8px"><input class="f" id="spLat" placeholder="纬度" value="' + (sp ? sp.lat : "") + '" style="flex:1"><input class="f" id="spLng" placeholder="经度" value="' + (sp ? sp.lng : "") + '" style="flex:1"></div>' +

      '<input class="f" id="spName" placeholder="位置名称（如：管理所）" value="' + (sp ? (sp.name || "") : "") + '" style="margin-bottom:8px">' +

      '<label class="f">默认出发时间（HH:MM）</label><input class="f" id="spLeave" type="time" value="' + (sp && sp.leaveAt ? sp.leaveAt : "07:30") + '">' +

      '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">取消</button>' +

      '<button class="btn-save" onclick="startPosSave()">保存出发位置</button></div>';

    $("genTitle").textContent = "默认出发位置";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  };

  window.startPosPickMap = function () {

    closeSheet("sheetGen");

    toast("点击地图选择出发位置");

    map.once("click", function (e) {

      SETTINGS.startPos = SETTINGS.startPos || {};

      SETTINGS.startPos.lat = e.latlng.lat; SETTINGS.startPos.lng = e.latlng.lng;

      SETTINGS.startPos.name = SETTINGS.startPos.name || "自定义点";

      saveSettings();

      openStartPosSheet();

      toast("已记录坐标，请填写名称后保存");

    });

  };

  window.startPosFromBuilding = function () {

    var opts = BUILDINGS.filter(function (x) { return x.lat != null; }).map(function (x) {

      return '<option value="' + esc(x.id) + '">' + esc(x.name) + "（" + esc(x.office || x.station || "") + "）</option>";

    }).join("");

    $("genBody").innerHTML = '<label class="f">选择建筑物</label><select class="f" id="spBld">' + opts + "</select>" +

      '<div class="form-actions"><button class="btn-cancel" onclick="openStartPosSheet()">返回</button>' +

      '<button class="btn-save" onclick="startPosSaveFromBld()">确定</button></div>';

    $("genTitle").textContent = "从建筑物选出发位置";

  };

  window.startPosSaveFromBld = function () {

    var b = BUILDINGS.find(function (x) { return x.id === $("spBld").value; });

    if (!b) { toast("请选择建筑物"); return; }

    SETTINGS.startPos = { lat: b.lat, lng: b.lon, name: b.name, leaveAt: "07:30" };

    saveSettings(); openStartPosSheet(); toast("已设为默认出发位置：" + b.name);

  };

  window.startPosSave = function () {

    var lat = parseFloat($("spLat").value), lng = parseFloat($("spLng").value);

    if (isNaN(lat) || isNaN(lng)) { toast("请输入有效经纬度"); return; }

    SETTINGS.startPos = { lat: lat, lng: lng, name: $("spName").value.trim() || "自定义点", leaveAt: $("spLeave").value || "07:30" };

    saveSettings(); closeSheet("sheetGen"); toast("默认出发位置已保存");

  };



  /* ---------- 运行维护：运行维护计划（F3）---------- */

  window.openMaintPlanSheet = function () {

    var html = '<label class="f">计划类型</label><select class="f" id="mpType">' +

      ['日常检查', '例行维护', '故障处理', '应急响应', '其他'].map(function (t) { return '<option>' + t + "</option>"; }).join("") + "</select>" +

      '<label class="f">开始日期</label><input class="f" id="mpStart" type="date">' +

      '<label class="f">结束日期</label><input class="f" id="mpEnd" type="date">' +

      '<label class="f">计划处理时间</label><input class="f" id="mpHandle" type="datetime-local">' +

      '<label class="f">范围（管理所，可多选）</label><select class="f" id="mpScope" multiple size="4">' +

      officeOptions().map(function (o) { return '<option>' + esc(o) + "</option>"; }).join("") + "</select>" +

      '<label class="f">备注</label><textarea class="f" id="mpNote" rows="3"></textarea>' +

      '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">取消</button>' +

      '<button class="btn-save" onclick="maintPlanSave()">保存计划</button></div>';

    $("genTitle").textContent = "运行维护计划";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  };

  window.maintPlanSave = function () {

    MAINT_PLANS.push({

      id: "mp" + Date.now(), type: $("mpType").value, startDate: $("mpStart").value,

      endDate: $("mpEnd").value, plannedTime: $("mpHandle").value,

      scope: Array.from($("mpScope").selectedOptions).map(function (o) { return o.value; }),

      note: $("mpNote").value.trim(), createdAt: Date.now()

    });

    saveMaintPlans(); closeSheet("sheetGen"); toast("运行维护计划已保存");

  };

  window.openMaintPlanList = function () {

    var html = MAINT_PLANS.length ? MAINT_PLANS.slice().reverse().map(function (p, i) {

      return '<div class="route-item"><div class="rt">' + (i + 1) + ". " + esc(p.type) +

        ' <span style="font-size:12px;color:#8a7c70">（' + esc(p.startDate || "—") + " ~ " + esc(p.endDate || "—") + "）</span></div>" +

        (p.plannedTime ? '<div class="rm">计划处理：' + esc(p.plannedTime) + "</div>" : "") +

        (p.scope && p.scope.length ? '<div class="rm">范围：' + esc(p.scope.join("、")) + "</div>" : "") +

        (p.note ? '<div class="rm" style="color:#3a2e28">' + esc(p.note) + "</div>" : "") + "</div>";

    }).join("") : '<div class="empty-tip">还没有运行维护计划</div>';

    $("genTitle").textContent = "运行维护计划列表";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  };



  /* ---------- 巡视检查（反向同步自 古建打卡；语义映射：打卡→巡视检查）---------- */

  var editingInspect = null;

  window.appInspect = function (id) { openInspect(id); };

  function openInspect(id) {

    var b = id ? BUILDINGS.find(function (x) { return x.id === id; }) : null;

    editingInspect = { targetId: id, photo: "", arrivalTime: nowLocalDateTime(), travelTime: "", experience: "" };

    var title = b ? ("巡视检查：" + b.name) : "巡视检查";

    $("genTitle").textContent = title;

    var selHtml = "";

    if (!b) {

      var opts = BUILDINGS.filter(function (x) { return x.lat != null; }).map(function (x) {

        return '<option value="' + esc(x.id) + '">' + esc(x.name) + "（" + esc(x.office || x.station || "") + "）</option>";

      }).join("");

      selHtml = '<label class="f">选择建筑物</label><select class="f" id="ciTarget">' + opts + "</select>";

    }

    $("genBody").innerHTML =

      selHtml +

      '<label class="f">巡视类型</label><select class="f" id="ciType">' +

      ['日常巡视', '例行维护', '故障处置', '应急响应', '其他'].map(function (t) { return '<option>' + t + "</option>"; }).join("") + "</select>" +

      '<label class="f">巡查照片</label><input type="file" id="ciPhoto" accept="image/*">' +

      '<div id="ciPhotoPrev" style="margin-top:6px"></div>' +

      '<label class="f">巡查时间</label><input class="f" type="datetime-local" id="ciArrival" value="' + editingInspect.arrivalTime + '">' +

      '<label class="f">显示坐标（自动获取，不可修改）</label><input class="f" id="ciCoord" readonly placeholder="获取中…">' +

      '<label class="f">是否计划内维护</label><select class="f" id="ciPlan"><option value="0">否</option><option value="1">是</option></select>' +

      '<label class="f">巡查时长（如 2 小时 / 半天）</label><input class="f" id="ciTravel" placeholder="本次巡视时长">' +

      '<label class="f">巡查情况</label><textarea class="f" id="ciExp" rows="4" placeholder="记录巡查发现、设施状态、处置建议…"></textarea>' +

      '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">取消</button>' +

      '<button class="btn-save" onclick="appSaveInspect()">保存巡视</button></div>';

    // 进入时自动获取坐标（只读）

    if (navigator.geolocation) {

      navigator.geolocation.getCurrentPosition(function (pos) {

        var el = $("ciCoord"); if (el) el.value = pos.coords.latitude.toFixed(6) + ", " + pos.coords.longitude.toFixed(6) + " (±" + Math.round(pos.coords.accuracy) + "m)";

      }, function () { var el = $("ciCoord"); if (el) el.value = "获取失败，可手动忽略"; }, { timeout: 8000 });

    } else { var el = $("ciCoord"); if (el) el.value = "不支持定位"; }

    $("ciPhoto").onchange = function () {

      var file = this.files && this.files[0]; if (!file) return;

      var r = new FileReader();

      r.onload = function () {

        // v3.31：>1.5M 的巡视照片先压缩再落盘

        compressDataUrlIfBig(r.result, function (d) {

          editingInspect.photo = "";

          try { if (window.Android && typeof window.Android.storePhoto === "function") editingInspect.photo = window.Android.storePhoto((id || "inspect_" + Date.now()), file.name, d); } catch (e) {}

          if (!editingInspect.photo) editingInspect.photo = d;

          $("ciPhotoPrev").innerHTML = '<img src="' + (editingInspect.photo.indexOf("data:") === 0 ? editingInspect.photo : (window.Android && window.Android.readPhoto ? window.Android.readPhoto(editingInspect.photo) : "")) + '" style="width:120px;height:120px;object-fit:cover;border-radius:8px;border:1px solid var(--border)">';

        });

      };

      r.readAsDataURL(file);

    };

    openSheet("sheetGen");

  }

  window.appSaveInspect = function () {

    var b = editingInspect.targetId ? BUILDINGS.find(function (x) { return x.id === editingInspect.targetId; }) : BUILDINGS.find(function (x) { return x.id === $("ciTarget").value; });

    if (!b) { toast("请选择要巡视的建筑物"); return; }

    b.inspections = b.inspections || [];

    var coordVal = ($("ciCoord").value || "").split(" (±")[0];

    var coordPair = coordVal.indexOf(",") >= 0 ? coordVal.split(",").map(function (s) { return parseFloat(s.trim()); }) : null;

    b.inspections.push({

      id: "i" + Date.now(),

      photo: editingInspect.photo,

      inspType: $("ciType").value,

      coord: coordPair && coordPair.length === 2 ? { lat: coordPair[0], lng: coordPair[1] } : null,

      planned: $("ciPlan").value === "1" ? 1 : 0,

      arrivalTime: $("ciArrival").value || nowLocalDateTime(),

      travelTime: $("ciTravel").value.trim(),

      experience: $("ciExp").value.trim(),

      createdAt: Date.now()

    });

    save(); render();

    if (MARKERS[b.id]) MARKERS[b.id].setPopupContent(popupHtml(b));

    closeSheet("sheetGen"); toast("巡视记录已保存：" + b.name);

  }

  function openInspectRoute() {

    var all = [];

    BUILDINGS.forEach(function (b) {

      (b.inspections || []).forEach(function (c) { all.push({ b: b, c: c }); });

    });

    // 按巡查时间从旧到新（段时长需顺序算），首段从默认出发位置算

    all.sort(function (a, b) {

      var ta = a.c.arrivalTime || "", tb = b.c.arrivalTime || "";

      if (ta !== tb) return ta < tb ? -1 : 1;

      return (a.c.createdAt || 0) - (b.c.createdAt || 0);

    });

    function fmtDur(sec) {

      if (!isFinite(sec) || sec < 0) sec = 0;

      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);

      return (h ? h + "时" : "") + (m ? m + "分" : "") + (s || (!h && !m) ? s + "秒" : "");

    }

    function toSec(t) { var d = new Date(t); return isNaN(d.getTime()) ? null : d.getTime() / 1000; }

    // 按天分组统计时长

    var dayStats = {};

    for (var i = 0; i < all.length; i++) {

      var c = all[i].c; var day = (c.arrivalTime || "").slice(0, 10); if (!day) continue;

      if (!dayStats[day]) dayStats[day] = { items: [], travel: 0, inspect: 0 };

      var ds = dayStats[day]; ds.items.push(all[i]);

      var cur = toSec(c.arrivalTime);

      if (cur != null) {

        if (ds.items.length === 1) {

          // 首段：从默认出发位置 leaveAt 算路上时长

          var sp = SETTINGS.startPos;

          if (sp && sp.leaveAt) {

            var ld = new Date(day + "T" + sp.leaveAt); var ls = isNaN(ld.getTime()) ? null : ld.getTime() / 1000;

            if (ls != null && cur >= ls) ds.travel += (cur - ls);

          }

        } else {

          var prev = toSec(ds.items[ds.items.length - 2].c.arrivalTime);

          if (prev != null && cur >= prev) ds.travel += (cur - prev);

        }

        ds.inspect += 180; // 每个巡视点估 3 分钟巡视操作

      }

    }

    var html = '<p style="font-size:13px;color:#555;margin-bottom:8px">共 ' + all.length + " 次巡视：</p>";

    // 时长汇总

    var dayKeys = Object.keys(dayStats);

    if (dayKeys.length) {

      html += '<div style="background:var(--soft);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px">';

      dayKeys.forEach(function (dk) {

        var ds = dayStats[dk];

        var sp = SETTINGS.startPos;

        html += '<div style="margin-bottom:4px"><b>' + dk + '</b>　从 <b>' + (sp ? esc(sp.name) : "默认起点") + '</b> 出发</div>' +

          '<div>总巡视时长：' + fmtDur(ds.inspect) + '　路上时长：' + fmtDur(ds.travel) +

          '　外勤总时长：' + fmtDur(ds.inspect + ds.travel) + '　巡视点：' + ds.items.length + "</div>";

      });

      html += "</div>";

    }

    if (!all.length) html += '<div class="empty-tip">还没有巡视记录，去「运行维护 → 巡视」添加吧。</div>';

    all.forEach(function (it, idx) {

      var photoSrc0 = it.c.photo ? (it.c.photo.indexOf("data:") === 0 ? it.c.photo : (window.Android && window.Android.readPhoto ? window.Android.readPhoto(it.c.photo) : "")) : "";

      html += '<div class="route-item">' +

        '<span class="go" onclick="appFly(\'' + esc(it.b.id) + '\')">定位 ›</span>' +

        '<div class="rt">' + (idx + 1) + ". " + esc(it.b.name) + ' <span style="font-size:12px;color:#8a7c70">（' + esc(it.b.office || it.b.station || "") + "）</span></div>" +

        '<div class="rm">类型：' + esc(it.c.inspType || "其他") + '　巡查：' + esc(it.c.arrivalTime || "—") + (it.c.travelTime ? "　时长：" + esc(it.c.travelTime) : "") + (it.c.planned ? "　✅计划内" : "") + "</div>" +

        (it.c.coord ? '<div class="rm" style="font-size:11px;color:#888">坐标：' + it.c.coord.lat.toFixed(5) + ", " + it.c.coord.lng.toFixed(5) + "</div>" : "") +

        (it.c.experience ? '<div class="rm" style="color:#3a2e28">' + esc(it.c.experience) + "</div>" : "") +

        (photoSrc0 ? '<img src="' + esc(photoSrc0) + '" style="width:72px;height:72px;object-fit:cover;border-radius:6px;margin-top:6px;border:1px solid var(--border);cursor:pointer" onclick="appLightboxSrc(\'' + esc(it.c.photo) + "','" + esc(it.b.name) + " 巡视照片')\">" : "") +

        '</div>';

    });

    $("genTitle").textContent = "我的巡视路线";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }



  /* ---------- 输入防抖（v3.20：性能）----------

     查询/筛选关键词每敲一键若立即 render()，会全量移除并重建地图上所有标记，

     建筑数量大时真机明显卡顿。统一走 200ms 防抖：用户停止输入后才渲染，

     单次输入期间只渲染一次，体验一致且流畅。 */

  var _filterTimer = null;

  function scheduleRender() {

    clearTimeout(_filterTimer);

    _filterTimer = setTimeout(function () {

      _filterTimer = null;

      render();

      if (window.updateFilterCount) window.updateFilterCount();

    }, 200);

  }

  window.scheduleRender = scheduleRender;



  /* ---------- 图例 ---------- */

  function buildLegend() {

    // v3.24：类型统一走规范清单（移除误当类型的字段，新增 泵站/溢洪道）

    var all = canonicalTypes();

    var types = all.slice(0, 8);

    var html = "<b>建筑物类型</b>";

    types.forEach(function (t) {

      html += '<div class="lg"><span class="dot" style="background:' + colorForType(t) + '">' + shapeForType(t) + '</span>' + esc(t) + "</div>";

    });

    if (all.length > types.length) html += '<div class="lg" style="color:#888">……等共 ' + all.length + ' 类</div>';

    html += '<div class="lg" style="margin-top:4px;color:#888">—— 蓝线为渠道</div>';

    var el = $("legend"); if (!el) {

      el = document.createElement("div"); el.id = "legend"; $("app").appendChild(el);

    }

    el.innerHTML = html;

  }



  /* ---------- 弹层 ---------- */

  function openSheet(id) {

    $(id).classList.add("show");

    $(id === "sheetMenu" ? "ovMenu" : "ovGen").classList.add("show");

    ensureSheetFoot(id); // Req 4：每个页面都有“退出本页”按钮，避免卡在当前页

  }

  function ensureSheetFoot(id) {

    var sheet = $(id); if (!sheet) return;

    if (sheet.querySelector(".sheet-foot")) return;

    var foot = document.createElement("div");

    foot.className = "sheet-foot";

    foot.innerHTML = '<button onclick="closeSheet(\'' + id + '\')">✕ 退出本页</button>';

    sheet.appendChild(foot);

  }

  function closeSheet(id) {

    $(id).classList.remove("show");

    if (id === "sheetMenu") $("ovMenu").classList.remove("show"); else $("ovGen").classList.remove("show");

  }

  // 暴露给全局，供 innerHTML 注入的 onclick 内联处理器（全局作用域）调用

  window.openSheet = openSheet;

  window.closeSheet = closeSheet;

  // 全局桥接②：尾部注入模块（游记/备忘录、升级/备份、知识库）在全局作用域裸引用以下闭包函数，
  // 不暴露则调用时 ReferenceError 被 window.onerror 捕获成「运行错误:script error」
  window.$ = $; window.esc = esc; window.toast = toast;
  window.getReleaseChannel = getReleaseChannel;
  window.save = save; window.compressDataUrlIfBig = compressDataUrlIfBig;
  // 全局桥接③：尾部注入模块（备忘录/升级备份/知识库）会裸引用主数据数组 BUILDINGS；
  // 该变量会被重新赋值（重载/恢复数据），故桥接为 getter 而非静态值，否则引用过期 → script error
  try { Object.defineProperty(window, "BUILDINGS", { get: function () { return BUILDINGS; }, configurable: true }); } catch (e) { window.BUILDINGS = BUILDINGS; }



  /* ---------- 菜单 ---------- */

  // v3.42：快捷常用——每个子菜单可收藏（☆），收藏项集中到「快捷常用」组；原子菜单保留

  function getFavMenus() { try { return JSON.parse(localStorage.getItem("favMenus") || "[]"); } catch (e) { return []; } }

  function setFavMenus(a) { try { localStorage.setItem("favMenus", JSON.stringify(a)); } catch (e) {} }

  function toggleFavMenu(k) {

    var f = getFavMenus();

    var i = f.indexOf(k);

    if (i >= 0) f.splice(i, 1); else f.push(k);

    setFavMenus(f);

    buildMenu();

    toast(i >= 0 ? "已从快捷常用移除" : "已添加到快捷常用");

  }

  function buildMenu() {

    // 一级菜单：查询 / 筛选 置顶并列；分组顺序（v3.42）：快捷常用→地图和位置→数据管理→传输与共享→运行维护→智能AI→设置→信息与帮助

    var topItems = [

      { k: "query", ico: "🔍", t: "查询（名称 / 类型 / 备注）", f: function () { closeSheet("sheetMenu"); setTimeout(function () { var s = $("search"); if (s) { s.focus(); s.select(); } }, 200); } },

      { k: "filter", ico: "🎚️", t: "筛选（管理所 / 管理站 / 类型）", f: openFilter }

    ];

    var groups = [

      { g: "地图和位置", ico: "🗺️", items: [

        { k: "locateMe", ico: "📍", t: "定位我的位置", f: locateMe },

        { k: "getCoord", ico: "🎯", t: "获取坐标", f: getCoordinates },

        { k: "baseMap", ico: "🗺️", t: "底图切换（矢量/影像）", f: switchBaseMap },

        { k: "measure", ico: "📏", t: "测距", f: toggleMeasure },

        { k: "nearby", ico: "🔎", t: "周边搜索", f: nearbySearch },

        { k: "listView", ico: "📋", t: "列表视图", f: toggleList },

        { k: "addBld", ico: "➕", t: "添加建筑物（点地图定位）", f: toggleAdd }

      ]},

      { g: "数据管理", ico: "🗂️", items: [

        { k: "impBld", ico: "📊", t: "批量导入建筑物", f: batchImportBuildings },

        { k: "impPhoto", ico: "🖼️", t: "批量导入照片", f: batchImportPhotos },

        { k: "expTable", ico: "📑", t: "导出建筑物表格", f: exportTable },

        { k: "expPhoto", ico: "🗂️", t: "导出照片（按管理所）", f: exportPhotos },

        { k: "cleanCache", ico: "🧹", t: "清理导入缓存（释放空间）", f: cleanImportCache },

        { k: "delPhotos", ico: "🗑️", t: "删除添加的照片", f: deleteImportedPhotos },

      ]},

      { g: "传输与共享", ico: "🔗", items: [

        { k: "impKmz", ico: "📥", t: "导入 ovkmz（奥维）", f: importKmz },

        { k: "expKmz", ico: "📤", t: "导出 ovkmz（奥维）", f: openExportKmz },

        { k: "impOvobj", ico: "📍", t: "导入 ovobj（奥维坐标）", f: importOvobj },

        { k: "expOvobj", ico: "📤", t: "导出 ovobj（奥维坐标·实验）", f: openExportOvobj },

        { k: "impObj", ico: "📍", t: "导入 obj 坐标（文本）", f: importObj },

        { k: "expObj", ico: "📤", t: "导出 obj 坐标（文本）", f: exportObj },

        { k: "xferSet", ico: "⚙️", t: "传输设置（WiFi/网盘/续传）", f: openXferSettings },

        { k: "peer", ico: "📡", t: "手机互传（服务端/客户端）", f: openPeer },

        { k: "photosUos", ico: "📲", t: "导出照片到统信平台", f: copyPhotosFromAndroid },

        { k: "photosFromAndroid", ico: "📦", t: "从安卓平台导出照片", f: exportPhotosForAndroid }

      ]},

      { g: "运行维护", ico: "🛠️", items: [

        { k: "startPos", ico: "📍", t: "默认出发位置", f: function () { closeSheet("sheetMenu"); openStartPosSheet(); } },

        { k: "maintPlan", ico: "🗓️", t: "运行维护计划", f: function () { closeSheet("sheetMenu"); openMaintPlanSheet(); } },

        { k: "maintPlanList", ico: "📋", t: "运行维护计划列表", f: function () { closeSheet("sheetMenu"); openMaintPlanList(); } },

        { k: "inspect", ico: "📷", t: "巡视（添加照片/巡查时间/情况）", f: function () { closeSheet("sheetMenu"); openInspect(null); } },

        { k: "inspectRoute", ico: "🛤️", t: "我的巡视路线", f: function () { closeSheet("sheetMenu"); openInspectRoute(); } },

        { k: "noteWrite", ico: "✍️", t: "写备忘录", f: function () { closeSheet("sheetMenu"); nmOpenEditor(null); } },

        { k: "noteList", ico: "📒", t: "我的备忘录", f: function () { closeSheet("sheetMenu"); nmOpenList(); } }

      ]},

    ];

    // v3.42：智能AI 注入——「智能AI」独立分组（置于设置之前），其设置项并入「设置」组

    var aiSettingItems = [];

    if (window.AIModule && typeof AIModule.getMenuGroups === "function") {

      AIModule.getMenuGroups().forEach(function (g) {

        g.items.forEach(function (it) { if (!it.k) it.k = "m:" + it.t; });

        if (g.g === "设置") aiSettingItems = aiSettingItems.concat(g.items);

        else groups.push(g);

      });

    }

    // 设置：组织与类型管理（v3.42 新增）+ 快捷常用设置 + 危险操作 + AI 设置项

    groups.push({ g: "设置", ico: "⚙️", items: [

      { k: "orgManage", ico: "🏢", t: "组织与类型管理（局/管理处/所/站/段/类型）", f: function () { closeSheet("sheetMenu"); openOrgManage(); } },

      { k: "favSet", ico: "⭐", t: "快捷常用设置", f: function () { closeSheet("sheetMenu"); openFavSettings(); } },

      // v3.45：修改/添加天地图密钥（防服务器封禁/过期，用户自换密钥）

      { k: "tdtKey", ico: "🗝️", t: "修改/添加天地图密钥", f: function () { closeSheet("sheetMenu"); openTdtKeySettings(); } }

    ].concat(aiSettingItems).concat([

      { k: "delBld", ico: "🏚️", t: "删除建筑物", f: deleteBuildingsMenu },

      { k: "resetData", ico: "♻️", t: "恢复初始数据", f: resetData },

      { k: "upExport", ico: "📤", t: "升级数据导出", f: upOpenExport },

      { k: "upImport", ico: "📥", t: "升级数据导入", f: upOpenImport },

      { k: "upUpgrade", ico: "🔄", t: "软件升级（检测新版）", f: upOpenUpgrade },

      { k: "ghUpgrade", ico: "🐙", t: "GitHub 升级（检测新版）", f: ghOpenUpgrade }

    ])});

    // 信息与帮助置底（关于/帮助放在最末）

    groups.push({ g: "信息与帮助", ico: "ℹ️", items: [

      { k: "stats", ico: "📈", t: "统计", f: showStats },

      { k: "changelog", ico: "📝", t: "版本变更", f: openChangelog },

      { k: "platformCompare", ico: "📊", t: "四端功能对照单", f: openPlatformCompare },

      { k: "photoHelp", ico: "🖼️", t: "照片（目录与命名）", f: openPhotoHelp },

      { k: "help", ico: "❓", t: "功能介绍", f: showHelp },

      { k: "about", ico: "ℹ️", t: "关于", f: showAbout }

    ]});

    // v3.42：快捷常用组（置于分组首位；空则不显示，去设置里添加）

    var keyMap = {};

    groups.forEach(function (grp) { grp.items.forEach(function (it) { keyMap[it.k] = it; }); });

    topItems.forEach(function (it) { keyMap[it.k] = it; });

    var favs = getFavMenus().filter(function (k) { return keyMap[k]; });

    if (favs.length) {

      groups.unshift({ g: "快捷常用", ico: "⭐", items: favs.map(function (k) { return keyMap[k]; }) });

    }

    var html = "";

    topItems.forEach(function (it, i) {

      html += '<div class="menu-top-item" data-ti="' + i + '"><span class="menu-ico">' + it.ico + "</span><span>" + esc(it.t) + "</span></div>";

    });

    groups.forEach(function (grp, gi) {

      html += '<div class="menu-group' + (grp.g === "快捷常用" ? "" : " collapsed") + '" data-gi="' + gi + '">' +

        '<div class="menu-group-head" data-gi="' + gi + '"><span class="gh-ico">' + grp.ico + '</span><span>' + esc(grp.g) + '</span><span class="plus">＋</span></div>' +

        '<div class="menu-group-body">';

      grp.items.forEach(function (it, ii) {

        var starred = getFavMenus().indexOf(it.k) >= 0;

        html += '<div class="menu-item sub" data-gi="' + gi + '" data-ii="' + ii + '"><span class="menu-ico">' + it.ico + '</span><span>' + esc(it.t) + '</span>' +

          '<span class="menu-fav" data-k="' + esc(it.k) + '" title="添加/移除快捷常用" style="float:right;margin-left:8px;padding:0 6px;color:' + (starred ? "#f0a020" : "#c8cdd2") + ';font-size:15px;cursor:pointer">' + (starred ? "★" : "☆") + "</span></div>";

      });

      html += "</div></div>";

    });

    if (!favs.length) {

      html += '<p style="margin:10px 4px;font-size:12px;color:#999">提示：点击任意子菜单右侧的 ☆ 可将其加入「快捷常用」（本组将置于菜单首位）；也可到 设置→快捷常用设置 批量勾选。</p>';

    }

    $("menuBody").innerHTML = html;

    $("menuBody").querySelectorAll(".menu-top-item").forEach(function (el, i) {

      el.onclick = function () { closeSheet("sheetMenu"); topItems[i].f(); };

    });

    $("menuBody").querySelectorAll(".menu-group-head").forEach(function (el) {

      el.onclick = function () { el.parentNode.classList.toggle("collapsed"); };

    });

    groups.forEach(function (grp, gi) {

      $("menuBody").querySelectorAll('.menu-item.sub[data-gi="' + gi + '"]').forEach(function (el) {

        el.onclick = function () { closeSheet("sheetMenu"); grp.items[+el.dataset.ii].f(); };

      });

    });

    // v3.43：☆ 收藏开关（阻止冒泡，不触发菜单动作；视觉反馈更醒目）

    $("menuBody").querySelectorAll(".menu-fav").forEach(function (el) {

      el.onclick = function (ev) {

        ev.stopPropagation(); ev.preventDefault();

        toggleFavMenu(el.dataset.k);

        // 视觉反馈：刚切换的星即时变成 ★ / ☆

        var starred = getFavMenus().indexOf(el.dataset.k) >= 0;

        el.textContent = starred ? "★" : "☆";

        el.style.color = starred ? "#f0a020" : "#c8cdd2";

      };

    });

    // v3.43：菜单项点击——防御性跳过星标/折叠头触发的误触

    groups.forEach(function (grp, gi) {

      $("menuBody").querySelectorAll('.menu-item.sub[data-gi="' + gi + '"]').forEach(function (el) {

        el.onclick = function (ev) {

          if (ev.target.closest(".menu-fav")) return;   // 不响应来自星标的点击

          closeSheet("sheetMenu"); grp.items[+el.dataset.ii].f();

        };

      });

    });

  }



  /* ---------- v3.42：设置 → 组织与类型管理（局/管理处/所/站/段 名称增删改、默认值修改、类型增删改） ---------- */

  function openOrgManage() {

    var tab = window.__orgTab || "names";

    var html = '<div class="seg" style="display:flex;gap:6px;margin-bottom:12px">' +

      '<button class="tbtn" data-otab="names" style="flex:1">①层级名称</button>' +

      '<button class="tbtn" data-otab="defaults" style="flex:1">②默认设置</button>' +

      '<button class="tbtn" data-otab="types" style="flex:1">③建筑物类型</button></div><div id="orgPanel"></div>' +

      '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +

      '<button class="btn-save" onclick="orgSaveSync()">💾 保存并同步</button></div>' +

      '<p style="font-size:12px;color:#999;margin:4px 0 0">「保存并同步」后，筛选菜单、导入导出、添加建筑物等所有用到组织/类型的地方立即更新。</p>';

    $("genTitle").textContent = "组织与类型管理";

    $("genBody").innerHTML = html;

    $("genBody").querySelectorAll("[data-otab]").forEach(function (b) {

      b.onclick = function () { window.__orgTab = b.dataset.otab; openOrgManage(); };

    });

    openSheet("sheetGen");

    if (tab === "names") orgPanelNames();

    else if (tab === "defaults") orgPanelDefaults();

    else orgPanelTypes();

  }

  // 同步刷新全部使用处（图例/地图/菜单/筛选计数）

  window.orgSaveSync = function () {

    try { if (typeof buildLegend === "function") buildLegend(); } catch (e) {}

    try { if (typeof render === "function") render(); } catch (e) {}

    try { if (typeof updateFilterCount === "function") updateFilterCount(); } catch (e) {}

    toast("✅ 已保存并同步：筛选/导入导出/添加建筑物等全部生效");

  };

  // —— 面板①：五级名称增删改 ——

  function orgPanelNames() {

    var lv = orgStore();

    var html = "";

    ORG_LEVELS.forEach(function (L) {

      var arr = lv[L.k] || [];

      html += '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:10px">' +

        '<p style="margin:0 0 6px;font-weight:700;font-size:14px">' + L.t + '（' + arr.length + '）</p><div class="chips">';

      arr.forEach(function (v, i) {

        html += '<span class="chip" style="display:inline-flex;align-items:center;gap:4px">' + esc(v) +

          '<b data-ren="' + L.k + '|' + i + '" style="cursor:pointer;color:#1565c0">✎</b>' +

          '<b data-del="' + L.k + '|' + i + '" style="cursor:pointer;color:#c62828">✕</b></span>';

      });

      if (!arr.length) html += '<span style="color:#999;font-size:13px">（空）</span>';

      html += '</div><div style="display:flex;gap:6px;margin-top:8px"><input class="f" id="orgAdd_' + L.k + '" placeholder="添加' + L.t + '名称…" style="flex:1;margin:0">' +

        '<button class="tbtn" data-add="' + L.k + '">＋ 添加</button></div></div>';

    });

    $("orgPanel").innerHTML = html;

    $("orgPanel").querySelectorAll("[data-add]").forEach(function (b) {

      b.onclick = function () {

        var k = b.dataset.add, inp = $("orgAdd_" + k);

        var v = (inp.value || "").trim(); if (!v) { toast("请输入名称"); return; }

        var o = orgStore();

        if (o[k].indexOf(v) >= 0) { toast("该名称已存在"); return; }

        o[k].push(v); saveOrgStore(o); toast("已添加" + (ORG_LEVELS.filter(function (x) { return x.k === k; })[0] || {}).t + "：" + v);

        orgPanelNames();

      };

    });

    $("orgPanel").querySelectorAll("[data-ren]").forEach(function (b) {

      b.onclick = function () {

        var pr = b.dataset.ren.split("|"), k = pr[0], i = +pr[1];

        var o = orgStore(), old = o[k][i];

        promptText("修改「" + old + "」为新名称", old, function (nv) {

          nv = (nv || "").trim(); if (!nv || nv === old) return;

          if (o[k].indexOf(nv) >= 0) { toast("该名称已存在"); return; }

          // 找到使用该名称的建筑物，逐个确认同步

          var field = k === "suo" ? "office" : k; // suo→office；zhan→station；duan→chan；ju/guanchu→同名

          var affected = BUILDINGS.filter(function (b) { return orgVal(b, k) === old; });

          o[k][i] = nv; saveOrgStore(o);

          if (!affected.length) { toast("已修改（无建筑物使用该名称）"); orgPanelNames(); return; }

          var idx = 0;

          var askNext = function () {

            if (idx >= affected.length) { orgSaveSync(); orgPanelNames(); return; }

            var b = affected[idx++];

            window.ask("同步建筑物 " + idx + "/" + affected.length,

              "将 <b>" + esc(b.name) + "</b> 的「" + (ORG_LEVELS.filter(function (x) { return x.k === k; })[0] || {}).t + "」由「" + esc(old) + "」改为「" + esc(nv) + "」？",

              [{ t: "✔ 确认修改", cls: "btn-confirm2", v: 1 }, { t: "跳过", cls: "btn-cancel2", v: 0 }], function (v) {

                if (v) {

                  if (k === "suo") b.office = nv;

                  else if (k === "ju") b.ju = nv;

                  else if (k === "guanchu") b.guanchu = nv;

                  else b[k] = nv; // zhan→station / duan→chan（k 即字段名）

                  try { save(); } catch (e) {}

                }

                askNext();

              });

          };

          askNext();

        });

      };

    });

    $("orgPanel").querySelectorAll("[data-del]").forEach(function (b) {

      b.onclick = function () {

        var pr = b.dataset.del.split("|"), k = pr[0], i = +pr[1];

        var o = orgStore(), v = o[k][i];

        var affected = BUILDINGS.filter(function (x) { return orgVal(x, k) === v; }).length;

        var doDel = function () { o[k].splice(i, 1); saveOrgStore(o); toast("已删除：" + v); orgPanelNames(); };

        if (affected) window.ask("删除确认", "有 <b>" + affected + "</b> 个建筑物正在使用「" + esc(v) + "」。<br>删除后下拉/筛选不再显示该名称（建筑物字段保留原值）。确定删除？",

          [{ t: "确定删除", cls: "btn-exit", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }], function (r) { if (r) doDel(); });

        else doDel();

      };

    });

  }

  // v3.43：面板②默认层级值：局 / 管理处 / 所(多) / 站 / 段(可空)

  function orgPanelDefaults() {

    var d = getOrgDefaults();

    var html = '<p style="font-size:13px;color:#555;margin:0 0 8px">新建筑物与导出命名的默认层级值（多个所=默认同时使用；段默认可空：与所名称独立）。</p>';

    // 局 / 管理处 / 站：单值下拉（与原行为一致）

    ["ju","guanchu","zhan"].forEach(function (k) {

      var L = ORG_LEVELS.filter(function (x) { return x.k === k; })[0];

      var opts = levelOptions(k), cur = d[k] || "";

      if (opts.indexOf(cur) < 0 && cur) opts.unshift(cur);

      html += '<label class="f">默认' + L.t + '（单值）</label>' +

        '<select class="f" id="orgDef_' + k + '">' +

        opts.map(function (o) { return '<option' + (o === cur ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + '</select>';

    });

    // 所：多选（offices）

    var allOff = officeOptions(), curOffs = d.offices || [];

    html += '<label class="f">默认管理所（可多选；空=不默认）</label>' +

      '<div id="orgDef_offices" class="chips" style="max-height:130px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">' +

      allOff.map(function (o) {

        var on = curOffs.indexOf(o) >= 0;

        return '<span class="chip def-off' + (on ? " on" : "") + '" data-v="' + esc(o) + '">' + esc(o) + "</span>";

      }).join("") + "</div>";

    // 段：可空 + 与所独立

    var allDuan = uniq(BUILDINGS.map(function (x) { return x.chan; }).filter(Boolean).concat(levelOptions("duan")));

    var curDuan = d.duan || "";

    html += '<label class="f">默认段（可空：与所独立）</label>' +

      '<select class="f" id="orgDef_duan"><option value="">（空：无默认段）</option>' +

      allDuan.map(function (o) { return '<option' + (o === curDuan ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + '</select>';

    html += '<div class="form-actions"><button class="btn-save" onclick="orgSaveDefaults()">保存默认值</button></div>';

    html += '<p style="margin-top:6px;font-size:12px;color:#888">多选管理所：点击「所」chip 切换（蓝色=启用，多个=批量默认）。保存后所有空 office 的建筑物自动使用第 1 个默认所。</p>';

    $("orgPanel").innerHTML = html;

    // 事件委托：多选 chip

    var wrap = $("orgDef_offices");

    if (wrap) wrap.onclick = function (e) {

      var chip = e.target.closest && e.target.closest(".def-off"); if (!chip) return;

      chip.classList.toggle("on");

    };

  }

  window.orgSaveDefaults = function () {

    var d = {};

    d.ju = ($("orgDef_ju") || {}).value || "";

    d.guanchu = ($("orgDef_guanchu") || {}).value || "";

    d.zhan = ($("orgDef_zhan") || {}).value || "";

    d.duan = ($("orgDef_duan") || {}).value || "";   // 可空

    // 多管理所（自 chip 读取）

    d.offices = [];

    var wrap = $("orgDef_offices");

    if (wrap) wrap.querySelectorAll(".def-off.on").forEach(function (c) { d.offices.push(c.dataset.v); });

    if (!d.offices.length) d.offices = [ORG_DEFAULT_NAMES.suo];   // 至少有 1 个兜底

    setOrgDefaults(d);

    toast("✅ 默认层级值已保存：管理所 " + d.offices.length + " 个，段 " + (d.duan ? '"' + d.duan + '"' : "（空）"));

  };

  // —— 面板③：建筑物类型增删改 ——

  function orgPanelTypes() {

    var types = canonicalTypes();

    var customs = getCustomTypes();

    var html = '<p style="font-size:13px;color:#555;margin:0 0 8px">类型清单（权威 + 自定义）；改名会逐个确认同步建筑物。</p><div class="chips">';

    types.forEach(function (t, i) {

      var isCustom = customs.indexOf(t) >= 0;

      html += '<span class="chip" style="display:inline-flex;align-items:center;gap:4px">' + esc(t) +

        '<b data-tren="' + i + '" style="cursor:pointer;color:#1565c0">✎</b>' +

        (isCustom ? '<b data-tdel="' + i + '" style="cursor:pointer;color:#c62828">✕</b>' : "") + "</span>";

    });

    html += '</div><div style="display:flex;gap:6px;margin-top:10px"><input class="f" id="typeAdd" placeholder="添加类型名称…" style="flex:1;margin:0">' +

      '<button class="tbtn" id="typeAddBtn">＋ 添加</button></div>';

    $("orgPanel").innerHTML = html;

    var all = canonicalTypes();

    $("orgPanel").querySelectorAll("[data-tren]").forEach(function (b) {

      b.onclick = function () {

        var old = all[+b.dataset.tren];

        promptText("修改类型「" + old + "」", old, function (nv) {

          nv = (nv || "").trim(); if (!nv || nv === old) return;

          var affected = BUILDINGS.filter(function (x) { return x.btype === old; });

          var cs = getCustomTypes();

          var ci = cs.indexOf(old);

          if (ci >= 0) cs[ci] = nv; else cs.push(nv);

          setCustomTypes(cs);

          var idx = 0;

          var askNext = function () {

            if (idx >= affected.length) { orgSaveSync(); orgPanelTypes(); return; }

            var bx = affected[idx++];

            window.ask("同步建筑物 " + idx + "/" + affected.length, "将 <b>" + esc(bx.name) + "</b> 的类型由「" + esc(old) + "」改为「" + esc(nv) + "」？",

              [{ t: "✔ 确认修改", cls: "btn-confirm2", v: 1 }, { t: "跳过", cls: "btn-cancel2", v: 0 }], function (v) {

                if (v) { bx.btype = nv; try { save(); } catch (e) {} }

                askNext();

              });

          };

          askNext();

        });

      };

    });

    $("orgPanel").querySelectorAll("[data-tdel]").forEach(function (b) {

      b.onclick = function () {

        var t = all[+b.dataset.tdel];

        var cs = getCustomTypes(), ci = cs.indexOf(t);

        if (ci >= 0) cs.splice(ci, 1);

        setCustomTypes(cs);

        toast("已删除类型：" + t); orgPanelTypes();

      };

    });

    $("typeAddBtn").onclick = function () {

      var v = ($("typeAdd").value || "").trim(); if (!v) { toast("请输入类型名称"); return; }

      var cs = getCustomTypes();

      if (cs.indexOf(v) >= 0 || CANONICAL_TYPES.indexOf(v) >= 0) { toast("该类型已存在"); return; }

      cs.push(v); setCustomTypes(cs); orgSaveSync(); orgPanelTypes();

    };

  }

  /* ---------- v3.42：设置 → 快捷常用设置（勾选常用子菜单） ---------- */

  function openFavSettings() {

    // 与 buildMenu 相同的分组结构（只读复用：重建一份 key 清单）

    var all = collectMenuIndex();

    var html = '<p style="font-size:13px;color:#555;margin:0 0 8px">勾选加入「快捷常用」（菜单首位）；取消勾选即移除。原子菜单始终保留。</p>';

    Object.keys(all).forEach(function (g) {

      html += '<div style="border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin-bottom:8px"><p style="margin:0 0 4px;font-weight:700;font-size:13px">' + esc(g) + "</p>";

      all[g].forEach(function (it) {

        var on = getFavMenus().indexOf(it.k) >= 0;

        html += '<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:13.5px"><input type="checkbox" data-favk="' + esc(it.k) + '"' + (on ? " checked" : "") + "> " + it.ico + " " + esc(it.t) + "</label>";

      });

      html += "</div>";

    });

    html += '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button><button class="btn-save" onclick="favSaveFromPanel()">保存</button></div>';

    $("genTitle").textContent = "快捷常用设置";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  // 汇总全部菜单项（分组名 → [{k,ico,t}]），供快捷常用设置与收藏解析共用

  function collectMenuIndex() {

    var out = {};

    var add = function (g, ico, k, t) { (out[g] = out[g] || []).push({ k: k, ico: ico, t: t }); };

    add("置顶", "🔍", "query", "查询（名称 / 类型 / 备注）");

    add("置顶", "🎚️", "filter", "筛选（管理所 / 管理站 / 类型）");

    add("地图和位置", "📍", "locateMe", "定位我的位置");

    add("地图和位置", "🎯", "getCoord", "获取坐标");

    add("地图和位置", "🗺️", "baseMap", "底图切换（矢量/影像）");

    add("地图和位置", "📏", "measure", "测距");

    add("地图和位置", "🔎", "nearby", "周边搜索");

    add("地图和位置", "📋", "listView", "列表视图");

    add("地图和位置", "➕", "addBld", "添加建筑物（点地图定位）");

    add("数据管理", "📊", "impBld", "批量导入建筑物");

    add("数据管理", "🖼️", "impPhoto", "批量导入照片");

    add("数据管理", "📑", "expTable", "导出建筑物表格");

    add("数据管理", "🗂️", "expPhoto", "导出照片（按管理所）");

    add("数据管理", "🧹", "cleanCache", "清理导入缓存（释放空间）");

    add("数据管理", "🗑️", "delPhotos", "删除添加的照片");

    add("传输与共享", "📥", "impKmz", "导入 ovkmz（奥维）");

    add("传输与共享", "📤", "expKmz", "导出 ovkmz（奥维）");

    add("传输与共享", "📍", "impOvobj", "导入 ovobj（奥维坐标）");

    add("传输与共享", "📤", "expOvobj", "导出 ovobj（奥维坐标·实验）");

    add("传输与共享", "📍", "impObj", "导入 obj 坐标（文本）");

    add("传输与共享", "📤", "expObj", "导出 obj 坐标（文本）");

    add("传输与共享", "⚙️", "xferSet", "传输设置（WiFi/网盘/续传）");

    add("传输与共享", "📡", "peer", "手机互传（服务端/客户端）");

    add("传输与共享", "📲", "photosUos", "导出照片到统信平台");

    add("传输与共享", "📦", "photosFromAndroid", "从安卓平台导出照片");

    add("运行维护", "📍", "startPos", "默认出发位置");

    add("运行维护", "🗓️", "maintPlan", "运行维护计划");

    add("运行维护", "📋", "maintPlanList", "运行维护计划列表");

    add("运行维护", "📷", "inspect", "巡视（添加照片/巡查时间/情况）");

    add("运行维护", "🛤️", "inspectRoute", "我的巡视路线");

    add("设置", "🏢", "orgManage", "组织与类型管理（局/管理处/所/站/段/类型）");

    add("设置", "⭐", "favSet", "快捷常用设置");

    add("设置", "🤖", "m:智能AI设置", "智能AI设置");

    add("设置", "📚", "m:知识库管理", "知识库管理");

    add("设置", "🏚️", "delBld", "删除建筑物");

    add("设置", "♻️", "resetData", "恢复初始数据");

    add("信息与帮助", "📈", "stats", "统计");

    add("信息与帮助", "📝", "changelog", "版本变更");

    add("信息与帮助", "📊", "platformCompare", "四端功能对照单");

    add("信息与帮助", "🖼️", "photoHelp", "照片（目录与命名）");

    add("信息与帮助", "❓", "help", "功能介绍");

    add("信息与帮助", "ℹ️", "about", "关于");

    return out;

  }

  window.favSaveFromPanel = function () {

    var on = [];

    document.querySelectorAll("[data-favk]").forEach(function (c) { if (c.checked) on.push(c.dataset.favk); });

    setFavMenus(on);

    buildMenu();

    toast("✅ 快捷常用已保存（" + on.length + " 项）");

    closeSheet("sheetGen");

  };

  /* ---------- v3.42：导出文件名/文件夹组装器（局/管理处/所/站/段/建筑名，英文 _ 分隔） ---------- */

  // 组装 UI（文件名 + 文件夹层次两组复选）；defName/defDir 为默认勾选段

  function orgComposerHtml(nameSegs, dirSegs) {

    var segs = [["ju", "局"], ["guanchu", "管理处"], ["suo", "所"], ["zhan", "站"], ["duan", "段"], ["bname", "建筑物名称"]];

    var mk = function (cls, defs) {

      return segs.map(function (s) {

        return '<label style="display:inline-flex;align-items:center;gap:4px;margin:3px 10px 3px 0;font-size:13px"><input type="checkbox" class="' + cls + '" value="' + s[0] + '"' + (defs.indexOf(s[0]) >= 0 ? " checked" : "") + "> " + s[1] + "</label>";

      }).join("");

    };

    return '<p style="font-size:13px;color:#555;margin:10px 0 4px">🧩 文件名组成（可多选，英文 _ 分隔）</p><div>' + mk("expNameSeg", nameSegs) + "</div>" +

      '<p style="font-size:13px;color:#555;margin:10px 0 4px">📁 文件夹层次（可多选，默认「所」；安卓/统信支持子目录）</p><div>' + mk("expDirSeg", dirSegs) + "</div>";

  }

  // 由勾选段 + 范围建筑列表生成 { name, dir }

  function orgCompose(segsName, segsDir, list) {

    var one = list && list.length === 1 ? list[0] : null;

    var common = {};

    ["ju", "guanchu", "suo", "zhan", "duan"].forEach(function (k) {

      var vals = uniq((list || []).map(function (b) { return orgVal(b, k); }));

      common[k] = vals.length === 1 ? vals[0] : "";

    });

    var parts = segsName.filter(function (k) {

      if (k === "bname") return !!(one && one.name);

      return !!(one ? orgVal(one, k) : common[k]);

    }).map(function (k) { return one ? orgVal(one, k) : common[k]; }).filter(Boolean);

    var name = parts.join("_").replace(/[\\/:*?"<>|]/g, "_") || APPNAME;

    var dirs = segsDir.filter(function (k) { return k !== "bname"; }).map(function (k) {

      return (one ? orgVal(one, k) : common[k]) || "";

    }).filter(Boolean);

    return { name: name, dir: dirs.join("/") };

  }

  function getCheckedSegs(cls) {

    return Array.prototype.slice.call(document.querySelectorAll("." + cls)).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });

  }

  // 导出最终落盘名：dir 子目录 + 文件名（浏览器回退时 / 合法化为 _）

  function orgExportPath(fileName, dir) {

    if (dir && window.Android && typeof window.Android.exportPath === "function") return window.Android.exportPath(dir + "/" + fileName);

    if (dir) { toast("当前端不支持子文件夹，已用 _ 连接到文件名"); return fileName; }

    return window.Android && typeof window.Android.exportPath === "function" ? window.Android.exportPath(fileName) : fileName;

  }



  /* ---------- 筛选 ---------- */

  function openFilter() {

    // v3.26：管理所列表按统一名称去重（温泉管理所 与 温泉所 合并为一个筛选项）；需求⑤：保证含全部管理所

    var offices = officeOptions();

    var stations = stationOptions();

    // v3.24：类型字段只显示规范清单（去掉 西田各庄段引渠/技术指标/挖填方统计表 等非类型字段），新增 泵站/溢洪道

    var types = canonicalTypes();

    function chips(arr, set, key) {

      return arr.map(function (v) {

        var real = v === "（未设置）" ? "" : v;

        return '<span class="chip' + (set.has(real) ? " on" : "") + '" data-k="' + key + '" data-v="' + esc(real) + '">' + esc(v) + "</span>";

      }).join("");

    }

    // Req 4：照片状态筛选（互斥单选：全部 / 有照片 / 多张照片(可自定义张数) / 无照片）

    function photoChips() {

      var opts = [["all", "全部"], ["has", "有照片"], ["many", "多张照片"], ["none", "无照片"]];

      return opts.map(function (o) {

        var chip = '<span class="chip photochip' + (filters.photoStatus === o[0] ? " on" : "") + '" data-k="photoStatus" data-v="' + o[0] + '">' + o[1] + "</span>";

        if (o[0] === "many") {

          chip += ' <span id="photoMinWrap" class="photo-min-wrap" style="' + (filters.photoStatus === "many" ? "" : "display:none") + '">≥<input id="photoMinInput" type="number" min="1" step="1" value="' + filters.photoMin + '" style="width:46px;font-size:12px;padding:2px 3px;border:1px solid var(--border);border-radius:4px"></span>';

        }

        return chip;

      }).join("");

    }

    function bindPhotoMin() {

      var inp = $("photoMinInput");

      if (inp)       inp.oninput = function () {

        var v = parseInt(inp.value, 10);

        filters.photoMin = (isNaN(v) || v < 1) ? 1 : v;

        saveDefaultFilter(); // v3.38

        scheduleRender();

      };

    }

    /* Req 6：筛选提示区 —— 实时显示「命中数量 + 全部生效条件（含查询关键词）」

       条件以小标签逐项回显，用户随手改一个 chip 就能立刻看到条件与结果的变化，

       不必确认后才知道选中了几个建筑。 */

    function updateFilterCount() {

      var n = BUILDINGS.filter(passFilter).length;

      var el = $("filterCount");

      if (!el) return;

      var tags = [];

      if (filters.text) tags.push('<span class="fc-tag kw">🔍 查询关键词：' + esc(filters.text) + "</span>");

      if (filters.guanchu.size) {

        Array.from(filters.guanchu).forEach(function (v) {

          tags.push('<span class="fc-tag"><span class="fc-k">管理处</span>' + esc(v) + "</span>");

        });

      }

      if (filters.offices.size) {

        Array.from(filters.offices).forEach(function (v) {

          tags.push('<span class="fc-tag"><span class="fc-k">管理所</span>' + esc(v || "未设置") + "</span>");

        });

      }

      if (filters.stations.size) {

        Array.from(filters.stations).forEach(function (v) {

          tags.push('<span class="fc-tag"><span class="fc-k">管理站</span>' + esc(v || "未设置") + "</span>");

        });

      }

      if (filters.types.size) {

        Array.from(filters.types).forEach(function (v) {

          tags.push('<span class="fc-tag"><span class="fc-k">类型</span>' + esc(v || "其他") + "</span>");

        });

      }

      if (filters.photoStatus === "has") tags.push('<span class="fc-tag"><span class="fc-k">照片</span>有照片</span>');

      else if (filters.photoStatus === "many") tags.push('<span class="fc-tag"><span class="fc-k">照片</span>≥' + filters.photoMin + " 张</span>");

      else if (filters.photoStatus === "none") tags.push('<span class="fc-tag"><span class="fc-k">照片</span>无照片</span>');



      var head = "当前符合条件：<b>" + n + "</b> 个建筑（共 " + BUILDINGS.length + " 个）";

      if (n === 0) head += ' <span class="fc-warn">无可显示，请放宽条件</span>';

      el.innerHTML = head +

        (tags.length

          ? '<div class="fc-cond">' + tags.join("") + "</div>"

          : '<div class="fc-none">尚未设置任何条件，当前为全部建筑。选择下方条件后此处实时更新。</div>');

    }

    window.updateFilterCount = updateFilterCount;

    $("genTitle").textContent = "筛选";

    $("genBody").innerHTML =

      '<div class="filter-count" id="filterCount"></div>' +

      // Req 6：关键词可在筛选面板内直接查看/修改，与顶部查询框双向同步

      '<div class="filter-sec"><h4>查询关键词</h4>' +

      '<div style="display:flex;gap:6px">' +

      '<input id="filterText" type="text" value="' + esc(filters.text || "") + '" placeholder="名称 / 类型 / 单位 / 参数，留空为不限" ' +

      'style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px">' +

      '<button class="chip" onclick="appFilterClearText()" style="flex:0 0 auto">清除</button></div></div>' +

      // v3.46：历史关键词紧贴查询关键词之下（点击展开 20 条历史关键词 chip 一键回填）

      '<div class="filter-sec"><h4 style="cursor:pointer;user-select:none" onclick="toggleKwHist()">🔖 历史关键词 <span id="kwHistToggle">▸</span></h4><div id="kwHistBox" style="display:none"></div></div>' +

      // v3.45：管理处可多选（按管理范围最粗颗粒先筛），默认京密引水管理处（持久化兜底在 SETTINGS.defaultFilter）

      '<div class="filter-sec"><h4>管理处</h4><div class="chips" id="cGc">' + chips(guanchuOptions(), filters.guanchu, "guanchu") + "</div></div>" +

      '<div class="filter-sec"><h4>管理所</h4><div class="chips" id="cOff">' + chips(offices, filters.offices, "office") + "</div>" +

      '<div style="display:flex;gap:6px;margin-top:6px"><button class="tbtn" onclick="addOffice()">＋ 添加</button><button class="tbtn" onclick="renameOffice()">✎ 改名</button></div></div>' +

      '<div class="filter-sec"><h4>管理站</h4><div class="chips" id="cSta">' + chips(stations, filters.stations, "station") + "</div>" +

      '<div style="display:flex;gap:6px;margin-top:6px"><button class="tbtn" onclick="addStation()">＋ 添加</button><button class="tbtn" onclick="renameStation()">✎ 改名</button></div></div>' +

      '<div class="filter-sec"><h4>建筑物类型</h4><div class="chips" id="cTyp">' + chips(types, filters.types, "type") + "</div></div>" +

      '<div class="filter-sec"><h4>照片状态</h4><div class="chips" id="cPh">' + photoChips() + "</div></div>" +

      '<div class="form-actions"><button class="btn-cancel" onclick="appClearFilter()">清空筛选</button>' +

      '<button class="btn-save" onclick="applyFilterAndJump()">确认</button></div>';

    // v3.41：事件委托统一处理所有 chip（含 photochip），不再点击后重建 DOM，杜绝「不能选/死机」

    $("genBody").onclick = function (e) {

      if (e.target.tagName === "INPUT") return; // 避免点「≥N」输入框误触照片状态切换

      var el = e.target.closest(".chip"); if (!el) return;

      if (el.classList.contains("photochip")) {

        filters.photoStatus = el.dataset.v;

        $("genBody").querySelectorAll(".photochip").forEach(function (c) { c.classList.toggle("on", c.dataset.v === filters.photoStatus); });

        var wrap = $("photoMinWrap"); if (wrap) wrap.style.display = (filters.photoStatus === "many") ? "" : "none"; // 仅切换显隐，不重建

        saveDefaultFilter(); scheduleRender(); updateFilterCount();

        return;

      }

      var set = el.dataset.k === "guanchu" ? filters.guanchu : el.dataset.k === "office" ? filters.offices : el.dataset.k === "station" ? filters.stations : filters.types;

      var v = el.dataset.v;

      if (set.has(v)) set.delete(v); else set.add(v);

      el.classList.toggle("on");

      saveDefaultFilter(); scheduleRender(); updateFilterCount();

    };

    // 关键词输入：与顶部查询框双向同步，边打边更新提示区

    var ft = $("filterText");

    if (ft) ft.oninput = function () {

      filters.text = ft.value.trim();

      var sb = $("search"); if (sb) sb.value = ft.value;

      saveDefaultFilter(); // v3.38

      scheduleRender();

    };

    updateFilterCount();

    bindPhotoMin();

    renderKwHist();

    openSheet("sheetGen");

  }

  window.appFilterClearText = function () {

    filters.text = "";

    var ft = $("filterText"); if (ft) ft.value = "";

    var sb = $("search"); if (sb) sb.value = "";

    saveDefaultFilter(); // v3.38：清空关键词也写回默认值

    render();

    if (window.updateFilterCount) window.updateFilterCount();

  };

  window.appClearFilter = function () {

    filters.offices.clear(); filters.stations.clear(); filters.types.clear();

    filters.photoStatus = "all";

    filters.text = "";

    var ft = $("filterText"); if (ft) ft.value = "";

    var sb = $("search"); if (sb) sb.value = "";

    $("genBody").querySelectorAll(".chip").forEach(function (c) { c.classList.remove("on"); });

    // 照片状态回到"全部"需要让对应 chip 重新高亮

    $("genBody").querySelectorAll(".photochip").forEach(function (c) { c.classList.toggle("on", c.dataset.v === "all"); });

    var wrap = $("photoMinWrap"); if (wrap) wrap.style.display = "none";

    saveDefaultFilter(); // v3.38：清空筛选写回默认值（全部）

    if (window.updateFilterCount) window.updateFilterCount();

    render(); toast("已清空筛选");

  };

  // Req 5：筛选“确认”后按结果数量跳转——0 提示无符合条件；1 立即定位；多个框选全部并适配视图

  window.applyFilterAndJump = function () {

    if (filters.text) pushKeywordHistory(filters.text);

    saveDefaultFilter(); // v3.38：确认即写回默认值

    var matched = BUILDINGS.filter(passFilter);

    var cond = filterDesc();

    if (!matched.length) {

      // 必须用自定义 ask()：原生 alert() 在离线 WebView 中不显示，用户将“无提示”

      ask("无符合条件的建筑",

        "没有符合条件的建筑。\n\n当前条件：" + (cond || "（无）") + "\n\n请放宽或清空筛选条件后重试。",

        [{ t: "知道了", cls: "btn-confirm2", v: 1 }],

        function () {});

      return;   // 保留面板不关闭，便于就地调整条件

    }

    closeSheet("sheetGen");

    render();

    if (matched.length === 1) {

      appFly(matched[0].id);

      toast("唯一匹配：" + matched[0].name + "，已定位");

    } else {

      // v3.24：筛选圈 = 浅蓝色虚线圈（区别于主界面查询的绿色圈）

      showFilterResult(matched, "blue");

      toast("命中 " + matched.length + " 个建筑，已用浅蓝色虚线圈选" + (cond ? "（" + cond + "）" : ""));

    }

  };

  // v3.41：管理所/管理站 手动添加 / 改名（改名同步到相关建筑物，弹受影响清单确认）

  function promptText(title, def, cb) {

    $("genTitle").textContent = title;

    $("genBody").innerHTML = '<label class="f">名称</label><input class="f" id="ptVal" value="' + esc(def || "") + '">' +

      '<div class="form-actions"><button class="btn-cancel" id="ptCancel">取消</button><button class="btn-save" id="ptOk">确定</button></div>';

    openSheet("sheetGen");

    $("ptCancel").onclick = function () { openFilter(); };

    $("ptOk").onclick = function () { var v = ($("ptVal").value || "").trim(); cb(v); };

  }

  window.addOffice = function () { promptText("添加管理所", "", function (v) {

    if (!v) { openFilter(); return; }

    v = normOffice(v) || v;

    if (officeOptions().indexOf(v) >= 0) { toast("该管理所已存在"); openFilter(); return; }

    var list = getCustomOffices(); list.push(v); setCustomOffices(list);

    toast("已添加管理所：" + v); openFilter();

  }); };

  window.renameOffice = function () { promptText("改名管理所·原名称", "", function (old) {

    if (!old) { openFilter(); return; }

    old = normOffice(old) || old;

    if (officeOptions().indexOf(old) < 0) { toast("未找到该管理所"); openFilter(); return; }

    promptText("改名管理所·新名称（" + old + "）", old, function (nv) {

      if (!nv) { openFilter(); return; }

      nv = normOffice(nv) || nv;

      if (old === nv) { openFilter(); return; }

      commitRenameOffice(old, nv);

    });

  }); };

  function commitRenameOffice(old, nv) {

    var aff = BUILDINGS.filter(function (b) { return normOffice(b.office) === old; });

    if (!aff.length) { applyCustomOfficeRename(old, nv); openFilter(); return; }

    ask("改名将影响建筑物", "将把以下 " + aff.length + " 个建筑物的管理所「" + old + "」改为「" + nv + "」：\n\n" +

      aff.slice(0, 40).map(function (b) { return "· " + b.name; }).join("\n") + (aff.length > 40 ? "\n…（其余略）" : ""),

      [{ t: "确认改名", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }],

      function (ok) { if (ok) { aff.forEach(function (b) { b.office = nv; }); applyCustomOfficeRename(old, nv); save(); toast("已改名：" + old + " → " + nv); } openFilter(); });

  }

  function applyCustomOfficeRename(old, nv) {

    var list = getCustomOffices(); var i = list.indexOf(old); if (i >= 0) list[i] = nv; setCustomOffices(list);

  }

  window.addStation = function () { promptText("添加管理站", "", function (v) {

    if (!v) { openFilter(); return; }

    if (stationOptions().indexOf(v) >= 0) { toast("该管理站已存在"); openFilter(); return; }

    var list = getCustomStations(); list.push(v); setCustomStations(list);

    toast("已添加管理站：" + v); openFilter();

  }); };

  window.renameStation = function () { promptText("改名管理站·原名称", "", function (old) {

    if (!old) { openFilter(); return; }

    if (stationOptions().indexOf(old) < 0) { toast("未找到该管理站"); openFilter(); return; }

    promptText("改名管理站·新名称（" + old + "）", old, function (nv) {

      if (!nv) { openFilter(); return; }

      if (old === nv) { openFilter(); return; }

      commitRenameStation(old, nv);

    });

  }); };

  function commitRenameStation(old, nv) {

    var aff = BUILDINGS.filter(function (b) { return (b.station || "") === old; });

    if (!aff.length) { var l = getCustomStations(); var i = l.indexOf(old); if (i >= 0) l[i] = nv; setCustomStations(l); openFilter(); return; }

    ask("改名将影响建筑物", "将把以下 " + aff.length + " 个建筑物的管理站「" + old + "」改为「" + nv + "」：\n\n" +

      aff.slice(0, 40).map(function (b) { return "· " + b.name; }).join("\n") + (aff.length > 40 ? "\n…（其余略）" : ""),

      [{ t: "确认改名", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }],

      function (ok) { if (ok) { aff.forEach(function (b) { b.station = nv; }); var l = getCustomStations(); var i = l.indexOf(old); if (i >= 0) l[i] = nv; setCustomStations(l); save(); toast("已改名：" + old + " → " + nv); } openFilter(); });

  }

  // 筛选关键词历史（可开收）

  function pushKeywordHistory(t) {

    t = (t || "").trim(); if (!t) return;

    var list = getKwHist().filter(function (h) { return h !== t; });

    list.unshift(t); if (list.length > 20) list = list.slice(0, 20);

    try { localStorage.setItem("filterKeywordHistory", JSON.stringify(list)); } catch (e) {}

  }

  function getKwHist() { try { return JSON.parse(localStorage.getItem("filterKeywordHistory") || "[]"); } catch (e) { return []; } }

  window.toggleKwHist = function () {

    var box = $("kwHistBox"); if (!box) return;

    var open = box.style.display !== "none";

    box.style.display = open ? "none" : "";

    var tg = $("kwHistToggle"); if (tg) tg.textContent = open ? "▸" : "▾";

    if (!open) renderKwHist();

  };

  function renderKwHist() {

    var box = $("kwHistBox"); if (!box) return;

    var list = getKwHist();

    if (!list.length) { box.innerHTML = '<div style="font-size:12px;color:#aaa">暂无历史关键词</div>'; return; }

    box.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:6px">' + list.map(function (h) {

      return '<span class="kwh" data-kw="' + esc(h) + '">' + esc(h) + "</span>";

    }).join("") + "</div>";

    box.querySelectorAll("[data-kw]").forEach(function (el) {

      el.onclick = function () {

        var v = el.getAttribute("data-kw");

        filters.text = v;

        var ft = $("filterText"); if (ft) ft.value = v;

        var sb = $("search"); if (sb) sb.value = v;

        saveDefaultFilter(); scheduleRender(); updateFilterCount();

      };

    });

  }

  // 多匹配结果展示：每个命中建筑替换为倒水滴高亮标记 + 虚线圈刚好罩住全部 + 适配视图

  // v3.22：圈选加动画——倒水滴错峰淡入缩放、虚线圈“由内向外展开”+“行进蚂蚁”描边、平滑飞入、居中“命中 N 个”徽标

  // v3.24：颜色按来源区分——筛选=浅蓝，查询=绿（color 参数：'blue' | 'green'，缺省绿色）

  var FILTER_CIRCLE_COLORS = {

    blue:  { stroke: "#4aa3e0", fill: "#4aa3e0" },

    green: { stroke: "#2e8b57", fill: "#2e8b57" }

  };

  function showFilterResult(matched, color) {

    var c = FILTER_CIRCLE_COLORS[color] || FILTER_CIRCLE_COLORS.green;

    if (!filterLayer) filterLayer = L.layerGroup().addTo(map);

    filterLayer.clearLayers();

    var pts = [];

    var idx = 0;

    function markDrop(marker) {

      marker.addTo(filterLayer);

      // 错峰动画延迟，让多个标记依次“落”下来

      var inner = marker._icon && marker._icon.querySelector(".fd-anim");

      if (inner) inner.style.animationDelay = (idx * 55) + "ms";

      idx++;

    }

    matched.forEach(function (b) {

      var lat, lon;

      if (b.geom === "Line" && b.line && b.line.length) {

        b.line.forEach(function (c) { pts.push([c[1], c[0]]); });

        var mid = b.line[Math.floor(b.line.length / 2)];

        lat = mid[1]; lon = mid[0];

        var hl = L.marker([lat, lon], { icon: makeFilterIcon() }).bindPopup(function () { return popupHtml(b); });

        markDrop(hl);

      } else if (b.lat != null && b.lon != null) {

        lat = b.lat; lon = b.lon; pts.push([lat, lon]);

        var m = L.marker([lat, lon], { icon: makeFilterIcon() }).bindPopup(function () { return popupHtml(b); });

        markDrop(m);

        if (MARKERS[b.id]) { m.on("click", function () { if (MARKERS[b.id]) MARKERS[b.id].openPopup(); }); }

      }

    });

    if (!pts.length) return;

    var bounds = L.latLngBounds(pts);

    var center = bounds.getCenter();

    // 半径：到最远点的直线距离 + 余量，确保虚线圈“刚好”罩住所有建筑

    var maxDist = 0;

    pts.forEach(function (p) { var d = center.distanceTo(L.latLng(p)); if (d > maxDist) maxDist = d; });

    var radius = Math.max(maxDist + 200, 300);

    // 先以最终半径创建（保证 fitBounds 取正确范围），再补“行进蚂蚁”动画 className

    // 颜色按调用方来源：筛选=浅蓝 #4aa3e0，查询=主题绿 #2e8b57

    var circle = L.circle(center, {

      radius: radius, color: c.stroke, weight: 2, dashArray: "7,8",

      fillColor: c.fill, fillOpacity: 0.06, className: "filter-circle"

    }).addTo(filterLayer);

    // 平滑飞入到圈选范围

    map.fitBounds(circle.getBounds(), { padding: [40, 40], animate: true, duration: 0.6 });

    // 由内向外展开动画（半径 0 → 目标）

    animateCircleRadius(circle, 0, radius, 700);

    // 居中弹出“命中 N 个”徽标

    showFilterBadge(matched.length);

  }

  // 圆形半径缓动展开（easeOutCubic）

  function animateCircleRadius(circle, from, to, dur) {

    if (typeof requestAnimationFrame !== "function") { circle.setRadius(to); return; }

    circle.setRadius(from);

    var t0 = null;

    function frame(ts) {

      if (t0 === null) t0 = ts;

      var k = Math.min((ts - t0) / dur, 1);

      var e = 1 - Math.pow(1 - k, 3);

      circle.setRadius(from + (to - from) * e);

      if (k < 1) requestAnimationFrame(frame);

      else circle.setRadius(to);

    }

    requestAnimationFrame(frame);

  }

  // 圈选命中数居中徽标：淡入放大后自动淡出

  function showFilterBadge(n) {

    var old = document.getElementById("filterBadge");

    if (old && old.parentNode) old.parentNode.removeChild(old);

    var el = document.createElement("div");

    el.id = "filterBadge";

    el.className = "filter-badge";

    el.textContent = "命中 " + n + " 个";

    var pane = map.getContainer();

    pane.appendChild(el);

    setTimeout(function () { el.classList.add("show"); }, 30);

    setTimeout(function () { el.classList.remove("show"); }, 1900);

    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2500);

  }



  // v3.24：主界面「查询」确认——与筛选确认同一套结果处理：0 提示 / 1 定位 / 多结果绿色虚线圈选

  // （顶栏「🔍 查询」按钮、搜索框回车键 均触发本函数）


  /* ---------- v3.48 智能查询后续操作 ---------- */
  window.furtherQuery = function (q) {
    filters.text = (q || "").trim();
    var sb = $("search"); if (sb) sb.value = filters.text;
    var ft = $("filterText"); if (ft) ft.value = filters.text;
    saveDefaultFilter();
    if (typeof window.doQueryConfirm === "function") window.doQueryConfirm();
    else if (typeof window.applyFilterAndJump === "function") window.applyFilterAndJump();
  };
  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return true; } } catch (e) {}
    try { var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select(); var ok = document.execCommand("copy"); document.body.removeChild(ta); return ok; } catch (e) { return false; }
  }
  function renderQueryFurther(matched, kw) {
    var box = $("queryFurther");
    if (!box) {
      var holder = $("search");
      if (!holder || !holder.parentNode) return;
      box = document.createElement("div"); box.id = "queryFurther"; box.className = "qf-box";
      holder.parentNode.insertBefore(box, holder.nextSibling);
    }
    box.innerHTML = "";
    if (!matched || !matched.length) return;
    var dims = {};
    function bump(dim, val) { if (!val) return; val = String(val); if (kw && val.indexOf(kw) >= 0) return; var k = dim + "\u0001" + val; if (!dims[k]) dims[k] = { dim: dim, val: val, n: 0 }; dims[k].n++; }
    matched.forEach(function (b) {
      bump("管理单位", b.office); bump("管理站", b.station); bump("类型", b.btype);
      bump("省份", b.province); bump("城市", b.city); bump("类别", b.type); bump("年代", b.dynasty); bump("级别", b.level);
      (b.attrs || []).forEach(function (a) { if (a && a[0]) bump(a[0], a[1]); });
    });
    var arr = Object.keys(dims).map(function (k) { return dims[k]; }).filter(function (d) { return d.n >= 2; });
    arr.sort(function (a, b) { return b.n - a.n; });
    if (arr.length > 8) arr = arr.slice(0, 8);
    if (!arr.length) return;
    var hint = document.createElement("div"); hint.className = "qf-hint";
    hint.innerHTML = "💡 进一步查询（智能推荐）：<b>单击</b>复制组合关键词，<b>双击</b>直接进一步查询。";
    box.appendChild(hint);
    var wrap = document.createElement("div"); wrap.className = "qf-chips";
    arr.forEach(function (d) {
      var q = (kw ? kw + " " : "") + d.val;
      var c = document.createElement("span"); c.className = "qf-chip";
      c.innerHTML = '<span class="qf-dim">' + esc(d.dim) + "</span>" + esc(d.val) + '<span class="n">' + d.n + "</span>";
      c.title = "单击复制查询「" + q + "」；双击直接进一步查询";
      c.addEventListener("click", function () { copyText(q); toast("已复制查询关键词：「" + q + "」（粘贴到查询框按确定即可查询）"); });
      c.addEventListener("dblclick", function (e) { e.preventDefault(); window.furtherQuery(q); });
      wrap.appendChild(c);
    });
    box.appendChild(wrap);
  }
  /* v3.48 智能查询后续操作：样式运行时注入（幂等） */
  (function () {
    if (document.getElementById("qf-style")) return;
    var s = document.createElement("style"); s.id = "qf-style";
    s.textContent = '.qf-box{margin-top:8px}.qf-hint{font-size:12px;color:#888;margin:4px 0 6px;line-height:1.5}.qf-chips{display:flex;flex-wrap:wrap;gap:6px}.qf-chip{cursor:pointer;user-select:none;padding:5px 10px;border:1px solid var(--border,rgba(0,0,0,.15));border-radius:14px;background:rgba(33,150,243,.08);font-size:13px;transition:background .15s}.qf-chip:hover{background:rgba(33,150,243,.18)}.qf-chip .n{color:#1976d2;font-weight:600;margin-left:4px}.qf-dim{opacity:.7;margin-right:2px}';
    (document.head || document.documentElement).appendChild(s);
  })();
  window.doQueryConfirm = function () {

    var sb = $("search");

    var kw = (sb ? sb.value.trim() : "") || ($("filterText") ? $("filterText").value.trim() : "");

    if (!kw) {

      toast("请输入查询关键词");

      if (sb) { sb.focus(); sb.select(); }

      return;

    }

    filters.text = kw;

    saveDefaultFilter(); // v3.38：查询确认写回默认值

    var matched = BUILDINGS.filter(passFilter);

    var cond = "查询关键词：" + kw;

    if (!matched.length) {

      ask("没有符合条件的建筑",

        "没有符合条件的建筑。\n\n当前条件：" + cond + "\n\n请换一个关键词重试。",

        [{ t: "知道了", cls: "btn-confirm2", v: 1 }],

        function () { if (sb) { sb.focus(); sb.select(); } });

      return;   // 保留关键词与搜索框，便于就地修改

    }

    closeSheet("sheetGen");

    render();

    if (matched.length === 1) {

      appFly(matched[0].id);

      toast("唯一匹配：" + matched[0].name + "，已定位");

    } else {

      showFilterResult(matched, "green");

      toast("查询命中 " + matched.length + " 个建筑，已用绿色虚线圈选（" + cond + "）");

    }

    renderQueryFurther(matched, kw);  // v3.48：命中多结果时给出进一步查询建议
  };



  /* ---------- 添加模式 ---------- */

  function toggleAdd() {

    if (measureMode) toggleMeasure();

    if (coordPickMode) { coordPickMode = false; map._container.style.cursor = ""; }

    addMode = !addMode;

    $("hintAdd").classList.toggle("show", addMode);

    $("btnMenu").textContent = addMode ? "☰ 取消添加" : "☰ 菜单";

    if (addMode) toast("点击地图放置新建筑物");

  }



  /* ---------- 增删改表单 ---------- */

  function openEdit(b) {

    editing = b;

    var offices = officeOptions();

    // v3.24：类型下拉走规范清单；若当前建筑是历史遗留的非规范类型，也保留该选项，

    // 避免打开编辑后类型被静默改写（数据安全优先）

    var types = canonicalTypes().filter(function (t) { return t !== "其他"; });

    if (b.btype && types.indexOf(b.btype) < 0) types.unshift(b.btype);

    function opt(arr, cur) {

      return arr.map(function (v) { return '<option' + (v === cur ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("");

    }

    var photosHtml = (function () {

      var arr = b.photos || [];

      var maxShow = 24, out = "";

      var shown = Math.min(arr.length, maxShow);

      for (var i = 0; i < shown; i++) {

        var p = arr[i], src = photoSrc(p);

        out += '<div class="photo-card"><button class="rm" data-pi="' + i + '">×</button>' +

          '<img src="' + esc(src) + '"><input value="' + esc(p.caption || "") + '" placeholder="如正面" data-cap="' + i + '"></div>';

      }

      if (arr.length > maxShow) out += '<div style="grid-column:1/-1;color:#888;font-size:12px">仅显示前 ' + maxShow + ' 张（共 ' + arr.length + ' 张，可在弹窗逐张查看）</div>';

      return out;

    })();

    var kv = (b.attrs || []).map(function (a, i) {

      return '<div class="kv-row"><input value="' + esc(a[0]) + '" placeholder="参数名" data-kk="' + i + '">' +

        '<input value="' + esc(a[1]) + '" placeholder="参数值" data-vv="' + i + '">' +

        '<button class="delkv" data-di="' + i + '">×</button></div>';

    }).join("");

    $("editTitle").textContent = b._new ? "新增建筑物" : "修改：" + b.name;

    var offOpts = offices.slice(); if (offOpts.indexOf(b.office) < 0) offOpts.unshift(b.office || "");

    var staOpts = stationOptions().slice(); if (staOpts.indexOf(b.station) < 0) staOpts.unshift(b.station || "");

    $("editBody").innerHTML =

      '<label class="f">名称</label><input class="f" id="fName" value="' + esc(b.name) + '">' +

      '<label class="f">管理所</label><select class="f" id="fOffice">' + opt(offOpts, b.office) + "</select>" +

      '<label class="f">管理站</label><select class="f" id="fStation">' + opt(staOpts, b.station) + "</select>" +

      '<label class="f">段</label><input class="f" id="fChan" value="' + esc(b.chan) + '">' +

      '<label class="f">建筑物类型</label><input class="f" id="fType" list="dlType" value="' + esc(b.btype) + '"><datalist id="dlType">' + opt(types, b.btype) + "</datalist>" +

      '<label class="f">经度</label><input class="f" id="fLon" value="' + (b.lon != null ? b.lon : "") + '">' +

      '<label class="f">纬度</label><input class="f" id="fLat" value="' + (b.lat != null ? b.lat : "") + '">' +

      '<label class="f">参数（逐行 名称/值，可增删）</label><div id="kvBox">' + kv + "</div>" +

      '<button class="tbtn" style="margin-top:6px" onclick="appAddKv()">+ 增加参数</button>' +

      '<label class="f">照片（可多张：正面/背面/侧面…）</label>' +

      '<input type="file" id="fPhotos" accept="image/*" multiple>' +

      '<div class="photo-grid" id="phGrid">' + photosHtml + "</div>" +

      '<div class="form-actions">' +

      (b._new ? "" : '<button class="btn-danger" onclick="appDel(\'' + esc(b.id) + '\')">删除</button>') +

      '<button class="btn-cancel" onclick="closeSheet(\'sheetEdit\')">取消</button>' +

      '<button class="btn-save" onclick="appSave()">保存</button></div>';

    // 绑定照片删除/说明

    $("editBody").querySelectorAll(".photo-card .rm").forEach(function (btn) {

      btn.onclick = function () { b.photos.splice(+btn.dataset.pi, 1); openEdit(b); };

    });

    $("editBody").querySelectorAll("input[data-cap]").forEach(function (inp) {

      inp.onchange = function () { b.photos[+inp.dataset.cap].caption = inp.value; };

    });

    $("editBody").querySelectorAll(".delkv").forEach(function (btn) {

      btn.onclick = function () { b.attrs.splice(+btn.dataset.di, 1); openEdit(b); };

    });

    // 照片网格局部刷新（v3.30.2 关键修复）：只更新 phGrid，不重建 input.f 元素，

    // 否则 WebView 自动填充对勾等已识别状态会随 DOM 重建丢失。

    function renderPhotoGrid() {

      var grid = $("phGrid"); if (!grid) { openEdit(b); return; } // 兜底：极端情况下才整段重建

      grid.innerHTML = buildPhotosHtml(b);

      bindPhotoCardEvents();

    }

    function buildPhotosHtml(b2) {

      var arr = b2.photos || [];

      var maxShow = 24, out = "";

      var shown = Math.min(arr.length, maxShow);

      for (var i = 0; i < shown; i++) {

        var p = arr[i], src = photoSrc(p);

        out += '<div class="photo-card"><button class="rm" data-pi="' + i + '">×</button>' +

          '<img src="' + esc(src) + '"><input value="' + esc(p.caption || "") + '" placeholder="如正面" data-cap="' + i + '"></div>';

      }

      if (arr.length > maxShow) out += '<div style="grid-column:1/-1;color:#888;font-size:12px">仅显示前 ' + maxShow + ' 张（共 ' + arr.length + ' 张，可在弹窗逐张查看）</div>';

      return out;

    }

    function bindPhotoCardEvents() {

      $("editBody").querySelectorAll(".photo-card .rm").forEach(function (btn) {

        btn.onclick = function () { b.photos.splice(+btn.dataset.pi, 1); renderPhotoGrid(); };

      });

      $("editBody").querySelectorAll("input[data-cap]").forEach(function (inp) {

        inp.onchange = function () { b.photos[+inp.dataset.cap].caption = inp.value; };

      });

    }

    // 绑定照片卡片（首次渲染由 openEdit 重建 editBody 后立即调用）

    bindPhotoCardEvents();

    // v3.31 #281：表单文本实时落盘到 editing，避免「+增加参数」等重建表单时丢失已填内容

    ["fName", "fOffice", "fStation", "fChan", "fType", "fLon", "fLat"].forEach(function (id) {

      var el = $(id); if (!el) return;

      el.oninput = flushEditFields; el.onchange = flushEditFields;

    });

    $("fPhotos").onchange = function () {

      var files = this.files;

      Array.prototype.forEach.call(files, function (file) {

        var r = new FileReader();

        r.onload = function () {

          // v3.31：>1.5M 的照片先压缩（canvas，按会话偏好）再落盘，只存压缩版

          compressDataUrlIfBig(r.result, function (d) {

            var rel = "";

            try { if (window.Android && typeof window.Android.storePhoto === "function") rel = window.Android.storePhoto(b.id, file.name, d); } catch (e) {}

            if (rel) b.photos.push({ file: rel, caption: "", added: Date.now() });

            else b.photos.push({ data: d, caption: "", added: Date.now() });

            renderPhotoGrid();

          });

        };

        r.readAsDataURL(file);

      });

    };

    openSheet("sheetEdit");

  }

  window.appAddKv = function () { flushEditFields(); editing.attrs.push(["", ""]); openEdit(editing); };

  window.appSave = function () {

    var b = editing;

    b.name = $("fName").value.trim() || "未命名";

    b.office = $("fOffice").value.trim();

    b.station = $("fStation").value.trim();

    b.chan = $("fChan").value.trim();

    b.btype = $("fType").value.trim() || "其他";

    var lon = parseFloat($("fLon").value), lat = parseFloat($("fLat").value);

    if (!isNaN(lon) && !isNaN(lat)) { b.lon = lon; b.lat = lat; b.geom = "Point"; }

    // attrs from inputs

    b.attrs = [];

    $("editBody").querySelectorAll(".kv-row").forEach(function (row) {

      var k = row.querySelector("[data-kk]").value.trim();

      var v = row.querySelector("[data-vv]").value.trim();

      if (k) b.attrs.push([k, v]);

    });

    if (b._new) { delete b._new; BUILDINGS.push(b); }

    save(); render(); closeSheet("sheetEdit"); toast("已保存");

  };

  window.appEdit = function (id) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (b) openEdit(b);

  };

  window.appDel = function (id) {

    ask("删除建筑物", "确定删除该建筑物？此操作<b>不可恢复</b>。",

      [{ t: "删除", cls: "btn-exit", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }],

      function (ok) {

        if (!ok) return;

        BUILDINGS = BUILDINGS.filter(function (x) { return x.id !== id; });

        save(); render(); closeSheet("sheetEdit"); toast("已删除");

      });

  };

  // v3.31 #281：把表单文本实时写回 editing，避免任何重建 editBody 的操作（如 +增加参数）丢失已填内容

  function flushEditFields() {

    if (!editing) return;

    var g = function (id) { var el = $(id); return el ? el.value : undefined; };

    if (g("fName") != null) editing.name = g("fName");

    if (g("fOffice") != null) editing.office = g("fOffice");

    if (g("fStation") != null) editing.station = g("fStation");

    if (g("fChan") != null) editing.chan = g("fChan");

    if (g("fType") != null) editing.btype = g("fType");

    var lon = parseFloat(g("fLon")), lat = parseFloat(g("fLat"));

    if (!isNaN(lon) && !isNaN(lat)) { editing.lon = lon; editing.lat = lat; editing.geom = "Point"; }

  }

  /* ---------- 导航 ---------- */

  window.appNav = function (id) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b) return;

    var lat, lon, name;

    if (b.geom === "Line" && b.line && b.line.length) {

      var mid = b.line[Math.floor(b.line.length / 2)];

      lon = mid[0]; lat = mid[1]; name = b.name;

    } else if (b.lat != null && b.lon != null) {

      lat = b.lat; lon = b.lon; name = b.name;

    } else { toast("该建筑物无坐标信息"); return; }

    // 使用 geo: URI，系统会弹出已安装的导航App供选择（高德/百度/腾讯等）

    // 注意：标签名(name)不要再做 URL 编码——Android WebView 把编码后的 %XX 原样传给地图App，

    // 导致在地图App里看到“%E5%B3%B0%E5%B1%B1...”这样的乱码。直接传原始中文即可正常显示。

    var geoUrl = "geo:" + lat + "," + lon + "?q=" + lat + "," + lon + "(" + name + ")";

    if (window.Android && typeof window.Android.openExternal === "function") {

      window.Android.openExternal(geoUrl);

    } else {

      // 浏览器环境：尝试直接打开

      window.open(geoUrl, "_blank");

    }

    toast("正在打开导航…");

  };



  window.appClosePopup = function () { map.closePopup(); };

  // 通用文本复制：Web 端剪贴板 API 在非安全上下文 / 失焦时可能静默失败，

  // 故先尝试 navigator.clipboard.writeText（带 .catch 兜底），失败再回退到

  // 临时 textarea + execCommand。确保「复制坐标」「复制分享文字」在离线 WebView 中可用。

  window.copyText = function (text, okMsg) {

    function fb() {

      try {

        var ta = document.createElement("textarea");

        ta.value = text;

        ta.style.position = "fixed"; ta.style.top = "-9999px"; ta.style.opacity = "0";

        document.body.appendChild(ta); ta.focus(); ta.select();

        var ok = false;

        try { ok = document.execCommand("copy"); } catch (e) {}

        document.body.removeChild(ta);

        return ok;

      } catch (e) { return false; }

    }

    if (navigator.clipboard && navigator.clipboard.writeText) {

      try {

        var p = navigator.clipboard.writeText(text);

        if (p && p.then) {

          p.then(function () { toast(okMsg || ("已复制：" + text)); })

           .catch(function () { toast(fb() ? (okMsg || ("已复制：" + text)) : ("复制失败：" + text)); });

          return;

        }

      } catch (e) { /* 落到下面的回退 */ }

    }

    toast(fb() ? (okMsg || ("已复制：" + text)) : ("复制失败：" + text));

  };

  window.copyCoord = function (lat, lon) {

    window.copyText(lat.toFixed(6) + "," + lon.toFixed(6));

  };

  // 在地图上查看：inline onclick 中无法访问 IIFE 作用域内的 map（会被解析到 <div id="map"> 元素，

  // 导致 “map.setView is not a function”）。统一走全局包装函数操作真实地图实例。

  window.appGoToMap = function (lat, lon, zoom, sheetId) {

    if (sheetId) closeSheet(sheetId);

    map.setView([lat, lon], zoom || 16);

  };



  /* ---------- 列表视图 ---------- */

  function toggleList() {

    listMode = !listMode;

    $("listView").style.display = listMode ? "block" : "none";

    $("map").style.display = listMode ? "none" : "block";

    var bs = $("baseSwitcher"); if (bs) bs.style.display = listMode ? "none" : "block";

    var lg = $("legend"); if (lg) lg.style.display = listMode ? "none" : "block";

    var hm = $("hintMeasure"); if (hm) hm.style.display = listMode ? "none" : "";

    if (listMode) renderList();

    else { setTimeout(function(){ map.invalidateSize(); }, 100); }

  }

  // 暴露到全局：列表视图内的「✕ 退出列表」按钮使用 inline onclick="toggleList()"，

  // 必须在全局作用域可访问（否则报 “toggleList is not defined”）。

  window.toggleList = toggleList;

  function renderList() {

    var html = '<div class="list-head"><span>📋 列表视图</span>' +

      '<button class="btn-cancel" onclick="toggleList()">✕ 退出列表</button></div>';

    var rows = BUILDINGS.filter(passFilter);

    if (!rows.length) html += "<p style='padding:20px;color:#888'>无匹配结果</p>";

    rows.forEach(function (b) {

      html += '<div class="list-card" data-id="' + esc(b.id) + '"><span class="go" onclick="appFly(\'' + esc(b.id) + '\')">快速定位 ›</span>' +

        "<h3>" + esc(b.name) + "</h3>" +

        '<div class="meta">' + esc(b.office) + " · " + esc(b.btype) + (b.station ? " · " + esc(b.station) : "") + ((b.inspections || []).length ? " · 已巡视" + b.inspections.length : "") + "</div></div>";

    });

    $("listView").innerHTML = html;

  }

  window.appFly = function (id) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b) return;

    // 计算目标坐标：点要素直接取 lat/lon；线要素取中点

    var flyLat, flyLon;

    if (b.geom === "Line" && b.line && b.line.length) {

      var mid = b.line[Math.floor(b.line.length / 2)];

      flyLon = mid[0]; flyLat = mid[1];

    } else if (b.lat != null && b.lon != null) {

      flyLat = b.lat; flyLon = b.lon;

    } else {

      toast("该建筑物无坐标信息");

      return;

    }

    listMode = false; $("listView").style.display = "none"; $("map").style.display = "block";

    // 切换容器显示后必须调用 invalidateSize，否则 Leaflet 不渲染

    setTimeout(function () {

      map.invalidateSize();

      map.setView([flyLat, flyLon], 16);

      if (MARKERS[b.id]) {

        MARKERS[b.id].openPopup();

      } else if (LINES[b.id]) {

        LINES[b.id].openPopup();

      }

    }, 150);

  };



  /* ---------- 定位 ---------- */

  var myLocationMarker = null;

  function locateMe() {

    if (!navigator.geolocation) { toast("设备不支持定位"); return; }

    toast("正在定位…");

    navigator.geolocation.getCurrentPosition(function (p) {

      var lat = p.coords.latitude, lon = p.coords.longitude;

      map.setView([lat, lon], 15);

      if (myLocationMarker) map.removeLayer(myLocationMarker);

      myLocationMarker = L.circleMarker([lat, lon], {

        radius: 10, color: "#e8a33d", fillColor: "#e8a33d", fillOpacity: 0.9, weight: 3

      }).addTo(map).bindPopup("我的位置（" + lat.toFixed(6) + ", " + lon.toFixed(6) + "）").openPopup();

      toast("定位成功");

    }, function (err) {

      if (err.code === err.PERMISSION_DENIED) {

        toast("定位权限未授权，正在跳转设置…");

        // 跳转系统定位设置页

        if (window.Android && typeof window.Android.openLocationSettings === "function") {

          setTimeout(function () { window.Android.openLocationSettings(); }, 1200);

        }

      } else if (err.code === err.TIMEOUT) {

        toast("定位超时，请重试");

      } else {

        toast("定位失败：" + (err.message || "未知错误"));

      }

    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });

  }



  /* ---------- 测距 ---------- */

  var measureMode = false;

  var measurePoints = [];

  var measureLayer = null;

  var measureMarkers = [];

  var measureTooltips = [];



  function toggleMeasure() {

    measureMode = !measureMode;

    if (measureMode) {

      measurePoints = [];

      addMode = false;

      coordPickMode = false;

      $("hintAdd").classList.remove("show");

      $("btnMenu").textContent = "☰ 结束测距";

      toast("测距模式：依次点击地图上的点，双击或点「结束测距」结束");

      $("hintMeasure").classList.add("show");

      map._container.style.cursor = "crosshair";

      map.doubleClickZoom.disable();

    } else {

      clearMeasure();

      $("btnMenu").textContent = "☰ 菜单";

      $("hintMeasure").classList.remove("show");

      map._container.style.cursor = "";

      map.doubleClickZoom.enable();

    }

  }

  function clearMeasure() {

    if (measureLayer) { map.removeLayer(measureLayer); measureLayer = null; }

    measureMarkers.forEach(function (m) { map.removeLayer(m); });

    measureMarkers = [];

    measureTooltips.forEach(function (t) { map.removeLayer(t); });

    measureTooltips = [];

    measurePoints = [];

  }

  function onMeasureClick(e) {

    if (!measureMode) return;

    measurePoints.push(e.latlng);

    // 添加点击点标记

    var dot = L.circleMarker(e.latlng, { radius: 5, color: "#e8a33d", fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);

    measureMarkers.push(dot);

    // 重绘线和距离标签

    if (measureLayer) map.removeLayer(measureLayer);

    measureTooltips.forEach(function (t) { map.removeLayer(t); });

    measureTooltips = [];

    if (measurePoints.length >= 2) {

      measureLayer = L.polyline(measurePoints, { color: "#e8a33d", weight: 3, dashArray: "6,4" }).addTo(map);

      var total = 0;

      for (var i = 1; i < measurePoints.length; i++) {

        var d = measurePoints[i - 1].distanceTo(measurePoints[i]);

        total += d;

        var mid = L.latLng((measurePoints[i - 1].lat + measurePoints[i].lat) / 2, (measurePoints[i - 1].lng + measurePoints[i].lng) / 2);

        var segLabel = L.marker(mid, { icon: L.divIcon({ className: "measure-tip", html: '<span style="background:#16324f;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;white-space:nowrap">' + fmtDist(d) + '</span>', iconSize: [60, 16], iconAnchor: [30, 8] }) }).addTo(map);

        measureTooltips.push(segLabel);

      }

      // 总距离标签

      var lastPt = measurePoints[measurePoints.length - 1];

      var totalLabel = L.marker(lastPt, { icon: L.divIcon({ className: "measure-tip", html: '<span style="background:#e8a33d;color:#16324f;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap">总计 ' + fmtDist(total) + '</span>', iconSize: [100, 20], iconAnchor: [50, -12] }) }).addTo(map);

      measureTooltips.push(totalLabel);

    }

  }

  function fmtDist(d) {

    if (d < 1000) return Math.round(d) + " m";

    return (d / 1000).toFixed(2) + " km";

  }

  // 绑定测距点击（在 initMap 的 click handler 中调用）

  // 双击结束测距（在 initMap 中绑定）

  window.appFinishMeasure = function () { if (measureMode) toggleMeasure(); };



  /* ---------- 周边搜索（v3.41：中心支持 建筑物/当前位置/地图选点；周边可按类型筛选）---------- */

  var nearbyPickMode = false;

  var nearbyCenter = null;   // {lat, lon, label}

  var nearbyPicked = null;   // 地图选点后回填，重开面板用

  function nearbySearch(restore) {

    var bpts = BUILDINGS.filter(function (b) { return b.lat != null; });

    var typeChips = canonicalTypes().map(function (t) {

      // v3.43：周边搜索类型筛选 chip 高亮用 .on 类（蓝色底）

      return '<span class="chip nbtype ntype" data-t="' + esc(t) + '" style="cursor:pointer;user-select:none">' + esc(t) + "</span>";

    }).join("");

    var html =

      '<div style="display:flex;gap:6px;margin-bottom:10px">' +

        '<button class="seg" data-m="b">选建筑物</button>' +

        '<button class="seg" data-m="gps">当前位置</button>' +

        '<button class="seg" data-m="map">地图选点</button>' +

      '</div>' +

      '<div id="nbBWrap"><label class="f">中心建筑物</label><select class="f" id="nearbyCenter">' +

        bpts.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join("") +

      '</select></div>' +

      '<div id="nbGwrap" style="display:none"><button class="tbtn" style="width:100%" onclick="nbGetGPS()">📡 获取当前定位</button><div id="nbGpsStatus" style="font-size:12px;color:#888;margin-top:6px"></div></div>' +

      '<div id="nbMwrap" style="display:none"><button class="tbtn" style="width:100%" onclick="nbPickMap()">👆 点地图选中心点</button><div id="nbMapStatus" style="font-size:12px;color:#888;margin-top:6px"></div></div>' +

      '<label class="f">搜索半径（米）</label><input class="f" type="number" id="nearbyRadius" value="1000" min="50" max="50000">' +

      '<label class="f">周边建筑物类型（可选，留空=全部）</label><div class="chips" id="nbTypes">' + typeChips + '</div>' +

      '<div class="form-actions"><button class="btn-save" onclick="appDoNearby()">搜索</button></div>' +

      '<div id="nearbyResult" style="margin-top:12px"></div>';

    $("genTitle").textContent = "周边搜索";

    $("genBody").innerHTML = html;

    // v3.43：周边建筑物类型 chip → toggle .on（蓝色背景）；事件 stopPropagation 防止误触模式按钮

    $("genBody").querySelectorAll(".nbtype").forEach(function (el) {

      el.onclick = function (ev) { ev.stopPropagation(); el.classList.toggle("on"); toast(el.classList.contains("on") ? ("✅ 已选 " + el.dataset.t) : ("已取消 " + el.dataset.t)); };

    });

    function setMode(m) {

      $("genBody").querySelectorAll(".seg").forEach(function (s) { s.classList.toggle("on", s.dataset.m === m); });

      $("nbBWrap").style.display = m === "b" ? "" : "none";

      $("nbGwrap").style.display = m === "gps" ? "" : "none";

      $("nbMwrap").style.display = m === "map" ? "" : "none";

      if (m !== "gps" && m !== "map") nearbyCenter = null;

    }

    $("genBody").querySelectorAll(".seg").forEach(function (el) {

      el.onclick = function () { setMode(el.dataset.m); if (el.dataset.m === "gps") nbGetGPS(); };

    });

    if (restore && nearbyPicked) {

      nearbyCenter = nearbyPicked;

      setMode("map");

      $("nbMapStatus").textContent = "已选中心：" + nearbyPicked.lat.toFixed(5) + ", " + nearbyPicked.lon.toFixed(5);

    } else {

      setMode("b");

    }

    openSheet("sheetGen");

  }

  window.nbGetGPS = function () {

    if (!navigator.geolocation) { $("nbGpsStatus").textContent = "设备不支持定位"; return; }

    $("nbGpsStatus").textContent = "正在定位…";

    navigator.geolocation.getCurrentPosition(function (p) {

      nearbyCenter = { lat: p.coords.latitude, lon: p.coords.longitude, label: "当前位置" };

      $("nbGpsStatus").textContent = "已定位：" + p.coords.latitude.toFixed(5) + ", " + p.coords.longitude.toFixed(5);

      if (myLocationMarker) map.removeLayer(myLocationMarker);

      myLocationMarker = L.circleMarker([nearbyCenter.lat, nearbyCenter.lon], { radius: 10, color: "#e8a33d", fillColor: "#e8a33d", fillOpacity: 0.9, weight: 3 }).addTo(map).bindPopup("当前位置").openPopup();

      map.setView([nearbyCenter.lat, nearbyCenter.lon], 15);

    }, function (err) { $("nbGpsStatus").textContent = "定位失败：" + (err.message || err.code); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });

  };

  window.nbPickMap = function () {

    nearbyPickMode = true;

    closeSheet("sheetGen");

    $("btnMenu").textContent = "☰ 点图选中心";

    map._container.style.cursor = "crosshair";

    toast("请在地图上点击中心点");

  };

  window.appDoNearby = function () {

    var seg = $("genBody").querySelector(".seg.on");

    var mode = seg ? seg.dataset.m : "b";

    var center = null;

    if (mode === "gps" || mode === "map") {

      if (!nearbyCenter) { toast("请先获取中心（定位或选点）"); return; }

      center = nearbyCenter;

    } else {

      var centerId = $("nearbyCenter").value;

      var cb = BUILDINGS.find(function (b) { return b.id === centerId; });

      if (!cb || cb.lat == null) { toast("中心建筑物无坐标"); return; }

      center = { lat: cb.lat, lon: cb.lon, label: cb.name };

    }

    var radius = parseFloat($("nearbyRadius").value);

    if (isNaN(radius) || radius < 50) { toast("请输入有效半径（≥50m）"); return; }

    var types = Array.from($("genBody").querySelectorAll(".ntype.on")).map(function (e) { return e.dataset.t; });

    var centerLatLng = L.latLng(center.lat, center.lon);

    var results = [];

    BUILDINGS.forEach(function (b) {

      if (b.lat == null) return;

      if (Math.abs(b.lat - center.lat) < 1e-9 && Math.abs(b.lon - center.lon) < 1e-9) return;

      if (types.length && types.indexOf(b.btype) < 0) return; // 周边类型过滤

      var d = centerLatLng.distanceTo(L.latLng(b.lat, b.lon));

      if (d <= radius) results.push({ b: b, dist: d });

    });

    results.sort(function (a, b) { return a.dist - b.dist; });

    if (window._nearbyCircle) map.removeLayer(window._nearbyCircle);

    window._nearbyCircle = L.circle([center.lat, center.lon], { radius: radius, color: "#2b8a5d", fillColor: "#2b8a5d", fillOpacity: 0.08, weight: 2, dashArray: "4,4" }).addTo(map);

    map.fitBounds(window._nearbyCircle.getBounds(), { padding: [30, 30] });

    var html = '<p style="margin:0 0 6px"><b>中心：</b>' + esc(center.label) + ' · 半径 ' + fmtDist(radius) + (types.length ? ' · 类型：' + types.join("/") : "") + '</p>';

    if (results.length === 0) {

      html += '<p style="color:#888">范围内无匹配建筑物' + (types.length ? '（已选类型：' + types.join("/") + '）' : '（按距离/类型筛选）') + '</p>';

    } else {

      html += '<p style="color:#2b8a5d;margin:0 0 6px">找到 ' + results.length + ' 个建筑物：</p>';

      results.forEach(function (r) {

        html += '<div class="list-card" style="margin-bottom:4px;padding:6px 10px">' +

          '<span class="go" onclick="appFly(\'' + esc(r.b.id) + '\')">定位 ›</span>' +

          '<span style="font-size:14px">' + esc(r.b.name) + '</span>' +

          '<span style="font-size:11px;color:#888;float:right">' + fmtDist(r.dist) + '</span>' +

          '<div class="meta">' + esc(r.b.office) + ' · ' + esc(r.b.btype) + '</div></div>';

      });

    }

    $("nearbyResult").innerHTML = html;

    toast("找到 " + results.length + " 个建筑物");

  };



  /* ---------- 获取坐标 ---------- */

  function getCoordinates() {

    var html = '<div style="margin-bottom:12px">' +

      '<button class="tbtn" style="width:100%;margin-bottom:8px;display:block" onclick="coordGetGPS()">📡 获取当前GPS坐标</button>' +

      '<button class="tbtn" style="width:100%;margin-bottom:8px;display:block" onclick="coordPickMap()">👆 点选地图获取坐标</button>' +

      '<button class="tbtn" style="width:100%;margin-bottom:8px;display:block" onclick="coordSearchBuilding()">🔍 搜索建筑物坐标</button>' +

      '</div>' +

      '<div id="coordResult" style="background:#f5f8fb;border-radius:8px;padding:12px;min-height:60px;font-size:14px;color:#555">请选择获取坐标的方式</div>';

    $("genTitle").textContent = "获取坐标";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  window.coordGetGPS = function () {

    if (!navigator.geolocation) { $("coordResult").innerHTML = "<span style='color:#c0392b'>设备不支持定位</span>"; return; }

    $("coordResult").innerHTML = "<span style='color:#888'>正在定位…</span>";

    navigator.geolocation.getCurrentPosition(function (p) {

      var lat = p.coords.latitude, lon = p.coords.longitude;

      var acc = p.coords.accuracy ? p.coords.accuracy.toFixed(0) : "?";

      $("coordResult").innerHTML =

        '<div style="font-size:16px;color:#16324f;font-weight:600;margin-bottom:8px">当前坐标</div>' +

        '<table style="width:100%;font-size:14px;border-collapse:collapse">' +

        '<tr><td style="color:#888;padding:3px 0">纬度：</td><td>' + lat.toFixed(6) + '</td></tr>' +

        '<tr><td style="color:#888;padding:3px 0">经度：</td><td>' + lon.toFixed(6) + '</td></tr>' +

        '<tr><td style="color:#888;padding:3px 0">精度：</td><td>±' + acc + ' m</td></tr>' +

        '</table>' +

        '<button class="tbtn" style="margin-top:10px;width:100%" onclick="copyCoord(' + lat + ',' + lon + ')">复制坐标</button>' +

        '<button class="tbtn" style="margin-top:6px;width:100%" onclick="appGoToMap(' + lat + ',' + lon + ',16,\'sheetGen\')">在地图上查看</button>';

      // 在地图上标记

      if (myLocationMarker) map.removeLayer(myLocationMarker);

      myLocationMarker = L.circleMarker([lat, lon], { radius: 10, color: "#e8a33d", fillColor: "#e8a33d", fillOpacity: 0.9, weight: 3 })

        .addTo(map).bindPopup("当前坐标：" + lat.toFixed(6) + ", " + lon.toFixed(6)).openPopup();

      map.setView([lat, lon], 16);

    }, function (err) {

      if (err.code === err.PERMISSION_DENIED) {

        $("coordResult").innerHTML = "<span style='color:#c0392b'>定位权限未授权</span><button class='tbtn' style='margin-top:8px;width:100%' onclick='gotoLocSettings()'>去设置开启定位</button>";

      } else {

        $("coordResult").innerHTML = "<span style='color:#c0392b'>定位失败：" + (err.message || "未知错误") + "</span>";

      }

    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });

  };

  window.gotoLocSettings = function () {

    if (window.Android && typeof window.Android.openLocationSettings === "function") {

      window.Android.openLocationSettings();

    } else { toast("请在系统设置中开启定位"); }

  };

  window.coordPickMap = function () {

    coordPickMode = true;

    closeSheet("sheetGen");

    if (listMode) toggleList();

    $("btnMenu").textContent = "☰ 取消拾取";

    map._container.style.cursor = "crosshair";

    toast("点击地图任意位置获取坐标");

  };

  window.coordSearchBuilding = function () {

    var pts = BUILDINGS.filter(function (b) { return b.lat != null; });

    var html = '<input class="f" id="coordSearchInput" placeholder="输入建筑物名称…" style="margin-bottom:8px" oninput="coordDoSearch()">' +

      '<div id="coordSearchResult" style="max-height:300px;overflow:auto"></div>';

    $("coordResult").innerHTML = html;

    // 显示全部

    window.coordDoSearch = function () {

      var q = ($("coordSearchInput") || {}).value || "";

      q = q.trim().toLowerCase();

      var matched = pts.filter(function (b) { return !q || b.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 30);

      var rh = matched.map(function (b) {

        return '<div class="list-card" style="margin-bottom:4px;padding:6px 10px;cursor:pointer" onclick="copyCoord(' + b.lat + ',' + b.lon + ')">' +

          '<span style="font-size:14px">' + esc(b.name) + '</span>' +

          '<span style="font-size:11px;color:#888;float:right">' + b.lat.toFixed(6) + ',' + b.lon.toFixed(6) + '</span>' +

          '<div class="meta">' + esc(b.office || "") + ' · ' + esc(b.btype || "") + '</div></div>';

      }).join("");

      $("coordSearchResult").innerHTML = rh || "<p style='color:#888;padding:8px'>无匹配</p>";

    };

    coordDoSearch();

  };



  /* ---------- 批量导入照片（原生大文件管线）---------- */

  function nameNoExt(n) { return String(n).replace(/\.[^.]+$/, "").trim(); }

  function batchImportPhotos() {

    var html = '<div style="font-size:14px;color:#555;margin-bottom:12px">' +

      '<p>选择来源后导入照片：支持<b>照片</b>、<b>ZIP</b>、<b>7z</b> 压缩包（可 &gt;3GB）。系统先选文件，再按文件名自动匹配建筑物。</p>' +

      '<p style="color:#888;font-size:12px">匹配：照片名（不含扩展名）与建筑物名称相等或相互包含；文件名末尾数字自动忽略（如「峰山口1.jpg」按「峰山口」匹配）。唯一匹配自动保存；多匹配弹窗勾选（可多选）。文件落盘到应用私有目录，不占 localStorage。</p>' +

      '<p style="color:#c0392b;font-size:12px;margin-top:6px">⚠ 内存较小的机器（如统信 UOS 8G）导入大体积 ZIP 可能卡死：建议改用「从安卓复制照片」直接复制文件夹，或到安卓端导入后「从安卓平台导出照片」再复制。</p></div>' +

      '<div class="imp-src-row">' +

      '<button class="imp-src" onclick="pickPhotosForImport()">' +

        '<span class="imp-ico" style="background:var(--primary-2)">📁</span>' +

        '<span class="imp-label">本地文件</span>' +

        '<span class="imp-sub">照片 / ZIP / 7z</span>' +

      '</button>' +

      '<button class="imp-src" onclick="importPhotosFromNetdisk(\'baidu\')">' +

        '<span class="imp-ico" style="background:#2e8b57">☁️</span>' +

        '<span class="imp-label">百度网盘</span>' +

        '<span class="imp-sub">分享方式导入</span>' +

      '</button>' +

      '<button class="imp-src" onclick="importPhotosFromNetdisk(\'quark\')">' +

        '<span class="imp-ico" style="background:#e6922e">☁️</span>' +

        '<span class="imp-label">夸克网盘</span>' +

        '<span class="imp-sub">分享方式导入</span>' +

      '</button>' +

      '</div>' +

      '<div id="batchPhotoResult" style="margin-top:12px"></div>';

    $("genTitle").textContent = "批量导入照片";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  // 清理导入缓存：仅删除解压临时目录（inbox/uz_*），不动用户已导入的照片数据；用于释放被多 GB 解压残留占用的空间

  window.cleanImportCache = function () {

    if (window.Android && typeof window.Android.cleanInbox === "function") {

      try { window.Android.cleanInbox(); toast("已清理导入临时文件（已导入的照片不会删除）"); }

      catch (e) { toast("清理失败：" + (e && e.message)); }

    } else {

      toast("当前环境不支持，请在安卓 App 中使用");

    }

  };

  // Req：删除添加的照片 —— 按 时间 / 管理所 过滤 → 多选 → 确认删除（含磁盘文件）

  var __delPhotosState = { days: "all", offices: new Set() };

  function deleteImportedPhotos() {

    var offices = uniq(BUILDINGS.map(function (b) { return b.office || "未设置"; }));

    __delPhotosState = { days: "all", offices: new Set() };

    function officeChips() {

      return offices.map(function (o) {

        return '<span class="chip ofchip' + (__delPhotosState.offices.has(o) ? " on" : "") + '" data-o="' + esc(o) + '">' + esc(o) + "</span>";

      }).join("");

    }

    function photoRows() {

      var rows = [];

      BUILDINGS.forEach(function (b) {

        if (__delPhotosState.offices.size && !__delPhotosState.offices.has(b.office || "未设置")) return;

        (b.photos || []).forEach(function (p, i) {

          if (!p.file) return; // 仅删除落盘的导入照片（含 added 时间戳的）

          if (__delPhotosState.days !== "all" && p.added) {

            var ageD = (Date.now() - (+p.added)) / 86400000;

            var lim = +__delPhotosState.days;

            if (ageD > lim) return;

          }

          rows.push({ bid: b.id, pi: i, bname: b.name, office: b.office || "未设置", fname: p.caption || p.file.split("/").pop(), rel: p.file, added: p.added || 0 });

        });

      });

      window.__delPhotoItems = rows;

      return rows.map(function (r, i) {

        return '<label class="del-photo-row" style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px dashed var(--border);font-size:12px">' +

          '<input type="checkbox" class="delPhChk" data-i="' + i + '" checked>' +

          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📷 ' + esc(r.fname) + ' → <b>' + esc(r.bname) + '</b> <span style="color:#888">[' + esc(r.office) + ']</span></span>' +

          '</label>';

      }).join("") || '<p style="color:#888;font-size:12px;padding:10px">当前条件下没有可删除的照片（仅含磁盘文件）</p>';

    }

    function render() {

      $("genBody").innerHTML =

        '<div class="filter-sec"><h4>时间</h4><div class="chips">' +

        [["all", "全部"], ["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"]].map(function (o) {

          return '<span class="chip daychip' + (__delPhotosState.days === o[0] ? " on" : "") + '" data-d="' + o[0] + '">' + o[1] + "</span>";

        }).join("") + '</div></div>' +

        '<div class="filter-sec"><h4>管理所</h4><div class="chips" id="dpoChips">' + officeChips() + "</div></div>" +

        '<p id="delPhCount" style="color:#555;font-size:12px;margin:6px 0"></p>' +

        '<div id="delPhList" style="max-height:50vh;overflow:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">' + photoRows() + "</div>" +

        '<div class="sel-actions">' +

          '<button class="btn-all" onclick="delPhAll()">全选</button>' +

          '<button class="btn-clear" onclick="delPhClear()">全部清除</button>' +

          '<button class="btn-cancel2" onclick="closeSheet(\'sheetGen\')">取消</button>' +

          '<button class="btn-confirm2" onclick="confirmDeletePhotos()">确认删除</button>' +

        "</div>";

      $("genBody").querySelectorAll(".daychip").forEach(function (el) {

        el.onclick = function () { __delPhotosState.days = el.dataset.d; render(); };

      });

      $("genBody").querySelectorAll(".ofchip").forEach(function (el) {

        el.onclick = function () {

          var o = el.dataset.o;

          if (__delPhotosState.offices.has(o)) __delPhotosState.offices.delete(o); else __delPhotosState.offices.add(o);

          render();

        };

      });

      var rows = window.__delPhotoItems || [];

      var checked = rows.length;

      $("delPhCount").innerHTML = "符合条件 <b>" + rows.length + "</b> 张" + (checked ? "（已默认全选）" : "");

    }

    $("genTitle").textContent = "删除添加的照片";

    render();

    openSheet("sheetGen");

  }

  window.delPhAll = function () { document.querySelectorAll(".delPhChk").forEach(function (c) { c.checked = true; }); };

  window.delPhClear = function () { document.querySelectorAll(".delPhChk").forEach(function (c) { c.checked = false; }); };

  window.confirmDeletePhotos = function () {

    var rows = window.__delPhotoItems || [];

    var picks = [];

    document.querySelectorAll(".delPhChk").forEach(function (chk) {

      if (chk.checked) picks.push(rows[+chk.dataset.i]);

    });

    if (!picks.length) { toast("未选择任何照片"); return; }

    ask("删除照片", "将删除 <b>" + picks.length + " 张照片</b>（含磁盘文件，<b>不可恢复</b>），是否继续？",

      [{ t: "删除", cls: "btn-exit", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }],

      function (ok) { if (ok) doDeletePhotos(picks); });

    return;

  };

  function doDeletePhotos(picks) {

    // 按 bid 汇总要删的 pi（从后往前删，避免索引错位）

    var byBid = {};

    picks.forEach(function (r) { (byBid[r.bid] = byBid[r.bid] || []).push(r); });

    var removed = 0;

    Object.keys(byBid).forEach(function (bid) {

      var b = BUILDINGS.find(function (x) { return x.id === bid; }); if (!b) return;

      var idxs = byBid[bid].map(function (r) { return r.pi; }).sort(function (a, b2) { return b2 - a; });

      idxs.forEach(function (pi) {

        var p = b.photos[pi]; if (!p) return;

        if (p.file && window.Android && typeof window.Android.deletePhoto === "function") {

          try { window.Android.deletePhoto(p.file); } catch (e) {}

        }

        b.photos.splice(pi, 1); removed++;

      });

    });

    save(); render();

    toast("已删除 " + removed + " 张照片");

    closeSheet("sheetGen");

    deleteImportedPhotos(); // 刷新列表

  }



  // Req：删除建筑物 —— 按 管理所 / 类型 过滤 → 多选 → 确认（提示数据不可恢复）

  var __delBldState = { offices: new Set(), types: new Set() };

  function deleteBuildingsMenu() {

    var offices = uniq(BUILDINGS.map(function (b) { return b.office || "未设置"; }));

    var types = uniq(BUILDINGS.map(function (b) { return b.btype || "其他"; }));

    __delBldState = { offices: new Set(), types: new Set() };

    function render() {

      var list = BUILDINGS.filter(function (b) {

        if (__delBldState.offices.size && !__delBldState.offices.has(b.office || "未设置")) return false;

        if (__delBldState.types.size && !__delBldState.types.has(b.btype || "其他")) return false;

        return true;

      });

      window.__delBldItems = list;

      $("genTitle").textContent = "删除建筑物";

      $("genBody").innerHTML =

        '<div class="filter-sec"><h4>管理所</h4><div class="chips">' +

        offices.map(function (o) { return '<span class="chip bochip' + (__delBldState.offices.has(o) ? " on" : "") + '" data-o="' + esc(o) + '">' + esc(o) + "</span>"; }).join("") +

        '</div></div>' +

        '<div class="filter-sec"><h4>建筑物类型</h4><div class="chips">' +

        types.map(function (t) { return '<span class="chip btchip' + (__delBldState.types.has(t) ? " on" : "") + '" data-t="' + esc(t) + '">' + esc(t) + "</span>"; }).join("") +

        '</div></div>' +

        '<p style="color:#c0392b;font-size:12px;margin:6px 0">⚠ 删除后数据不可恢复（建筑物记录及其全部照片将被永久移除）</p>' +

        '<p id="delBldCount" style="color:#555;font-size:12px;margin:6px 0">符合条件 <b>' + list.length + '</b> 个建筑物</p>' +

        '<div id="delBldList" style="max-height:45vh;overflow:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">' +

        (list.length ? list.map(function (b, i) {

          var pn = (b.photos || []).length;

          return '<label class="del-bld-row" style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px dashed var(--border);font-size:12px">' +

            '<input type="checkbox" class="delBldChk" data-i="' + i + '" checked>' +

            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🏠 ' + esc(b.name) + ' <span style="color:#888">[' + esc(b.office || "未设置") + ' · ' + esc(b.btype || "其他") + ' · 照片 ' + pn + ']</span></span>' +

          '</label>';

        }).join("") : '<p style="color:#888;font-size:12px;padding:10px">当前条件下无建筑物</p>') +

        "</div>" +

        '<div class="sel-actions">' +

          '<button class="btn-all" onclick="delBldAll()">全选</button>' +

          '<button class="btn-clear" onclick="delBldClear()">全部清除</button>' +

          '<button class="btn-cancel2" onclick="closeSheet(\'sheetGen\')">取消</button>' +

          '<button class="btn-confirm2" onclick="confirmDeleteBuildings()">确认删除</button>' +

        "</div>";

      $("genBody").querySelectorAll(".bochip").forEach(function (el) {

        el.onclick = function () {

          var o = el.dataset.o;

          if (__delBldState.offices.has(o)) __delBldState.offices.delete(o); else __delBldState.offices.add(o);

          render();

        };

      });

      $("genBody").querySelectorAll(".btchip").forEach(function (el) {

        el.onclick = function () {

          var t = el.dataset.t;

          if (__delBldState.types.has(t)) __delBldState.types.delete(t); else __delBldState.types.add(t);

          render();

        };

      });

    }

    render();

    openSheet("sheetGen");

  }

  window.delBldAll = function () { document.querySelectorAll(".delBldChk").forEach(function (c) { c.checked = true; }); };

  window.delBldClear = function () { document.querySelectorAll(".delBldChk").forEach(function (c) { c.checked = false; }); };

  window.confirmDeleteBuildings = function () {

    var list = window.__delBldItems || [];

    var picks = [];

    document.querySelectorAll(".delBldChk").forEach(function (chk) {

      if (chk.checked) picks.push(list[+chk.dataset.i]);

    });

    if (!picks.length) { toast("未选择任何建筑物"); return; }

    var totalPhotos = picks.reduce(function (s, b) { return s + ((b.photos || []).length); }, 0);

    ask("删除建筑物", "将永久删除 <b>" + picks.length + " 个建筑物</b>及其 <b>" + totalPhotos + " 张照片</b>（<b>不可恢复</b>），是否继续？",

      [{ t: "删除", cls: "btn-exit", v: 1 }, { t: "取消", cls: "btn-cancel2", v: 0 }],

      function (ok) {

        if (!ok) return;

        // 先删磁盘照片

        picks.forEach(function (b) {

          (b.photos || []).forEach(function (p) {

            if (p.file && window.Android && typeof window.Android.deletePhoto === "function") {

              try { window.Android.deletePhoto(p.file); } catch (e) {}

            }

          });

        });

        var ids = picks.map(function (b) { return b.id; });

        BUILDINGS = BUILDINGS.filter(function (b) { return ids.indexOf(b.id) < 0; });

        save(); render();

        toast("已删除 " + picks.length + " 个建筑物");

        closeSheet("sheetGen");

      });

  };

  // 网盘导入：原生提供 netdiskPick 时唤起网盘选择器，否则给出明确提示（需先连接网盘账号）

  window.importPhotosFromNetdisk = function (provider) {

    if (window.Android && typeof window.Android.netdiskPick === "function") {

      $("batchPhotoResult").innerHTML = "<span style='color:#888'>已唤起" + (provider === "baidu" ? "百度" : "夸克") + "网盘：在网盘内选文件→分享→「水利工程一张图」即可导入</span>";

      window.Android.netdiskPick(provider);

    } else {

      toast("网盘导入：请在网盘 App 中选文件后「分享/发送给」→「水利工程一张图」；或先用「本地文件」导入");

    }

  };

  // 触发原生大文件选择器（落盘到 inbox，避免经 base64 穿桥）

  // 本地导入同时开放照片与压缩包：用 "*/*" 而非具体 MIME，避免不同机型把 .7z/.rar 识别成

  // application/octet-stream 而在选择器里被灰掉、选不中。选中后在 onPickFiles 里按扩展名分流：

  // 压缩包走原生 unzipImages，照片走匹配；其它文件无副作用（不会匹配到建筑）。

  window.pickPhotosForImport = function () {

    if (!(window.Android && typeof window.Android.pickFiles === "function")) { legacyPickPhotos(); return; }

    $("batchPhotoResult").innerHTML = "<span style='color:#888'>请在系统选择器中选取照片，或 ZIP / 7z / RAR 压缩包…</span>";

    window.Android.pickFiles("*/*");

  };

  // 原生选择器回调：list = [{name,path}]

  window.onPickFiles = function (json) {

    try {

    var list; try { list = JSON.parse(json); } catch (e) { list = []; }

    if (!list || !list.length) { toast("未选择文件"); window.__kmzImport = false; window.__bldImport = false; window.__ovobjFolderImport = false; window.__objFolderImport = false; return; }

    // 批量导入建筑物路由：CSV/XLSX/ZIP 经原生读取后解析

    if (window.__bldImport) {

      window.__bldImport = false;

      var bfile = list.find(function (f) { return /\.(csv|xlsx|xls|zip)$/i.test(f.name); });

      if (!bfile) { toast("未选择 CSV / XLSX / ZIP 文件"); return; }

      importBuildingFromFile(bfile); return;

    }

    // kmz 导入路由：文件选择器里若含 ovkmz/kmz/kml，则走原生大文件导入

    if (window.__kmzImport) {

      window.__kmzImport = false;

      var kmz = list.find(function (f) { return /\.(ovkmz|kmz|kml)$/i.test(f.name); });

      if (kmz) { importKmzFromPath(kmz.path); return; }

      toast("未选择 ovkmz / kmz 文件"); return;

    }

    // ovobj 导入路由：安卓端经 readFileBase64 读二进制 -> JS 解析

    if (window.__ovobjImport) {

      window.__ovobjImport = false;

      var ovobj = list.find(function (f) { return /\.ovobj$/i.test(f.name); });

      if (ovobj) {

        if (window.Android && typeof window.Android.readFileBase64 === "function") {

          busy("正在导入 " + ovobj.name + "，请稍后…"); busyDetail("解析奥维坐标中");

          setTimeout(function () {

            try {

              var b64 = window.Android.readFileBase64(ovobj.path);

              var bytes = b64ToBytes(b64);

              var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

              var pts = parseOvobj(buf);

              cacheOvobjTemplate(bytes);

              mergeCoordPoints(pts, ovobj.name);

            } catch (e) { idle(); toast("导入失败：" + e.message); }

          }, 40);

        } else { importOvobjFromPath && importOvobjFromPath(ovobj.path); }

        return;

      }

      toast("未选择 ovobj 文件"); return;

    }

    // obj/txt/csv 坐标文本导入路由

    if (window.__objImport) {

      window.__objImport = false;

      var objf = list.find(function (f) { return /\.(obj|txt|csv)$/i.test(f.name); });

      if (objf) {

        if (window.Android && typeof window.Android.readFileBase64 === "function") {

          busy("正在导入 " + objf.name + "，请稍后…"); busyDetail("解析坐标文本中");

          setTimeout(function () {

            try {

              var b64b = window.Android.readFileBase64(objf.path);

              var bytes2 = b64ToBytes(b64b);

              var text = new TextDecoder("utf-8").decode(bytes2);

              mergeCoordPoints(parseObjText(text), objf.name);

            } catch (e) { idle(); toast("导入失败：" + e.message); }

          }, 40);

        } else { importObjFromPath && importObjFromPath(objf.path); }

        return;

      }

      toast("未选择 obj / txt / csv 文件"); return;

    }

    // ovobj 文件夹批量导入路由（v3.31 #280：pickFolder 递归枚举后回传）

    if (window.__ovobjFolderImport) {

      window.__ovobjFolderImport = false;

      importOvobjFolder(list); return;

    }

    // obj 文件夹批量导入路由

    if (window.__objFolderImport) {

      window.__objFolderImport = false;

      importObjFolder(list); return;

    }

    var archives = list.filter(function (f) { return /\.(zip|7z|rar)$/i.test(f.name); });

    var imgs = list.filter(function (f) { return !/\.(zip|7z|rar)$/i.test(f.name); });

    var items = imgs.map(function (f) { return { fname: nameNoExt(f.name), base: normalizePhotoName(f.name), path: f.path, folder: "" }; });

    if (!archives.length) { runPhotoMatchNative(items); return; }

    // 大型压缩包改为后台异步解压（原生 unzipImages 走线程池 + 进度），避免在主线程同步解压数 GB 导致卡死。

    // 结果经 window.onUnzipImages 回传，全部完成后统一进入匹配。

    if (!(window.Android && typeof window.Android.unzipImages === "function")) {

      toast("当前环境不支持解压，请改用「本地文件」直接选照片，或安装到安卓后导入");

      return;

    }

    // v3.42：原 zip 文件名跟踪队列（按压栈顺序 pop 标注到每张照片）

    window.__uzAcc = { items: items, total: archives.length, done: 0, zipQueue: archives.slice().reverse() };

    openXferProgress("unzip", "正在解压压缩包（" + archives.length + " 个）…");

    setXferTitle("正在解压 " + archives.length + " 个压缩包，执行中请稍后…");

    archives.forEach(function (z) {

      try { window.Android.unzipImages(z.path); } catch (e) { window.__uzAcc.done++; finishUzIfDone(); }

    });

    } catch (e) {

      try { toast("文件回调出错：" + (e && (e.stack || e.message || e))); } catch (e2) {}

    }

  };

  // 原生异步解压回调：累积结果，全部完成后再统一匹配（v3.42：把 zip 文件名作为 zipName 写入 item，供三级匹配）

  window.onUnzipImages = function (json) {

    var arr; try { arr = JSON.parse(json); } catch (e) { arr = []; }

    var zipName = "";

    try { if (window.__uzAcc && window.__uzAcc.zipQueue && window.__uzAcc.zipQueue.length) zipName = nameNoExt(window.__uzAcc.zipQueue.pop()); } catch (e) {}

    if (typeof arr === "string") { toast((arr + "").replace(/^ERR:/, "")); }

    else { (arr || []).forEach(function (x) { window.__uzAcc.items.push({ fname: nameNoExt(x.name), base: normalizePhotoName(x.name), path: x.path, folder: x.folder || "", zipName: zipName }); }); }

    window.__uzAcc.done++;

    finishUzIfDone();

  };

  function finishUzIfDone() {

    if (window.__uzAcc && window.__uzAcc.done >= window.__uzAcc.total) {

      var items = window.__uzAcc.items; window.__uzAcc = null;

      closeXferProgress();

      // v3.42：为每张照片打 orgScope 标签（zipName→zipFolder→fname 三级回退）

      items.forEach(function (it) { it.orgScope = itemOrgScope(it); });

      runPhotoMatchNative(items);

    }

  }

  // 浏览器回退（小文件）：input file + dataURL

  function legacyPickPhotos() {

    var inp = document.createElement("input");

    inp.type = "file"; inp.accept = "image/*,.zip,.7z,.rar"; inp.multiple = true;

    inp.onchange = function () {

      var files = Array.prototype.slice.call(this.files);

      if (!files.length) { toast("未选择文件"); return; }

      busy("正在读取照片，请稍后…");

      var items = []; var todo = files.length, done = 0;

      var ready = function () {

        if (++done === todo) { idle(); runPhotoMatchLegacy(items); }

      };

      files.forEach(function (f) {

        if (/\.(7z|rar)$/i.test(f.name)) { toast("浏览器环境不支持 7z/RAR 解压，请改用 ZIP 或安装到安卓使用本地导入"); ready(); return; }

        if (/\.zip$/i.test(f.name)) {

          var fName = nameNoExt(f.name);

          JSZip.loadAsync(f).then(function (zip) {

            var names = Object.keys(zip.files).filter(function (n) { return /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(n) && !zip.files[n].dir; });

            return Promise.all(names.map(function (n) {

              return zip.file(n).async("base64").then(function (b64) {

                items.push({ fname: nameNoExt(n.split("/").pop()), base: normalizePhotoName(n), data: "data:image/jpeg;base64," + b64, folder: (n.indexOf("/") >= 0 ? n.substring(0, n.indexOf("/")) : ""), zipName: fName });

              });

            }));

          }).catch(function () {}).then(ready);

        } else {

          var r = new FileReader();

          r.onload = function () { items.push({ fname: nameNoExt(f.name), base: normalizePhotoName(f.name), data: r.result, folder: "" }); ready(); };

          r.readAsDataURL(f);

        }

      });

    };

    inp.click();

  }

  /* ============ 模糊 / 智能匹配（Req 2 + Req 6）============ */

  function longestCommonSubstringLen(a, b) {

    var m = a.length, n = b.length, best = 0, prev = new Array(n + 1).fill(0), cur;

    for (var i = 1; i <= m; i++) {

      cur = new Array(n + 1).fill(0);

      for (var j = 1; j <= n; j++) {

        if (a.charAt(i - 1) === b.charAt(j - 1)) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }

      }

      prev = cur;

    }

    return best;

  }

  function editDistance(a, b) {

    var m = a.length, n = b.length, dp = [];

    for (var i = 0; i <= m; i++) { dp[i] = new Array(n + 1); dp[i][0] = i; }

    for (var j = 0; j <= n; j++) dp[0][j] = j;

    for (var i = 1; i <= m; i++) for (var j = 1; j <= n; j++) {

      var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;

      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);

    }

    return dp[m][n];

  }

  function commonBigrams(a, b) {

    function g(s) { var o = {}; for (var i = 0; i < s.length - 1; i++) { var k = s.substr(i, 2); o[k] = (o[k] || 0) + 1; } return o; }

    var ga = g(a), gb = g(b), c = 0;

    for (var k in ga) if (gb[k]) c += Math.min(ga[k], gb[k]);

    return c;

  }

  // 评分：相等=1000；包含=900；最长公共子串比例高或编辑距离小（容错错字/漏字/多字）>=700；

  // 部分关键词（公共子串>=34%）>=400；2-gram 重合>=2 给 200+。返回 0 表示无关。

  // 匹配置信度文案（Req 4：智能匹配，不确定在范围内确认）

  function confLabel(s) {

    if (s >= 700) return "高匹配";

    if (s >= 400) return "较可能";

    return "待确认";

  }

  function scoreMatch(a, b) {

    a = (a || "").trim(); b = (b || "").trim();

    if (!a || !b) return 0;

    if (a === b) return 1000;

    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 900;

    var lcs = longestCommonSubstringLen(a, b);

    if (lcs >= 2) {

      var r = lcs / Math.max(a.length, b.length);

      var ed = editDistance(a, b);

      if (r >= 0.5 || (ed <= 2 && Math.min(a.length, b.length) >= 3)) return 700 + lcs * 5 - ed * 30;

      if (r >= 0.34) return 400 + lcs * 5;

    }

    var g = commonBigrams(a, b);

    if (g >= 2) return 200 + g * 20;

    return 0;

  }

  // 在候选集中按名称模糊打分，返回 {b, s} 降序（最多 12 个）

  function smartFuzzyMatches(base, cands) {

    var out = [];

    (cands || BUILDINGS).forEach(function (b) {

      if (!b.name) return;

      var s = scoreMatch(base, b.name.trim());

      if (s > 0) out.push({ b: b, s: s });

    });

    out.sort(function (x, y) { return y.s - x.s; });

    return out.slice(0, 12);

  }

  // 智能匹配核心（Req 4）：一张照片既可能靠「文件名」命中建筑物，也可能靠「所在文件夹名」命中。

  // v3.10 的 bug：压缩包按 建筑物A/照片.jpg 或 管理所X/建筑物A/照片.jpg 组织时，文件夹名就是建筑物名，

  // 但旧匹配只拿「文件名」去比建筑物名、且 matchScopeForFolder 只按管理所/类型缩小范围（从不对建筑物名），

  // 导致整包照片 base="photo001" 全部 score=0 → 未匹配 → 建筑物查不到照片，而 3.9G 解压文件堆在 inbox。

  // v3.42：把文件夹「每一层目录名」和「文件名」都拿去跟建筑物名比对，取各建筑物最高分。

  // v3.46（关键修复）：zipName 命中的 orgScope 必须用作强约束——先把 BUILDINGS 收窄到「该 zipName 命中的管理所/局/管理处/站/段」子集，

  //   再在子集里做文件/folder 名模糊匹配（仅当文件/folder 名命中不到时退到「名称首字 + 同级同段」启发），

  //   退到全集合（不强制锁范围）。案例：C:\Users\admin\Downloads\史山.zip 内 IMG-6857.jpg →

  //     zipName="史山.zip" longest-match → orgScope={level:"suo",value:"史山管理所"} → cands=所有 b.guanchu=="京密引水管理处" 且 normOffice(b.office)=="史山所" 的建筑物 → 在 cands 里 fuzzyMatch 文件/folder → 若没命中"三扬分水闸"字面则按经纬度最近匹配。

  function bestMatchesForItem(it) {

    var cands = BUILDINGS;

    // v3.46：先用 it.orgScope（zipName + folder 三级 longest-match 锁出的层级）收窄候选集

    if (it && it.orgScope && it.orgScope.level) {

      var locked = BUILDINGS.filter(function (b) { return passOrgScope(b, it.orgScope); });

      if (locked.length) cands = locked;

    }

    var keys = [];

    if (it.folder) it.folder.split("/").forEach(function (s) { s = (s || "").trim(); if (s) keys.push(s); });

    if (it.base) keys.push(it.base);

    // v3.46：补 zipName 作为最后兜底 key——例如 IMG-6857.jpg 在 zipName="史山.zip" 里，文件名看不出任何建筑物，

    //   但 zipName 模糊比建筑物名仍可能正中"三扬分水闸"（不可能），更多是给"zip 名=建筑物名"场景（如三扬分水闸.zip/IMG-001.jpg）

    if (it.zipName) {

      var z = (it.zipName || "").replace(/\.zip$/i, "").trim();

      if (z) keys.push(z);

    }

    var map = {};

    keys.forEach(function (k) {

      smartFuzzyMatches(k, cands).forEach(function (m) {

        var id = m.b.id;

        if (!map[id] || m.s > map[id].s) map[id] = m;

      });

    });

    return Object.keys(map).map(function (id) { return map[id]; }).sort(function (x, y) { return y.s - x.s; });

  }

  // 单张分类：高匹配(>=700)且明显最优 → 自动绑定；否则放入待确认（不确定就在范围内让用户确认）

  function classifyOne(it) {

    var matched = bestMatchesForItem(it);

    if (!matched.length) return { kind: "unmatched", cands: [] };

    var top = matched[0];

    var clearlyBest = (matched.length === 1) || (matched[1].s < top.s - 200);

    if (top.s >= 700 && clearlyBest) return { kind: "auto", b: top.b, cands: matched };

    return { kind: "ambiguous", cands: matched };

  }

  function scopeLabel(it) { return it.folder ? ("文件夹：" + it.folder) : ""; }

  // 落盘保存一张照片（原生 linkPhoto；浏览器回退 base64）

  // 落盘文件名与显示 caption 统一命名为「建筑物名_顺序号」，便于归档与查找（Req：手动匹配后按对应建筑物照片+顺序号重命名）

  function linkOrBase64(b, it) {

    var seq = (b.photos ? b.photos.length : 0) + 1;

    var cap = b.name + " #" + seq;

    if (window.Android && window.Android.linkPhoto) {

      try {

        var rel = window.Android.linkPhoto(b.id, it.path, b.name + "_" + seq + ".jpg");

        if (rel) {

          b.photos.push({ file: rel, caption: cap, added: Date.now() });

          queueCompress(rel); // v3.31：>1.5M 的照片落盘后排队压缩（只存压缩版）

          return true;

        }

      } catch (e) {}

    }

    if (it.data) { b.photos.push({ data: it.data, caption: cap, added: Date.now() }); return true; }

    return false;

  }

  // Req 7：保存前按内容（SHA-256）比对已有照片，存在则记入待确认（覆盖/跳过）

  function dupCheck(it, b, dupPending) {

    if (!(window.Android && window.Android.fileSha256 && window.Android.photoSha256)) return false;

    try {

      var cSha = window.Android.fileSha256(it.path);

      var exPhoto = null;

      (b.photos || []).some(function (ep) {

        if (!ep.file) return false;

        var eSha = ""; try { eSha = window.Android.photoSha256(ep.file); } catch (e) {}

        if (eSha && eSha === cSha) { exPhoto = ep; return true; }

        return false;

      });

      if (exPhoto) { dupPending.push({ it: it, b: b, exPhoto: exPhoto }); return true; }

    } catch (e) {}

    return false;

  }

  // 统一分类：对每张照片智能匹配（文件夹各层 + 文件名）→ 自动/待确认/未匹配/重复

  function classifyItems(items) {

    var r = { auto: 0, unmatched: [], ambiguous: [], dup: 0, dupPending: [] };

    items.forEach(function (it) {

      var cl = classifyOne(it);

      if (cl.kind === "auto") {

        if (dupCheck(it, cl.b, r.dupPending)) { r.dup++; }

        else if (linkOrBase64(cl.b, it)) { r.auto++; }

        else { r.unmatched.push({ it: it, scope: scopeLabel(it) }); }

      } else if (cl.kind === "ambiguous") {

        r.ambiguous.push({ it: it, cands: cl.cands.map(function (m) { return { b: m.b, s: m.s }; }), scope: scopeLabel(it) });

      } else {

        r.unmatched.push({ it: it, scope: scopeLabel(it) });

      }

    });

    return r;

  }



  function runPhotoMatchLegacy(items) {

    if (!items.length) { $("batchPhotoResult").innerHTML = "<span style='color:#c0392b'>未找到图片文件</span>"; return; }

    // classifyItems 是同步重活（含 SHA-256 去重），先弹忙提示再执行

    busyRun("正在智能匹配 " + items.length + " 张照片，请稍后…", function () {

      var r = classifyItems(items);

      window.__saveOne = linkOrBase64;

      finishPhotoMatch(r);

    });

  }

  // 原生管线匹配：照片落盘（linkPhoto）记录相对路径，彻底规避 localStorage 容量限制

    // v3.43 / v3.45：从 token 中找五级组织名称；按「最长匹配」优先，

//   避免 "史山所.zip" 命中较短的 "山水所" / "山水管理所"。

//   返回最强层级 + 命中值 + parentLevel（命中层级下一级，供 folder 子匹配用）

  function matchOrgInToken(token, levels) {

    if (!token) return null;

    var lv = orgStore();

    var levels = levels || ["ju", "guanchu", "suo", "zhan", "duan"];

    var labels = { ju: "局", guanchu: "管理处", suo: "所", zhan: "站", duan: "段" };

    var best = null;  // { level, value, parentLevel, label, hitLen }

    // 1) 同级按 level 顺序（ju→guanchu→suo→zhan→duan）层层找，但每层内取最长匹配

    for (var li = 0; li < levels.length; li++) {

      var k = levels[li];

      var arr = (lv[k] || []).slice();

      arr.sort(function (a, b) { return b.length - a.length; }); // 长→短

      for (var i = 0; i < arr.length; i++) {

        var v = arr[i];

        if (v && token.indexOf(v) >= 0) {

          // 同级内取第一个（最长）

          var r = { level: k, value: v, parentLevel: levels[li + 1] || null, label: labels[k], hitLen: v.length };

          if (!best) { best = r; }

          else if (k === best.level) {

            // 同级更长匹配覆盖（已被排序保证，但前面层级已找到的也保留）

            if (v.length > best.hitLen) best = r;

          }

          // 跨级不覆盖：上级一旦命中，folder 子匹配从下一级开始

          break;

        }

      }

    }

    return best;

  }

  // v3.43：把 item 的 zipName/folder 解析为 scope。

  //  匹配顺序：

  //   1) zipName 按 局 → 处 → 所 → 站 → 段 层级依次检查（命中任一层即视为锁定该层；folder 子匹配从下一级开始）

  //   2) zipName 未命中时，folder 拆 / 逐段匹配（按相同层级）

  //   3) 仍无命中则 null

  function itemOrgScope(it) {

    var z = it || {};

    if (z.zipName) {

      var r = matchOrgInToken(z.zipName, ["ju", "guanchu", "suo", "zhan", "duan"]);

      if (r) return r;

    }

    if (z.folder) {

      var parts = String(z.folder).split(/[\\\/]+/);

      // 优先用 zipName 匹配的 parentLevel；没有 zipName 命中时，从最上级开始

      var prev = null;

      for (var pi = 0; pi < parts.length; pi++) {

        var startLevels = prev ? [prev] : ["ju", "guanchu", "suo", "zhan", "duan"];

        var rr = matchOrgInToken(parts[pi], startLevels);

        if (rr) { prev = rr.parentLevel; return rr; }

      }

      var r3 = matchOrgInToken(z.folder, ["ju", "guanchu", "suo", "zhan", "duan"]);

      if (r3) return r3;

    }

    return null;

  }

  function passOrgScope(b, scope) {

    if (!scope) return true;

    var fld;

    if (scope.level === "suo") fld = normOffice(b.office);

    else if (scope.level === "guanchu") fld = b.guanchu || getOrgDefaults().guanchu;

    else if (scope.level === "ju") fld = b.ju || getOrgDefaults().ju;

    else if (scope.level === "zhan") fld = b.station;

    else if (scope.level === "duan") fld = b.chan;

    return fld === scope.value;

  }



  function runPhotoMatchNative(items) {

    if (!items.length) { $("batchPhotoResult").innerHTML = "<span style='color:#c0392b'>未找到图片文件</span>"; return; }

    window.__saveOne = linkOrBase64;

    // 分块处理并让出主线程，避免数千张照片一次性匹配（尤其含 SHA-256 去重）卡死 WebView

    var r = { auto: 0, unmatched: [], ambiguous: [], dup: 0, dupPending: [] };

    var i = 0, total = items.length;

    openXferProgress("match", "正在智能匹配照片（" + total + " 张）…");

    setXferTitle("正在智能匹配 " + total + " 张照片，执行中请稍后…");

    function step() {

      var CHUNK = 30;

      for (var c = 0; c < CHUNK && i < total; c++, i++) {

        var it = items[i];

        var cl = classifyOne(it);

        if (cl.kind === "auto") {

          if (dupCheck(it, cl.b, r.dupPending)) { r.dup++; }

          else if (linkOrBase64(cl.b, it)) { r.auto++; }

          else { r.unmatched.push({ it: it, scope: scopeLabel(it) }); }

        } else if (cl.kind === "ambiguous") {

          r.ambiguous.push({ it: it, cands: cl.cands.map(function (m) { return { b: m.b, s: m.s }; }), scope: scopeLabel(it) });

        } else {

          r.unmatched.push({ it: it, scope: scopeLabel(it) });

        }

      }

      updateXferProgress("match", i, total);

      if (i < total) setTimeout(step, 0);

      else { closeXferProgress(); finishPhotoMatch(r); flushCompress(); }

    }

    step();

  }

  // 统一渲染匹配结果 + 多匹配勾选（含 全选/全部清除/取消/确认/退出，Req 3）+ 重复确认（Req 7）

  // 仅在所有手动匹配框（重复/多选/未匹配）都处理完毕后才清理解压临时目录。

  // 否则未匹配/多选照片的源文件在 inbox/uz_* 中被提前删除，手动绑定时 linkPhoto 打开已删文件会静默失败（根因修复）。

  function maybeCleanInbox() {

    var dupBoxEl = document.getElementById("dupBox");

    if (dupBoxEl && dupBoxEl.querySelector(".sel-item")) return; // 还有未处理的重复项

    if (document.getElementById("ambBox")) return;

    if (document.getElementById("unmbBox")) return;

    if (window.Android && typeof window.Android.cleanInbox === "function") { try { window.Android.cleanInbox(); } catch (e) {} }

  }

  function finishPhotoMatch(r) {

    r = r || {};

    save(); render();

    // 关键修复（v3.30.2）：此处【绝不】立即 cleanInbox()。

    // 旧代码在此处调用 maybeCleanInbox()，但此时 ambBox/dupBox/unmbBox 尚未写入 DOM，

    // 三个守卫判断全部失效 → 直接删掉所有 inbox/uz_* 临时解压目录。

    // 之后 ambBox 才渲染出来，用户勾选确认时 linkPhoto 打开的源文件已被删除 → 静默失败 → 保存 0 张。

    // 清理统一交给 confirmAmbiguous / confirmUnmatched / dupOverwrite 各自末尾的 maybeCleanInbox()（DOM 已写入，时机正确）。

    var html = '<p style="color:#2b8a5d;font-weight:600">自动匹配：' + (r.auto || 0) + ' 张</p>';

    if (r.dup) html += '<p style="color:#888">待确认重复（内容相同）：' + r.dup + ' 张</p>';

    if (r.unmatched && r.unmatched.length) html += '<p style="color:#c0392b">未匹配：' + r.unmatched.length + ' 张</p>';

    // 重复确认

    if (r.dupPending && r.dupPending.length) {

      html += '<div id="dupBox" style="margin-top:10px"><p style="font-weight:600;color:#e6922e">以下 ' + r.dupPending.length + ' 张照片与已有照片内容相同，请选择「覆盖」或「跳过」：</p>';

      r.dupPending.forEach(function (d, i) {

        var exSrc = d.exPhoto ? photoSrc(d.exPhoto) : "";

        html += '<div class="sel-item" style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px"><div style="flex:1"><div style="font-weight:600">📷 ' + esc(d.it.fname) + ' → ' + esc(d.b.name) + '</div>' +

          (exSrc ? '<img src="' + esc(exSrc) + '" style="width:64px;height:64px;object-fit:cover;border-radius:4px;margin-top:4px">' : '') +

          '<div style="margin-top:6px"><button class="btn-save" style="padding:5px 12px;font-size:12px" onclick="dupOverwrite(' + i + ')">覆盖</button> <button class="btn-cancel" style="padding:5px 12px;font-size:12px" onclick="dupSkip(' + i + ')">跳过</button></div></div></div>';

      });

      html += '</div>';

      window.__dupPending = r.dupPending;

    }

    // 多匹配确认：默认勾选最匹配项，并标注置信度与推断范围，方便用户一键确认（Req 4）

    // v3.22：实时“已选 X/N”计数 + “全部按最匹配”一键 + 键盘 Enter 确认 / Esc 取消 + 操作条常驻（sticky）

    if (r.ambiguous && r.ambiguous.length) {

      html += '<div id="ambBox" style="margin-top:10px"><p style="font-weight:600;color:#e6922e">以下 ' + r.ambiguous.length + ' 张照片匹配到多个建筑物，已默认选中最匹配项（单选，每张照片只绑定一个建筑物），请确认或改选：</p>';

      html += '<div id="ambCountTip" class="amb-count"></div>';

      r.ambiguous.forEach(function (a, i) {

        var top = a.cands[0];

        html += '<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px"><div style="font-weight:600;margin-bottom:4px">📷 ' + esc(a.it.fname) + (a.scope ? (' <span style="color:#888;font-size:11px">范围：' + esc(a.scope) + '</span>') : '') + '</div>';

        a.cands.forEach(function (c) {

          var b = c.b;

          var checked = (c === top) ? " checked" : "";

          html += '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px"><input type="radio" class="ambChk" name="amb' + i + '" data-i="' + i + '" data-bid="' + esc(b.id) + '"' + checked + '> ' + esc(b.name) + ' <span style="color:#888;font-size:11px">[' + confLabel(c.s) + '] ' + esc(b.office || "未设置") + '</span></label>';

        });

        html += '</div>';

      });

      html += '<div class="sel-actions sticky-actions">' +

        '<button class="btn-all" onclick="ambSelectTop()">全部按最匹配</button>' +

        '<button class="btn-clear" onclick="ambClearAll()">全部清除</button>' +

        '<button class="btn-cancel2" onclick="ambCancel()">取消(Esc)</button>' +

        '<button class="btn-confirm2" onclick="confirmAmbiguous()">确认(Enter)</button>' +

        '<button class="btn-exit" onclick="closeSheet(\'sheetGen\')">退出</button></div></div>';

      window.__ambiguous = r.ambiguous;

    } else if (!(r.dupPending && r.dupPending.length) && !(r.ambiguous && r.ambiguous.length) && !(r.unmatched && r.unmatched.length)) {

      html += '<div style="margin-top:8px;font-size:12px;color:#555">导入完成。</div>';

    }

    // Req 4 + 核心修复：未匹配照片的「批量绑定」确认 UI（一键全部应用 + 逐张调整）。

    // 解决 1.7G 包导入后建筑物查不到照片的根因——v3.11 智能匹配对「文件夹无建筑物名」的压缩包

    // （如仅按管理所/日期组织的包）得分=0→全部未匹配→旧版仅展示文件名无任何绑定入口，导致 0 张入库。

    // 此处用 datalist 共享 557 个建筑物选项，3628+ 行也不会卡。

    if (r.unmatched && r.unmatched.length) {

      var bldOpts = BUILDINGS.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '（' + esc(b.office || "未设置") + '）</option>'; }).join("");

      var rows = r.unmatched.map(function (u, i) {

        return '<div class="sel-item umb-row" style="border:1px solid var(--border);border-radius:8px;padding:5px 8px;margin-bottom:5px">' +

          '<label style="display:flex;align-items:center;gap:6px">' +

          '<input type="checkbox" class="umbChk" data-i="' + i + '" checked>' +

          '<span style="font-size:11px;color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📷 ' + esc(u.it.fname) + (u.scope ? ' <span style="font-size:9px">[' + esc(u.scope) + ']</span>' : '') + '</span>' +

          '<input list="umbBldList" class="umbSel" data-i="' + i + '" placeholder="搜/选建筑物…" style="font-size:11px;padding:3px;width:55%">' +

          '</label></div>';

      }).join("");

      html += '<div id="unmbBox" style="margin-top:10px">' +

        '<datalist id="umbBldList">' + bldOpts + '</datalist>' +

        '<p style="font-weight:600;color:#c0392b">未匹配 ' + r.unmatched.length + ' 张 —— 选建筑物后确认（可一键全部应用，逐张调整）：</p>' +

        '<div style="display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap">' +

          '<span style="font-size:12px;color:#555">一键全部绑定到：</span>' +

          '<input list="umbBldList" id="unmbAllSel" placeholder="搜/选建筑物…" style="font-size:12px;padding:3px;flex:1;min-width:40%">' +

          '<button class="btn-save" style="padding:5px 10px;font-size:12px" onclick="unmbApplyAll()">全部应用</button>' +

        '</div>' +

        '<div style="max-height:50vh;overflow:auto;border-top:1px dashed var(--border);padding-top:6px">' + rows + '</div>' +

        '<div class="sel-actions">' +

          '<button class="btn-all" onclick="unmbSelectAll()">全选</button>' +

          '<button class="btn-clear" onclick="unmbClearAll()">全部清除</button>' +

          '<button class="btn-cancel2" onclick="unmbCancel()">取消</button>' +

          '<button class="btn-confirm2" onclick="confirmUnmatched()">确认</button>' +

          '<button class="btn-exit" onclick="closeSheet(\'sheetGen\')">退出</button>' +

        '</div></div>';

      window.__unmatched = r.unmatched;

    }

    $("batchPhotoResult").innerHTML = html;

    // v3.22：多匹配确认加交互——实时计数 + 键盘 Enter/Esc（仅 ambBox 存在时生效）

    if (r.ambiguous && r.ambiguous.length) { bindAmbEvents(); ambUpdateCount(); }

    toast("自动匹配 " + (r.auto || 0) + " 张" + (r.dup ? "，重复待确认 " + r.dup + " 张" : "") + ((r.ambiguous && r.ambiguous.length) ? "，" + r.ambiguous.length + " 张待确认" : "") + ((r.unmatched && r.unmatched.length) ? "，" + r.unmatched.length + " 张未匹配待确认" : ""));

  }



  // 多匹配确认保存（统一走 window.__saveOne：原生用 linkPhoto 落盘，浏览器回退用 base64）

  window.confirmAmbiguous = function () {

    var ambiguous = window.__ambiguous || [];

    var chosen = 0;

    document.querySelectorAll(".ambChk").forEach(function (chk) {

      if (!chk.checked) return;

      var a = ambiguous[+chk.dataset.i]; if (!a) return;

      var b = BUILDINGS.find(function (x) { return x.id === chk.dataset.bid; });

      // 互斥单选：每张照片只绑一个建筑物；只有真正落盘成功才计入（避免“显示已保存”却没绑定）

      if (b) { var ok = window.__saveOne ? window.__saveOne(b, a.it) : false; if (ok) chosen++; }

    });

    save(); render();

    maybeCleanInbox();

    flushCompress();

    var box = $("ambBox");

    if (box) box.outerHTML = '<p style="color:#2b8a5d;margin-top:10px">已按勾选保存 ' + chosen + ' 张照片。</p>';

    toast("已保存 " + chosen + " 张勾选照片");

  };

  // v3.22：全部按“最匹配项”勾选（每张照片只选其置信度最高的候选），比旧“全选”更符合一键确认预期

  window.ambSelectTop = function () {

    var seen = {};

    document.querySelectorAll(".ambChk").forEach(function (c) {

      var gi = c.getAttribute("name");

      if (seen[gi]) { c.checked = false; return; }

      seen[gi] = true; c.checked = true; // 每组（每张照片）只勾第一个=最匹配

    });

    ambUpdateCount();

  };

  window.ambSelectAll = function () { window.ambSelectTop(); };

  window.ambClearAll = function () { document.querySelectorAll(".ambChk").forEach(function (c) { c.checked = false; }); ambUpdateCount(); };

  // 实时统计“已选 X / 共 N 张”（每张照片只计一个勾选项）

  function ambUpdateCount() {

    var tip = document.getElementById("ambCountTip"); if (!tip) return;

    var seen = {}, sel = 0, total = 0;

    document.querySelectorAll(".ambChk").forEach(function (c) {

      var gi = c.getAttribute("name");

      if (seen[gi]) return; seen[gi] = true; total++;

      if (c.checked) sel++;

    });

    tip.innerHTML = '已选 <b>' + sel + '</b> / ' + total + ' 张（每张只绑一个建筑物）';

  }

  // 绑定单选变化计数 + 键盘 Enter 确认 / Esc 取消（仅当匹配确认框存在时生效，避免误触其它输入）

  function bindAmbEvents() {

    document.querySelectorAll(".ambChk").forEach(function (c) {

      c.addEventListener("change", ambUpdateCount);

    });

    if (window.__ambKeyBound) return;

    window.__ambKeyBound = true;

    document.addEventListener("keydown", function (e) {

      var box = document.getElementById("ambBox");

      if (!box) return;

      var t = e.target || {};

      if (t.tagName === "INPUT" && t.type === "text") return; // 文本框内不拦截 Enter

      if (e.key === "Enter") { e.preventDefault(); if (window.confirmAmbiguous) window.confirmAmbiguous(); }

      else if (e.key === "Escape") { e.preventDefault(); if (window.ambCancel) window.ambCancel(); }

    });

  }

  window.ambCancel = function () {

    ambClearAll();

    var box = $("ambBox"); if (box) box.outerHTML = '<p style="color:#888;margin-top:10px">已取消多选匹配。</p>';

    maybeCleanInbox();

    toast("已取消多选匹配");

  };

  window.dupOverwrite = function (i) {

    var d = (window.__dupPending || [])[i]; if (!d) return;

    if (window.__saveOne) window.__saveOne(d.b, d.it);

    save(); render();

    var el = document.querySelectorAll("#dupBox .sel-item")[i]; if (el) el.outerHTML = '<p style="color:#2b8a5d;font-size:12px">已覆盖保存：' + esc(d.it.fname) + '</p>';

    maybeCleanInbox();

    flushCompress();

    toast("已覆盖保存");

  };

  window.dupSkip = function (i) {

    var d = (window.__dupPending || [])[i]; if (!d) return;

    var el = document.querySelectorAll("#dupBox .sel-item")[i]; if (el) el.outerHTML = '<p style="color:#888;font-size:12px">已跳过重复：' + esc(d.it.fname) + '</p>';

    maybeCleanInbox();

    toast("已跳过重复照片");

  };



  // 未匹配照片的批量绑定确认（v3.12 核心修复）

  window.confirmUnmatched = function () {

    var items = window.__unmatched || [];

    if (!items.length) return;

    var chosen = 0, skipped = 0;

    document.querySelectorAll(".umbChk").forEach(function (chk) {

      if (!chk.checked) return;

      var i = +chk.dataset.i;

      var sel = document.querySelector('.umbSel[data-i="' + i + '"]');

      var bid = sel && sel.value; if (!bid) { skipped++; return; }

      var b = BUILDINGS.find(function (x) { return x.id === bid; }); if (!b) { skipped++; return; }

      // 关键修复：只有 linkOrBase64 真正返回 true（文件已落盘）才算保存成功，否则计入 skipped，避免“显示已保存”却没绑定的假象

      var ok = window.__saveOne ? window.__saveOne(b, items[i].it) : false;

      if (ok) chosen++; else skipped++;

    });

    save(); render();

    maybeCleanInbox();

    flushCompress();

    var box = $("unmbBox");

    if (box) box.outerHTML = '<p style="color:#2b8a5d;margin-top:10px">已按勾选保存 ' + chosen + ' 张照片' + (skipped ? '（' + skipped + ' 张未选建筑物已跳过）' : '') + '。</p>';

    toast("已保存 " + chosen + " 张" + (skipped ? "（" + skipped + " 张跳过）" : ""));

  };

  window.unmbApplyAll = function () {

    var inp = $("unmbAllSel"); var v = inp && inp.value;

    if (!v) { toast("请先输入/选择建筑物名称"); if (inp) inp.focus(); return; }

    document.querySelectorAll(".umbSel").forEach(function (s) { s.value = v; });

    toast("已全部预选，可点「确认」保存");

  };

  window.unmbSelectAll = function () { document.querySelectorAll(".umbChk").forEach(function (c) { c.checked = true; }); };

  window.unmbClearAll = function () { document.querySelectorAll(".umbChk").forEach(function (c) { c.checked = false; }); };

  window.unmbCancel = function () {

    document.querySelectorAll(".umbChk").forEach(function (c) { c.checked = false; });

    document.querySelectorAll(".umbSel").forEach(function (s) { s.value = ""; });

    var inp = $("unmbAllSel"); if (inp) inp.value = "";

    var box = $("unmbBox"); if (box) box.outerHTML = '<p style="color:#888;margin-top:10px">已取消未匹配绑定。</p>';

    maybeCleanInbox();

    toast("已取消未匹配绑定");

  };



  /* ---------- 批量导入建筑物 ---------- */

  function batchImportBuildings() {

    var html = '<div style="font-size:14px;color:#555;margin-bottom:12px">' +

      '<p>批量导入建筑物信息（CSV / Excel / ZIP 压缩包）。</p>' +

      '<p style="color:#888;font-size:12px">支持列：name(名称), lat(纬度), lon(经度), office(管理所), station(管理站), btype(建筑物类型), chan(段)。<br>有经纬度的自动定位；无经纬度的按名称匹配已有建筑物坐标。</p></div>' +

      '<div class="form-actions"><button class="btn-save" onclick="pickBuildingFile()">选择文件</button></div>' +

      '<div id="batchBldResult" style="margin-top:12px"></div>';

    $("genTitle").textContent = "批量导入建筑物";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  // 触发原生大文件选择器（落盘到 inbox，避免 WebView 受限读取 content URI）；

  // 与照片导入共用 onPickFiles，借助 window.__bldImport 标记路由。

  window.pickBuildingFile = function () {

    // 仅 Android 用原生选择器（其 <input type=file> 受限）；桌面/统信/浏览器用更可靠的 <input type=file>+FileReader

    var isAndroid = /Android/i.test(navigator.userAgent || "");

    if (isAndroid && window.Android && typeof window.Android.pickFiles === "function") {

      window.__bldImport = true;

      $("batchBldResult").innerHTML = "<span style='color:#888'>请在系统选择器中选取 CSV / XLSX / ZIP 文件…</span>";

      window.Android.pickFiles("*/*");

    } else {

      legacyPickBuilding();

    }

  };

  // 浏览器/桌面回退：原生桥不可用时，仍用 <input type=file>（桌面不受作用域存储限制）

  function legacyPickBuilding() {

    var inp = document.createElement("input");

    inp.type = "file"; inp.accept = ".csv,.xlsx,.xls,.zip";

    inp.onchange = function () {

      var file = inp.files && inp.files[0]; if (!file) return;

      var fname = file.name.toLowerCase();

      $("batchBldResult").innerHTML = "<span style='color:#888'>正在解析 " + esc(file.name) + " …</span>";

      if (/\.csv$/i.test(fname)) {

        var r = new FileReader();

        r.onload = function () { processBuildingRows(parseCSV(r.result)); };

        r.readAsText(file, "UTF-8");

      } else {

        var r2 = new FileReader();

        r2.onload = function () { JSZip.loadAsync(r2.result).then(function (zip) { resolveBuildingZip(zip, file.name); })

          .catch(function (e) { $("batchBldResult").innerHTML = "<span style='color:#c0392b'>解析失败：" + esc(e.message) + "</span>"; }); };

        r2.readAsArrayBuffer(file);

      }

    };

    inp.click();

  }

  // 原生选择器返回后：定位 CSV/XLSX/ZIP，读取并解析

  // 原生选择器返回后：先做“同文件二次导入”内容校验（SHA-256），再定位 CSV/XLSX/ZIP 读取解析

  function importBuildingFromFile(f) {

    var fname = f.name.toLowerCase();

    // v3.19：与 ovkmz 导入一致，按文件内容 SHA-256 识别“同一个文件再次导入”。

    // 大文件算哈希会短暂阻塞，先弹“校验中”忙提示，下一帧再算（否则提示画不出来）。

    busy("正在校验文件，请稍后…");

    busyDetail(esc(f.name) + "（内容校验，请勿退出）");

    setTimeout(function () {

      var sha = "";

      try { if (window.Android) sha = window.Android.fileSha256(f.path); } catch (e) {}

      idle();

      var lastSha = ""; try { lastSha = localStorage.getItem("shuili_lastBldSha") || ""; } catch (e) {}

      if (sha && lastSha && sha === lastSha) {

        ask("该文件已导入过",

          "文件“" + esc(f.name) + "”的内容与上次导入<b>完全相同</b>（按文件内容比对，非文件名）。是否覆盖导入？",

          [{ t: "覆盖导入", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel", v: 0 }],

          function (ok) {

            if (ok) { try { if (sha) localStorage.setItem("shuili_lastBldSha", sha); } catch (e) {} readBuildingFile(f, fname); }

            else toast("已取消导入");

          });

        return;

      }

      try { if (sha) localStorage.setItem("shuili_lastBldSha", sha); } catch (e) {}

      readBuildingFile(f, fname);

    }, 40);

  }

  // 稳健读取 CSV 文本：优先原生 readFileText；其次 readFileBase64 解码；均无则抛清晰错误（不再 is not a function 崩溃）

  function readBuildingText(f) {

    if (window.Android && typeof window.Android.readFileText === "function") {

      var t = window.Android.readFileText(f.path);

      if (t != null) return t;

    }

    if (window.Android && typeof window.Android.readFileBase64 === "function" && f && f.path) {

      try { return new TextDecoder("utf-8").decode(b64ToBytes(window.Android.readFileBase64(f.path))); } catch (e) {}

    }

    throw new Error("当前平台未提供文件文本读取能力（readFileText/readFileBase64 均不可用）");

  }

  function readBuildingFile(f, fname) {

    busy("正在读取 " + esc(f.name) + "，请稍后…");

    busyDetail("执行中请稍后");

    setTimeout(function () {

      try {

        if (/\.csv$/i.test(fname)) {

          var text = readBuildingText(f);

          idle();

          processBuildingRows(parseCSV(text));

        } else if (/\.zip$/i.test(fname)) {

          var b64 = window.Android.readFileBase64(f.path);

          JSZip.loadAsync(base64ToBytes(b64)).then(function (zip) { resolveBuildingZip(zip, f.name); })

            .catch(function (e) { idle(); $("batchBldResult").innerHTML = "<span style='color:#c0392b'>解析失败：" + esc(e.message) + "</span>"; });

        } else if (/\.xlsx$/i.test(fname) || /\.xls$/i.test(fname)) {

          var b64 = window.Android.readFileBase64(f.path);

          JSZip.loadAsync(base64ToBytes(b64)).then(function (zip) {

            return parseXlsx(zip);

          }).then(function (rows) { idle(); processBuildingRows(rows); })

            .catch(function (e) { idle(); $("batchBldResult").innerHTML = "<span style='color:#c0392b'>解析失败：" + esc(e.message) + "</span>"; });

        } else { idle(); toast("不支持的文件格式"); }

      } catch (e) { idle(); $("batchBldResult").innerHTML = "<span style='color:#c0392b'>读取失败：" + esc(e.message) + "</span>"; }

    }, 30);

  }

  // 从 ZIP 内定位 CSV / XLSX 并解析（统一出口）

  function resolveBuildingZip(zip, fname) {

    var csvName = Object.keys(zip.files).find(function (n) { return /\.csv$/i.test(n); });

    var xlsName = Object.keys(zip.files).find(function (n) { return /\.xlsx$/i.test(n); });

    if (csvName) {

      return zip.file(csvName).async("string").then(function (t) { idle(); processBuildingRows(parseCSV(t)); });

    }

    if (xlsName) {

      return zip.file(xlsName).async("blob").then(function (b) {

        return JSZip.loadAsync(b).then(function (iz) { idle(); return parseXlsx(iz); });

      }).then(function (rows) { processBuildingRows(rows); });

    }

    // v3.30：含图片但无表格 → 自动引导到「批量导入照片」流程，不再静默报错

    var hasImg = Object.keys(zip.files).some(function (n) { return /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(n); });

    idle();

    if (hasImg) {

      $("batchBldResult").innerHTML = "<div style='color:#c0392b;margin-bottom:8px'>检测到本包为<b>照片压缩包</b>（无 CSV/XLSX 表格），建筑导入不适用。</div>" +

        "<button class='btn-save' onclick='closeSheet(\"sheetGen\");batchImportPhotos()'>转到「批量导入照片」›</button>";

      return;

    }

    $("batchBldResult").innerHTML = "<span style='color:#c0392b'>ZIP 中未找到 CSV 或 XLSX 文件</span>";

  }

  // 通用解析 + 写入（CSV/XLSX/内部 ZIP 共用）

  // v3.19：存在“名称完全相同”的现有建筑物时，弹三选一（覆盖更新 / 保留现有 / 取消导入），不再静默覆盖。

  function processBuildingRows(rows) {

    if (!rows || !rows.length) { $("batchBldResult").innerHTML = "<span style='color:#c0392b'>未解析到数据行</span>"; return; }

    var header = rows[0].map(function (h) { return String(h == null ? "" : h).trim().toLowerCase(); });

    var findCol = function (names) {

      for (var i = 0; i < names.length; i++) {

        var idx = header.indexOf(names[i]);

        if (idx >= 0) return idx;

      }

      return -1;

    };

    var iName = findCol(["name", "名称", "建筑物名称"]);

    var iLat = findCol(["lat", "latitude", "纬度"]);

    var iLon = findCol(["lon", "lng", "longitude", "经度"]);

    var iOffice = findCol(["office", "管理所"]);

    var iStation = findCol(["station", "管理站"]);

    var iBtype = findCol(["btype", "type", "建筑物类型", "类型"]);

    var iChan = findCol(["chan", "段"]);



    if (iName < 0) { $("batchBldResult").innerHTML = "<span style='color:#c0392b'>未找到\"名称\"列（name/名称）</span>"; return; }



    // 先解析成行对象（跳过空名称），并去重“文件内部同名行”（同名只保留最后一行）

    var parsed = [];

    for (var r = 1; r < rows.length; r++) {

      var row = rows[r];

      if (!row || row[iName] == null || !String(row[iName]).trim()) continue;

      parsed.push({

        name: String(row[iName]).trim(),

        lat: iLat >= 0 ? parseFloat(row[iLat]) : NaN,

        lon: iLon >= 0 ? parseFloat(row[iLon]) : NaN,

        office: iOffice >= 0 ? normOffice(row[iOffice]) : "",

        station: iStation >= 0 ? String(row[iStation] || "").trim() : "",

        btype: iBtype >= 0 ? String(row[iBtype] || "").trim() : "其他",

        chan: iChan >= 0 ? String(row[iChan] || "").trim() : ""

      });

    }

    if (!parsed.length) { $("batchBldResult").innerHTML = "<span style='color:#c0392b'>未解析到数据行</span>"; return; }

    var seen = {};

    parsed = parsed.filter(function (p) { if (seen[p.name]) return false; seen[p.name] = true; return true; });



    // 与现有建筑物按“名称完全相同”比对（对导入前的快照判断，避免导入过程相互污染）

    var existName = {}; BUILDINGS.forEach(function (b) { existName[b.name] = 1; });

    var uniqDup = parsed.filter(function (p) { return existName[p.name]; }).map(function (p) { return p.name; })

      .filter(function (n, i, a) { return a.indexOf(n) === i; });



    // 实际写入（mode: overwrite 全量处理 / keep 只加新名，跳过同名）

    function applyRows(list) {

      var added = 0, updated = 0, noCoord = 0;

      var details = [];

      var seq = 0;

      list.forEach(function (p) {

        var existing = BUILDINGS.find(function (b) { return b.name === p.name; });

        if (existing) {

          existing.office = p.office || existing.office;

          existing.station = p.station || existing.station;

          existing.btype = p.btype || existing.btype;

          existing.chan = p.chan || existing.chan;

          if (!isNaN(p.lat) && !isNaN(p.lon)) { existing.lat = p.lat; existing.lon = p.lon; existing.geom = "Point"; }

          updated++;

          details.push("✎ 更新：" + p.name);

        } else {

          var nb = { id: "imp" + Date.now() + (seq++), name: p.name, office: p.office, station: p.station, chan: p.chan, btype: p.btype, path: "", attrs: [], photos: [], geom: "Point" };

          if (!isNaN(p.lat) && !isNaN(p.lon)) {

            nb.lat = p.lat; nb.lon = p.lon;

          } else {

            // 尝试按名称匹配已有建筑物坐标

            var match = BUILDINGS.find(function (b) { return b.name && b.name.indexOf(p.name) >= 0 && b.lat != null; });

            if (match) { nb.lat = match.lat; nb.lon = match.lon; details.push("  ↳ 坐标来自：" + match.name); }

            else { nb.lat = null; nb.lon = null; nb.geom = "None"; noCoord++; }

          }

          BUILDINGS.push(nb);

          added++;

          details.push("✚ 新增：" + p.name);

        }

      });

      save(); render(); buildLegend();

      var html = '<p style="color:#2b8a5d;font-weight:600">新增：' + added + '　更新：' + updated + (noCoord ? "　无坐标：" + noCoord : "") + "</p>";

      html += '<div style="margin-top:8px;max-height:200px;overflow:auto;font-size:12px;color:#555">' +

        details.map(function (d) { return "<div>" + esc(d) + "</div>"; }).join("") + "</div>";

      $("batchBldResult").innerHTML = html;

      toast("导入完成：新增 " + added + "，更新 " + updated);

    }



    if (!uniqDup.length) { applyRows(parsed); return; }



    var shown = uniqDup.slice(0, 5).map(esc).join("、");

    var more = uniqDup.length > 5 ? " 等 " + uniqDup.length + " 个" : "";

    ask("存在同名建筑物",

      "导入的文件中有 <b>" + uniqDup.length + "</b> 个建筑物与现有数据<b>名称完全相同</b>（" + shown + more + "）。如何处理？",

      [

        { t: "覆盖更新", cls: "btn-confirm2", v: "overwrite" },

        { t: "保留现有", cls: "btn-cancel", v: "keep" },

        { t: "取消导入", cls: "btn-exit", v: "cancel" }

      ],

      function (mode) {

        if (mode === "cancel") { $("batchBldResult").innerHTML = "<p style='color:#888'>已取消导入，未作任何改动。</p>"; return; }

        applyRows(mode === "overwrite" ? parsed : parsed.filter(function (p) { return !existName[p.name]; }));

      });

  }

  // base64（NO_WRAP）→ Uint8Array（用于 XLSX/ZIP 通过 JSZip 在 WebView 内解包）

  function base64ToBytes(b64) {

    var bin = atob(b64);

    var len = bin.length;

    var bytes = new Uint8Array(len);

    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);

    return bytes;

  }



  /* ---------- CSV 解析 ---------- */

  function parseCSV(text) {

    if (text == null) return [];

    // 剥离 UTF-8 BOM（EF BB BF），否则首列表头会被污染（如 ﻿name），导致"未找到名称列"

    text = String(text).replace(/^\uFEFF/, "");

    var rows = [];

    var row = [], field = "", inQuotes = false;

    for (var i = 0; i < text.length; i++) {

      var c = text[i];

      if (inQuotes) {

        if (c === '"') {

          if (text[i + 1] === '"') { field += '"'; i++; }

          else inQuotes = false;

        } else field += c;

      } else {

        if (c === '"') inQuotes = true;

        else if (c === ',' || c === '\t' || c === ';') { row.push(field); field = ""; }

        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }

        else if (c === '\r') { /* skip */ }

        else field += c;

      }

    }

    if (field || row.length) { row.push(field); rows.push(row); }

    return rows;

  }



  /* ---------- XLSX 解析（基于 JSZip） ---------- */

  function parseXlsx(zip) {

    return zip.file("xl/sharedStrings.xml").async("string").then(function (ssXml) {

      var ssDoc = new DOMParser().parseFromString(ssXml, "application/xml");

      var strings = [];

      var sis = ssDoc.getElementsByTagName("si");

      for (var i = 0; i < sis.length; i++) {

        var ts = sis[i].getElementsByTagName("t");

        var s = "";

        for (var j = 0; j < ts.length; j++) s += (ts[j].textContent || "");

        strings.push(s);

      }

      return strings;

    }).then(function (strings) {

      return zip.file("xl/worksheets/sheet1.xml").async("string").then(function (wsXml) {

        var wsDoc = new DOMParser().parseFromString(wsXml, "application/xml");

        var rows = [];

        var rowEls = wsDoc.getElementsByTagName("row");

        for (var i = 0; i < rowEls.length; i++) {

          var cells = rowEls[i].getElementsByTagName("c");

          var rowData = [];

          var maxCol = 0;

          for (var j = 0; j < cells.length; j++) {

            var ref = cells[j].getAttribute("r") || "";

            var colLetters = ref.replace(/[0-9]/g, "");

            var colIdx = 0;

            for (var k = 0; k < colLetters.length; k++) colIdx = colIdx * 26 + (colLetters.charCodeAt(k) - 64);

            colIdx = Math.max(0, colIdx - 1);

            var type = cells[j].getAttribute("t");

            var vEl = cells[j].getElementsByTagName("v")[0];

            var isEl = cells[j].getElementsByTagName("is")[0];

            var val = "";

            if (type === "s" && vEl) {

              val = strings[parseInt(vEl.textContent)] || "";

            } else if (type === "inlineStr" && isEl) {

              var tEl = isEl.getElementsByTagName("t")[0];

              val = tEl ? tEl.textContent : "";

            } else if (vEl) {

              val = vEl.textContent;

            }

            while (rowData.length < colIdx) rowData.push("");

            rowData[colIdx] = val;

            if (colIdx > maxCol) maxCol = colIdx;

          }

          while (rowData.length <= maxCol) rowData.push("");

          rows.push(rowData);

        }

        return rows;

      });

    });

  }





  function showStats() {

    var byType = {}, byOffice = {}, pts = 0, lns = 0, ph = 0, totalPhotos = 0, totalInspect = 0, inspBuildings = 0;

    BUILDINGS.forEach(function (b) {

      byType[b.btype || "其他"] = (byType[b.btype || "其他"] || 0) + 1;

      byOffice[b.office || "未设置"] = (byOffice[b.office || "未设置"] || 0) + 1;

      if (b.geom === "Point") pts++; else if (b.geom === "Line") lns++;

      var np = (b.photos || []).length;

      if (np) { ph++; totalPhotos += np; }

      var ni = (b.inspections || []).length;

      if (ni) { inspBuildings++; totalInspect += ni; }

    });

    function top(o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, 6)

      .map(function (k) { return k + "：" + o[k]; }).join("　"); }

    $("genTitle").textContent = "统计";

    $("genBody").innerHTML =

      '<div class="stat-grid">' +

      '<div class="stat-box"><div class="n">' + BUILDINGS.length + '</div><div class="t">建筑物总数</div></div>' +

      '<div class="stat-box"><div class="n">' + pts + '</div><div class="t">点（闸/桥等）</div></div>' +

      '<div class="stat-box"><div class="n">' + lns + '</div><div class="t">线（渠道）</div></div>' +

      '<div class="stat-box"><div class="n">' + totalPhotos + '</div><div class="t">总照片数</div></div>' +

      '<div class="stat-box"><div class="n">' + ph + '</div><div class="t">含照片建筑</div></div>' +

      '<div class="stat-box"><div class="n">' + totalInspect + '</div><div class="t">巡视次数</div></div>' +

      '<div class="stat-box"><div class="n">' + inspBuildings + '</div><div class="t">已巡视建筑</div></div></div>' +

      "<p style='margin-top:14px;color:#555;font-size:12px'>含照片建筑 = 含 ≥1 张照片的建筑物数；总照片数 = 全部照片合计（含系统内置+导入）。</p>" +

      "<p style='margin-top:14px'><b>按类型</b><br>" + esc(top(byType)) + "</p>" +

      "<p><b>按管理所</b><br>" + esc(top(byOffice)) + "</p>";

    openSheet("sheetGen");

  }



  /* ---------- 帮助 / 关于 ---------- */

  function showHelp() {

    $("genTitle").textContent = "功能介绍";

    $("genBody").innerHTML =

      "<p style='font-size:13px;color:#555;margin-bottom:6px'>水利工程基础信息一张图 · 四端（Android / iOS / Win11 / 统信 UOS）功能一致，以下为常用功能指引。</p>" +

      "<p><b>① 筛选</b>：按管理处 / 管理所 / 管理站 / 建筑物类型组合过滤，或顶部搜索框关键字检索；筛选默认值持久化（重启即套用）。</p>" +

      "<p><b>② 添加</b>：菜单「添加建筑物」→ 点地图放置 → 填写信息、上传多张照片。</p>" +

      "<p><b>③ 修改 / ④ 删除</b>：点击标记弹出 → 「修改」编辑，或「删除」。</p>" +

      "<p><b>⑤ 导航</b>：弹窗点「导航」，唤起手机已装地图 App。</p>" +

      "<p><b>⑥ 测距 / ⑦ 周边搜索</b>：菜单「测距」依次点地图取各段距离；「周边搜索」选中心与半径查范围内建筑，支持当前位置 / 地图选坐标 / 按类型筛选。</p>" +

      "<p><b>⑧ 获取坐标</b>：菜单「获取坐标」支持 GPS 定位 / 点选地图 / 搜索建筑三种方式，可一键复制。</p>" +

      "<p><b>⑨ 快捷常用（收藏）</b>：菜单项右侧 ☆ 点选收藏；子菜单内<b>长按 600ms</b>也可添加 / 移除「快捷常用」（与 ☆ 并存，解决手机/平板星标点不准、易误触），长按带振动与 toast 反馈。</p>" +

      "<p><b>⑩ 智能AI</b>：菜单「智能AI」可基于本地记录问答 / 补全 / 存疑标注（内部资料「本地辅助」不联网编造）；「设置 → 智能AI设置」可自定义大模型接口、多模型与自动调用策略。查询结果支持单击复制关键词 / 双击自动复制。</p>" +

      "<p><b>⑪ 知识库</b>：菜单「设置 → 知识库管理」可读取外部文件（pdf/xls/doc/csv/txt/md / 网页 / 公众号）入库、导出 / 导入备份；智能查询与知识库查询融合（本地优先 🔒，允许时在线 🌐）。</p>" +

      "<p><b>⑫ 运行维护</b>：菜单「运行维护」含默认出发位置、运行维护计划、巡视检查、我的巡视路线与巡视时长汇总。</p>" +

      "<p><b>⑬ 设置</b>：天地图密钥（🗝️ 修改 / 添加，保存即重建底图）、管理所 / 管理站添加与改名、密钥隐藏（复制需密码）、恢复初始数据。</p>" +

      "<p><b>⑭ 导入 / 导出</b>：ovkmz / obj / CSV / XLSX / 照片批量导入；导出照片 / 建筑物表格（字段列可勾选、文件名可自定义）、ovkmz / obj（导出前对话框）。</p>" +

      "<p><b>⑮ 统计 / 版本变更 / 四端功能对照单</b>：信息与帮助内可看统计、版本变更与四端功能差异。</p>" +

      "<p><b>⑯ 错误日志排查</b>：若运行异常，菜单「信息与帮助 → 错误日志」可查看并复制最近脚本错误反馈。</p>" +
      "<p><b>⑰ 知识库智能检索（RAG）</b>：导入的文档智能切片（保持语句完整）并向量化，支持混合检索（向量+关键词+模糊）、内容反查条目、智能生成提示词与智能回答（引用标注来源）；知识库菜单内可「重建向量索引」「查看索引状态」。</p>" +
      "<p><b>⑱ 知识库入库与升级备份</b>：外部文档 pdf/docx/xlsx/csv/txt/md/网页 智能转 Markdown 入库（OCR 识别，全过程进度条）；升级数据导出可自定义文件夹与文件名（默认 水利一张图备份_YYYYMMDD.bak），导入前提示确认最新备份并覆盖数据。</p>" +
      "<p><b>⑲ 知识库导出与 GitHub 升级</b>：知识库管理导出 md/txt/html 可自定义文件名（默认 知识库_YYYYMMDD.md/.txt/.html）与保存文件夹（Android 原生目录选择，Win/UOS/iOS 走系统下载目录并提示）；「设置 → GitHub 升级（检测新版）」查询本渠道最新 Release 并列出四平台安装包下载。</p>" +

      (RELEASE_CHANNEL === "public"
        ? "<p style='color:#b8860b;margin-top:8px'>📢 当前为<b>公开测试版</b>：内置为演示数据，不含单位内部水利设施信息；导入/导出、智能AI 等均基于演示数据，便于功能验证与对外分发测试。</p>"
        : "<p style='color:#2e6b4f;margin-top:8px'>🔒 当前为<b>内部版</b>：含完整单位内部数据，仅限单位内部使用。</p>") +

      "<p style='color:#888;font-size:12px;margin-top:8px'>提示：三击顶部标题或点右下角悬浮按钮可快速打开菜单；app 启动时会记录当前版本 / 构建日期 / 运行平台，便于核对是否为最新版。</p>" +

      "<p>数据保存在本机（localStorage），「恢复初始数据」可清空改动。</p>";

    openSheet("sheetGen");

  }

  function showAbout() {

    var m = window.SHUILI_META || {};

    var env = detectEnv();

    // 制作环境（开发机固定信息）

    var buildEnv = [

      ["操作系统", "Windows 10 Pro"],

      ["CPU", "Intel Core i7-9700K @ 3.60GHz 8核"],

      ["GPU", "NVIDIA GeForce GTX 1660 Ti"],

      ["内存", "32 GB"],

      ["开发工具", "WorkBuddy + webview-app-packager"],

      ["地图引擎", "Leaflet 1.x + 天地图 API"],

      ["打包工具", "aapt2 + d8 + zipalign + apksigner"],

      ["构建日期", APP_BUILD_DATE],

      ["发布通道", RELEASE_CHANNEL === "internal" ? "内部版（含完整单位数据）" : "公开测试版（不含单位内部数据）"]

    ];

    // 建议使用环境

    var suggestEnv = [

      ["操作系统", "Android 8.0+ / iOS 12+ / Windows 10+"],

      ["屏幕", "5.0 寸以上，分辨率 720p+"],

      ["内存", "2 GB 以上"],

      ["存储", "50 MB 可用空间"],

      ["网络", "在线底图需联网，离线可查看标记"],

      ["权限", "定位（可选）、存储（导出）"]

    ];

    $("genTitle").textContent = "关于";

    $("genBody").innerHTML =

      "<h3 style='color:#16324f;margin:0 0 6px'>水利工程基础信息一张图</h3>" +

      "<p>作者：<b>" + AUTHOR + "</b></p>" +

      "<p>版本：<b>" + APP_VERSION + "</b>（" + APP_BUILD_DATE + "）</p>" +

      (RELEASE_CHANNEL === "public"
        ? "<p style='color:#b8860b'>📢 本程序为<b>公开测试版</b>：内置数据为演示示例，<b>不含任何单位内部水利设施信息</b>；AI 仅基于演示数据作答，请自行在「设置 → 智能AI设置」填写密钥。</p>"
        : "<p style='color:#2e6b4f'>🔒 本程序为<b>内部版</b>：含完整单位内部数据，仅限单位内部使用，请勿外传。</p>") +

      "<p>数据来源：奥维互动地图导出（水利工程基础信息.ovkmz）</p>" +

      "<p>共 " + (m.counts ? m.counts.total : BUILDINGS.length) + " 个要素（点 " + (m.counts ? m.counts.point : "") + " / 线 " + (m.counts ? m.counts.line : "") + "）</p>" +

      "<p>底图：天地图（CGCS2000）</p>" +

      "<hr style='border:none;border-top:1px solid #eee;margin:12px 0'>" +

      "<p style='font-weight:600;color:#16324f'>建议使用环境</p>" +

      "<table style='width:100%;font-size:13px;border-collapse:collapse'>" +

      suggestEnv.map(function (e) {

        return "<tr><td style='color:#888;white-space:nowrap;padding:3px 8px 3px 0'>" + esc(e[0]) + "</td><td style='padding:3px 0'>" + esc(e[1]) + "</td></tr>";

      }).join("") +

      "</table>" +

      "<hr style='border:none;border-top:1px solid #eee;margin:12px 0'>" +

      "<p style='font-weight:600;color:#16324f'>制作环境</p>" +

      "<table style='width:100%;font-size:13px;border-collapse:collapse'>" +

      buildEnv.map(function (e) {

        return "<tr><td style='color:#888;white-space:nowrap;padding:3px 8px 3px 0'>" + esc(e[0]) + "</td><td style='padding:3px 0'>" + esc(e[1]) + "</td></tr>";

      }).join("") +

      "</table>" +

      "<hr style='border:none;border-top:1px solid #eee;margin:12px 0'>" +

      "<p style='font-weight:600;color:#16324f'>当前运行环境</p>" +

      "<table style='width:100%;font-size:13px;border-collapse:collapse'>" +

      env.map(function (e) {

        return "<tr><td style='color:#888;white-space:nowrap;padding:3px 8px 3px 0'>" + esc(e[0]) + "</td><td style='padding:3px 0'>" + esc(e[1]) + "</td></tr>";

      }).join("") +

      "</table>" +

      "<p style='color:#888;font-size:12px;margin-top:10px'>离线 WebView 版 · 支持筛选/增删改/多照片/测距/导航/周边搜索/奥维导入导出</p>";

    openSheet("sheetGen");

  }



  /* ---------- 版本变更 ---------- */

  var CHANGES = [

    { v: "v3.59", d: "2026-09-07", items: [
      "公开测试版（与感知 v1.35 / 古建 v3.7.5 同步）：①知识库管理导出 md/txt/html 支持自定义文件名（默认 知识库_YYYYMMDD.md/.txt/.html）+ 自选保存文件夹（Android 原生目录选择落 Download/指定目录；Win/UOS/iOS 回退系统下载目录并提示），共享模块 kbExport 三应用同步，改一处即三端生效；②数据脱敏修复：公开版内置数据切换为演示种子（data.js / kb_building_seed.js 用 .demo.js 覆盖），杜绝单位内部水利设施信息进入公开分发；③信息与帮助（功能介绍 / 版本变更 / 四端功能对照单）更新至 v3.59；④其余导出（建筑物表格 / 照片 / ovkmz / ovobj / obj / 升级备份）自定义文件夹与文件名逐一核查保持 + 各子菜单防「运行错误:script error」冒烟回归。"
    ]},

    { v: "3.58", d: "2026-09-05", items: [
      "修复安卓端升级菜单「下载更新包」点击报错：改由系统浏览器/网盘App接管打开（Win/iOS 不受影响）"
    ]},

    { v: "v3.56", d: "2026-09-05", items: [
      "内部版（含完整单位内部水利设施数据，仅限单位内部使用）：与感知 v1.32 / 古建 v3.7.3 同步。偶数版保留真实水利建筑物坐标/管理所/设计参数，程序标注「内部版」。知识库智能化/OCR/升级备份/四端对照单与 v3.55 相同。"
    ]},

    { v: "v3.55", d: "2026-09-05", items: [
      "知识库智能化与三端四平台同步（与感知 v1.31 / 古建 v3.7.3 同步，功能不删不减）：①知识库切片保持语句相对完整——以「整句」为最小粒度递归打包（段落→句末标点→逗号级→极端硬切兜底），重叠按整句回溯并预留空间保证不超长，切片绝不在句中截断；②知识库保存前先切片再落盘——新增条目/文档导入/网页入库/OCR入库/Hermes沉淀/查询保存全部经 kbSave 统一写入口，先按句切片（chunks+签名缓存，正文变更才重切）随条目一起保存，向量索引优先复用已存切片；③RAG 智能检索四端同步：向量余弦 0.45 + BM25 0.35 + 模糊 0.20 混合检索、内容反查条目、模糊/智能查询、智能生成提示词、结合已接入大模型的智能问答（引用标注[1]，失败降级抽取式答案）、记忆管理 + Hermes 自我学习；④轻量化 OCR 读取外部文档(pdf/docx/xlsx/csv/txt/md)智能转 md 入库同步四端；⑤升级数据导出自定义文件夹/文件名（默认 水利一张图备份_YYYYMMDD.bak），导入增加「请确认这是最新备份，导入会覆盖程序中的全部数据」预检与合并/覆盖双模式，导出→导入闭环实测 14/14 通过；⑥内部版（偶数通道）支持百度网盘自动升级；⑦写备忘录/写游记「运行错误:script error」修复（宿主数据数组 getter 桥接）；⑧信息与帮助→功能介绍/版本变更/四端功能对照单全面更新至 v3.55。Android / Win11 MSI+EXE / 统信 UOS deb / iOS PWA 四平台全量同步（含 kb_rag.js / ocr / kb_building_seed），改动前已备份可回退。"
    ]},
    { v: "v3.53", d: "2026-09-04", items: [
      "修复设置菜单（升级数据导出/导入/软件升级）与备忘录菜单「运行错误:script error」——宿主闭包函数($/esc/toast/getReleaseChannel/save等)全局桥接；知识库导入导出改为主流知识库格式 md/txt/html（按标题智能分条、同名条目更新不重复、兼容旧zip/json备份）；外部文件 .pdf/.docx/.xlsx/.csv 自动智能转 Markdown 入库（全过程进度条，旧版 .doc/.xls 提示另存）。"
    ]},
    { v: "v3.51", d: "2026-09-04", items: [
      "公开测试版：运行维护菜单新增「写备忘录 / 我的备忘录」（所见即所得编辑器：字体/字号/表情符号/图片/表格，默认绑定建筑物，支持关键词筛选与智能AI 查询）。"
    ]},
    { v: "v3.50", d: "2026-09-04", items: [
      "内部版（含完整单位内部水利设施数据，仅限单位内部使用）：奇偶双通道发版机制落地——偶数版保留真实水利建筑物坐标/管理所/设计参数，程序标注「内部版」。"
    ]},

    { v: "v3.49", d: "2026-09-02", items: [
      "文档与诊断增强（功能不删不减，与感知 v1.25 / 古建 v3.7 同步）：①菜单「帮助」更名为「功能介绍」，消除与「关于」歧义，并补全新增功能说明（快捷常用长按、智能AI、知识库、运行维护、设置-天地图密钥/管理所、错误日志排查、统计、导出自定义文件名等）；②信息与帮助→版本变更、四端功能对照单增补至 v3.49（含 v3.42–v3.48 智能AI×知识库深度融合、5级景区组织、天地图密钥/管理处、最长匹配、回归修复、UOS 浏览器壳+no-store+启动日志等）；③新增全平台启动诊断：app 启动即在控制台与本地诊断缓冲记录当前版本/构建日期/运行平台（UOS 另由 server.py 写入 launch_err.log，版本号随版本自动更新），便于发现「装了新版却显示旧版」；④UOS 保留 no-store 防缓存头与每次启动写 launch_err.log + install.log。"
    ]},
    { v: "v3.48", d: "2026-09-01", items: [
      "修复与优化（统一三日经验教训的收敛版本，功能不删不减）：①子菜单「长按 600ms」即可添加/移除「快捷常用」——与右侧 ☆ 并存，解决手机/平板上 15px 星标点不准、易误触；②UOS deb 统一修复：纯浏览器壳（零 PyQt6，龙芯不崩壳）、control 补全 postinst/postrm/md5sums、postinst 以 dpkg -L 收敛历史残留、每端独立端口（7205/7206/7207）；③Win MSI/EXE 根治 WebView2 E_ACCESSDENIED（userDataFolder 用户可写）+ 出包修复标记门禁；④webroot 垃圾清理与打包剪枝。"
    ]},
    { v: "v3.46", d: "2026-08-31", items: [
      "回归修复（已知问题修复，功能不删不减）：①导出建筑物表格/导出照片菜单 script error 修复并打通；②全菜单运行错误回归（window.onerror 全局拦截 + 关键菜单 path 兜底）；③导入压缩包照片回退至 level-aware 三级匹配（按 局→管理处→所→站→段 longest-match）；④筛选 管理所/管理站/建筑物类型「添加成功」生效修复（persist + SETTINGS 写入）；⑤历史关键词上移紧挨查询关键词；⑥本地智能查询增强（无 KB 条目时改用 App 自有组织数据作答）；⑦AI 结果提示进一步操作 + 单击/双击复制关键词；⑧隐藏当前密钥显示，复制需密码 3305。"
    ]},
    { v: "v3.30", d: "2026-08-24", items: [

      "修复（安装后中间空白 / 运行错误 Script error @0:0 · 根因）：assets 目录缺失 leaflet 地图库（leaflet/leaflet.js + leaflet/leaflet.css），index.html 引用但文件不存在，导致 Leaflet 全局 L 未定义、initMap() 抛错、地图空白且无法操作。已从同源版本补回 leaflet 目录（约 164KB），重打 APK 后地图正常加载、全部功能可用。",

      "统一（风格/规范）：与感知项目对齐——每页保留「退出当前页面」按钮、三击空白呼出主菜单；菜单与页面配色、背景、字号沿用统一主题变量，未删除任何已有功能与菜单。"

    ]},

    { v: "v3.29", d: "2026-08-24", items: [

      "修复（安装无桌面图标/不提示打开 · 根因）：AndroidManifest.xml 的 Launcher category 误写为 android.category.LAUNCHER（少了 intent.），系统无法识别启动入口。改为标准 android.intent.category.LAUNCHER，重打 APK 后安装正常出图标、可打开（与感知同步修复）。"

    ]},

    { v: "v3.29", d: "2026-08-22", items: [

      "新增（巡视检查 · 反向同步自 古建打卡）：菜单「巡视检查」分组，支持对建筑物记录照片 + 巡查时间 + 巡查时长 + 巡查情况，自动记入「我的巡视路线」（按巡查时间从新到旧排列，可一键定位）。",

      "新增：地图弹窗、列表视图、统计页均显示「已巡视 N 次 / 已巡视建筑」；导出建筑物表格新增「巡视次数」可选列。"

    ]},

    { v: "v3.28", d: "2026-08-21", items: [

      "功能（照片跨平台显示 · 修复 UOS「没有可导出照片」）：统一照片相对路径约定 photos/<管理所>/<建筑物>/<序号>.jpg，桌面/iOS 端 photoSrc 改为按本地 HTTP 服务 origin 解析相对路径（webroot/photos/…），与安卓原生落盘共用同一套路径，复制文件夹即跨平台显示，无需重新导入。",

      "功能（照片跨平台同步菜单 · 需求⑤）：传输与共享新增「从安卓复制照片」（把安卓导出的 photos 文件夹并入本端，直接显示、不占内存）与「从安卓平台导出照片」（安卓原生/浏览器两种方式整包导出）；信息与帮助新增「照片」页，展示四端存放位置与目录约定，便于核对复制正确性。",

      "功能（收藏窗口 · 需求⑦）：原「收藏位置/返回收藏位置」升级为「收藏窗口/放回收藏窗口」，记录当前视窗四角经纬度（可收藏多个窗口），放回一键 fitBounds 复原；多收藏时弹窗选择/删除。",

      "修复（删除内置照片 · 需求⑨）：移除 6 张西田各庄所跌水内置照片（images/pic_1..6.jpg），它们在安卓端显示为 ×、其它端无法加载；现内置照片引用为 0，全部 557 个建筑物保留。",

      "优化（照片导入/导出 UX · 需求②③⑥）：导入选择文件后显示「请稍后」忙提示；UOS 8G 内存机明确提示「不要走浏览器打包导入，直接复制文件夹」，规避导入 ZIP 卡死；导出前显示「请稍后」，同名文件提示覆盖；无匹配照片时提供「查看照片」入口人工核对。",

      "核对（需求⑧）：管理所名称统一（normOffice）此前已实现——导入/导出去「管理」、潮河管理所/潮河总干渠管理所→潮河所、查询/筛选忽略「管理」、站≠所不参与合并；本轮回归确认无回退。"

    ]},

    { v: "v3.27", d: "2026-08-21", items: [

      "统一（服务端口）：四端本地服务端口由 8899 统一改为 7205——Win11 启动器（PowerShell HttpListener）与统信 UOS 启动器（python3 -m http.server）现在使用同一端口，避免与企业/校园网常见的 8899 服务冲突，也便于后续集中运维。",

      "统一（版本号）：全链路版本号 3.26 → 3.27 同步——前端 app.js 的 APP_VERSION、Win11 NSIS 安装器、UOS DEB 的 control Version、Android 的 versionCode/versionName、iOS PWA 的 manifest 版本字段一次对齐，系统安装页与 App「关于」显示一致。",

      "修复（文档与启动说明）：修正 Win11 安装说明中过时的「file:// 直接打开」「运行 run.bat」描述（run.bat 已弃用、启动已走本地 HTTP 服务），改为「双击启动 → 浏览器自动打开 http://127.0.0.1:7205/」；四端功能对照单与生成说明同步至 V3.27。",

      "核对（回归）：地图操作控件（放大/缩小/收藏/返回收藏）、管理所名称统一、ZIP 多层目录导入、图标双维度区分、四端功能对照单等 V3.26 已实现项，本轮回归确认无回退；node --check 通过、Win/UOS 启动器端口校验通过。"

    ]},

    { v: "v3.26", d: "2026-08-21", items: [

      "功能（地图操作控件）：页面右侧中部新增「＋ 放大 / － 缩小 / ☆ 收藏位置 / ⌂ 返回收藏位置」四个悬浮按钮。放大缩小与 Leaflet 内置控件一致；收藏位置将当前地图中心与缩放级别存入本地，返回收藏位置一键跳回并弹标记，离线可用。",

      "功能（管理所名称统一）：新增 normOffice() 统一处理——导入/导出时去掉“管理”二字（温泉管理所→温泉所、埝头管理所→埝头所），潮河管理所 / 潮河总干渠管理所→潮河所；查询/筛选时“管理”二字可忽略（史山所 与 史山管理所 视为同一管理所）；管理站(station) 是管理所下一级单位，不参与合并。覆盖 CSV/XLSX 表格导入、ovkmz/KMZ 导入、建筑物表格导出、ovkmz 导出分组、筛选列表去重、查询关键词匹配。",

      "功能（ZIP 多层目录导入）：导入建筑物表格 ZIP / 照片 ZIP 时递归搜索全部层级目录（JSZip 全路径查找），支持多层子目录结构。",

      "修复（UOS DEB 龙芯兼容 · 双重）：① data.tar.gz / control.tar.gz 改用 GNU_FORMAT（GNU tar 自家格式，无 PAX 扩展头）——修复龙芯 3A400 / 内核 4.19 老 gnu tar 报“不支持的 PAX tar 头部类型 'x'”；② data.tar.gz 内路径带 ./opt/shuili-map/ 前缀，修复 dpkg 报“无法创建 /opt/shuili-map/app.js.dpkg-new: 没有那个文件或目录”。",

      "核对（需求②⑤⑥⑦与原则）：图标颜色+形状双维度 + 左下角图例（v3.25）、查询/筛选置顶 + 实时计数 + 蓝/绿虚线圈选 + 单/多/零结果跳转、执行中「请稍后」忙提示、每页退出按钮 + 三击空白进主菜单、四端功能对照单子菜单等已实现项，本轮回归确认无回退。"

    ]},

    { v: "v3.25", d: "2026-08-20", items: [

      "功能（建筑物双维度区分 · 需求②）：不同建筑物类型用「颜色 + 形状」双重区分——标记水滴填充色取类型专属色（colorForType），中心白点内嵌该类型专属形状符号（shapeForType：● ■ ▲ ◆ ★ ⬢ ✚ ✖ 循环对应）。左下角图例同步升级：每个类型项展示「名称 + 彩色形状符号」，一眼可辨类型归属。颜色按类型名哈希唯一，形状按同类哈希循环，二者叠加保证两两易区分。",

      "核对（需求③④⑤⑥⑦及四端对照单）：导入同名建筑三选一覆盖 / 同文件 SHA-256 二次导入提示、智能模糊匹配（不确定在范围内确认）、每页退出按钮 + 三击空白进主菜单、执行中「请稍后」忙提示、查询/筛选置顶 + 实时计数 + 蓝/绿虚线圈选 + 单/多/零结果跳转、信息与帮助「四端功能对照单」子菜单等此前已实现项，本轮回归确认无回退。"

    ]},

    { v: "v3.24", d: "2026-08-19", items: [

      "功能（主界面查询圈选）：顶栏「🔍 查询」与搜索框回车 = 查询确认，与筛选同一套结果处理——0 个符合：弹窗提示并保留关键词；1 个符合：立即 flyTo 定位；多个符合：倒水滴高亮标记 + 绿色虚线圈（#2e8b57）刚好罩住全部 + 平滑飞入显示整圈。",

      "功能（筛选圈改浅蓝）：筛选「确认」的多结果圈选改为浅蓝色虚线圈（#4aa3e0），与主界面查询的绿色圈区分开（查询=绿，筛选=浅蓝）。",

      "功能（建筑物类型规范化）：主界面图例、筛选「建筑物类型」、编辑表单类型下拉统一改为规范类型清单，移除被误当类型的字段（西田各庄段引渠 / 技术指标 / 挖填方统计表 / “进水闸 部分缺少经纬度”等，仅影响分类显示，不删任何建筑），新增「泵站」「溢洪道」类型；历史遗留的非规范类型在编辑该建筑时仍保留可选项，避免被静默改写。"

    ]},

    { v: "v3.23", d: "2026-08-19", items: [

      "修复（导入提示真机不弹 · 根因）：kmz/ovkmz/建筑物表格导入时的重复文件与同名建筑物提示此前误用原生 confirm()/alert()，离线 Android WebView 不显示且默认返回 false，导致静默取消或静默覆盖。已全部改为自定义 ask() 对话框，提示必现。",

      "修复（导入覆盖逻辑）：现三处均弹窗——① 同名建筑物「覆盖更新 / 保留现有 / 取消导入」三选一；② 同一文件按 SHA-256 内容比对二次导入提示「已导入过，是否覆盖」；③ 解析不到任何建筑时给出原因提示。",

      "修复并调整（查询圈选）：筛选/查询「确定」后——0 个符合弹窗提示并保留面板；1 个符合立即跳转到该建筑物；多个符合倒水滴高亮 + 绿色虚线圈（accent #2e8b57）刚好罩住全部 + 平滑飞入显示整圈；无结果/导入异常提示统一改用 ask()。",

      "一致性：圈选虚线圈由蓝改绿，与 App 主题绿一致；所有弹窗仍走统一 ask() 与 CSS 变量，风格、背景、色彩、文字全 App 一致。"

    ]},

    { v: "v3.21", d: "2026-08-19", items: [

      "修复（真机崩溃 · 根因）：列表视图点击「✕ 退出列表」报 “Uncaught ReferenceError: toggleList is not defined”——toggleList 仅定义在 IIFE 闭包内，被列表内联 onclick 在全局作用域调用时找不到。已暴露为全局 window.toggleList。",

      "修复（真机崩溃 · 根因）：获取坐标界面「在地图上查看」报 “Uncaught TypeError: map.setView is not a function”——内联 onclick 里的 map 被解析到 <div id=\"map\"> 元素（浏览器具名元素全局变量特性），而非 Leaflet 地图实例。已改为走全局包装函数 window.appGoToMap 操作真实地图。",

      "修复（真机崩溃 · 根因）：传输进度弹层「关闭（传输在后台继续）」按钮报 “closeXferProgress is not defined”。已暴露为全局 window.closeXferProgress。",

      "修复（功能失效）：「复制坐标」「复制分享文字」在离线 Android WebView 中复制无效——navigator.clipboard.writeText 在无安全上下文/失焦时静默失败且无兜底。已新增通用 window.copyText，优先剪贴板 API、失败回退 textarea+execCommand，复制坐标/分享文字均走此通道。",

      "核对（需求覆盖）：查询/筛选置顶显眼、筛选「确认」按结果跳转（0 提示/1 直接定位/多则蓝色虚线圈罩全部并 fitBounds）、实时提示区、每个页面退出按钮+三击空白呼主菜单、忙提示浮层、导入同名覆盖三选一+同文件 SHA-256 二次导入提示、智能模糊匹配（不确定在范围内确认）等需求此前已实现，本轮回归验证通过。"

    ]},

    { v: "v3.20", d: "2026-08-18", items: [

      "性能（真机流畅度）：查询/筛选关键词输入增加 200ms 防抖——旧版每敲一键就全量重建地图全部标记（移除+重绘），建筑多时输入卡顿；现停止输入后才渲染，打字不再阻塞主线程，且筛选实时提示区仍同步刷新。",

      "修复（版本一致）：v3.16–v3.19 各版 AndroidManifest 版本号未随版本更新（系统安装包仍显示 3.17）。本轮统一升到 versionCode 18 / versionName 3.20，与 App 内「关于/版本变更」显示一致，避免旧包覆盖安装判断错误。",

      "核对（风格/防卡死）：全 App 菜单与页面风格统一（同一套 CSS 变量），每个页面均有「✕ 退出本页」+ 三击空白退出/回主菜单快捷操作；未删除任何已有功能与菜单。"

    ]},

    { v: "v3.19", d: "2026-08-18", items: [

      "修复（根因）：真机误触地图左下角“Leaflet”版权外链（指向 https://leafletjs.com/）后整个页面跳到外网，离线时停在「网页无法打开 net::ERR_CONNECTION_TIMED_OUT」错误页，怎么按都没反应——① 网页端关闭带外链前缀的默认版权控件，改为仅显示“天地图”文字（离线无任何外部跳转）；② 原生 WebView 拦截所有非 file:// 链接改交系统浏览器打开，主页面加载失败自动回本地首页，彻底杜绝“卡死在错误页”。",

      "修复（根因）：获取坐标等浅色页面按钮白字白底看不清——.tbtn 按钮样式原为深色顶栏设计（白字+半透明白底），在浅色弹层/弹窗里被复用导致对比度不足。已用上下文选择器统一修正：凡出现在弹层（.sheet）与地图弹窗（.leaflet-popup）内的 .tbtn 自动切换为“白底深字”浅色主题；并全量排查其它页面（传输设置、编辑参数、地图弹窗复制按钮等）同类白字白底问题一并修复。",

      "新增（数据安全）：导入 kmz/ovkmz/建筑物表格时，若存在与现有数据“名称完全相同”的建筑物，弹三选一对话框：「覆盖更新 / 保留现有 / 取消导入」，不再静默覆盖；同一文件再次导入（按内容 SHA-256 比对）也会提示“已导入过一次，是否覆盖”。",

      "优化（一致性）：新增通用多选确认对话框（#askBox），复用同一套 CSS 变量与配色，全 App 弹窗风格统一；对话框同样提供「✕」与三击空白关闭入口。",

      "优化（性能/整洁）：移除 Leaflet 默认版权外链控件（少一个外网请求入口）；对话框开关不残留 DOM。未删除任何已有功能与菜单。"

    ]},

    { v: "v3.18", d: "2026-08-18", items: [

      "修复（根因）：导入奥维 ovkmz 提示「导入解析失败：返回数据格式错误」——原生 escapeJson 只转义 \\ \" \\n \\r，未处理 TAB 等控制字符；奥维 KML 含大量 TAB，回传 JSON 含裸 TAB 导致 JSON.parse 抛 “Bad control character”。已重写为逐字符转义（TAB/\\b/\\f 及所有 <0x20 控制字符统一转义，并剥离 UTF-8 BOM），导入 557 个要素 + 6 张附件照片实测通过。",

      "修复（根因）：批量导入照片无法选中 ZIP / 7z / RAR 压缩包——旧版给原生选择器传了精确 MIME（application/x-7z-compressed 等），不同机型把 7z/rar 识别成 application/octet-stream，在选择器里被灰掉选不中。已改为传 \"*/*\"（与 kmz 导入一致），选中后在 onPickFiles 按扩展名分流：压缩包走原生 unzipImages，照片走匹配，其它文件无副作用。",

      "优化（防卡死）：三击空白由「仅呼主菜单」升级为「先关最上层弹层，否则呼主菜单」——等同于任意页面的「退出当前页面」快捷操作；传输/忙提示期间不响应，防误触。",

      "优化（防卡死 + 一致性）：列表视图新增顶部「✕ 退出列表」按钮，全 App 所有页面/弹层均具备显式退出入口（菜单/通用/编辑/筛选页的「✕ 退出本页」、灯箱 ×、长按照片操作条「✕ 退出」、列表「✕ 退出列表」）。",

      "优化（内存）：关闭灯箱/长按照片时主动清空大图 src，释放解码后的位图内存，降低多图浏览后的内存占用。",

      "风格统一：列表视图头部、退出按钮等沿用同一套 CSS 变量（--primary/--surface/--border/--muted），全 App 菜单与页面风格、背景、色彩、文字保持一致；未删除任何已有功能与菜单。"

    ]},

    { v: "v3.17", d: "2026-08-17", items: [

      "修复（根因）：批量导入建筑物点击 CSV 无响应——旧版用 <input type=file> + JS FileReader，在 Android 10+ 作用域存储下 WebView 无法读取选中的 content:// URI，导致「点了没反应」。已改为走原生 pickFiles 大文件选择器（与照片导入同一管线，落盘到 inbox 后再读取），新增原生 readFileText / readFileBase64 桥；CSV 经 readFileText、XLSX/ZIP 经 base64→JSZip 解包，导入全程加「执行中请稍后」忙提示。",

      "修复：parseCSV 增加 UTF-8 BOM 剥离，与导出 CSV 的 BOM 前缀形成正确往返（避免重导入报「未找到名称列」）。",

      "优化：筛选完成后导出默认仅导出筛选结果（可取消勾选导出全部），范围提示含命中数与筛选条件。",

      "核对：kmz/ovkmz 导入（原生 importKmz→onImportData）双向兼容奥维 okm，含附件照片引用解析；过大文件经 fileSha256 内容比对 + 续传 + 进度提示。导出 CSV/Excel/照片压缩包/ovkmz 各格式均可用。"

    ]},

    { v: "v3.16", d: "2026-08-17", items: [

      "修复（根因）：批量导入照片「手动匹配的照片不入库/不显示」——此前 3 次修复都只改 web JS，真实缺陷在原生平桥 LargeFileManager 缺 thumbPhoto/cleanInbox 两个方法，导致 photoSrc 退回全分辨率 base64，某建筑挂数百张照片时 WebView 解码 OOM 空白，看似「未绑定」实则已落盘。已从完整原生合并缩略图管线（720px 降采样 / RGB_565 / JPEG 72%）+ 清理临时目录，现手动/自动匹配照片均可正常渲染与绑定。",

      "修复：原生 unzipImages 改为异步回传 onUnzipImages 回调（旧版同步 return 会被 JS 丢弃并卡死导入）。",

      "优化：菜单 / 面板底色整体微调一档（更沉稳、层次更清晰，详见《APP 风格色彩字体搭配》文档）。",

      "核对并加固：查询 / 筛选 置顶显眼、筛选「确认」按结果跳转（0 提示 / 1 直接定位 / 多则用蓝色虚线圈罩住全部并 fitBounds）、实时提示区、退出本页按钮、三击空白呼主菜单、忙提示浮层、分享（微信/QQ/飞书/系统面板）、照片灯箱放大、kmz/ovkmz 与奥维 okm 双向兼容（含附件照片）等需求均已在 v3.6–v3.15 实现，本轮缺失项补齐并回归。",

      "新增：导出《APP 风格色彩字体搭配》文档，统一 CSS 变量（--primary / --bg / --accent 等），便于后期统一改色。"

    ]},

    { v: "v3.6", d: "2026-08-15", items: [

      "菜单重构为「一级 + 二级」：查询 / 筛选 置顶并列；地图和位置 / 数据管理 / 传输与共享 / 信息与帮助 四大分组（二级默认隐藏，点标题或 ＋ 展开）。",

      "照片 / ZIP 导入智能模糊匹配：在「相等 / 包含」之外，支持部分关键词、最长公共子串、编辑距离容错（错字 / 漏字 / 多字，如「峰山口大大.jpg」可匹配「峰山口」）。",

      "导入逐步匹配（文件夹 / ZIP）：先按顶层文件夹名匹配管理所或类型，再在该范围内按文件名模糊匹配；无匹配则进入人工选择。",

      "多选弹窗统一增加：全选 / 全部清除 / 取消 / 确认 / 退出 按钮（多匹配勾选、重复确认等）。",

      "所有页面（菜单 / 通用 / 编辑）均增加「退出本页」按钮，避免卡在当前页面。",

      "查询 / 筛选 提至顶栏显眼位置；筛选「确认」后按结果跳转：0 提示无符合条件，1 立即定位，多个跳到第一个。",

      "导入每张照片保存前按内容（SHA-256）比对，重复时弹「覆盖 / 跳过」并展示已有照片便于对比。",

      "长按照片（弹窗或灯箱）弹出操作条：保存图片 / 上一张 / 下一张 / 退出（多张可切换）。",

      "整体风格统一（CSS 变量驱动），并新增《APP 风格色彩字体搭配》文档便于后期修改。"

    ]},

    { v: "v3.4", d: "2026-08-13", items: [

      "修复：导航时地图App显示地点名称乱码（%E5%B3%B0…）——geo: 链接中地名不再做 URL 编码，直接传中文，高德/百度/腾讯可正常显示。",

      "优化：批量导入照片匹配逻辑——文件名末尾数字自动忽略（如“峰山口1.jpg”按“峰山口”匹配）；唯一匹配自动保存，匹配到多个建筑物时弹窗由用户勾选保存（可多选）；无匹配提示未匹配。",

      "新增：导出照片——按管理所分文件夹打包为 ZIP，建筑物多张照片自动加 _1、_2… 序号区分。",

      "新增：导出建筑物表格——可选导出字段列（名称/管理所/管理站/段/类型/经纬度/参数等，含自定义参数列），并可按管理所筛选导出范围，导出为 Excel 友好 CSV。",

      "修改：关于页作者改为“科技推广中心”。"

    ]},

    { v: "v3.3", d: "2026-08-13", items: [

      "修复：运行中弹出 “closeSheet is not defined” 错误，导致筛选“完成”、编辑“取消”等弹窗无法关闭——已将 openSheet/closeSheet 暴露为全局函数。",

      "修复：批量导入单张照片提示“未找到图片文件”——修正文件类型筛选函数缺少 return，导致 imageFiles 始终为空。",

      "修复/恢复：右上角底图“矢量/影像”切换开关；新增菜单项“底图切换（矢量/影像）”便于从菜单切换。",

      "优化：整体界面美化，统一配色、字体与弹窗/菜单/按钮间距阴影，提升协调度与可读性。",

      "新增：菜单“版本变更”，记录每个版本修复与更新。"

    ]},

    { v: "v3.2", d: "2026-08-13", items: [

      "修复：v3.1 因 app.js 引号未转义导致语法错误白屏/假死。",

      "增强：新增全局 window.onerror 兜底，运行期错误以 toast 提示，避免静默白屏。"

    ]},

    { v: "v3.1", d: "2026-08-13", items: [

      "列表视图下主菜单自动隐藏 → 增加右下角悬浮按钮(FAB)与三击标题快捷打开菜单。",

      "建筑物列表“基础”改为“快速定位”，点击快速进入地图并定位。",

      "新增“获取坐标”：支持 GPS、点选地图、搜索建筑物三种方式。",

      "所有弹出窗口增加关闭图标，防止找不到主菜单。",

      "新增批量导入照片（文件夹/zip，按文件名匹配）。",

      "新增批量导入建筑物（CSV/XLSX/zip，按经纬度或名称匹配）。"

    ]},

    { v: "v3.0", d: "2026-08-12", items: [

      "在线地图，支持矢量/影像切换（天地图 CGCS2000）。",

      "建筑物标记改为倒立蓝色水滴状，中间小白点。",

      "定位我的位置，未授权自动跳转系统设置。",

      "新增到建筑物导航（geo: URI 唤起第三方地图App）。",

      "距离测量（多段，显示分段与总距离）。",

      "周边搜索（按中心建筑物与半径）。",

      "智能调节功能菜单排列。",

      "自定义导出/导入目录。",

      "关于页：建议使用环境 + 制作环境 + 当前运行环境。",

      "替换天地图 token（服务器端/浏览器端）。"

    ]},

    { v: "v2.0", d: "2026-08-12", items: [

      "基础功能：列表定位、照片上传、底图选中状态同步、导出导入文件夹选择、关于制作环境、界面遮挡修复。"

    ]}

  ];



  /* ---------- 四端功能对照单（跨平台同步差异，平台原生能力允许不同） ---------- */

  var PLATFORM_COMPARE = [

    { v: "v3.59", d: "2026-09-07", note: "本版（公开测试版，与感知 v1.35 / 古建 v3.7.5 同步）：①知识库管理导出 md/txt/html 自定义文件名 + 自选文件夹（默认 知识库_YYYYMMDD.fmt）；②公开版数据脱敏为演示种子（data.js / kb_building_seed.js → .demo.js），杜绝内部设施数据外泄；③信息与帮助（功能介绍 / 版本变更 / 四端功能对照单）更新至 v3.59。", rows: [
      { f: "知识库导出 md/txt/html 自定义文件名 + 自选文件夹", a: "✅ 原生桥", i: "✅ 浏览器下载", w: "✅ 浏览器下载", u: "✅ 浏览器下载", n: "v3.59 默认 知识库_YYYYMMDD.md/.txt/.html，共享模块三应用同步" },
      { f: "公开版数据脱敏（演示种子替换内部数据）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.59 data.js/kb_building_seed.js 用 .demo.js 覆盖" },
      { f: "GitHub 升级（检测新版，查本渠道 Release）", a: "✅", i: "✅", w: "✅", u: "✅", n: "设置→GitHub 升级 列出四平台安装包" },
      { f: "写备忘录 / 我的备忘录（运行维护）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.51 新增，script error 已修复" },
      { f: "每页退出按钮 + 三击空白呼出主菜单", a: "✅", i: "✅", w: "✅", u: "✅", n: "全平台一致" }
    ]},

    { v: "v3.55", d: "2026-09-05", note: "本版（知识库智能化与四平台同步）：①知识库切片保持语句相对完整（整句打包，绝不在句中断开）；②知识库保存前先切片再落盘（统一写入口 + 签名缓存）；③RAG 智能检索/反向查询/智能问答/记忆+Hermes 四端同步；④OCR 外部文档入库四端同步；⑤升级备份导出自定义目录/文件名 + 导入预检（最新备份警示/合并-覆盖）；⑥内部版百度网盘自动升级；⑦备忘录/游记 script error 修复。", rows: [
      { f: "知识库智能切片（语句完整，保存前先切片）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.55 整句打包+签名缓存" },
      { f: "RAG 混合检索（向量+BM25+模糊）/ 内容反查条目", a: "✅", i: "✅", w: "✅", u: "✅", n: "kb_rag.js 随包，纯本地离线" },
      { f: "智能问答（大模型+知识库引用+记忆+Hermes）", a: "✅", i: "✅", w: "✅", u: "✅", n: "引用标注[1]；失败降级抽取式答案" },
      { f: "OCR 读取外部文档入库（pdf/docx/xlsx/csv）", a: "✅ 本地引擎", i: "✅ 浏览器 wasm", w: "✅ 本地引擎", u: "✅ 本地引擎", n: "智能转 Markdown 入库" },
      { f: "升级备份导出自定义目录/文件名（默认 水利一张图备份_YYYYMMDD.bak）", a: "✅ 原生桥", i: "✅ 浏览器下载", w: "✅ 浏览器下载", u: "✅ 浏览器下载", n: "导入预检：最新备份警示 + 合并/覆盖" },
      { f: "写备忘录 / 我的备忘录（运行维护）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.51 新增，v3.53 script error 已修复" },
      { f: "每页退出按钮 + 三击空白呼出主菜单", a: "✅", i: "✅", w: "✅", u: "✅", n: "全平台一致" }
    ]},

    { v: "v3.49", d: "2026-09-02", note: "本版（文档与诊断增强）：①菜单「帮助」更名为「功能介绍」，消除与「关于」歧义，并补全新增功能说明；②信息与帮助→版本变更、四端功能对照单增补至 v3.49；③新增全平台启动诊断：app 启动即在控制台与本地诊断缓冲记录当前版本 / 构建日期 / 运行平台（UOS 另由 server.py 写入 launch_err.log，版本号随版本自动更新），便于发现「装了新版却显示旧版」；④UOS 保留 no-store 防缓存头与每次启动写 launch_err.log + install.log；四平台同步保持。", rows: [

      { f: "功能介绍（原「帮助」改名，新增功能指引）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.49 消除与「关于」歧义" },

      { f: "全平台启动诊断（版本/平台随版本记录，便于排查旧版）", a: "✅ 控制台+本地", i: "✅ 控制台+本地", w: "✅ 控制台+本地", u: "✅ 控制台+本地", n: "v3.49 app 启动即记录；UOS 另写 launch_err.log" },

      { f: "UOS no-store 防缓存 + 每次启动写 launch_err.log/install.log", a: "—", i: "—", w: "—", u: "✅ 浏览器壳", n: "v3.48 起；浏览器永不缓存，打开即最新" }

    ]},

    { v: "v3.42–v3.48", d: "2026-08-29 → 2026-09-01", note: "期间跨版本重点（与感知 / 古建同步）：智能AI×知识库深度融合（本地优先 🔒 → 在线 🌐，来源标注，不再 script error）、发行前预生成建筑骨干知识库随包内置；设置新增天地图密钥（三层回退，保存即重建底图）；筛选新增管理处可多选 + 导出管理处列；ZIP 三级匹配升级为最长匹配；子菜单长按 600ms 添加 / 移除快捷常用（与 ☆ 并存）；UOS deb 统一修复（纯浏览器壳 + control 四件套 + 独立端口 7205/7206/7207 + Depends 不含 pyqt6）；Win MSI/EXE WebView2 userDataFolder 改用用户可写目录根治 E_ACCESSDENIED；webroot 垃圾清理与打包剪枝。", rows: [

      { f: "智能AI×知识库深度融合（本地优先→在线兜底，来源标注）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.42/v3.43 本地🔒/在线🌐，无结果友好提示" },

      { f: "建筑骨干知识库随包内置（可导出/导入/重新播种）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 起 557 条内置" },

      { f: "设置→天地图密钥（三层回退，保存即重建底图）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.45 加；复制密钥需密码" },

      { f: "筛选→管理处可多选 + 导出管理处列", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.45 管理处/所/站共用组织体系" },

      { f: "ZIP 三级匹配升级为最长匹配（局→处→所→站→段）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.45 避免「史山/温泉」误命中" },

      { f: "子菜单长按 600ms 添加/移除快捷常用（与 ☆ 并存）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.48 解决手机星标点不准误触" },

      { f: "UOS deb 纯浏览器壳 + control 四件套 + 独立端口", a: "—", i: "—", w: "—", u: "✅ mips64el/loongarch64/arm64/amd64", n: "v3.48 龙芯不再崩壳，三端同机不撞端口" },

      { f: "Win MSI/EXE WebView2 userDataFolder 用户可写（根治 E_ACCESSDENIED）", a: "—", i: "—", w: "✅", u: "—", n: "v3.48 修复标准用户启动拒绝访问" }

    ]},

    { v: "v3.41", d: "2026-08-29", note: "本版（智能AI×知识库深度融合 + 交互修复）：①发行前预生成建筑骨干知识库（kb_building_seed.js 随安装包内置，安装即有本地KB）；②智能AI查询与知识库查询融合为同一引擎：先查本地KB（标注🔒本地），本地无且允许联网再走大模型（标注🌐在线），全程异常兜底不再出现「运行错误: script error」，查询前有确认按钮；③知识库支持读取网页入库（普通网页/微信公众号/微博）；④智能更新补丁预览改为可编辑输入框；⑤修复筛选照片状态点击卡顿/死机（事件委托）；⑥筛选管理所/管理站支持手动添加与改名（逐个确认同步建筑物），添加/编辑建筑物表单改下拉选择；⑦筛选关键词历史记录（可展开/收起）；⑧周边搜索新增「当前位置」「地图选坐标」中心 + 按周边建筑物类型筛选；⑨导出建筑物表格/照片管理所覆盖全部9所并按建筑物自动匹配；⑩导出 ovkmz/ovobj/照片/表格均支持自定义文件名。", rows: [

      { f: "发行前预生成建筑骨干知识库（随包内置）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 kb_building_seed.js 安装即有本地KB，可导出/导入" },

      { f: "智能AI×知识库查询融合（本地优先→在线兜底，来源标注）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 🔒本地/🌐在线标注；无结果友好提示，不再 script error" },

      { f: "知识库读取网页入库（普通/微信公众号/微博）", a: "✅ Web", i: "⚠️ 受限", w: "✅ Web", u: "⚠️ 受限", n: "v3.41 受目标站跨域限制，失败时提示改用复制粘贴入库" },

      { f: "智能更新补丁可编辑（应用前逐字段修改）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 预览字段改输入框" },

      { f: "筛选照片状态点击卡顿/死机修复", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 事件委托，不再重建DOM/全量render" },

      { f: "管理所/管理站手动添加与改名（逐个确认同步）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 持久化记录；改名逐个确认并同步受影响建筑物" },

      { f: "添加/编辑建筑物管理所/管理站下拉选择", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 从持久化记录读取" },

      { f: "筛选关键词历史记录（可展开/收起）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 本地持久化，最近若干条" },

      { f: "周边搜索：当前位置/地图选坐标为中心 + 类型筛选", a: "✅ 定位", i: "✅ 定位", w: "✅ 定位", u: "⚠️ 手动", n: "v3.41 定位不可用时自动引导改用地图选坐标" },

      { f: "导出建筑物表格/照片管理所覆盖全9所 + 按建筑自动匹配", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 名称归一化比较，无照片的所标注" },

      { f: "导出文件名可编辑（ovkmz/ovobj/照片/表格）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.41 ovkmz/ovobj 增加导出前对话框（含范围）" }

    ]},

    { v: "v3.31", d: "2026-08-25", note: "本版（三端四平台 + 小程序基线全面同步）重点修复导入导出与安装问题：①ovobj/obj 导入导出仿 ovkmz 支持「选单个文件 / 选整个文件夹批量」，弹窗列明可选后缀（.ovobj/.obj/.txt/.csv），根治「点了没反应 / 不知从哪导入 / 文件夹卡死」；②原生桥 escapeJson 补转义单引号，根治文件名含 ' 时的「运行错误：Script error. @0:0」；③新增 pickFolder（ACTION_OPEN_DOCUMENT_TREE 递归枚举最多 6 层按后缀过滤）；④建筑物与照片同时添加时表单文字实时回写（flushEditFields），不再丢失已填信息；⑤导出 zip 照片前先压缩（>1.5MB 走 canvasCompress）；⑥UOS DEB 架构对照修正（龙芯 3A3000/3A4000→mips64el、3A5000+→loongarch64、FT2000/鲲鹏→arm64、其余→amd64），支持 ARCH= 覆盖，修复「架构不匹配」安装失败；⑦三产品四平台 webroot 全量同步，index.html 补加载 ovobj_bridge.js。按管理所导入/导出照片含全部管理所；最佳匹配照片（ambiguous）选择后正常保存（linkOrBase64 仅成功才计数）。", rows: [

      { f: "导入 ovobj/obj（单文件 + 文件夹，仿 ovkmz）", a: "✅ 原声+文件夹", i: "✅ Web", w: "✅ Web", u: "✅ Web", n: "v3.31 新增文件夹批量导入（pickFolder 递归枚举），弹窗列明 .ovobj/.obj/.txt/.csv" },

      { f: "导出 ovobj/obj（奥维坐标，含 UOS）", a: "✅ 原声", i: "✅ Web", w: "✅ Web", u: "✅ Web", n: "v3.31 index.html 全平台补加载 ovobj_bridge.js" },

      { f: "导入/导出 txt/csv 坐标文本", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.31 与 ovobj 同路径：单文件 + 文件夹选择" },

      { f: "文件名含 ' 的 escapeJson 转义（修复 Script error @0:0）", a: "✅ 原声桥", i: "—", w: "—", u: "—", n: "v3.31 MainActivity.escapeJson 补转义单引号，仅 Android 原声桥受影响" },

      { f: "导出 zip 照片先压缩（>1.5MB canvasCompress）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.31 导出体积大幅下降" },

      { f: "建筑物 + 照片同时添加不丢失信息（flushEditFields）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.31 表单 oninput 实时回写" },

      { f: "最佳匹配照片保存（ambiguous→linkOrBase64 仅成功计数）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.31 修复「完全匹配可存、最佳匹配存不了」" },

      { f: "按管理所导入/导出照片（含全部管理所）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.31 覆盖全部管理所，UOS 同样可用" },

      { f: "UOS DEB 架构对照（mips64el 等，修复架构不匹配）", a: "—", i: "—", w: "—", u: "✅ mips64el", n: "v3.31 make_deb.py 修正架构表，3A4000→mips64el，支持 ARCH= 覆盖" },

      { f: "三产品四平台 webroot 全量同步 + 小程序基线", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.31 水利/感知/古建 × Android/UOS/Win/iOS 一致；小程序对齐版本+配色" },

      { f: "四端退出当前页按钮 + 三击空白弹主菜单", a: "✅", i: "✅", w: "✅", u: "✅", n: "全端一致（v3.6 起已含，v3.31 回归确认）" }

    ]},

    { v: "v3.30", d: "2026-08-24", note: "v3.30：补齐 assets/leaflet（修复安装后中间空白 + Script error @0:0）。v3.30.2：四端同步打包（版本号对齐 .2 系列）。v3.30.3 照片性能三件套——①筛选/查询高亮 marker 弹窗改懒构造（修复 500+ 建筑点「有照片/无照片」筛选卡死根因）；②显示改走持久化缩略图 ensureThumb（.thumbs 缓存，首次生成后永久复用，不再每次解码 7M 原图）；③导入压缩：>1.5M 大图导入时（zip 批量/ovkmz/单张添加/巡视）弹窗选压缩目标（200K/500K/1M/不压缩，默认 500K），原声 4 并发压缩带进度条，只存压缩版。", rows: [

      { f: "补齐 assets/leaflet（修复安装空白 + Script error）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.30 修复安装后白屏/假死" },

      { f: "筛选/查询高亮 marker 懒构造（防 500+ 点卡死）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.30.3 修复大量建筑点筛选卡死" },

      { f: "持久化缩略图 ensureThumb（.thumbs 缓存复用）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.30.3 不再每次解码 7M 原图" },

      { f: "导入大图压缩（200K/500K/1M/不压缩）", a: "✅ 原声4并发", i: "⚠️ Web", w: "⚠️ Web", u: "⚠️ Web", n: "v3.30.3 原声 4 并发带进度条；非 Android 走 Web 压缩" },

      { f: "四端同步打包（版本号对齐）", a: "✅ 3.30.2", i: "✅ 3.30.2", w: "✅ 3.30.2", u: "✅ 3.30.2", n: "v3.30.2 四端一致" }

    ]},

    { v: "v3.29", d: "2026-08-24", note: "v3.29：独立包名 com.shuili.yitu（三应用可同装）、render() 改 marker 差异更新 + popup 懒构造（修复卡顿）、筛选激活时关闭视窗裁剪（修复蓝圈缺失）、含图无表 ZIP 引导转「批量导入照片」、xferOverlay z-index 提至 3000 + 解压进度回调、新增「运行维护」菜单（默认出发位置/运行维护计划/巡视检查/我的巡视路线）与巡视时长汇总、照片灯箱放大。", rows: [

      { f: "独立包名 com.shuili.yitu（三应用可同装）", a: "✅", i: "—", w: "—", u: "—", n: "v3.29 三应用不再互相覆盖" },

      { f: "marker 差异更新 + popup 懒构造（修复卡顿）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.29 性能优化" },

      { f: "筛选激活时关闭视窗裁剪（修复蓝圈缺失）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.29 圈选高亮修复" },

      { f: "运行维护菜单（巡视计划/路线/时长汇总）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.29 新增" },

      { f: "照片灯箱放大", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.29 新增" }

    ]},

    { v: "v3.28", d: "2026-08-21", note: "本版重点：照片跨平台显示修复（UOS「没有可导出照片」）+ 照片跨平台同步菜单 + 收藏窗口 + 删除内置照片。统一照片相对路径 photos/<管理所>/<建筑物>/<序号>.jpg，桌面/iOS 经本地 HTTP 服务按需读取，与安卓共用同一路径约定，复制文件夹即复用，规避 UOS 8G 内存瓶颈。", rows: [

      { f: "照片跨平台显示（相对路径 HTTP 读取）", a: "✅ 原生落盘", i: "✅ HTTP", w: "✅ HTTP", u: "✅ HTTP", n: "v3.28 统一路径约定，复制文件夹即跨端显示，UOS 不再「没有可导出照片」" },

      { f: "从安卓复制照片（并入 photos 目录，不导入内存）", a: "—", i: "✅ 说明", w: "✅ 说明", u: "✅ 说明", n: "v3.28 新增：解压安卓导出包到 photos/ 后「重新扫描」即可" },

      { f: "从安卓平台导出照片（整包）", a: "✅ 原生/Web", i: "—", w: "—", u: "—", n: "v3.28 新增：安卓原生打包不占内存；UOS 不推荐浏览器打包" },

      { f: "照片信息（四端目录与命名）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.28 新增：信息与帮助→照片" },

      { f: "收藏窗口（记录视窗四角/放回 fitBounds）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.28 由「收藏位置」升级，可收藏多个窗口" },

      { f: "删除内置照片（pic_1..6）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.28 移除 6 张不可显示的西田各庄所跌水内置照片" },

      { f: "管理所名称统一（去「管理」/潮河并归/查询忽略）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.26 已实现，v3.28 回归确认无回退" },

      { f: "照片导入/导出「请稍后」+ 同名覆盖提示", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.28 增强 UX" }

    ]},

    { v: "v3.27", d: "2026-08-21", note: "本版为端口与版本号统一发布版：四端本地服务端口统一为 7205（Win11 PowerShell HttpListener / UOS python3 http.server），版本号 3.26→3.27 全链路对齐（app.js / Win NSIS / UOS deb / Android Manifest / iOS PWA manifest）；修正过时启动文档。功能模块与 V3.26 一致，无功能回退。", rows: [

      { f: "服务端口统一（Win11 / UOS 本地 HTTP）", a: "—", i: "—", w: "✅ 7205", u: "✅ 7205", n: "v3.27 统一为 7205（原 8899）" },

      { f: "版本号全链路一致（app / NSIS / deb / Manifest / PWA）", a: "✅ 3.27", i: "✅ 3.27", w: "✅ 3.27", u: "✅ 3.27", n: "v3.27 一次对齐" }

    ]},

    { v: "v3.26", d: "2026-08-21", note: "本版新增：地图操作控件（放大/缩小/收藏位置/返回收藏位置）、管理所名称统一（去“管理”、潮河并归、查询筛选忽略“管理”）、ZIP 多层目录导入；UOS DEB 修复龙芯兼容（GNU tar 无 PAX 头 + opt/shuili-map 路径前缀）。", rows: [

      { f: "地图操作控件（＋ 放大 / － 缩小 / ☆ 收藏 / ⌂ 返回收藏）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.26 新增，四端一致" },

      { f: "管理所名称统一（导入/导出/查询/筛选）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.26 新增：温泉管理所→温泉所、潮河管理所→潮河所；史山所=史山管理所" },

      { f: "ZIP 多层目录导入", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "v3.26 增强；非 Android 端走 Web 文件选择器" },

      { f: "基础地图（Leaflet 矢量/影像底图切换）", a: "✅", i: "✅", w: "✅", u: "✅", n: "离线时标记仍在，底图需联网" },

      { f: "筛选 / 查询 / 周边搜索 / 测距", a: "✅", i: "✅", w: "✅", u: "✅", n: "核心前端逻辑四端完全一致" },

      { f: "查询/筛选圈选虚线圆动画", a: "✅ 完整", i: "⚠️ 高亮替代", w: "⚠️ 高亮替代", u: "⚠️ 高亮替代", n: "iOS/Win11/UOS 以高亮标记替代 transform 虚线圆动画" },

      { f: "添加/修改/删除建筑物 + 多照片", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "非 Android 端文件访问受限，照片导入走 Web 文件选择器" },

      { f: "GPS 定位", a: "✅", i: "✅", w: "⚠️ 受限", u: "❌ 桌面无硬件", n: "Win11 需浏览器授权；UOS 桌面通常无 GPS 硬件" },

      { f: "导航唤起（第三方地图）", a: "✅ 深链", i: "⚠️ 受限", w: "⚠️ 开 URL", u: "⚠️ 开 URL", n: "Android 走 geo: 深链，其余端以打开地图网页为主" },

      { f: "批量导入照片 / 建筑物（CSV/XLSX/ovkmz）", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "非 Android 端文件访问受限，可用 Web 选择器做轻量导入" },

      { f: "导入/导出 ovkmz（奥维）", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "同上，文件访问受限" },

      { f: "导出照片 / 建筑物表格", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "同上" },

      { f: "统计 / 版本变更 / 关于", a: "✅", i: "✅", w: "✅", u: "✅", n: "全端一致" },

      { f: "离线对话框（confirm→ask）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.23 修复，四端统一自定义对话框" },

      { f: "类型规范清单（CANONICAL_TYPES）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.24 新增，四端一致" },

      { f: "图标颜色+形状双维度区分 + 图例", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.25 新增，四端一致" },

      { f: "PWA 可托管（HTTPS 离线）", a: "❌ 原生 App", i: "✅ 本包即 PWA", w: "❌", u: "❌", n: "iOS 包内置 manifest+service worker，可托管 HTTPS 后添加到主屏离线使用" }

    ]},

    { v: "v3.24", d: "2026-08-19", note: "四端打包（Android / 统信 UOS / Win11 x86_64 / Apple iOS PWA）自本版起同步生成；此前版本仅 Android。", rows: [

      { f: "基础地图（Leaflet 矢量/影像底图切换）", a: "✅", i: "✅", w: "✅", u: "✅", n: "离线时标记仍在，底图需联网" },

      { f: "筛选 / 查询 / 周边搜索 / 测距", a: "✅", i: "✅", w: "✅", u: "✅", n: "核心前端逻辑四端完全一致" },

      { f: "查询/筛选圈选虚线圆动画", a: "✅ 完整", i: "⚠️ 高亮替代", w: "⚠️ 高亮替代", u: "⚠️ 高亮替代", n: "iOS/Win11/UOS 以高亮标记替代 transform 虚线圆动画" },

      { f: "添加/修改/删除建筑物 + 多照片", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "非 Android 端文件访问受限，照片导入走 Web 文件选择器" },

      { f: "GPS 定位", a: "✅", i: "✅", w: "⚠️ 受限", u: "❌ 桌面无硬件", n: "Win11 需浏览器授权；UOS 桌面通常无 GPS 硬件" },

      { f: "导航唤起（第三方地图）", a: "✅ 深链", i: "⚠️ 受限", w: "⚠️ 开 URL", u: "⚠️ 开 URL", n: "Android 走 geo: 深链，其余端以打开地图网页为主" },

      { f: "批量导入照片 / 建筑物（CSV/XLSX/ovkmz）", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "非 Android 端文件访问受限，可用 Web 选择器做轻量导入" },

      { f: "导入/导出 ovkmz（奥维）", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "同上，文件访问受限" },

      { f: "导出照片 / 建筑物表格", a: "✅", i: "⚠️ 受限", w: "✅", u: "⚠️ 受限", n: "同上" },

      { f: "统计 / 版本变更 / 关于", a: "✅", i: "✅", w: "✅", u: "✅", n: "全端一致" },

      { f: "离线对话框（confirm→ask）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.23 修复，四端统一自定义对话框" },

      { f: "类型规范清单（CANONICAL_TYPES）", a: "✅", i: "✅", w: "✅", u: "✅", n: "v3.24 新增，四端一致" },

      { f: "PWA 可托管（HTTPS 离线）", a: "❌ 原生 App", i: "✅ 本包即 PWA", w: "❌", u: "❌", n: "iOS 包内置 manifest+service worker，可托管 HTTPS 后添加到主屏离线使用" }

    ]}

  ];

  function statusCls(s) {

    if (s.indexOf("✅") === 0) return "ok";

    if (s.indexOf("⚠️") === 0) return "warn";

    if (s.indexOf("❌") === 0) return "bad";

    return "";

  }

  function openPlatformCompare() {

    var html = '<p style="color:#888;font-size:12px">记录每个版本在 Android / iOS / Win11 / 统信 UOS 四端的功能差异。平台原生能力（定位/文件/动画/导航）允许不同，核心前端逻辑四端一致。</p>';

    PLATFORM_COMPARE.forEach(function (c) {

      html += '<div class="changelog-ver"><span class="cv">' + esc(c.v) + '</span><span class="cd">' + esc(c.d) + '</span></div>';

      if (c.note) html += '<p style="font-size:12px;color:#666;margin:2px 0 6px">' + esc(c.note) + '</p>';

      html += '<table class="cmp-table"><thead><tr><th>功能</th><th>Android</th><th>iOS</th><th>Win11</th><th>UOS</th></tr></thead><tbody>';

      c.rows.forEach(function (r) {

        html += '<tr><td class="cmp-f">' + esc(r.f) + '</td>'

          + '<td class="' + statusCls(r.a) + '">' + esc(r.a) + '</td>'

          + '<td class="' + statusCls(r.i) + '">' + esc(r.i) + '</td>'

          + '<td class="' + statusCls(r.w) + '">' + esc(r.w) + '</td>'

          + '<td class="' + statusCls(r.u) + '">' + esc(r.u) + '</td></tr>';

        if (r.n) html += '<tr class="cmp-note"><td colspan="5">' + esc(r.n) + '</td></tr>';

      });

      html += '</tbody></table>';

    });

    $("genTitle").textContent = "四端功能对照单";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  function openChangelog() {

    var html = "";

    CHANGES.forEach(function (c) {

      html += '<div class="changelog-ver"><span class="cv">' + esc(c.v) + '</span><span class="cd">' + esc(c.d) + '</span></div>';

      html += '<ul class="changelog-list">';

      c.items.forEach(function (it) { html += "<li>" + esc(it) + "</li>"; });

      html += "</ul>";

    });

    $("genTitle").textContent = "版本变更";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }



  /* ---------- 检测运行环境 ---------- */

  function detectEnv() {

    var info = [];

    // 操作系统

    var ua = navigator.userAgent || "";

    var os = "未知";

    if (/Windows NT 10/.test(ua)) os = "Windows 10/11";

    else if (/Windows NT 6\.3/.test(ua)) os = "Windows 8.1";

    else if (/Windows NT 6\.1/.test(ua)) os = "Windows 7";

    else if (/Android (\d+)/.test(ua)) os = "Android " + (ua.match(/Android (\d+)/) || [])[1];

    else if (/iPhone OS (\d+)/.test(ua)) os = "iOS " + (ua.match(/iPhone OS (\d+)/) || [])[1];

    else if (/Mac OS X/.test(ua)) os = "macOS";

    else if (/Linux/.test(ua)) os = "Linux";

    info.push(["操作系统", os]);

    // 平台

    info.push(["平台", navigator.platform || "未知"]);

    // CPU 核心

    info.push(["CPU 核心", (navigator.hardwareConcurrency || "未知") + " 核"]);

    // 屏幕

    info.push(["屏幕分辨率", (screen.width || "?") + " × " + (screen.height || "?")]);

    info.push(["设备像素比", (window.devicePixelRatio || 1).toFixed(2)]);

    // GPU

    var gpu = "未知";

    try {

      var canvas = document.createElement("canvas");

      var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");

      if (gl) {

        var ext = gl.getExtension("WEBGL_debug_renderer_info");

        if (ext) {

          gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "未知";

        } else {

          gpu = gl.getParameter(gl.RENDERER) || "未知";

        }

      }

    } catch (e) {}

    info.push(["GPU", gpu]);

    // 内存

    if (navigator.deviceMemory) info.push(["设备内存", navigator.deviceMemory + " GB"]);

    // 浏览器内核

    var browser = "WebView";

    if (/Chrome\/(\d+)/.test(ua)) browser = "Chrome " + (ua.match(/Chrome\/(\d+)/) || [])[1] + " 内核";

    info.push(["浏览器内核", browser]);

    // 语言

    info.push(["语言", navigator.language || "未知"]);

    // 构建时间

    info.push(["App 版本", APP_VERSION + " (" + APP_BUILD_DATE + ")"]);

    return info;

  }



  /* ---------- 照片跨平台同步（Req 5/6：从安卓复制照片 / 从安卓平台导出照片 / 照片信息）---------- */

  // 四端统一照片目录约定：photos/<管理所>/<建筑物>/<序号>.jpg（相对 webroot）。

  // 安卓原生落盘与桌面/iOS 本地 HTTP 服务共用同一相对路径；复制文件夹即可跨平台复用，无需重新导入（规避 UOS 8G 内存瓶颈）。

  function photoDirOf(b) {

    return "photos/" + (normOffice(b.office || "未设置管理所")).replace(/[\\/:*?"<>|]/g, "_") + "/" + (b.name || "建筑物").replace(/[\\/:*?"<>|]/g, "_");

  }

  // 桌面/iOS 照片由本地 HTTP 服务按需读取，无需真正“扫描”；这里仅重渲染并提示用户确认目录已就位。

  window.reScanPhotos = function () { render(); toast("已重新加载照片（请确认 photos 目录已按约定放置）"); };

  // 从安卓复制照片：非安卓端把安卓导出的照片文件夹并入本端 webroot/photos，直接显示（不重新导入）

  function copyPhotosFromAndroid() {

    var isAndroid = !!(window.Android && typeof window.Android.exportPhotos === "function");

    var html =

      '<div style="font-size:14px;color:#555;line-height:1.7">' +

      '<p>把安卓端导出的照片，并入当前端（Win11 / UOS / iOS）本地目录，使其<b>直接显示、无需重新导入</b>（避免大体积照片占满内存）。</p>' +

      '<p style="font-weight:600;margin-top:8px">① 安卓端：「传输与共享 → 从安卓平台导出照片」导出照片压缩包（按 <code>photos/管理所/建筑物/序号.jpg</code> 组织）。</p>' +

      '<p style="font-weight:600">② 本端：将压缩包解压（或直接复制文件夹）到应用根目录的 <code>photos/</code> 下，保持 管理所 / 建筑物 层级。</p>' +

      '<p style="font-weight:600">③ 点击「重新扫描」刷新，建筑物即可显示照片。</p>' +

      (isAndroid ? '<p style="color:#888;margin-top:8px">当前为安卓端：照片已在本机，无需复制，直接用「批量导入照片」即可。</p>' : '') +

      '</div>' +

      '<div class="form-actions"><button class="btn-save" onclick="reScanPhotos()">重新扫描照片</button></div>' +

      '<div id="cpResult" style="margin-top:10px"></div>';

    $("genTitle").textContent = "导出照片到统信平台";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  // 从安卓平台导出照片：产出整包照片（按统一目录约定），供其它端复制使用

  function exportPhotosForAndroid() {

    var total = 0;

    BUILDINGS.forEach(function (b) { if (b.photos) total += b.photos.length; });

    if (!total) { toast("没有可导出的照片"); return; }

    var nativeOk = !!(window.Android && typeof window.Android.exportPhotosAll === "function");

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">将全部照片按统一目录约定打包，供 Win11 / UOS / iOS 端复制使用：</p>' +

      '<div class="filter-sec"><h4>目录约定</h4><div style="font-family:monospace;font-size:12px;background:var(--soft);padding:8px;border-radius:6px">photos/&lt;管理所&gt;/&lt;建筑物&gt;/&lt;序号&gt;.jpg</div></div>' +

      '<div class="filter-sec"><h4>导出方式</h4><div class="exp-radios">' +

        (nativeOk ? '<label class="exp-radio"><input type="radio" name="expMode" value="native" checked> 安卓原生打包（不占内存，支持大体积）</label>' : '') +

        '<label class="exp-radio"><input type="radio" name="expMode" value="web"' + (nativeOk ? '' : ' checked') + '> 浏览器打包（ZIP，体积大时较吃内存）</label>' +

      '</div></div>' +

      '<div style="color:#c0392b;font-size:12px">⚠ UOS（8G 内存）导入大体积 ZIP 会卡死，请改用「从安卓复制照片」直接复制文件夹，不要走浏览器打包导入。</div>' +

      '<div class="form-actions"><button class="btn-save" onclick="doExportPhotosForAndroid()">开始导出</button></div>';

    $("genTitle").textContent = "从安卓平台导出照片";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  window.doExportPhotosForAndroid = function () {

    var mode = (document.querySelector('input[name="expMode"]:checked') || {}).value || "web";

    if (mode === "native" && window.Android && typeof window.Android.exportPhotosAll === "function") {

      var out = window.Android.exportPath(APPNAME + "_照片_all_" + getTodayStr() + ".zip");

      ensureWifi("导出全部照片", function () {

        openXferProgress("exportPhotos", "正在导出全部照片…");

        window.Android.exportPhotosAll(out, XFER.resume);

      });

      return;

    }

    busy("正在打包照片，请稍后…");

    var zip = new JSZip();

    var tasks = [];

    BUILDINGS.forEach(function (b) {

      (b.photos || []).forEach(function (p, i) {

        var data = p.data || p.file;

        if (!data) return;

        tasks.push(addPhotoToZip(zip, photoDirOf(b), (i + 1) + ".jpg", data));

      });

    });

    Promise.all(tasks).then(function () { return zip.generateAsync({ type: "blob", compression: "DEFLATE" }); })

      .then(function (blob) { idle(); saveBlobFile(blob, APPNAME + "_照片_all_" + getTodayStr() + ".zip"); toast("照片已导出"); })

      .catch(function (e) { idle(); toast("导出失败：" + e.message); });

  };

  // 照片信息：四端存放位置与目录约定，便于核对复制是否正确

  function openPhotoHelp() {

    var plat = [

      ["安卓", "应用私有目录（原生落盘）：photos/<管理所>/<建筑物>/<序号>.jpg"],

      ["Win11", "安装目录 webroot/photos/…（本地 HTTP 服务读取）"],

      ["统信 UOS", "/opt/shuili-map/photos/…（python http.server 读取，8G 内存机请直接复制文件夹）"],

      ["iOS", "托管目录 photos/…（PWA 本地服务读取）"]

    ];

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">照片在各端的存放位置与目录约定（四端一致的相对路径，复制文件夹即可复用）：</p>' +

      '<div style="font-family:monospace;font-size:12px;background:var(--soft);padding:8px 10px;border-radius:6px;margin-bottom:10px">photos/&lt;管理所&gt;/&lt;建筑物&gt;/&lt;序号&gt;.jpg</div>' +

      '<div style="font-size:13px;line-height:1.9">' +

      plat.map(function (x) { return '<div style="display:flex;gap:8px"><span style="flex:0 0 84px;font-weight:600">' + esc(x[0]) + '</span><span style="flex:1">' + esc(x[1]) + '</span></div>'; }).join("") +

      '</div>' +

      '<p style="font-size:13px;color:#333;margin-top:12px;font-weight:600">如何把安卓照片复制到其它平台：</p>' +

      '<div style="font-size:12px;color:#555;line-height:1.8">' +

      '① 安卓端：「传输与共享 → 从安卓平台导出照片」生成 <code>photos/…</code> 压缩包（不占内存）。<br>' +

      '② 统信 UOS：解压到 <code>/opt/shuili-map/photos/</code>（sudo cp -r 后 sudo chmod -R 755 photos）；回到 App「传输与共享 → 导出照片到统信平台 → 重新扫描」。<br>' +

      '③ Win11：解压到 <code>安装目录\webroot\photos\</code>；iOS：托管目录 <code>photos/</code>。<br>' +

      '④ 用文件管理器确认目录层级为 <code>photos/管理所/建筑物/序号.jpg</code>，App 上点建筑物即可看图。' +

      '</div>' +

      '<p style="font-size:12px;color:#888;margin-top:10px">点击地图建筑物弹出信息即展示其照片；导入照片同名/同内容会提示覆盖或跳过（见「批量导入照片」）。</p>';

    $("genTitle").textContent = "照片（目录与命名）";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }



  /* ---------- 分享建筑物信息 + 照片（Req 1）---------- */

  // 组装可读的文字信息（微信/QQ 文本分享用）

  function buildingShareText(b) {

    var L = [];

    L.push("【" + (b.name || "未命名建筑") + "】");

    if (b.office) L.push("管理所：" + b.office);

    if (b.station) L.push("管理站：" + b.station);

    if (b.chan) L.push("所属渠段：" + b.chan);

    if (b.btype) L.push("建筑物类型：" + b.btype);

    if (b.lat != null && b.lon != null && isFinite(b.lat) && isFinite(b.lon)) {

      L.push("坐标：" + Number(b.lat).toFixed(6) + ", " + Number(b.lon).toFixed(6));

    }

    (b.attrs || []).forEach(function (a) { if (a[0]) L.push(a[0] + "：" + a[1]); });

    var np = (b.photos || []).length;

    L.push("照片：" + np + " 张");

    L.push("—— 由「" + APPNAME + "」" + APP_VERSION + " 导出");

    return L.join("\n");

  }

  window.appShareBuilding = function (id) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b) { toast("未找到该建筑"); return; }

    var np = (b.photos || []).length;

    var hasNative = !!(window.Android && typeof window.Android.shareBuilding === "function");

    $("genTitle").textContent = "分享：" + b.name;

    $("genBody").innerHTML =

      '<div class="filter-count" style="margin-bottom:12px">将分享<b>' + esc(b.name) + '</b>的基础信息' +

      (np ? '，含 <b>' + np + '</b> 张照片' : '（该建筑暂无照片）') + '。</div>' +

      '<div class="filter-sec"><h4>分享内容</h4><div class="exp-radios">' +

      '<label class="exp-radio"><input type="radio" name="shMode" value="both"' + (np ? " checked" : "") + (np ? "" : " disabled") + '> 信息 + 照片（信息另存为 txt 一并发送）</label>' +

      '<label class="exp-radio"><input type="radio" name="shMode" value="photos"' + (np ? "" : " disabled") + '> 仅照片（' + np + ' 张）</label>' +

      '<label class="exp-radio"><input type="radio" name="shMode" value="text"' + (np ? "" : " checked") + '> 仅文字信息（微信/QQ 兼容性最好）</label>' +

      '</div></div>' +

      '<div class="filter-sec"><h4>分享到</h4><div class="exp-radios">' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#1aad19">💬</span><input type="radio" name="shTarget" value="wechat" checked> 微信</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#12b7f5">🐧</span><input type="radio" name="shTarget" value="qq"> QQ</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#3370ff">📘</span><input type="radio" name="shTarget" value="feishu"> 飞书</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:var(--muted)">📤</span><input type="radio" name="shTarget" value="other"> 其他（系统分享面板）</label>' +

      '</div></div>' +

      (hasNative ? "" : '<p style="font-size:12px;color:var(--danger)">当前环境不支持原生分享，将回退为复制文字/系统分享。</p>') +

      '<div style="font-size:12px;color:var(--muted);line-height:1.6">提示：微信对「图片+文字」同时发送有限制，若文字未带上，可先用「仅文字信息」发一条，再用「仅照片」发图片。</div>' +

      '<div class="form-actions"><button class="btn-cancel" onclick="appCopyShareText(\'' + esc(b.id) + '\')">复制文字</button>' +

      '<button class="btn-save" onclick="appDoShare(\'' + esc(b.id) + '\')">分享</button></div>';

    openSheet("sheetGen");

  };

  window.appCopyShareText = function (id) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b) return;

    var t = buildingShareText(b);

    window.copyText(t, "信息已复制，可直接粘贴到微信/QQ");

  };

  window.appDoShare = function (id) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b) return;

    var modeEl = document.querySelector('input[name="shMode"]:checked');

    var tgtEl = document.querySelector('input[name="shTarget"]:checked');

    var mode = modeEl ? modeEl.value : "text";

    var target = tgtEl ? tgtEl.value : "other";

    var text = buildingShareText(b);

    var rels = (b.photos || []).map(function (p) { return p.file || ""; }).filter(Boolean);

    if (mode !== "text" && !rels.length) {

      // 老数据的照片是内联 base64，没有磁盘路径，无法走原生多文件分享

      toast("该建筑照片为旧版内联格式，仅能分享文字");

      mode = "text";

    }

    closeSheet("sheetGen");

    if (window.Android && typeof window.Android.shareBuilding === "function") {

      busy("正在准备分享内容，请稍后…");

      busyDetail(mode === "text" ? "文字信息" : "照片 " + rels.length + " 张（需先复制到可分享目录）");

      setTimeout(function () {

        try { window.Android.shareBuilding(b.name || "建筑物", text, JSON.stringify(rels), target, mode); }

        catch (e) { toast("分享失败：" + e.message); idle(); return; }

        // 原生复制完照片后会回调 onShareReady 收起提示；再加兜底超时防回调丢失

        setTimeout(idle, 15000);

      }, 40);

      return;

    }

    // 浏览器回退：Web Share API → 复制文字

    if (navigator.share) {

      navigator.share({ title: b.name, text: text }).catch(function () {});

      return;

    }

    window.appCopyShareText(id);

  };

  // 原生分享内容准备就绪回调（照片已复制到可分享目录，系统分享面板即将弹出）

  window.onShareReady = function (n) {

    idle();

    if (n > 0) toast("已准备 " + n + " 个文件，请在分享面板中选择");

  };



  /* ---------- 灯箱（Req 1：照片放大 —— 双指缩放 / 双击放大 / 按钮缩放 + 单张分享）---------- */

  window.appLightbox = function (id, i) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b || !b.photos[i]) return;

    window.__lb = { id: id, i: i, scale: 1 };

    var p = b.photos[i];

    var img = $("lbImg");

    img.src = photoFullSrc(p);

    lbApplyScale(1);

    $("lbCap").textContent = (p.caption || b.name) + "（" + (i + 1) + "/" + b.photos.length + "）";

    $("lightbox").classList.add("show");

  };

  // G1：直接显示单张照片（如巡视记录的单图 c.photo），支持自动循环查看

  window.appLightboxSrc = function (src, caption) {

    if (!src) return;

    window.__lb = { id: null, i: 0, scale: 1, single: true };

    var img = $("lbImg");

    img.src = src.indexOf("data:") === 0 ? src : (window.Android && window.Android.readPhoto ? window.Android.readPhoto(src) : src);

    lbApplyScale(1);

    $("lbCap").textContent = caption || "照片";

    $("lightbox").classList.add("show");

  };

  function lbApplyScale(s) {

    if (!window.__lb) return;

    s = Math.max(1, Math.min(6, s));

    window.__lb.scale = s;

    var img = $("lbImg");

    if (img) img.style.transform = "scale(" + s + ")";

    var ind = $("lbZoom");

    if (ind) ind.textContent = Math.round(s * 100) + "%";

  }

  window.lbZoomIn = function () { lbApplyScale((window.__lb ? window.__lb.scale : 1) * 1.5); };

  window.lbZoomOut = function () { lbApplyScale((window.__lb ? window.__lb.scale : 1) / 1.5); };

  window.lbZoomReset = function () { lbApplyScale(1); };

  window.lbStep = function (d) {

    var lb = window.__lb; if (!lb) return;

    var b = BUILDINGS.find(function (x) { return x.id === lb.id; });

    if (!b || !b.photos.length) return;

    var n = (lb.i + d + b.photos.length) % b.photos.length;

    window.appLightbox(lb.id, n);

  };

  window.lbShare = function () {

    var lb = window.__lb; if (!lb) return;

    $("lightbox").classList.remove("show");

    window.appShareBuilding(lb.id);

  };



  /* ---------- 长按照片操作条（Req 8：保存 / 上一张 / 下一张 / 退出）---------- */

  window.appPhotoAct = function (id, i) {

    var b = BUILDINGS.find(function (x) { return x.id === id; });

    if (!b || !b.photos[i]) return;

    window.__photoAct = { id: id, i: i };

    renderPhotoAct();

    $("photoAct").classList.add("show");

  };

  function renderPhotoAct() {

    var pa = window.__photoAct; if (!pa) return;

    var b = BUILDINGS.find(function (x) { return x.id === pa.id; });

    if (!b) return;

    var p = b.photos[pa.i];

    var cap = $("paCap"), img = $("paImg");

    if (img) img.src = photoFullSrc(p);

    if (cap) cap.textContent = (p.caption || b.name) + "（" + (pa.i + 1) + "/" + b.photos.length + "）";

  }

  window.photoActSave = function () {

    var pa = window.__photoAct; if (!pa) return;

    var b = BUILDINGS.find(function (x) { return x.id === pa.id; }); if (!b) return;

    var p = b.photos[pa.i];

    var src = photoFullSrc(p);

    var name = (p.caption || b.name || "photo") + ".jpg";

    if (window.Android && typeof window.Android.saveBlob === "function") {

      window.Android.saveBlob(src, name);

      toast("正在保存到下载目录…");

    } else {

      var a = document.createElement("a"); a.href = src; a.download = name; document.body.appendChild(a); a.click(); a.remove();

      toast("已保存 " + name);

    }

  };

  window.photoActPrev = function () {

    var pa = window.__photoAct; if (!pa) return;

    var b = BUILDINGS.find(function (x) { return x.id === pa.id; }); if (!b) return;

    pa.i = (pa.i - 1 + b.photos.length) % b.photos.length; renderPhotoAct();

  };

  window.photoActNext = function () {

    var pa = window.__photoAct; if (!pa) return;

    var b = BUILDINGS.find(function (x) { return x.id === pa.id; }); if (!b) return;

    pa.i = (pa.i + 1) % b.photos.length; renderPhotoAct();

  };

  window.closePhotoAct = function () { $("photoAct").classList.remove("show"); };



  /* ---------- 导入 ovkmz（原生大文件管线：解压到磁盘 + 进度 + 续传 + 内容比对）---------- */

  function importKmz() {

    if (window.Android && typeof window.Android.pickFiles === "function") {

      window.__kmzImport = true; // 标记 onPickFiles 路由到 kmz 导入

      $("toast").textContent = "请选择 ovkmz / kmz / kml 文件…"; $("toast").classList.add("show");

      window.Android.pickFiles("*/*");

    } else {

      legacyImportKmz();

    }

  }

  // 原生选择器返回 kmz 路径后：Req 1/2 断点续传 + Req 6 内容相同提示

  function importKmzFromPath(path) {

    var fname = path.split("/").pop();

    function doImport() {

      openXferProgress("import", "正在导入 " + fname + " …");

      setXferTitle("正在导入 " + fname + "，请稍后…");

      window.Android.importKmz(path, XFER.resume);

    }

    /* fileSha256 是同步桥调用，会把整个文件读一遍算哈希：

       2GB 包在这里能阻塞 UI 线程十几秒，用户会以为"点了没反应/卡死"。

       故：先弹"校验中，请稍后"忙提示，下一帧再真正开算（否则提示画不出来）。 */

    busy("正在校验文件，请稍后…");

    busyDetail(fname + "（大文件校验较慢，请勿退出）");

    setTimeout(function () {

      var sha = "";

      try { if (window.Android) sha = window.Android.fileSha256(path); } catch (e) {}

      idle();

      window.__kmzSha = sha || null;

      var lastSha = ""; try { lastSha = localStorage.getItem("shuili_lastKmzSha") || ""; } catch (e) {}

      if (sha && lastSha && sha === lastSha) {

        // Req 6：文件内容（SHA-256）与上次导入完全相同（非文件名），提示是否仍覆盖

        // 必须用自定义 ask()：原生 confirm() 在离线 WebView 中不显示且默认返回 false，会静默取消导入

        ask("文件已导入过",

          "文件“" + esc(fname) + "”的内容与上次导入<b>完全相同</b>（按文件内容 SHA-256 比对，非文件名）。是否覆盖导入？",

          [{ t: "覆盖导入", cls: "btn-confirm2", v: 1 }, { t: "取消", cls: "btn-cancel", v: 0 }],

          function (ok) {

            if (ok) doImport();

            else { closeXferProgress(); toast("已取消导入"); }

          });

      } else {

        ensureWifi("导入 ovkmz（可能含大量照片）", doImport);

      }

    }, 40);

  }

  /* 原生导入完成回调：spec = { kml, photos:[{ovName, ovPath, relPath}] }

     解析 + 合并是同步重活（上万 Placemark 时会明显卡顿），故包在忙提示里执行，

     并在结束时给出可核对的明细（建筑数 / 照片数 / 无坐标数），便于确认"导入是否真的成功"。 */

  window.onImportData = function (json) {

    var spec;

    try { spec = JSON.parse(json); }

    catch (e) { closeXferProgress(); idle(); toast("导入解析失败：返回数据格式错误"); return; }

    closeXferProgress();

    busy("正在解析并写入数据，请稍后…");

    busyDetail("附件照片 " + ((spec.photos || []).length) + " 张，请勿退出");

    setTimeout(function () {

      var imported;

      try { imported = parseKmlWithPhotos(spec.kml || "", spec.photos || []); }

      catch (e) { idle(); toast("导入失败：" + e.message); return; }

      if (!imported.length) {

        idle();

        ask("未解析到建筑",

          "导入结束，但未从文件中解析出任何建筑（Placemark）。\n\n可能原因：\n1) 压缩包内没有 doc.kml 或 *.kml；\n2) KML 内没有 Placemark 节点；\n3) 文件已损坏。",

          [{ t: "知道了", cls: "btn-confirm2", v: 1 }], function () {});

        return;

      }

      idle();

      // v3.19：存在“名称完全相同”的现有建筑物时弹三选一，不再静默覆盖

      var existName = {}; BUILDINGS.forEach(function (b) { existName[b.name] = 1; });

      var uniqDup = imported.filter(function (nb) { return existName[nb.name]; }).map(function (nb) { return nb.name; })

        .filter(function (n, i, a) { return a.indexOf(n) === i; });

      if (uniqDup.length) {

        var shown = uniqDup.slice(0, 5).map(esc).join("、");

        var more = uniqDup.length > 5 ? " 等 " + uniqDup.length + " 个" : "";

        ask("存在同名建筑物",

          "导入的文件中有 <b>" + uniqDup.length + "</b> 个建筑物与现有数据<b>名称完全相同</b>（" + shown + more + "）。如何处理？",

          [

            { t: "覆盖更新", cls: "btn-confirm2", v: "overwrite" },

            { t: "保留现有", cls: "btn-cancel", v: "keep" },

            { t: "取消导入", cls: "btn-exit", v: "cancel" }

          ],

          function (mode) {

            if (mode === "cancel") { toast("已取消导入"); return; }

            mergeImported(mode === "overwrite" ? imported : imported.filter(function (nb) { return !existName[nb.name]; }),

              spec, mode === "keep");

          });

        return;

      }

      mergeImported(imported, spec, false);

    }, 40);

  };

  // 实际合并写入（onImportData 共用）：同名且同坐标的更新，其余新增；keptExisting 仅用于文案提示

  function mergeImported(list, spec, keptExisting) {

    busy("正在写入数据，请稍后…");

    busyDetail("请勿退出");

    setTimeout(function () {

      var added = 0, upd = 0, noGeo = 0, photoCnt = 0;

      list.forEach(function (nb) {

        if (nb.lat == null || nb.lon == null || !isFinite(nb.lat) || !isFinite(nb.lon)) noGeo++;

        photoCnt += (nb.photos || []).length;

        var ex = BUILDINGS.find(function (x) {

          return x.name === nb.name && x.lat != null && nb.lat != null &&

            Math.abs(x.lat - nb.lat) < 1e-4 && Math.abs(x.lon - nb.lon) < 1e-4;

        });

        if (ex) {

          ex.attrs = nb.attrs; ex.photos = nb.photos; ex.btype = nb.btype;

          ex.office = nb.office; ex.station = nb.station; ex.chan = nb.chan;

          if (nb.geom === "Line" && nb.line) { ex.geom = "Line"; ex.line = nb.line; }

          upd++;

        } else { BUILDINGS.push(nb); added++; }

      });

      try { if (window.__kmzSha) localStorage.setItem("shuili_lastKmzSha", window.__kmzSha); } catch (e) {}

      window.__kmzSha = null;

      save(); render(); buildLegend();

      idle();

      var msg = "导入完成\n\n新增建筑：" + added + " 个\n更新建筑：" + upd + " 个\n绑定照片：" + photoCnt + " 张";

      if (keptExisting) msg += "\n（同名建筑已按「保留现有」处理，未覆盖）";

      if (noGeo) msg += "\n\n注意：其中 " + noGeo + " 个建筑没有有效坐标，地图上不会显示，可在「列表」中补录坐标。";

      var left = (spec.photos || []).length - photoCnt;

      if (left > 0) msg += "\n提示：压缩包内另有 " + left + " 张照片未被 KML 引用，未绑定到建筑。";

      ask("导入完成", msg, [{ t: "知道了", cls: "btn-confirm2", v: 1 }], function () { flushCompress(); });

      toast("导入完成：新增 " + added + "，更新 " + upd);

    }, 40);

  }

  /* ---------- KML 解析工具（命名空间容错 / 直接子节点 / 坐标）---------- */

  // 有些 KML 用前缀（<kml:name>），getElementsByTagName 会失配，故加 NS 通配回退

  function els(el, tag) {

    if (!el) return [];

    var r = el.getElementsByTagName(tag);

    if (r && r.length) return r;

    try { r = el.getElementsByTagNameNS("*", tag); } catch (e) { r = null; }

    return r || [];

  }

  // 只取直接子节点，避免把 Style / 子 Placemark 里的 <name> 误当成自己的

  function dchild(el, tag) {

    if (!el || !el.childNodes) return null;

    for (var i = 0; i < el.childNodes.length; i++) {

      var c = el.childNodes[i];

      if (c.nodeType !== 1) continue;

      var ln = c.localName || c.nodeName;

      if (ln === tag || c.nodeName === tag) return c;

    }

    return null;

  }

  function dtxt(el, tag) {

    var c = dchild(el, tag);

    return c && c.textContent ? c.textContent.trim() : "";

  }

  // 解析 KML coordinates："lon,lat[,alt]" 以空白/换行分隔

  function parseCoords(s) {

    if (!s) return [];

    return s.trim().split(/\s+/).map(function (t) {

      var p = t.split(",");

      var lon = parseFloat(p[0]), lat = parseFloat(p[1]);

      if (!isFinite(lon) || !isFinite(lat)) return null;

      // 越界坐标一律丢弃：否则 Leaflet 的 fitBounds/图例统计会被一个脏点整体带跑，

      // 全图缩放到大洋中间，用户会以为"导入失败/数据没了"

      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

      if (lon === 0 && lat === 0) return null;   // 0,0 是典型的"无坐标"占位值

      return [lon, lat];

    }).filter(Boolean);

  }

  // 描述字段可能是：竖线属性串 / HTML 表格（奥维、Google Earth 常见）/ 纯文本

  function parseDescAttrs(desc) {

    if (!desc) return [];

    var out = [];

    if (/<\s*(table|tr|td|br|p|div)/i.test(desc)) {

      // HTML：优先按 <tr><td>键</td><td>值</td></tr> 抽取，其次按 <br> 行拆

      var rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, m;

      while ((m = rowRe.exec(desc))) {

        var tds = m[1].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];

        if (tds.length >= 2) {

          var k = stripTags(tds[0]), v = stripTags(tds[1]);

          if (k) out.push([k, v]);

        }

      }

      if (!out.length) {

        desc.split(/<br\s*\/?>|<\/p>|<\/div>/i).forEach(function (line) {

          var t = stripTags(line); if (!t) return;

          var p = t.split(/[:：]/);

          if (p.length >= 2 && p[0].trim()) out.push([p[0].trim(), p.slice(1).join(":").trim()]);

        });

      }

      return out;

    }

    // 纯文本：先按竖线，再按换行

    var parts = desc.indexOf("|") >= 0 ? desc.split("|") : desc.split(/\r?\n/);

    parts.forEach(function (l) {

      var p = l.split(/[:：]/);

      if (p.length >= 2 && p[0].trim()) out.push([p[0].trim(), p.slice(1).join(":").trim()]);

    });

    return out;

  }

  function stripTags(s) {

    return String(s == null ? "" : s).replace(/<[^>]*>/g, "")

      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")

      .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').trim();

  }

  // 属性名归一化：把常见别名映射到内部字段

  var FIELD_ALIAS = {

    office: ["管理单位", "管理处", "单位", "所属单位", "office", "所属管理处"],

    station: ["管理站", "station", "所属管理站", "站点"],

    chan: ["渠道", "所属渠道", "chan", "channel", "干渠"],

    btype: ["建筑物类型", "类型", "btype", "type", "建筑类型"],

    name: ["建筑物名称", "名称", "name", "工程名称"]

  };

  function matchField(key) {

    var k = String(key || "").trim().toLowerCase();

    for (var f in FIELD_ALIAS) {

      for (var i = 0; i < FIELD_ALIAS[f].length; i++) {

        if (FIELD_ALIAS[f][i].toLowerCase() === k) return f;

      }

    }

    return "";

  }



  /* ---------- 富解析（v3.15 重写：奥维地图格式兼容 + 照片按引用绑定）----------

     兼容点：

     1) 照片不再按"出现顺序"盲配，而是用 <OvAttaItem> 文本（如 ovatta/pic_3.jpg）

        去照片清单里按 ovPath / ovName / 基名 精确匹配；匹配不到才退回顺序取用。

        —— 原实现一旦附件数与 KML 引用数不一致（奥维导出很常见），后面所有建筑的

           照片会整体错位绑到别的建筑上。

     2) 支持奥维 / Google Earth 的 <ExtendedData><Data name=".."><value>..</value></Data>

        与 <SchemaData><SimpleData name="..">，属性不再只认竖线描述串。

     3) <description> 支持 HTML 表格 / <br> 行 / 竖线串 / 换行串。

     4) 文件夹层级取"最后两级"（倒数第二级=管理单位，最后一级=渠道--类型），

        不再硬编码 segs[1]/segs[2] —— 原实现导致自家导出的文件再导入时

        管理单位被写成渠道文件夹名、渠道与类型全空。

     5) 几何支持 Point / LineString / Polygon / MultiGeometry，坐标做有效性校验。

     6) 显式属性（ExtendedData/description）优先级高于文件夹推断。 */

  function parseKmlWithPhotos(xml, photos) {

    photos = photos || [];

    var doc = new DOMParser().parseFromString(xml || "", "application/xml");

    if (doc.getElementsByTagName("parsererror").length) throw new Error("KML 格式无法解析（XML 语法错误）");

    var pms = doc.getElementsByTagName("Placemark");

    if (!pms.length) pms = els(doc, "Placemark");



    // 照片索引：ovPath / ovName / 基名（小写）→ 照片项；供按引用精确绑定

    var byRef = {}, used = {}, seq = 0;

    photos.forEach(function (p, i) {

      if (!p) return;

      var keys = [];

      if (p.ovPath) keys.push(String(p.ovPath).replace(/\\/g, "/").toLowerCase());

      if (p.ovName) keys.push(String(p.ovName).toLowerCase());

      if (p.relPath) keys.push(String(p.relPath).split("/").pop().toLowerCase());

      keys.forEach(function (k) { if (k && byRef[k] === undefined) byRef[k] = i; });

    });

    function takeByRef(ref) {

      var r = String(ref || "").replace(/\\/g, "/").trim();

      if (!r) return null;

      var cands = [r.toLowerCase(), r.split("/").pop().toLowerCase()];

      for (var i = 0; i < cands.length; i++) {

        var idx = byRef[cands[i]];

        if (idx !== undefined && !used[idx]) { used[idx] = 1; return photos[idx]; }

      }

      return null;

    }

    function takeNext() {

      while (seq < photos.length && used[seq]) seq++;

      if (seq >= photos.length) return null;

      used[seq] = 1; return photos[seq++];

    }



    var out = [];

    for (var pi = 0; pi < pms.length; pi++) {

      var pm = pms[pi];

      var name = dtxt(pm, "name");

      var desc = dtxt(pm, "description");

      var attrs = parseDescAttrs(desc);



      // ExtendedData：<Data name=".."><value>..</value></Data> 与 <SimpleData name="..">

      var explicit = {};

      var eds = els(pm, "Data");

      for (var di = 0; di < eds.length; di++) {

        var dk = eds[di].getAttribute("name") || dtxt(eds[di], "displayName");

        var dv = dtxt(eds[di], "value");

        if (!dk) continue;

        var f = matchField(dk);

        if (f) explicit[f] = dv;

        else if (!attrs.some(function (a) { return a[0] === dk; })) attrs.push([String(dk).trim(), dv]);

      }

      var sds = els(pm, "SimpleData");

      for (var si = 0; si < sds.length; si++) {

        var sk = sds[si].getAttribute("name");

        var sv = sds[si].textContent ? sds[si].textContent.trim() : "";

        if (!sk) continue;

        var sf = matchField(sk);

        if (sf) explicit[sf] = sv;

        else if (!attrs.some(function (a) { return a[0] === sk; })) attrs.push([String(sk).trim(), sv]);

      }

      // 竖线/HTML 描述里若也含可识别字段，补进 explicit（不覆盖 ExtendedData）

      attrs.forEach(function (a) {

        var f2 = matchField(a[0]);

        if (f2 && !explicit[f2]) explicit[f2] = a[1];

      });



      // 文件夹层级：取最后两级（倒数第二=管理单位，最后=渠道--类型）

      var path = "", par = pm.parentNode;

      while (par && par.nodeType === 1) {

        var pn = par.localName || par.nodeName;

        if (pn === "kml") break;

        if (pn === "Folder") { var fn = dtxt(par, "name"); if (fn) path = "/" + fn + path; }

        par = par.parentNode;

      }

      var segs = path.split("/").filter(Boolean);

      var office = "", chan = "", btype = "";

      if (segs.length >= 2) {

        office = segs[segs.length - 2];

        var s = segs[segs.length - 1];

        if (s.indexOf("--") >= 0) { chan = s.split("--")[0]; btype = s.split("--")[1]; }

        else { chan = s; btype = s; }

      } else if (segs.length === 1) {

        office = segs[0];

      }

      // 显式属性优先

      if (explicit.office) office = explicit.office;

      // v3.26：管理所名称统一（温泉管理所→温泉所 / 潮河管理所→潮河所）

      office = normOffice(office);

      if (explicit.chan) chan = explicit.chan;

      if (explicit.btype) btype = explicit.btype;

      if (explicit.name && !name) name = explicit.name;

      var station = explicit.station || "";



      // 照片：按 <OvAttaItem> 引用精确绑定

      var photosArr = [];

      var atta = els(pm, "OvAttaItem");

      for (var k = 0; k < atta.length; k++) {

        var ref = atta[k].textContent ? atta[k].textContent.trim() : "";

        // 奥维部分版本把文件名放在子节点里

        if (!ref) ref = dtxt(atta[k], "OvAttaFile") || dtxt(atta[k], "name");

        var ph = takeByRef(ref) || takeNext();

        if (!ph) continue;

        // 原生管线给磁盘相对路径；浏览器回退给 base64 dataURL

        if (ph.relPath) { photosArr.push({ file: ph.relPath, caption: "" }); queueCompress(ph.relPath); }

        else if (ph.data) photosArr.push({ data: ph.data, caption: "" });

      }



      var rec = {

        id: "imp" + Date.now() + "_" + pi + "_" + Math.floor(Math.random() * 1e4),

        name: name, office: office, station: station, chan: chan, btype: btype,

        path: path, attrs: attrs, photos: photosArr

      };



      // 几何：Point / LineString / Polygon（取外环）/ MultiGeometry

      var pt = els(pm, "Point")[0], ln = els(pm, "LineString")[0], pg = els(pm, "Polygon")[0];

      if (pt && dtxt(pt, "coordinates")) {

        var c = parseCoords(dtxt(pt, "coordinates"))[0];

        if (c) { rec.geom = "Point"; rec.lon = c[0]; rec.lat = c[1]; } else rec.geom = "None";

      } else if (ln) {

        var lcEl = els(ln, "coordinates")[0];

        var lc = parseCoords(dtxt(ln, "coordinates") || (lcEl && lcEl.textContent ? lcEl.textContent : ""));

        if (lc.length) {

          rec.geom = "Line"; rec.line = lc;

          rec.lon = lc[0][0]; rec.lat = lc[0][1];   // 便于列表/定位/筛选统一按点处理

        } else rec.geom = "None";

      } else if (pg) {

        var ring = els(pg, "coordinates")[0];

        var gc = parseCoords(ring && ring.textContent ? ring.textContent : "");

        if (gc.length) {

          rec.geom = "Line"; rec.line = gc;

          rec.lon = gc[0][0]; rec.lat = gc[0][1];

        } else rec.geom = "None";

      } else {

        rec.geom = "None";

      }

      if (!rec.name) rec.name = "未命名_" + (pi + 1);

      out.push(rec);

    }

    return out;

  }

  // 浏览器回退：直接用 JSZip 解析（小文件）

  function legacyImportKmz() {

    var inp = document.createElement("input");

    inp.type = "file"; inp.accept = ".ovkmz,.kmz,.kml";

    inp.onchange = function () {

      var f = this.files[0]; if (!f) return;

      busy("正在导入 " + f.name + "，请稍后…");

      busyDetail("正在解压并解析，请勿退出本页…");

      // 裸 .kml 直接读文本，不走 JSZip（否则必然抛错）

      if (/\.kml$/i.test(f.name)) {

        var fr = new FileReader();

        fr.onload = function () {

          try { mergeImported(parseKmlWithPhotos(String(fr.result || ""), [])); }

          catch (e) { idle(); toast("导入失败：" + e.message); }

        };

        fr.onerror = function () { idle(); toast("读取文件失败"); };

        fr.readAsText(f);

        return;

      }

      JSZip.loadAsync(f).then(function (zip) {

        // doc.kml 优先，缺失则回退到包内任意 *.kml（兼容其它工具导出的 kmz）

        var names = Object.keys(zip.files);

        var kmlName = names.find(function (n) { return /doc\.kml$/i.test(n); }) ||

                      names.find(function (n) { return /\.kml$/i.test(n) && !zip.files[n].dir; });

        if (!kmlName) throw new Error("压缩包内找不到 doc.kml 或任何 .kml 文件");

        return zip.file(kmlName).async("string").then(function (xml) { return parseKml(xml, zip); });

      }).then(function (imported) {

        mergeImported(imported);

      }).catch(function (e) { idle(); toast("导入失败：" + e.message); });

    };

    inp.click();

  }

  // 合并导入结果（浏览器回退路径复用，与原生路径行为保持一致）

  function mergeImported(imported) {

    if (!imported || !imported.length) { idle(); ask("导入结束", "未从文件中解析出任何建筑（Placemark）。<br><br>可能原因：<br>1) 压缩包内没有 doc.kml 或 *.kml；<br>2) KML 内没有 Placemark 节点；<br>3) 文件已损坏。", [{ t: "知道了", cls: "btn-confirm2", v: 1 }]); return; }

    var added = 0, upd = 0, photoCnt = 0;

    imported.forEach(function (nb) {

      photoCnt += (nb.photos || []).length;

      var ex = BUILDINGS.find(function (x) {

        return x.name === nb.name && x.lat != null && nb.lat != null &&

          Math.abs(x.lat - nb.lat) < 1e-4 && Math.abs(x.lon - nb.lon) < 1e-4;

      });

      if (ex) {

        ex.attrs = nb.attrs; ex.photos = nb.photos; ex.btype = nb.btype;

        ex.office = nb.office; ex.station = nb.station; ex.chan = nb.chan;

        if (nb.geom === "Line" && nb.line) { ex.geom = "Line"; ex.line = nb.line; }

        upd++;

      } else { BUILDINGS.push(nb); added++; }

    });

    save(); render(); buildLegend();

    idle();

    ask("导入完成", "新增建筑：" + added + " 个<br>更新建筑：" + upd + " 个<br>绑定照片：" + photoCnt + " 张", [{ t: "知道了", cls: "btn-confirm2", v: 1 }]);

    toast("导入完成：新增 " + added + "，更新 " + upd);

  }

  /* 浏览器回退解析：先把压缩包内附件读成 base64 清单（带 ovPath/ovName），

     再复用与原生管线完全相同的 parseKmlWithPhotos，避免两套解析逻辑行为不一致。 */

  function parseKml(xml, zip) {

    var names = zip ? Object.keys(zip.files) : [];

    var picNames = names.filter(function (n) {

      if (zip.files[n].dir) return false;

      var low = n.toLowerCase();

      return /\.(jpg|jpeg|png|webp|bmp|gif)$/.test(low);

    });

    return Promise.all(picNames.map(function (n) {

      return zip.file(n).async("base64").then(function (b64) {

        var low = n.toLowerCase(), mime = /\.png$/.test(low) ? "image/png" : /\.webp$/.test(low) ? "image/webp" : "image/jpeg";

        return { ovPath: n.replace(/\\/g, "/"), ovName: n.split("/").pop(), data: "data:" + mime + ";base64," + b64 };

      });

    })).then(function (list) {

      return parseKmlWithPhotos(xml, list);

    });

  }

  function txt(el, tag) {

    var e = el.getElementsByTagName(tag)[0];

    return e && e.textContent ? e.textContent.trim() : "";

  }



  /* ---------- 导出 ovkmz（#353：文件名可改，范围可选）---------- */

  function exportKmz(fileName, useFilter, cfg) {

    if (!BUILDINGS.length) { toast("没有可导出的数据"); return; }

    // Req 3：筛选完成后默认导出筛选出的建筑

    var uf = (typeof useFilter === "boolean") ? useFilter : filterActive();

    var list = uf ? filteredList() : BUILDINGS;

    var scope = uf ? "筛选结果" : "全部";

    if (!list.length) { toast("没有可导出的数据"); return; }

    busy("正在整理导出数据（" + list.length + " 个建筑）…");

    // 让忙提示先渲染出来，再做可能较重的 KML 组装

    setTimeout(function () {

      var spec;

      try { spec = buildExportSpec(list); }

      catch (e) { idle(); toast("导出准备失败：" + e.message); return; }

      idle();

      fileName = fileName || (APPNAME + (scope === "筛选结果" ? "_筛选" : "") + "_" + getTodayStr());

      var fullName = fileName + ".ovkmz";

      if (window.Android && typeof window.Android.exportKmz === "function") {

        var outPath = window.Android.exportPath(fullName);

        ensureWifi("导出 ovkmz（" + scope + "：" + list.length + " 个建筑，" + spec.photos.length + " 张照片）", function () {

          openXferProgress("export", "正在导出 " + fullName + " …");

          setXferTitle("正在导出 " + scope + "：" + list.length + " 个建筑 / " + spec.photos.length + " 张照片，请稍后…");

          window.Android.exportKmz(JSON.stringify(spec), outPath, XFER.resume);

        });

      } else {

        legacyExportKmz(list, fileName, scope);

      }

    }, 30);

  }

  // #353 + v3.42：ovkmz 导出对话框（范围 + 文件名 + 文件名组成 / 文件夹层次）

  function openExportKmz() {

    if (!BUILDINGS.length) { toast("没有可导出的数据"); return; }

    var fCnt = filterActive() ? filteredList().length : 0;

    var scopeHtml = filterActive()

      ? '<div class="filter-count" style="margin:0 0 12px">当前处于筛选状态，将导出<b>筛选结果</b>：<b>' + fCnt + '</b> / ' + BUILDINGS.length + ' 个' +

        (filterDesc() ? '<div class="fc-cond"><span class="fc-tag kw">' + esc(filterDesc()) + '</span></div>' : "") +

        '<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px"><input type="checkbox" id="kmzUseFilter" checked> 仅导出筛选结果（取消则导出全部）</label></div>'

      : "";

    var cfg = expDefaultCfg("kmz");

    var sampleName = assembleExportName({ name: "示例建筑物" }, cfg, APPNAME + "_" + getTodayStr());

    var html = scopeHtml +

      '<p style="font-size:13px;color:#555;margin-bottom:8px">导出奥维 kmz（含照片，可能较大）：</p>' +

      '<label class="f" style="font-size:13px;color:#555">导出文件名（不含扩展名，留空则按下方规则自动组装）</label>' +

      '<input class="f" id="kmzFileName" placeholder="留空则按勾选规则自动组装" value="">' +

      '<div style="font-size:12px;color:#888;margin:6px 0"><b>默认预览：</b><code>' + esc(sampleName) + '</code></div>' +

      renderExportOptions("kmz", cfg) +

      '<p style="font-size:12px;color:#999;margin-top:6px">将保存至：Download/水利工程一张图/（安卓）或浏览器下载目录</p>' +

      '<div class="form-actions"><button class="btn-save" onclick="doExportKmz()">开始导出</button></div>' +

      '<div id="kmzResult" style="margin-top:10px"></div>';

    $("genTitle").textContent = "导出 ovkmz";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  window.doExportKmz = function () {

    var raw = ($("kmzFileName") && $("kmzFileName").value.trim()) || "";

    var cfg = readExportOptions($("genBody"), "kmz");

    var useFilter = $("kmzUseFilter") ? $("kmzUseFilter").checked : filterActive();

    // Ovkmz 顶层文件名以第一个建筑物组装；为空则用 fileBase

    var firstB = (useFilter ? filteredList() : BUILDINGS)[0] || { name: "" };

    var fileName = raw || assembleExportName(firstB, cfg, APPNAME + "_" + getTodayStr());

    fileName = fileName.replace(/[\\/:*?"<>|]/g, "_");

    exportKmz(fileName, useFilter, cfg);

  };

  // #353 + v3.42：ovobj 导出对话框（文件名可改 + 文件名组成 / 文件夹层次）

  function openExportOvobj() {

    if (!BUILDINGS.length) { toast("没有可导出的数据"); return; }

    var cfg = expDefaultCfg("ovobj");

    var sampleName = assembleExportName({ name: "示例建筑物" }, cfg, APPNAME + "_" + getTodayStr());

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">导出 ovobj（本应用坐标格式·实验性）：</p>' +

      '<label class="f" style="font-size:13px;color:#555">导出文件名（不含扩展名，留空则按下方规则自动组装）</label>' +

      '<input class="f" id="ovobjFileName" placeholder="留空则按勾选规则自动组装" value="">' +

      '<div style="font-size:12px;color:#888;margin:6px 0"><b>默认预览：</b><code>' + esc(sampleName) + '</code></div>' +

      renderExportOptions("ovobj", cfg) +

      '<p style="font-size:12px;color:#999">将保存至：Download/水利工程一张图/（安卓）或浏览器下载目录</p>' +

      '<div class="form-actions"><button class="btn-save" onclick="doExportOvobj()">开始导出</button></div>' +

      '<div id="ovobjResult" style="margin-top:10px"></div>';

    $("genTitle").textContent = "导出 ovobj";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  window.doExportOvobj = function () {

    var raw = ($("ovobjFileName") && $("ovobjFileName").value.trim()) || "";

    var cfg = readExportOptions($("genBody"), "ovobj");

    var fileName = raw || assembleExportName({ name: "" }, cfg, APPNAME + "_" + getTodayStr());

    fileName = fileName.replace(/[\\/:*?"<>|]/g, "_");

    if (typeof exportOvobj === "function") exportOvobj(fileName);

  };

  /* 组装导出规格：KML（含属性/文件夹/多照片）+ 照片清单（磁盘相对路径）

     v3.15 增强（双向兼容：奥维地图能识别，自身也能无损导回）：

     1) 同时写 <description>（竖线串，奥维气泡可读）与 <ExtendedData><Data>（结构化，

        导回时精确还原）—— 原先只有 description，且"管理站(station)"根本没被导出，

        导入后管理站永久丢失。

     2) ovName 保留照片原扩展名，不再一律写成 .jpg。

     3) OvAttaItem 的引用文本与照片清单的 ovName 严格一一对应，导入侧按引用绑定。

     4) 去掉原先 "<Point></Point>".replace(...) 的怪写法，直接拼装几何。

     5) 支持只导出筛选结果（Req 3）。 */

  function buildExportSpec(list) {

    var src = (list && list.length) ? list : BUILDINGS;

    var root = {};

    src.forEach(function (b) {

      // v3.26：导出 KMZ 管理所文件夹名统一（温泉管理所→温泉所 / 潮河管理所→潮河所）

      var o = normOffice(b.office) || "未设置", c = (b.chan || (b.btype || "其他"));

      var fn = b.btype ? c + "--" + b.btype : c;

      root[o] = root[o] || {}; root[o][fn] = root[o][fn] || []; root[o][fn].push(b);

    });

    var photos = [];

    function extOf(f) {

      var m = /\.([A-Za-z0-9]{2,5})$/.exec(String(f || ""));

      return m ? "." + m[1].toLowerCase() : ".jpg";

    }

    function dataEl(k, v) {

      if (v == null || v === "") return "";

      return '<Data name="' + esc(k) + '"><value>' + esc(v) + "</value></Data>";

    }

    function placemark(b) {

      var desc = (b.attrs || []).map(function (a) { return esc(a[0]) + " : " + esc(a[1]); }).join("|");

      var atta = "";

      (b.photos || []).forEach(function (p) {

        if (!p || (!p.file && !p.data)) return;

        var ovName = "pic_" + photos.length + (p.file ? extOf(p.file) : ".jpg");

        // relPath 走原生磁盘管线；data 是旧数据/浏览器回退用的 base64

        photos.push({ relPath: p.file || "", data: p.file ? "" : (p.data || ""), ovName: ovName });

        atta += "<OvAttaItem>ovatta/" + ovName + "</OvAttaItem>";

      });

      // 结构化属性：内部字段 + 自定义属性，保证导回无损

      var ext = dataEl("管理单位", normOffice(b.office)) + dataEl("管理站", b.station) +

                dataEl("渠道", b.chan) + dataEl("建筑物类型", b.btype);

      (b.attrs || []).forEach(function (a) { if (a[0]) ext += dataEl(a[0], a[1]); });

      var geo;

      if (b.geom === "Line" && b.line && b.line.length) {

        geo = "<LineString><tessellate>1</tessellate><coordinates>" +

          b.line.map(function (c) { return c[0] + "," + c[1] + ",0"; }).join(" ") +

          "</coordinates></LineString>";

      } else if (b.lon != null && b.lat != null && !(b.lon === 0 && b.lat === 0)) {

        geo = "<Point><coordinates>" + b.lon + "," + b.lat + ",0</coordinates></Point>";

      } else {

        // 无坐标的建筑不写假的 0,0：否则奥维会把它标到几内亚湾海面上

        geo = "";

      }

      return "<Placemark><name>" + esc(b.name) + "</name><description>" + desc + "</description>" +

        (ext ? "<ExtendedData>" + ext + "</ExtendedData>" : "") +

        "<OvAttr><OvIcon>1</OvIcon><OvIconNum>0</OvIconNum>" + (atta ? "<OvAttaList>" + atta + "</OvAttaList>" : "") + "</OvAttr>" +

        "<Style><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon></IconStyle></Style>" +

        geo + "</Placemark>";

    }

    var folders = "";

    Object.keys(root).forEach(function (o) {

      var sub = "";

      Object.keys(root[o]).forEach(function (fn) {

        sub += "<Folder><name>" + esc(fn) + "</name>" + root[o][fn].map(placemark).join("") + "</Folder>";

      });

      folders += "<Folder><name>" + esc(o) + "</name>" + sub + "</Folder>";

    });

    var kml = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + APPNAME + "</name>" + folders + "</Document></kml>";

    return { kml: kml, photos: photos, count: src.length };

  }

  /* 浏览器/旧 WebView 回退：JSZip 直接打包（小文件）

     v3.15：不再自己拼一套 KML，改为复用 buildExportSpec，保证与原生管线导出的

     格式完全一致（同样带 ExtendedData / 管理站 / 原扩展名），避免两套格式分叉。 */

  // #353：支持可编辑文件名（fileName 不含扩展名）

  function legacyExportKmz(list, fileName, scope) {

    busy("正在打包导出，请稍后…");

    var spec = buildExportSpec(list && list.length ? list : BUILDINGS);

    var zip = new JSZip();

    zip.file("doc.kml", spec.kml);

    var pics = spec.photos;

    var proms = pics.map(function (p) {

      if (p.data) {

        var b64 = String(p.data).split(",")[1] || "";

        zip.file("ovatta/" + p.ovName, b64, { base64: true });

        return null;

      }

      if (p.relPath) {

        return fetch(p.relPath).then(function (r) { return r.arrayBuffer(); })

          .then(function (buf) { zip.file("ovatta/" + p.ovName, buf, { binary: true }); })

          .catch(function () {});

      }

      return null;

    }).filter(Boolean);

    Promise.all(proms).then(function () {

      busyDetail("正在压缩 " + pics.length + " 张照片…");

      return zip.generateAsync({ type: "blob", compression: "DEFLATE" });

    }).then(function (blob) {

      idle();

      fileName = fileName || (APPNAME + (scope === "筛选结果" ? "_筛选" : "") + "_" + getTodayStr());

      var fullName = fileName + ".ovkmz";

      if (window.Android && typeof window.Android.saveBlob === "function") {

        var r = new FileReader();

        r.onload = function () { window.Android.saveBlob(r.result, fullName); };

        r.readAsDataURL(blob);

        toast("正在导出到 Download/水利工程一张图/" + fullName);

        return;

      }

      var file = new File([blob], fullName, { type: "application/octet-stream" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: APPNAME }).catch(function () {}); return; }

      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fullName; document.body.appendChild(a); a.click(); a.remove();

      toast("已导出 " + fullName);

    }).catch(function (e) { idle(); toast("导出失败：" + e.message); });

  }



  /* ---------- 导出照片（按管理所分文件夹，原生大文件管线）---------- */

  function exportPhotos() {

    // 改为先弹出选项对话框，由 openExportPhotos 收集 范围/格式/目标 后调用 runExportPhotos

    openExportPhotos();

  }

  // 导出照片对话框：范围（全部/按管理所）、格式（zip/7z）、目标（本地/网盘/分享）

  function openExportPhotos() {

    // #352：管理所全9所（权威清单 + 实际出现，统一归一化），标记无照片的所

    var allOffices = officeOptions();

    var havePhoto = {};

    BUILDINGS.forEach(function (b) { if (b.photos && b.photos.length) havePhoto[normOffice(b.office) || "未设置管理所"] = 1; });

    var officeOpts = '<label class="exp-radio"><input type="radio" name="expOffice" value="__ALL__" checked> 全部管理所（合并一个压缩包，按管理所分文件夹）</label>' +

      allOffices.map(function (o) {

        var tag = havePhoto[o] ? "" : ' <span style="color:#bbb;font-size:11px">（暂无照片）</span>';

        return '<label class="exp-radio"><input type="radio" name="expOffice" value="' + esc(o) + '"> ' + esc(o) + tag + '（单独一个压缩包）</label>';

      }).join("");

    // #352：按建筑物自动匹配管理所（选建筑后自动选中其管理所 radio）

    var bldHtml = '<label class="f" style="font-size:13px;color:#555">🎯 按建筑物自动匹配管理所（可选）</label>' +

      '<select class="f" id="expPhotoBld" onchange="expPhotoPickBuilding()" style="margin-bottom:8px">' +

      '<option value="">（不选 / 手动选管理所）</option>' +

      BUILDINGS.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join("") +

      '</select>';

    // #353 + v3.42：文件名可编辑（不含扩展名）+ 文件名组成 / 文件夹层次

    var cfgP = expDefaultCfg("photos");

    var sampleP = assembleExportName({ name: "示例建筑物" }, cfgP, APPNAME + "_照片");

    var fileHtml = '<label class="f" style="font-size:13px;color:#555">导出文件名（不含扩展名，留空则按下方规则自动组装）</label>' +

      '<input class="f" id="expPhotoName" placeholder="留空则按勾选规则自动组装" value="">' +

      '<div style="font-size:12px;color:#888;margin:6px 0"><b>默认预览：</b><code>' + esc(sampleP) + '</code></div>' +

      renderExportOptions("photos", cfgP);

    var html =

      '<p style="font-size:13px;color:#555;margin-bottom:8px">选择照片导出方式：</p>' +

      bldHtml +

      '<div class="filter-sec"><h4>范围（管理所）</h4><div class="exp-radios">' + officeOpts + '</div></div>' +

      '<div class="filter-sec"><h4>压缩格式</h4><div class="exp-radios">' +

      '<label class="exp-radio"><input type="radio" name="expFmt" value="zip" checked> ZIP（通用，推荐）</label>' +

      '<label class="exp-radio"><input type="radio" name="expFmt" value="7z"> 7z（需原生打包支持，否则回退 ZIP）</label></div></div>' +

      '<div class="filter-sec"><h4>导出目标</h4><div class="exp-radios">' +

      '<label class="exp-radio"><span class="exp-ico" style="background:var(--primary-2)">💾</span><input type="radio" name="expTarget" value="local" checked> 本地下载（Download/水利工程一张图）</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#2e8b57">☁️</span><input type="radio" name="expTarget" value="baidu"> 百度网盘</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#e6922e">☁️</span><input type="radio" name="expTarget" value="quark"> 夸克网盘</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#1aad19">💬</span><input type="radio" name="expTarget" value="wechat"> 分享到微信</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#3370ff">📘</span><input type="radio" name="expTarget" value="feishu"> 分享到飞书</label>' +

      '<label class="exp-radio"><span class="exp-ico" style="background:#12b7f5">🐧</span><input type="radio" name="expTarget" value="qq"> 分享到 QQ</label></div></div>' +

      fileHtml +

      '<div class="form-actions"><button class="btn-save" onclick="doExportPhotos()">开始导出</button></div>' +

      '<div id="expPhotoResult" style="margin-top:10px"></div>';

    $("genTitle").textContent = "导出照片";

    $("genBody").innerHTML = html;

    openSheet("sheetGen");

  }

  // #352：按建筑物自动匹配其管理所（照片导出为单选管理所）

  window.expPhotoPickBuilding = function () {

    var id = $("expPhotoBld").value;

    if (!id) return;

    var b = BUILDINGS.find(function (x) { return x.id === id; }); if (!b) return;

    var o = normOffice(b.office) || "未设置管理所";

    document.querySelectorAll('input[name="expOffice"]').forEach(function (r) { r.checked = (r.value === o); });

    toast("已匹配管理所：" + o);

  };

  window.doExportPhotos = function () {

    try {

      // v3.46：querySelectorAll 限定到当前 sheet 容器（避免残留混淆）+ offs 归一化

      var body = $("genBody") || document;

      var office = (body.querySelector('input[name="expOffice"]:checked') || {}).value || "__ALL__";

      var fmt = (body.querySelector('input[name="expFmt"]:checked') || {}).value || "zip";

      var target = (body.querySelector('input[name="expTarget"]:checked') || {}).value || "local";

      // #353 + v3.42：cfg 回读 + folder 多级 + 文件名可编辑

      var cfgP2 = readExportOptions(body, "photos");

      var files = [];

      var firstB = null;

      BUILDINGS.forEach(function (b) {

        if (!b.photos || !b.photos.length) return;

        var no = normOffice(b.office) || "未设置管理所";

        if (office !== "__ALL__" && no !== office) return;

        if (!firstB) firstB = b;

        // 文件夹层次：按 cfg.pathFields 拼段；空段丢掉

        var segs = assembleExportPath(b, cfgP2);

        if (!segs.length) segs = [no];

        var folder = segs.map(function (s) { return String(s).replace(/[\\/:*?"<>|]/g, "_"); }).join("/");

        var bn = (b.name || "建筑物");

        b.photos.forEach(function (p, i) {

          if (!p.file) return;

          var suffix = b.photos.length > 1 ? ("_" + (i + 1)) : "";

          files.push({ relPath: p.file, folder: folder, fileName: bn + suffix });

        });

      });

      if (!files.length) { toast("没有可导出的照片"); return; }

      var raw = (body.querySelector("#expPhotoName") && body.querySelector("#expPhotoName").value.trim()) || "";

      var base = raw || assembleExportName(firstB || { name: "" }, cfgP2, APPNAME + "_照片_" + getTodayStr());

      var baseName = base.replace(/[\\/:*?"<>|]/g, "_");

      runExportPhotos(files, baseName, target, fmt);

    } catch (e) {

      try { _logErr("doExportPhotos", e.message || String(e), "doExportPhotos", 0, 0, e); } catch (e2) {}

      try { toast("导出照片出错：" + (e.message || e)); } catch (e3) {}

    }

  };

  function runExportPhotos(files, baseName, target, fmt) {

    if (!(window.Android && typeof window.Android.exportPhotos === "function")) { legacyExportPhotos(baseName); return; }

    var ext = "zip";

    if (fmt === "7z") {

      if (window.Android && typeof window.Android.exportPhotos7z === "function") ext = "7z";

      else toast("7z 打包需原生支持，已用 ZIP 格式导出");

    }

    var fileName = baseName + "." + ext;

    var outPath = window.Android.exportPath(fileName);

    pendingExportTarget = target;

    ensureWifi("导出照片（可能超过 3GB）", function () {

      openXferProgress("exportPhotos", "正在导出照片…");

      if (ext === "7z") window.Android.exportPhotos7z(JSON.stringify({ files: files }), outPath, XFER.resume);

      else window.Android.exportPhotos(JSON.stringify({ files: files }), outPath, XFER.resume);

    });

  }

  // 浏览器回退：JSZip 打包（#353：支持可编辑文件名 baseName）

  function legacyExportPhotos(baseName) {

    var offices = {};

    var total = 0;

    BUILDINGS.forEach(function (b) {

      if (!b.photos || !b.photos.length) return;

      var o = normOffice(b.office) || "未设置管理所";

      offices[o] = offices[o] || []; offices[o].push(b); total += b.photos.length;

    });

    if (!total) { toast("没有可导出的照片"); return; }

    busy("正在导出照片，请稍后…");

    var zip = new JSZip();

    var tasks = [];

    Object.keys(offices).forEach(function (o) {

      var folder = (o || "未设置管理所").replace(/[\\/:*?"<>|]/g, "_");

      offices[o].forEach(function (b) {

        var bn = (b.name || "建筑物").replace(/[\\/:*?"<>|]/g, "_");

        b.photos.forEach(function (p, i) {

          var data = p.data || p.file;

          if (!data) return;

          var ext = "jpg";

          var m = /^data:image\/(\w+)/.exec(data);

          if (m) ext = m[1] === "jpeg" ? "jpg" : m[1];

          else { var em = /\.([a-z0-9]+)$/i.exec(data); if (em) ext = (em[1].toLowerCase() === "jpeg" ? "jpg" : em[1].toLowerCase()); }

          var suffix = b.photos.length > 1 ? ("_" + (i + 1)) : "";

          tasks.push(addPhotoToZip(zip, folder, bn + suffix + "." + ext, data));

        });

      });

    });

    Promise.all(tasks).then(function () {

      return zip.generateAsync({ type: "blob", compression: "DEFLATE" });

    }).then(function (blob) {

      idle(); saveBlobFile(blob, (baseName || (APPNAME + "_照片_" + getTodayStr())) + ".zip");

      toast("照片已导出");

    }).catch(function (e) { idle(); toast("导出失败：" + e.message); });

  }

  // 跨平台照片落地：data: base64 / http(s) 直链 / 相对路径（Web 托管下按当前 origin 解析后 fetch）

  // —— 这样 Win11 / UOS / iOS 托管环境也能把照片（内置相对路径或用户添加）打进 ZIP，

  //    而不再因“相对路径既不是 data: 也不是 http:”被当作无效而跳过（旧版导致“没有可导出照片”）。

  function addPhotoToZip(zip, folder, fName, data) {

    return new Promise(function (res) {

      if (!data) { res(); return; }

      if (data.indexOf("data:") === 0) {

        // v3.31 #286：大图（>1.5MB）先 canvas 压缩到 ~600KB 再落盘，避免 ZIP 体积爆炸

        var sizeMB = data.length * 3 / 4 / 1048576;

        if (sizeMB > 1.5 && typeof canvasCompress === "function") {

          canvasCompress(data, 600, function (c) {

            try { zip.file(folder + "/" + fName, c.split(",")[1], { base64: true }); } catch (e) {}

            res();

          });

        } else {

          zip.file(folder + "/" + fName, data.split(",")[1], { base64: true });

          res();

        }

      } else if (/^https?:\/\//i.test(data)) {

        fetch(data).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {

          zip.file(folder + "/" + fName, buf, { binary: true }); res();

        }).catch(function () { res(); });

      } else {

        // 相对路径（如 images/温泉所/.../pic.jpg 或 photos/...）：解析为绝对 URL 后 fetch

        var url = data;

        try { if (!/^[a-z]+:\/\//i.test(data)) url = new URL(data, location.href).href; } catch (e) {}

        fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {

          zip.file(folder + "/" + fName, buf, { binary: true }); res();

        }).catch(function () { res(); });

      }

    });

  }



  /* ---------- 导出建筑物表格（可选列 + 筛选 + 全管理所 + 按建筑匹配 + 文件名可改）---------- */

  function exportTable() {

    var baseCols = [

      { k: "name", t: "名称", checked: true },

      // v3.45：管理处列放在「名称」后面，默认不勾选（保持原有列顺序 + 配置兼容）

      { k: "guanchu", t: "管理处", checked: false },

      { k: "office", t: "管理所", checked: true }, { k: "station", t: "管理站", checked: true },

      { k: "chan", t: "段", checked: true }, { k: "btype", t: "建筑物类型", checked: true },

      { k: "lat", t: "纬度", checked: true }, { k: "lon", t: "经度", checked: true },

      { k: "params", t: "参数说明", checked: true }, { k: "inspect", t: "巡视次数", checked: true }

    ];

    var attrKeys = uniq(BUILDINGS.reduce(function (acc, b) {

      return acc.concat((b.attrs || []).map(function (a) { return a[0]; }));

    }, [])).filter(Boolean).slice(0, 12);

    var offices = officeOptions();   // #352：全部管理所（权威9所 + 实际出现）

    var colHtml = baseCols.map(function (c) {

      // v3.45：管理处列默认不勾选，其他列维持原有默认（兼容老用户）

      return '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:14px"><input type="checkbox" class="expCol" value="' + c.k + '"' + (c.checked ? " checked" : "") + '> ' + c.t + "</label>";

    }).join("");

    var attrHtml = attrKeys.length ? '<div style="margin-top:6px;font-size:12px;color:#888">附加参数列：</div>' + attrKeys.map(function (k) {

      return '<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:13px"><input type="checkbox" class="expCol" value="attr:' + esc(k) + '"> ' + esc(k) + "</label>";

    }).join("") : "";

    // #352：按建筑物自动匹配管理所（选建筑后取消"全部"、勾选其管理所）

    var bldHtml = '<label class="f" style="font-size:13px;color:#555">🎯 按建筑物自动匹配管理所（可选）</label>' +

      '<select class="f" id="expBld" onchange="expPickBuilding()" style="margin-bottom:6px">' +

      '<option value="">（不选 / 手动勾选管理所）</option>' +

      BUILDINGS.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join("") +

      '</select>';

    var officeHtml = '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:14px"><input type="checkbox" class="expOff" value="" checked> 全部管理所</label>' +

      offices.map(function (o) { return '<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px"><input type="checkbox" class="expOff" value="' + esc(o) + '"> ' + esc(o) + "</label>"; }).join("");

    // #353 + v3.42：文件名可编辑（不含扩展名）+ 文件名组成 / 文件夹层次

    var cfgT = expDefaultCfg("table");

    var sampleT = assembleExportName({ name: "示例建筑物" }, cfgT, APPNAME + "_建筑物");

    var fileHtml = '<p style="font-size:13px;color:#555;margin:12px 0 6px">导出文件名（不含扩展名，留空则按下方规则自动组装）</p>' +

      '<input class="f" id="expFileName" placeholder="留空则按勾选规则自动组装" value="">' +

      '<div style="font-size:12px;color:#888;margin:6px 0"><b>默认预览：</b><code>' + esc(sampleT) + '</code></div>' +

      renderExportOptions("table", cfgT);

    // Req 3：处于筛选状态时，默认只导出筛选结果（可取消）

    var fCnt = filterActive() ? filteredList().length : 0;

    var scopeHtml = filterActive()

      ? '<div class="filter-count" style="margin:0 0 12px">当前处于筛选状态，默认只导出<b>筛选结果</b>：<b>' + fCnt + '</b> / ' + BUILDINGS.length + ' 个' +

        (filterDesc() ? '<div class="fc-cond"><span class="fc-tag kw">' + esc(filterDesc()) + '</span></div>' : "") +

        '<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px">' +

        '<input type="checkbox" id="expUseFilter" checked> 仅导出筛选结果（取消勾选则导出全部）</label></div>'

      : "";

    $("genTitle").textContent = "导出建筑物表格";

    $("genBody").innerHTML =

      scopeHtml +

      '<p style="font-size:13px;color:#555;margin-bottom:8px">选择要导出的字段列：</p>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px">' + colHtml + attrHtml + "</div>" +

      bldHtml +

      '<p style="font-size:13px;color:#555;margin:12px 0 6px">筛选导出的建筑物（按管理所）：</p>' +

      '<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;max-height:190px;overflow:auto">' + officeHtml + "</div>" +

      fileHtml +

      '<div class="form-actions"><button class="btn-save" onclick="doExportTable()">导出 CSV</button></div>' +

      '<div id="expTableResult" style="margin-top:10px"></div>';

    openSheet("sheetGen");

  }

  // #352：按建筑物自动匹配其管理所

  window.expPickBuilding = function () {

    var id = $("expBld").value;

    var boxes = document.querySelectorAll(".expOff");

    if (!id) { boxes.forEach(function (c) { c.checked = (c.value === ""); }); return; }

    var b = BUILDINGS.find(function (x) { return x.id === id; }); if (!b) return;

    var o = b.office || "未设置";

    boxes.forEach(function (c) { c.checked = (c.value === "" ? false : (c.value === o)); });

    toast("已匹配管理所：" + o);

  };

  window.doExportTable = function () {

    // v3.46：querySelectorAll 限定到当前 sheet 容器（避免与其他 sheetGen 残留混淆）+ offs 同样 normOffice 归一化

    var body = $("genBody") || document;

    var cols = Array.prototype.slice.call(body.querySelectorAll(".expCol")).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });

    var offs = Array.prototype.slice.call(body.querySelectorAll(".expOff")).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });

    if (!cols.length) { toast("请至少选择一列"); return; }

    var allOff = offs.indexOf("") >= 0 || offs.length === 0;

    // v3.46：先归一化 offs（与导出保持一致），避免"勾了温泉所但建筑物 office='温泉管理所'"漏选

    var offsNorm = offs.map(function (o) { return o ? (normOffice(o) || o) : ""; });

    var labelMap = { name: "名称", guanchu: "管理处", office: "管理所", station: "管理站", chan: "段", btype: "建筑物类型", lat: "纬度", lon: "经度", params: "参数说明", inspect: "巡视次数" };

    var attrCols = cols.filter(function (c) { return c.indexOf("attr:") === 0; }).map(function (c) { return c.slice(5); });

    var baseCols = cols.filter(function (c) { return c.indexOf("attr:") !== 0; });

    var header = baseCols.map(function (c) { return labelMap[c] || c; }).concat(attrCols);

    // Req 3：优先使用筛选结果作为导出基集

    var useFilter = $("expUseFilter") && $("expUseFilter").checked;

    var base = useFilter ? filteredList() : BUILDINGS;

    var rows = base.filter(function (b) {

      if (allOff) return true;

      var no = normOffice(b.office) || "未设置";

      // v3.46：管理所按规范化名比对（如 offsNorm 含"温泉所"，b.office="温泉管理所"→normOffice→"温泉所" 命中）

      return offsNorm.indexOf(no) >= 0 || offsNorm.indexOf(b.office || "") >= 0;

    });

    if (!rows.length) { toast("没有符合条件的记录可导出"); return; }

    var lines = [header.map(csvCell).join(",")];

    rows.forEach(function (b) {

      try {

        var line = baseCols.map(function (c) {

          if (c === "params") return (b.attrs || []).map(function (a) { return a[0] + ":" + a[1]; }).join("; ");

          if (c === "inspect") return (b.inspections || []).length;

          // v3.45：管理处直接取 b.guanchu（缺则回退默认值）

          if (c === "guanchu") return b.guanchu || getOrgDefaults().guanchu || "";

          // v3.26：导出时管理所名称统一（温泉管理所→温泉所 / 潮河管理所→潮河所）

          if (c === "office") return normOffice(b.office);

          return b[c] != null ? b[c] : "";

        });

        attrCols.forEach(function (k) {

          var a = (b.attrs || []).find(function (x) { return x[0] === k; });

          line.push(a ? a[1] : "");

        });

        lines.push(line.map(csvCell).join(","));

      } catch (err) { try { _logErr("doExportTable_row", err.message || String(err), "", 0, 0, err); } catch (e) {} }

    });

    var csv = "﻿" + lines.join("\r\n");

    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });

    // #353 + v3.42：文件名可编辑（留空则按 cfg + 第一项建筑组装）

    var raw = ($("expFileName") && $("expFileName").value.trim()) || "";

    var cfgT2 = readExportOptions($("genBody"), "table");

    var fileBaseN = raw || assembleExportName(rows[0] || { name: "" }, cfgT2, APPNAME + "_建筑物_" + getTodayStr());

    var fileName = fileBaseN.replace(/[\\/:*?"<>|]/g, "_") + ".csv";

    saveBlobFile(blob, fileName);

    $("expTableResult").innerHTML = '<p style="color:#2b8a5d">已导出 ' + rows.length + ' 条记录，' + header.length + ' 列' +

      (useFilter ? '（范围：筛选结果）' : '（范围：全部）') + ' → ' + esc(fileName) + '</p>';

  };

  function csvCell(s) {

    s = String(s == null ? "" : s);

    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';

    return s;

  }

  // 统一保存导出文件（优先走 Android 原生桥到 Download/水利工程一张图/，否则浏览器下载）

  function saveBlobFile(blob, fileName) {

    if (window.Android && typeof window.Android.saveBlob === "function") {

      var r = new FileReader();

      r.onload = function () { window.Android.saveBlob(r.result, fileName); };

      r.readAsDataURL(blob);

    } else {

      var a = document.createElement("a");

      a.href = URL.createObjectURL(blob); a.download = fileName;

      document.body.appendChild(a); a.click(); a.remove();

      toast("已导出 " + fileName);

    }

  }



  /* ---------- 搜索 ---------- */

  $("search").addEventListener("input", function () {

    filters.text = this.value.trim();

    saveDefaultFilter(); // v3.38：搜索框关键词写回默认值

    scheduleRender();

    // 与筛选面板的关键词框 / 实时提示区保持同步（Req 6）

    var ft = $("filterText"); if (ft && ft.value !== this.value) ft.value = this.value;

  });

  // v3.24：搜索框回车 = 查询确认（与顶栏「🔍 查询」按钮一致：0 提示 / 1 定位 / 多结果绿色虚线圈选）

  $("search").addEventListener("keydown", function (e) {

    if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); window.doQueryConfirm(); }

  });



  /* ---------- 关闭绑定 ---------- */

  document.querySelectorAll("[data-close]").forEach(function (x) {

    x.onclick = function () { closeSheet(x.dataset.close); };

  });

  $("ovMenu").onclick = function () { closeSheet("sheetMenu"); };

  $("ovGen").onclick = function () { closeSheet("sheetGen"); };

  $("ovEdit").onclick = function () { closeSheet("sheetEdit"); };

  $("lbX").onclick = function () { $("lightbox").classList.remove("show"); var li = $("lbImg"); if (li) li.src = ""; window.__lb = null; lbApplyScale(1); };

  var lbImgEl = $("lbImg");

  if (lbImgEl) {

    lbImgEl.oncontextmenu = function () { if (window.__lb) { appPhotoAct(window.__lb.id, window.__lb.i); return false; } };

    // Req 1：双击在 1x / 2.5x 之间切换放大（配合 CSS touch-action:pinch-zoom 支持双指捏合）

    var lastTap = 0;

    lbImgEl.addEventListener("click", function () {

      var now = Date.now();

      if (now - lastTap < 320) {

        lbApplyScale((window.__lb && window.__lb.scale > 1) ? 1 : 2.5);

        lastTap = 0;

      } else lastTap = now;

    });

  }

  // Req 5：顶部「查询 / 筛选」高频按钮置顶

  var btnQuery = $("btnQuery"), btnFilter = $("btnFilter");

  // v3.24：顶栏「🔍 查询」= 查询确认（输入关键词后点击：0 提示 / 1 定位 / 多结果绿色虚线圈选）

  if (btnQuery) btnQuery.onclick = function () { window.doQueryConfirm(); };

  if (btnFilter) btnFilter.onclick = openFilter;

  $("btnMenu").onclick = function () {

    if (addMode) { toggleAdd(); }

    else if (measureMode) { toggleMeasure(); }

    else if (coordPickMode) { coordPickMode = false; map._container.style.cursor = ""; $("btnMenu").textContent = "☰ 菜单"; toast("已取消拾取"); }

    else openSheet("sheetMenu");

  };



  /* ---------- 收藏窗口（记录当前地图视窗四角坐标，可收藏多个；放回收藏窗口跳回视窗）---------- */

  var BM_KEY = "shuili_bookmarks";

  function getBookmarks() {

    try { var a = JSON.parse(localStorage.getItem(BM_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; }

  }

  function saveBookmarks(a) { try { localStorage.setItem(BM_KEY, JSON.stringify(a)); } catch (e) {} }

  var btnZi = $("btnZoomIn"), btnZo = $("btnZoomOut"), btnBk = $("btnBookmark"), btnGb = $("btnGotoBookmark");

  if (btnZi) btnZi.onclick = function () { map.zoomIn(); };

  if (btnZo) btnZo.onclick = function () { map.zoomOut(); };

  // 收藏窗口：记录当前视窗四角（bounds），可收藏多个窗口位置

  window.appBookmark = function () {

    if (!map) return;

    var b = map.getBounds(), sw = b.getSouthWest(), ne = b.getNorthEast();

    var list = getBookmarks();

    list.push({ sw: [sw.lat, sw.lng], ne: [ne.lat, ne.lng], t: Date.now() });

    saveBookmarks(list);

    toast("已收藏窗口（共 " + list.length + " 个）");

  };

  // 放回收藏窗口：跳回记录的视窗范围（fitBounds 显示整窗），多个时弹出选择

  window.appGotoBookmark = function () {

    if (!map) return;

    var list = getBookmarks();

    if (!list.length) { toast("尚未收藏窗口，请先点 ☆ 收藏窗口"); return; }

    if (list.length === 1) { gotoBookmark(list[0]); return; }

    openBookmarkChooser(list);

  };

  function gotoBookmark(bm) {

    try {

      map.fitBounds([[bm.sw[0], bm.sw[1]], [bm.ne[0], bm.ne[1]]], { animate: true, padding: [40, 40] });

      toast("已放回收藏窗口");

    } catch (e) { toast("收藏窗口数据无效"); }

  }

  function openBookmarkChooser(list) {

    var rows = list.map(function (bm, i) {

      var d = new Date(bm.t);

      var ts = (d.getMonth() + 1) + "-" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

      return '<div class="bm-row" style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border)">' +

        '<span style="flex:1;font-size:13px">窗口 ' + (i + 1) + ' <span style="color:#888">（' + ts + '）</span></span>' +

        '<button class="btn-save" style="padding:4px 10px;font-size:12px" onclick="gotoBookmarkByIndex(' + i + ')">放回</button>' +

        '<button class="btn-cancel2" style="padding:4px 10px;font-size:12px" onclick="delBookmarkByIndex(' + i + ')">删除</button>' +

        '</div>';

    }).join("");

    $("genTitle").textContent = "选择收藏窗口（共 " + list.length + " 个）";

    $("genBody").innerHTML = rows + '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button></div>';

    openSheet("sheetGen");

  }

  window.gotoBookmarkByIndex = function (i) { closeSheet("sheetGen"); var l = getBookmarks(); if (l[i]) gotoBookmark(l[i]); };

  window.delBookmarkByIndex = function (i) {

    var l = getBookmarks(); if (!l[i]) return;

    l.splice(i, 1); saveBookmarks(l);

    if (!l.length) { closeSheet("sheetGen"); toast("已清空收藏窗口"); return; }

    openBookmarkChooser(l); toast("已删除该窗口");

  };

  if (btnBk) btnBk.onclick = function () { window.appBookmark(); };

  if (btnGb) btnGb.onclick = function () { window.appGotoBookmark(); };



  /* ---------- 三击任意处（含空白/地图）：先关最上层弹层，否则呼出主菜单（避免卡页） ---------- */

  // 关闭当前最上层的可见弹层/全屏页；返回 true 表示关掉了一层。传输/忙提示期间不响应。

  function anyBusy() {

    return ($("busyOverlay") && $("busyOverlay").classList.contains("show")) ||

           ($("xferOverlay") && $("xferOverlay").classList.contains("show"));

  }

  function closeTopLayer() {

    if ($("askBox") && $("askBox").classList.contains("show")) { closeAsk(); return true; }

    if ($("lightbox") && $("lightbox").classList.contains("show")) {

      $("lightbox").classList.remove("show");

      var li = $("lbImg"); if (li) li.src = "";        // 释放大图内存

      window.__lb = null; lbApplyScale(1);

      return true;

    }

    if ($("photoAct") && $("photoAct").classList.contains("show")) { $("photoAct").classList.remove("show"); return true; }

    if ($("sheetGen") && $("sheetGen").classList.contains("show")) { closeSheet("sheetGen"); return true; }

    if ($("sheetFilter") && $("sheetFilter").classList.contains("show")) { closeSheet("sheetFilter"); return true; }

    if ($("sheetMenu") && $("sheetMenu").classList.contains("show")) { closeSheet("sheetMenu"); return true; }

    if ($("listView") && $("listView").style.display === "block") { toggleList(); return true; }

    return false;

  }

  var tapTimes = [];

  document.addEventListener("click", function (e) {

    if (e.target.closest && e.target.closest(".sheet")) return;   // 弹层按钮/内容点击不计入（避免与退出按钮冲突）

    if (anyBusy()) return;                                         // 传输/忙提示期间忽略，防误触

    var now = Date.now(); tapTimes.push(now); tapTimes = tapTimes.filter(function (t) { return now - t < 700; });

    if (tapTimes.length >= 3) {

      tapTimes = [];

      // 有弹层/全屏页开着 → 三击=退出当前页面；否则呼出主菜单

      if (closeTopLayer()) toast("已退出当前页面");

      else { openSheet("sheetMenu"); toast("已呼出主菜单"); }

    }

  });



  /* ---------- 悬浮菜单按钮（FAB）---------- */

  var fab = document.createElement("div");

  fab.id = "fabMenu";

  fab.innerHTML = "☰";

  fab.style.cssText = "position:fixed;right:14px;bottom:60px;width:48px;height:48px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:1500;cursor:pointer;user-select:none;";

  fab.onclick = function () {

    if (addMode) toggleAdd();

    else if (measureMode) toggleMeasure();

    else if (coordPickMode) { coordPickMode = false; map._container.style.cursor = ""; $("btnMenu").textContent = "☰ 菜单"; }

    else openSheet("sheetMenu");

  };

  document.body.appendChild(fab);



  /* ---------- 启动 ---------- */

  load();

  initMap();

  initAIModule(); buildMenu();

  applyDefaultFilter(); // v3.38：打开时套用筛选默认值（默认非"全部"，避免全量渲染卡顿）

  render();

  if (window.CtxMenu) window.CtxMenu.init({ map: map, records: function () { return BUILDINGS; }, textFields: [], getCoordinates: getCoordinates, nearbySearch: nearbySearch });



  // 启动即清理解压临时目录（上次导入若中途退出会残留数 GB 的 inbox/uz_*），释放空间、避免“数据还在”

  if (window.Android && typeof window.Android.cleanInbox === "function") { try { window.Android.cleanInbox(); } catch (e) {} }

  // 首次进入提示三击快捷键（避免卡页找不到主菜单）

  setTimeout(function () { var h = $("tripleHint"); if (h) { h.classList.add("show"); setTimeout(function () { h.classList.remove("show"); }, 3500); } }, 1200);



  /* ---------- 智能AI（设置 + 智能助手）初始化 ---------- */

  function initAIModule() {

    if (!window.AIModule) return;

    window.AIModule.init({

      domain: "shuili",

      appName: "水利工程基础信息一张图",

      allowOnlineQuery: false,

      fieldSchema: ["office","station","btype","chan"],

      getRecord: function (id) { return BUILDINGS.find(function (x) { return x.id === id; }); },

      searchRecords: function (q) {

        q = (q || "").trim();

        return BUILDINGS.filter(function (b) { return !q || ["name","office","station"].some(function (f) { return (b[f] || "").indexOf(q) >= 0; }); });

      },

      listAll: function () { return BUILDINGS; },

      applyUpdate: function (rec, patch) {

        ["office","station","btype","chan"].forEach(function (k) { if (patch[k] != null && String(patch[k]).trim() !== "") rec[k] = patch[k]; });

        save(); render();

      }

    });

  }







  /* ---------- v3.48 长按子菜单→快捷常用 ---------- */

  (function () {

    if (window.__favLongPressInstalled) return;

    window.__favLongPressInstalled = true;

    var PRESS_MS = 600, suppressMouseUntil = 0;

    function favToggle(k) {

      if (typeof toggleFavMenu === "function") { toggleFavMenu(k); return true; }

      if (typeof _v32_favToggle === "function") { _v32_favToggle(k); return true; }

      return false;

    }

    function favIsOn(k) {

      try {

        if (typeof _v32_favHas === "function") return _v32_favHas(k);

        return (JSON.parse(localStorage.getItem("favMenus") || "[]")).indexOf(k) >= 0;

      } catch (e) { return false; }

    }

    function bind(el) {

      if (el.__favLP || !el.querySelector) return;

      el.__favLP = true;

      var star = el.querySelector(".menu-fav");

      if (!star || !star.dataset || !star.dataset.k) return;

      var k = star.dataset.k;

      var timer = null, fired = false;

      function fire() {

        fired = true;

        favToggle(k);

        var on = favIsOn(k);

        var s = el.querySelector(".menu-fav");

        if (s) { s.textContent = on ? "\u2605" : "\u2606"; s.style.color = on ? "#f0a020" : "#c8cdd2"; }

        el.style.background = "rgba(240,160,32,.18)";

        setTimeout(function () { try { el.style.background = ""; } catch (e) {} }, 500);

        try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}

        var label = String(el.textContent || "").replace(/[\u2605\u2606]/g, "").trim();

        try { toast(on ? "\u5df2\u52a0\u5165\u5feb\u6377\u5e38\u7528\uff1a" + label : "\u5df2\u79fb\u51fa\u5feb\u6377\u5e38\u7528\uff1a" + label); } catch (e) {}

      }

      function begin() { fired = false; if (timer) clearTimeout(timer); timer = setTimeout(function () { timer = null; fire(); }, PRESS_MS); }

      function cancel() { if (timer) { clearTimeout(timer); timer = null; } }

      el.addEventListener("touchstart", function () { suppressMouseUntil = Date.now() + 2000; begin(); }, { passive: true });

      el.addEventListener("touchend", cancel);

      el.addEventListener("touchmove", cancel);

      el.addEventListener("touchcancel", cancel);

      el.addEventListener("mousedown", function () { if (Date.now() < suppressMouseUntil) return; begin(); });

      el.addEventListener("mouseup", cancel);

      el.addEventListener("mouseleave", cancel);

      /* 长按触发后吞掉随后的 click，避免「加收藏」同时把菜单打开了 */

      el.addEventListener("click", function (ev) {

        if (fired) { fired = false; ev.stopPropagation(); ev.preventDefault(); }

      }, true);

    }

    function bindAll() {

      var mb = document.getElementById("menuBody");

      if (!mb) return;

      var items = mb.querySelectorAll(".menu-item.sub");

      for (var i = 0; i < items.length; i++) { try { bind(items[i]); } catch (e) {} }

    }

    function start() {

      var mb = document.getElementById("menuBody");

      if (!mb) { setTimeout(start, 300); return; }

      if (typeof MutationObserver !== "undefined") {

        try { new MutationObserver(function () { bindAll(); }).observe(mb, { childList: true, subtree: true }); }

        catch (e) { setInterval(bindAll, 800); }

      } else {

        setInterval(bindAll, 800);

      }

      bindAll();

    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);

    else start();

  })();



})();


/* ============================================================================
 * 游记 / 备忘录 模块（所见即所得编辑器 + 关键字筛选 + 智能AI查询 + 导入导出）
 * 三端四平台共享同一份函数，仅通过 nmInstall(cfg) 适配：
 *   cfg = {
 *     kind:      "游记" | "备忘录",
 *     docNoun:   "古建" | "建筑物" | "感知设备",
 *     appName:   "古建景点打卡" | "水利感知平台" | "水利一张图",
 *     lsKey:     "gujian_notes_v1" 等（localStorage 键）,
 *     fileTag:   "gujian" | "perc" | "shuili"（导出文件名用，纯 ASCII）,
 *     bindLabel: "绑定古建" | "绑定建筑物" | "绑定感知设备",
 *     recs:      function(){ return HERITAGE | BUILDINGS; },
 *     recName:   function(r){ return 显示名; }
 *   }
 * 依赖宿主全局：$ / esc / toast / save / compressDataUrlIfBig / appFly / window.AIModule.ask
 * ========================================================================== */
var nmCfg = null;
function nmInstall(cfg) { nmCfg = cfg; }
var nmEditId = null;

/* ---------- 存储 ---------- */
function nmGetAll() { try { return JSON.parse(localStorage.getItem(nmCfg.lsKey) || "[]"); } catch (e) { return []; } }
function nmPersist(arr) { try { localStorage.setItem(nmCfg.lsKey, JSON.stringify(arr)); return true; } catch (e) { try { toast("保存失败：本地存储可能已满"); } catch (_) {} return false; } }
function nmById(id) { return nmGetAll().find(function (n) { return n.id === id; }); }
function nmNow() { return new Date().toLocaleString("zh-CN"); }
function nmStripHtml(html) { var d = document.createElement("div"); d.innerHTML = html || ""; return (d.textContent || "").replace(/\s+/g, " ").trim(); }
function nmFly(id) { try { if (id && window.appFly) window.appFly(id); else if (id && typeof appFly === "function") appFly(id); } catch (e) {} }

/* ---------- 编辑器样式（注入一次）---------- */
function nmEnsureStyle() {
  if (document.getElementById("nmStyle")) return;
  var s = document.createElement("style"); s.id = "nmStyle";
  s.textContent = [
    ".nm-mask{position:fixed;inset:0;background:rgba(40,30,20,.45);z-index:9999;display:flex;align-items:flex-end;justify-content:center}",
    ".nm-sheet{width:100%;max-width:680px;background:#fff;max-height:94vh;display:flex;flex-direction:column;border-radius:16px 16px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.25)}",
    ".nm-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eee;font-weight:700;color:#6b2e2e}",
    ".nm-head .nm-title{flex:1;font-size:16px}",
    ".nm-body{padding:12px 14px;overflow:auto;flex:1}",
    ".nm-row{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center}",
    ".nm-row label{font-size:12px;color:#8a7c70}",
    ".nm-f{flex:1;min-width:120px;padding:8px 10px;border:1px solid #e4dccf;border-radius:8px;font-size:14px;background:#fffdf9}",
    ".nm-toolbar{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;background:#faf6ef;border-bottom:1px solid #eee;align-items:center}",
    ".nm-tb{height:32px;min-width:32px;padding:0 8px;border:1px solid #e4dccf;background:#fff;border-radius:7px;cursor:pointer;font-size:13px}",
    ".nm-tb:hover{background:#fff3da}",
    ".nm-edit{min-height:200px;max-height:38vh;overflow:auto;border:1px solid #e4dccf;border-radius:10px;padding:10px;font-size:14px;line-height:1.7;background:#fffdf9;outline:none}",
    ".nm-edit:empty:before{content:attr(data-ph);color:#b9ad9c}",
    ".nm-edit img{max-width:100%;border-radius:8px;margin:4px 0}",
    ".nm-edit table{border-collapse:collapse;width:100%;margin:6px 0}",
    ".nm-edit td,.nm-edit th{border:1px solid #d8cdb8;padding:6px 8px;font-size:13px}",
    ".nm-actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #eee}",
    ".nm-btn{flex:1;padding:10px;border:none;border-radius:10px;font-size:14px;cursor:pointer;font-weight:600}",
    ".nm-save{background:#b8862f;color:#fff}",
    ".nm-ghost{background:#efe7d8;color:#6b2e2e}",
    ".nm-list-item{border:1px solid #eee;border-radius:10px;padding:10px;margin-bottom:8px;background:#fffdf9}",
    ".nm-list-item .t{font-weight:700;color:#3a2e28}",
    ".nm-list-item .m{font-size:12px;color:#8a7c70;margin:2px 0}",
    ".nm-list-item .s{font-size:13px;color:#5a4d40;margin:4px 0}",
    ".nm-chips{display:flex;gap:6px;flex-wrap:wrap}",
    ".nm-search{flex:1;min-width:140px;padding:8px 10px;border:1px solid #e4dccf;border-radius:8px;font-size:14px}",
    ".nm-emoji-pop{position:absolute;background:#fff;border:1px solid #e4dccf;border-radius:10px;padding:6px;display:flex;flex-wrap:wrap;gap:4px;max-width:240px;z-index:10001;box-shadow:0 4px 16px rgba(0,0,0,.18)}",
    ".nm-emoji-pop span{cursor:pointer;font-size:20px;padding:2px 4px}",
    ".nm-out{margin-top:10px;font-size:13px;line-height:1.7;color:#3a2e28;white-space:pre-wrap;background:#fff7e6;border:1px solid #ffe7a3;border-radius:10px;padding:10px}",
    ".nm-empty{color:#8a7c70;font-size:13px;text-align:center;padding:20px}"
  ].join("\n");
  document.head.appendChild(s);
}

/* ---------- caret 插入辅助 ---------- */
function nmInsertHtml(html) { try { document.execCommand("insertHTML", false, html); } catch (e) {} }
function nmExec(cmd, val) { try { document.execCommand(cmd, false, val || null); } catch (e) {} }

/* ---------- 从编辑器当前字段构造一条记录（用于导出/未保存态）---------- */
function nmCurrentNote() {
  var ed = document.getElementById("nmEdit");
  var bindSel = document.getElementById("nmBind");
  var bindId = bindSel ? bindSel.value : "";
  var recs = nmCfg.recs() || []; var bindName = "";
  if (bindId) { var br = recs.find(function (r) { return String(r.id) === String(bindId); }); if (br) bindName = nmCfg.recName(br); }
  var existing = nmEditId ? nmById(nmEditId) : null;
  return {
    id: (nmEditId || ("n" + Date.now() + "_" + Math.floor(Math.random() * 1e4).toString(36))),
    title: (document.getElementById("nmTitle").value.trim() || (nmCfg.kind + " " + nmNow())),
    summary: (document.getElementById("nmSummary") ? document.getElementById("nmSummary").value.trim() : ""),
    bindId: bindId, bindName: bindName,
    html: ed ? ed.innerHTML : "",
    createdAt: existing ? existing.createdAt : nmNow(),
    updatedAt: nmNow()
  };
}

/* ---------- 导出下载（与导入格式一致，图片以 base64 内嵌）---------- */
function nmDownload(items) {
  var data = { app: nmCfg.appName, kind: nmCfg.kind, version: 1, exportedAt: new Date().toISOString(), items: items };
  var fn = "notes_" + (nmCfg.fileTag || "export") + "_" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".json";
  try {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url; a.download = fn;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
    toast("已导出 " + items.length + " 条" + nmCfg.kind);
  } catch (e) { toast("导出失败：" + (e && e.message || e)); }
}

/* ============================================================================
 * 编辑器（所见即所得）
 * ========================================================================== */
function nmOpenEditor(id) {
  if (!nmCfg) { try { toast("模块未初始化"); } catch (_) {} return; }
  nmEnsureStyle();
  nmEditId = id || null;
  var editing = id ? nmById(id) : null;
  var recs = nmCfg.recs() || [];
  var opts = recs.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(nmCfg.recName(r)) + "</option>"; }).join("");
  var sel = editing ? editing.bindId : (recs[0] ? recs[0].id : "");
  var html =
    '<div class="nm-mask" id="nmMask">' +
      '<div class="nm-sheet">' +
        '<div class="nm-head"><span class="nm-title">' + (editing ? ("编辑" + nmCfg.kind) : ("写" + nmCfg.kind)) + '</span>' +
          '<button class="nm-tb" id="nmClose">✕ 关闭</button></div>' +
        '<div class="nm-body">' +
          '<div class="nm-row"><label>' + nmCfg.bindLabel + '</label>' +
            '<select class="nm-f" id="nmBind">' + (opts ? ('<option value="">（不绑定）</option>' + opts) : ('<option value="">（无' + nmCfg.docNoun + '）</option>')) + '</select></div>' +
          '<div class="nm-row"><label>标题</label><input class="nm-f" id="nmTitle" placeholder="' + nmCfg.kind + '标题" value="' + esc(editing ? editing.title : "") + '"></div>' +
          '<div class="nm-row"><label>摘要/关键词</label><input class="nm-f" id="nmSummary" placeholder="一句话摘要，便于筛选（如：周末游、建筑结构）" value="' + esc(editing ? editing.summary : "") + '"></div>' +
          '<div class="nm-toolbar">' +
            '<select class="nm-tb" id="nmFont" title="字体"><option>默认</option><option>宋体</option><option>黑体</option><option>楷体</option><option>微软雅黑</option><option>serif</option><option>sans-serif</option></select>' +
            '<select class="nm-tb" id="nmSize" title="字号"><option value="">字号</option><option value="2">小</option><option value="3">正常</option><option value="4">大</option><option value="5">特大</option><option value="6">超大</option></select>' +
            '<button class="nm-tb" id="nmB" title="粗体"><b>B</b></button>' +
            '<button class="nm-tb" id="nmI" title="斜体"><i>I</i></button>' +
            '<button class="nm-tb" id="nmU" title="下划线"><u>U</u></button>' +
            '<input type="color" id="nmColor" class="nm-tb" title="文字颜色" value="#b8862f" style="width:34px;padding:2px">' +
            '<button class="nm-tb" id="nmEmoji" title="表情符号">😊</button>' +
            '<button class="nm-tb" id="nmImg" title="插入图片">🖼️</button>' +
            '<button class="nm-tb" id="nmTable" title="插入表格">▦</button>' +
            '<button class="nm-tb" id="nmUndo" title="撤销">↶</button>' +
            '<button class="nm-tb" id="nmRedo" title="重做">↷</button>' +
          '</div>' +
          '<div class="nm-edit" id="nmEdit" contenteditable="true" data-ph="在此输入' + nmCfg.kind + '内容，支持复制粘贴、字体/字号/表情/图片/表格…">' + (editing ? editing.html : "") + '</div>' +
          '<input type="file" id="nmImgFile" accept="image/*" style="display:none">' +
        '</div>' +
        '<div class="nm-actions">' +
          (editing ? '<button class="nm-btn nm-ghost" id="nmDel">🗑 删除</button>' : '') +
          '<button class="nm-btn nm-ghost" id="nmAsk">🤖 问AI</button>' +
          '<button class="nm-btn nm-ghost" id="nmExp">⬇ 导出</button>' +
          '<button class="nm-btn nm-save" id="nmSave">💾 保存</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  var old = document.getElementById("nmMask"); if (old) old.remove();
  var box = document.createElement("div"); box.innerHTML = html;
  document.body.appendChild(box.firstElementChild);
  var mask = document.getElementById("nmMask");
  var ed = document.getElementById("nmEdit");
  function focusEd() { ed.focus(); }
  if (sel) { var bs = document.getElementById("nmBind"); if (bs) bs.value = sel; }
  document.getElementById("nmClose").onclick = function () { mask.remove(); };
  mask.onclick = function (e) { if (e.target === mask) mask.remove(); };

  document.getElementById("nmFont").onchange = function () { if (this.value && this.value !== "默认") nmExec("fontName", this.value); };
  document.getElementById("nmSize").onchange = function () { if (this.value) nmExec("fontSize", this.value); };
  document.getElementById("nmB").onclick = function () { nmExec("bold"); };
  document.getElementById("nmI").onclick = function () { nmExec("italic"); };
  document.getElementById("nmU").onclick = function () { nmExec("underline"); };
  document.getElementById("nmColor").onclick = function () { focusEd(); };
  document.getElementById("nmColor").oninput = function () { nmExec("foreColor", this.value); };
  document.getElementById("nmUndo").onclick = function () { nmExec("undo"); };
  document.getElementById("nmRedo").onclick = function () { nmExec("redo"); };
  document.getElementById("nmTable").onclick = function () { focusEd(); nmInsertHtml('<table><tbody><tr><td>表头1</td><td>表头2</td></tr><tr><td>内容</td><td>内容</td></tr></tbody></table><p><br></p>'); };

  var EMO = ["😀", "😄", "😊", "🤔", "👍", "👏", "❤️", "🔥", "⭐", "🌟", "📍", "🏯", "🏞️", "🌊", "💡", "✅", "⚠️", "📷", "📌", "🎉", "😅", "🙏", "💧", "🛠️", "🌿", "🍃"];
  document.getElementById("nmEmoji").onclick = function (e) {
    e.stopPropagation();
    var ex = document.getElementById("nmEmojiPop"); if (ex) { ex.remove(); return; }
    var pop = document.createElement("div"); pop.id = "nmEmojiPop"; pop.className = "nm-emoji-pop";
    pop.innerHTML = EMO.map(function (x) { return '<span>' + x + '</span>'; }).join("");
    document.body.appendChild(pop);
    var r = this.getBoundingClientRect(); pop.style.left = Math.max(6, r.left) + "px"; pop.style.top = (r.top - pop.offsetHeight - 6) + "px";
    pop.querySelectorAll("span").forEach(function (sp) { sp.onclick = function () { focusEd(); nmInsertHtml(sp.textContent); pop.remove(); }; });
  };
  if (!window.__nmEmojiBound) { window.__nmEmojiBound = true; document.addEventListener("click", function (ev) { var p = document.getElementById("nmEmojiPop"); if (p && !p.contains(ev.target) && ev.target.id !== "nmEmoji") p.remove(); }); }

  var imgBtn = document.getElementById("nmImg");
  imgBtn.onclick = function () { document.getElementById("nmImgFile").click(); };
  document.getElementById("nmImgFile").onchange = function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { compressDataUrlIfBig(rd.result, function (d) { focusEd(); nmInsertHtml('<img src="' + d + '" alt="' + esc(f.name) + '">'); }); };
    rd.readAsDataURL(f); this.value = "";
  };

  document.getElementById("nmSave").onclick = function () {
    var note = nmCurrentNote();
    var all = nmGetAll();
    if (editing) { var i = all.findIndex(function (n) { return n.id === editing.id; }); if (i >= 0) all[i] = note; else all.unshift(note); }
    else all.unshift(note);
    if (nmPersist(all)) { toast("已保存" + nmCfg.kind + "：" + note.title); mask.remove(); nmOpenList(); }
  };
  if (editing) document.getElementById("nmDel").onclick = function () {
    if (!confirm("确定删除这条" + nmCfg.kind + "？")) return;
    var all = nmGetAll().filter(function (n) { return n.id !== editing.id; });
    nmPersist(all); toast("已删除"); mask.remove(); nmOpenList();
  };
  document.getElementById("nmExp").onclick = function () { nmDownload([nmCurrentNote()]); };
  document.getElementById("nmAsk").onclick = function () { nmAskAI(); };
}

/* ============================================================================
 * 列表（关键字筛选：绑定名 / 记录时间 / 摘要 / 正文）
 * ========================================================================== */
function nmRenderList(kw) {
  var box = document.getElementById("nmListBox"); if (!box) return;
  var all = nmGetAll();
  if (kw) {
    var t = kw.toLowerCase();
    all = all.filter(function (n) {
      return (n.title || "").toLowerCase().indexOf(t) >= 0
        || (n.bindName || "").toLowerCase().indexOf(t) >= 0
        || (n.summary || "").toLowerCase().indexOf(t) >= 0
        || (n.createdAt || "").toLowerCase().indexOf(t) >= 0
        || (n.updatedAt || "").toLowerCase().indexOf(t) >= 0
        || nmStripHtml(n.html).toLowerCase().indexOf(t) >= 0;
    });
  }
  if (!all.length) { box.innerHTML = '<div class="nm-empty">还没有' + nmCfg.kind + '，点「✍️ 写' + nmCfg.kind + '」开始</div>'; return; }
  box.innerHTML = all.map(function (n) {
    var preview = nmStripHtml(n.html).slice(0, 80);
    return '<div class="nm-list-item">' +
      '<div class="t">' + esc(n.title || "(无标题)") + '</div>' +
      '<div class="m">' + (n.bindName ? ('🔗 ' + esc(n.bindName)) : '未绑定') + '　·　🕒 ' + esc(n.updatedAt || n.createdAt || "") + '</div>' +
      (n.summary ? '<div class="s">📝 ' + esc(n.summary) + '</div>' : '') +
      (preview ? '<div class="s" style="color:#8a7c70">' + esc(preview) + '</div>' : '') +
      '<div class="nm-chips" style="margin-top:6px">' +
        '<button class="nm-tb" data-edit="' + esc(n.id) + '">编辑</button>' +
        (n.bindId ? '<button class="nm-tb" data-fly="' + esc(n.bindId) + '">定位</button>' : '') +
        '<button class="nm-tb" data-del="' + esc(n.id) + '">删除</button>' +
      '</div>' +
    '</div>';
  }).join("");
  box.querySelectorAll("[data-edit]").forEach(function (el) { el.onclick = function () { var m = document.getElementById("nmMask"); if (m) m.remove(); nmOpenEditor(el.getAttribute("data-edit")); }; });
  box.querySelectorAll("[data-fly]").forEach(function (el) { el.onclick = function () { nmFly(el.getAttribute("data-fly")); }; });
  box.querySelectorAll("[data-del]").forEach(function (el) { el.onclick = function () {
    var id = el.getAttribute("data-del"); if (!confirm("确定删除这条" + nmCfg.kind + "？")) return;
    var a = nmGetAll().filter(function (n) { return n.id !== id; }); nmPersist(a); toast("已删除");
    nmRenderList(document.getElementById("nmQ") ? document.getElementById("nmQ").value.trim() : "");
  }; });
}

function nmOpenList() {
  if (!nmCfg) { try { toast("模块未初始化"); } catch (_) {} return; }
  nmEnsureStyle();
  var all = nmGetAll();
  var html =
    '<div class="nm-mask" id="nmMask">' +
      '<div class="nm-sheet">' +
        '<div class="nm-head"><span class="nm-title">我的' + nmCfg.kind + '（' + all.length + '）</span>' +
          '<button class="nm-tb" id="nmClose">✕ 关闭</button></div>' +
        '<div class="nm-body">' +
          '<div class="nm-row"><input class="nm-search" id="nmQ" placeholder="筛选：' + nmCfg.bindLabel.replace("绑定", "") + '名称 / 记录时间 / ' + nmCfg.kind + '摘要">' +
            '<button class="nm-tb" id="nmNew">✍️ 写' + nmCfg.kind + '</button>' +
            '<button class="nm-tb" id="nmImportBtn">⬆ 导入</button>' +
            '<button class="nm-tb" id="nmExpAll">⬇ 导出</button>' +
            '<button class="nm-tb" id="nmAskAll">🤖 问AI</button></div>' +
          '<div id="nmListBox"></div>' +
          '<input type="file" id="nmImpFile" accept=".json,application/json" style="display:none">' +
        '</div>' +
      '</div>' +
    '</div>';
  var old = document.getElementById("nmMask"); if (old) old.remove();
  var box = document.createElement("div"); box.innerHTML = html;
  document.body.appendChild(box.firstElementChild);
  var mask = document.getElementById("nmMask");
  document.getElementById("nmClose").onclick = function () { mask.remove(); };
  mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
  document.getElementById("nmNew").onclick = function () { mask.remove(); nmOpenEditor(null); };
  document.getElementById("nmExpAll").onclick = function () { var a = nmGetAll(); if (!a.length) { toast("还没有" + nmCfg.kind); return; } nmDownload(a); };
  document.getElementById("nmAskAll").onclick = function () { nmAskAI(); };
  document.getElementById("nmImportBtn").onclick = function () { document.getElementById("nmImpFile").click(); };
  document.getElementById("nmImpFile").onchange = function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var d = JSON.parse(rd.result);
        var items = Array.isArray(d) ? d : (d.items || []);
        if (!items.length) { toast("文件中没有" + nmCfg.kind + "数据"); return; }
        var allx = nmGetAll(); var cnt = 0;
        items.forEach(function (it) {
          if (!it || !it.id) return;
          var ex = allx.findIndex(function (n) { return n.id === it.id; });
          if (ex >= 0) allx[ex] = it; else allx.unshift(it);
          cnt++;
        });
        nmPersist(allx); toast("已导入 " + cnt + " 条" + nmCfg.kind); nmRenderList("");
      } catch (e) { toast("导入失败：" + (e && e.message || e)); }
    };
    rd.readAsText(f); this.value = "";
  };
  document.getElementById("nmQ").oninput = function () { nmRenderList(this.value.trim()); };
  nmRenderList("");
}

/* ============================================================================
 * 智能AI 查询（把全部游记/备忘录作为上下文，调用 AIModule.ask）
 * ========================================================================== */
function nmAskAI() {
  if (!nmCfg) { try { toast("模块未初始化"); } catch (_) {} return; }
  nmEnsureStyle();
  var all = nmGetAll();
  if (!all.length) { toast("还没有可查询的" + nmCfg.kind + "，先写几条吧"); return; }
  var ctx = all.map(function (n) {
    return "【" + (n.title || "") + "】" + (n.bindName ? (" 绑定:" + n.bindName) : "") + (n.summary ? (" 摘要:" + n.summary) : "") + "\n" + (nmStripHtml(n.html) || "（空）");
  }).join("\n----------\n");
  var html =
    '<div class="nm-mask" id="nmMask">' +
      '<div class="nm-sheet">' +
        '<div class="nm-head"><span class="nm-title">🤖 用智能AI查询' + nmCfg.kind + '</span>' +
          '<button class="nm-tb" id="nmClose">✕ 关闭</button></div>' +
        '<div class="nm-body">' +
          '<p style="font-size:13px;color:#3a2e28;line-height:1.6">将把你的 ' + all.length + ' 条' + nmCfg.kind + '作为上下文发给智能AI（不外泄）。输入问题即可问答。</p>' +
          '<textarea class="nm-f" id="nmAskQ" rows="3" placeholder="如：哪几条提到了都江堰？/ 帮我总结关于故宫的游览要点"></textarea>' +
          '<div id="nmAskOut"></div>' +
        '</div>' +
        '<div class="nm-actions">' +
          '<button class="nm-btn nm-ghost" id="nmAskBack">返回</button>' +
          '<button class="nm-btn nm-save" id="nmAskRun">查询</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  var old = document.getElementById("nmMask"); if (old) old.remove();
  var box = document.createElement("div"); box.innerHTML = html;
  document.body.appendChild(box.firstElementChild);
  var mask = document.getElementById("nmMask");
  document.getElementById("nmClose").onclick = function () { mask.remove(); };
  mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
  document.getElementById("nmAskBack").onclick = function () { mask.remove(); nmOpenList(); };
  document.getElementById("nmAskRun").onclick = function () {
    var q = document.getElementById("nmAskQ").value.trim(); if (!q) { toast("请输入问题"); return; }
    if (!window.AIModule || typeof AIModule.ask !== "function") { toast("未启用智能AI：请先到「设置→智能AI设置」配置模型"); return; }
    var out = document.getElementById("nmAskOut"); out.innerHTML = '<div class="nm-out">🔒 正在思考…</div>';
    var sys = "你是「" + nmCfg.appName + "」的本地助手。用户写了一些" + nmCfg.kind + "，内容涉及" + nmCfg.docNoun + "的现场记录与心得。请基于下面提供的" + nmCfg.kind + "上下文回答用户问题，不要编造上下文之外的内部数据；引用时尽量注明出自哪条" + nmCfg.kind + "。用中文、条理清晰。";
    var user = "用户问题：" + q + "\n\n【" + nmCfg.kind + "上下文】\n" + ctx;
    AIModule.ask([{ role: "system", content: sys }, { role: "user", content: user }]).then(function (txt) {
      out.innerHTML = '<div class="nm-out">' + (esc(txt) || "（无返回）") + '</div>';
    }).catch(function (e) { out.innerHTML = '<div class="nm-out" style="border-color:#f3c0c0;background:#fff0f0">查询失败：' + esc(e && e.message || e) + '</div>'; });
  };
}

/* 兼容旧浏览器：若无 URL.createObjectURL 则尝试复制文本兜底 */

/* 水利一张图：备忘录模块配置（v3.51） */
nmInstall({ kind: "备忘录", docNoun: "建筑物", appName: "水利一张图", lsKey: "shuili_memos_v1", fileTag: "shuili", bindLabel: "绑定建筑物", recs: function () { return BUILDINGS; }, recName: function (r) { return (r.name || "?") + (r.office ? ("（" + r.office + "）") : ""); } });
/* ===== 升级 / 数据备份 模块（古建 / 水利一张图 / 水利感知 三平台共享） =====
 * 注入方式：cat upgrade_funcs.src.js cfg_up_<平台>.js >> app.js
 * 菜单项调用：upOpenExport() / upOpenImport() / upOpenUpgrade() （函数声明 hoist，挂在 buildMenu 前即可用）
 * 配置：文件末尾 upInstall({app, appName, channel, fileTag, manifestUrl})
 *   - channel: "single" 字符串 或 function() 返回 "public"/"internal"（奇偶双通道）
 *   - manifestUrl: 升级清单 JSON 的公开可访问地址（构建流水线注入；为空时提示联系管理员）
 */
var upCfg = null;
function upInstall(cfg) { upCfg = cfg; }

// 收集本机全部用户数据键（排除临时/缓存键，避免把错误日志、增量缓存打进备份）
function upLsKeys() {
  var deny = (upCfg && upCfg.deny) || ["gujian_script_errors", "shuili_script_errors", "yitu_runtime_log", "shuili_lastBldSha", "shuili_lastKmzSha"];
  var out = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && deny.indexOf(k) < 0) out.push(k);
  }
  return out;
}

function upCollect() {
  var keys = upLsKeys();
  var payload = {}, counts = {}, bytes = 0;
  keys.forEach(function (k) {
    var v = localStorage.getItem(k) || "";
    payload[k] = v;
    bytes += v.length;
    try { var a = JSON.parse(v); if (Array.isArray(a)) counts[k] = a.length; } catch (e) {}
  });
  return { payload: payload, counts: counts, bytes: bytes, keys: keys };
}

function upBuildBundle() {
  var c = upCollect();
  return {
    format: "yitu-upgrade-backup",
    schema: 1,
    app: upCfg.app,
    channel: (typeof upCfg.channel === "function") ? upCfg.channel() : (upCfg.channel || "single"),
    exportedAt: new Date().toISOString(),
    appVersion: (typeof APP_VERSION !== "undefined") ? String(APP_VERSION) : "",
    payload: c.payload
  };
}

function upSizeStr(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

// 版本号比较（去 v 前缀，逐段数字比较）：a<b 返回 -1，a==b 返回 0，a>b 返回 1
function upCmpVer(a, b) {
  a = String(a || "").replace(/^v/i, "").split(".");
  b = String(b || "").replace(/^v/i, "").split(".");
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    var x = parseInt(a[i] || "0", 10) || 0, y = parseInt(b[i] || "0", 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function upChannelLabel(ch) {
  return ch === "single" ? "不分内外" : (ch === "public" ? "公开版" : "内部版");
}

// —— 导出默认目录 / 文件名（cfg 可覆盖：exportDir / exportBase）——
function upDateTag() {
  var d = new Date();
  return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
}
function upDefaultDir() {
  return (upCfg && upCfg.exportDir) || ((upCfg && upCfg.appName ? upCfg.appName : "yitu") + "备份");
}
function upDefaultName() {
  var base = (upCfg && upCfg.exportBase) || (upCfg && upCfg.appName) || "backup";
  return base + "_" + upDateTag() + ".bak";
}
function upSafeName(s, fb) {
  s = String(s || "").trim().replace(/[\/:*?"<>|]/g, "_");
  if (!s) s = fb;
  if (!/\.bak$/i.test(s)) s += ".bak";
  return s;
}
// UTF-8 安全 base64（用于走 Android 桥保存，避免中文乱码）
function upB64(str) {
  try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { try { return btoa(str); } catch (e2) { return null; } }
}

function upStyle() {
  if (document.getElementById("upStyle")) return;
  var s = document.createElement("style");
  s.id = "upStyle";
  s.innerHTML = ".up-row{padding:7px 0;border-bottom:1px solid #eee;font-size:13px}.up-k{color:#888}.up-info{background:#f6f8fa;border-radius:8px;padding:10px 12px;font-size:13px;color:#444;margin:8px 0;line-height:1.6}.up-warn{color:#c0392b}.up-ok{color:#1a8a3c}.up-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}";
  document.head.appendChild(s);
}

function upOpenExport() {
  upStyle();
  var c = upCollect();
  var rows = c.keys.slice(0, 40).map(function (k) {
    var n = (c.counts[k] != null) ? ("（" + c.counts[k] + " 条）") : "";
    return '<div class="up-row"><span class="up-k">' + esc(k) + "</span> " + n + "</div>";
  }).join("");
  if (c.keys.length > 40) rows += '<div class="up-row up-k">…共 ' + c.keys.length + " 项</div>";
  var defDir = upDefaultDir(), defName = upDefaultName();
  var html =
    '<div class="up-info">将导出本机<b>全部用户数据</b>（照片已内嵌在备份中）。请妥善保存备份文件，升级或更换设备后可导入恢复，旧数据不会丢失。<br>数据项：<b>' + c.keys.length + "</b> 项，大小：<b>" + upSizeStr(c.bytes) + "</b></div>" +
    '<div style="max-height:160px;overflow:auto">' + rows + "</div>" +
    '<label class="f" style="display:block;margin:10px 0 4px">保存到文件夹（Download 目录下，可自定义）</label>' +
    '<input class="f" id="upDir" style="width:100%;box-sizing:border-box" value="' + esc(defDir) + '">' +
    '<label class="f" style="display:block;margin:8px 0 4px">备份文件名（默认 .bak）</label>' +
    '<input class="f" id="upName" style="width:100%;box-sizing:border-box" value="' + esc(defName) + '">' +
    '<div style="font-size:12px;color:#8a7c70;margin-top:6px">默认文件名：' + esc(defName) + '；可改成任意名字（自动补 .bak）。</div>' +
    '<div class="up-btns">' +
      '<button class="btn-save" onclick="upDoExport()">⬇️ 下载备份文件</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +
    "</div>";
  $("genTitle").textContent = "升级数据导出";
  $("genBody").innerHTML = html;
  openSheet("sheetGen");
}

function upDoExport() {
  var bundle = upBuildBundle();
  var dirEl = document.getElementById("upDir"), nameEl = document.getElementById("upName");
  var folder = (dirEl && dirEl.value) ? dirEl.value.trim() : "";
  var name = upSafeName(nameEl ? nameEl.value : "", upDefaultName());
  var json = JSON.stringify(bundle, null, 2);
  var saved = false, path = "";
  try {
    var A = (typeof window !== "undefined") ? window.Android : null;
    var b64 = upB64(json);
    // 大备份（>700KB）走浏览器下载，避免 Binder 传输上限导致失败
    if (A && b64 && json.length <= 700000 && typeof A.saveBlobTo === "function") {
      A.saveBlobTo("data:application/octet-stream;base64," + b64, folder, name);
      saved = true; path = "Download/" + (folder || upDefaultDir()) + "/" + name;
    } else if (A && b64 && json.length <= 700000 && typeof A.saveBlob === "function") {
      A.saveBlob("data:application/octet-stream;base64," + b64, name);
      saved = true; path = "Download/" + name + "（系统默认目录）";
    }
  } catch (e) { saved = false; }
  if (!saved) {
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
    path = "系统下载目录：" + name;
  }
  toast("已导出备份：" + path);
  try {
    var info = document.getElementById("upInfo2");
    if (info) info.innerHTML = '<span class="up-ok">已导出：' + esc(path) + "</span>";
  } catch (e) {}
}

function upOpenImport() {
  upStyle();
  var html =
    '<div class="up-info up-warn">⚠️ 导入会用备份文件里的数据<b>覆盖</b>程序中的对应数据（覆盖模式将<b>覆盖程序中的全部数据</b>）。请务必确认选择的是<b>最新一次导出</b>的备份，避免用旧备份回退数据。</div>' +
    '<div class="up-info">选择备份文件（<b>.bak</b> 或旧版 .json）。默认<b>合并导入</b>：备份中有、程序中没有的条目追加；两边都有的条目以备份为准（覆盖更新）；程序中独有的条目保留。</div>' +
    '<input type="file" id="upImportFile" accept=".bak,.json,application/json" style="margin:10px 0;width:100%" onchange="upInspectFile()">' +
    '<div id="upFileInfo" style="font-size:12px;color:#8a7c70;min-height:16px"></div>' +
    '<div style="margin:8px 0;font-size:13px"><label><input type="radio" name="upMode" value="merge" checked> 合并导入（推荐，保留程序独有数据）</label><br>' +
    '<label><input type="radio" name="upMode" value="overwrite"> 覆盖导入（清空现有同名数据后完整还原）</label></div>' +
    '<div id="upImportMsg" style="font-size:13px;min-height:18px"></div>' +
    '<div class="up-btns">' +
      '<button class="btn-save" onclick="upDoImport()">⬆️ 开始导入</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +
    "</div>";
  $("genTitle").textContent = "升级数据导入";
  $("genBody").innerHTML = html;
  openSheet("sheetGen");
}

// 选中文件后先解析出备份概要（导出时间/版本/条目），让用户确认是否为最新备份
function upInspectFile() {
  var inp = document.getElementById("upImportFile"), info = document.getElementById("upFileInfo");
  if (!inp || !inp.files || !inp.files.length || !info) return;
  var f = inp.files[0];
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var b = JSON.parse(reader.result);
      if (!b || b.format !== "yitu-upgrade-backup" || !b.payload) { info.innerHTML = '<span class="up-warn">不是本应用的备份文件</span>'; return; }
      var keys = Object.keys(b.payload);
      var when = String(b.exportedAt || "").replace("T", " ").slice(0, 16);
      var warn = (b.app && upCfg.app && b.app !== upCfg.app) ? ' <span class="up-warn">（应用不匹配：' + esc(b.app) + "）</span>" : "";
      info.innerHTML = "文件：" + esc(f.name) + " ｜ 导出时间：<b>" + esc(when || "?") + "</b> ｜ 版本：" + esc(b.appVersion || "?") +
        " ｜ 数据项 " + keys.length + " 项" + warn + '<br><span class="up-warn">请确认这是最新备份，导入后同条目数据将以备份为准。</span>';
    } catch (e) { info.innerHTML = '<span class="up-warn">文件解析失败，不是有效备份</span>'; }
  };
  reader.onerror = function () { if (info) info.innerHTML = '<span class="up-warn">读取文件失败</span>'; };
  reader.readAsText(f);
}

function upImportMode() {
  var els = document.getElementsByName("upMode");
  for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
  return "merge";
}

// 合并策略：数组按 id 合并（旧的优先保留，导入字段补充）；对象深合并；标量以导入为准。保证旧数据不丢。
function upMerge(targetStr, incomingStr) {
  var t, i;
  try { t = JSON.parse(targetStr); } catch (e) { t = undefined; }
  try { i = JSON.parse(incomingStr); } catch (e) { i = undefined; }
  if (Array.isArray(t) && Array.isArray(i)) {
    var map = {};
    t.forEach(function (x) { if (x && x.id != null) map[x.id] = x; });
    i.forEach(function (x) {
      if (x && x.id != null) map[x.id] = map[x.id] ? Object.assign({}, map[x.id], x) : x;
      else t.push(x);
    });
    return JSON.stringify(Object.keys(map).length ? Object.keys(map).map(function (k) { return map[k]; }) : t);
  }
  if (t && typeof t === "object" && i && typeof i === "object" && !Array.isArray(t) && !Array.isArray(i)) {
    return JSON.stringify(Object.assign({}, t, i));
  }
  return JSON.stringify(i);
}

function upDoImport() {
  var inp = document.getElementById("upImportFile");
  var msg = document.getElementById("upImportMsg");
  if (!inp || !inp.files || !inp.files.length) { if (msg) msg.innerHTML = '<span class="up-warn">请先选择备份文件</span>'; return; }
  var mode = upImportMode();
  if (mode === "overwrite") {
    var ok = true;
    try { if (typeof confirm === "function") ok = confirm("覆盖导入将用备份数据覆盖程序中的全部数据，且不可撤销。\n请确认所选备份是最新一次导出的。\n\n确定继续吗？"); } catch (e) {}
    if (!ok) { if (msg) msg.innerHTML = '<span class="up-warn">已取消导入</span>'; return; }
  }
  var reader = new FileReader();
  reader.onload = function () {
    var bundle;
    try { bundle = JSON.parse(reader.result); } catch (e) { if (msg) msg.innerHTML = '<span class="up-warn">文件不是有效备份（JSON 解析失败）</span>'; return; }
    if (!bundle || bundle.format !== "yitu-upgrade-backup" || !bundle.payload) { if (msg) msg.innerHTML = '<span class="up-warn">不是本应用的升级备份文件</span>'; return; }
    if (bundle.app && upCfg.app && bundle.app !== upCfg.app) { if (msg) msg.innerHTML = '<span class="up-warn">应用不匹配（备份为 ' + esc(bundle.app) + '，当前为 ' + esc(upCfg.app) + '）</span>'; return; }
    var keys = Object.keys(bundle.payload), added = 0, merged = 0, errs = 0;
    keys.forEach(function (k) {
      try {
        var cur = localStorage.getItem(k);
        if (mode === "overwrite" || cur == null) { localStorage.setItem(k, bundle.payload[k]); (cur == null ? added++ : merged++); }
        else { localStorage.setItem(k, upMerge(cur, bundle.payload[k])); merged++; }
      } catch (e) { errs++; }
    });
    if (msg) msg.innerHTML = '<span class="up-ok">' + (mode === "overwrite" ? "覆盖导入完成" : "导入完成") +
      "：写入 " + added + " 项、覆盖/合并 " + merged + " 项" + (errs ? "，失败 " + errs + " 项" : "") + "。建议重启应用生效。</span>";
    toast("数据导入完成");
  };
  reader.onerror = function () { if (msg) msg.innerHTML = '<span class="up-warn">读取文件失败</span>'; };
  reader.readAsText(inp.files[0]);
}

function upOpenUpgrade() {
  upStyle();
  var ch = (typeof upCfg.channel === "function") ? upCfg.channel() : (upCfg.channel || "single");
  var html =
    '<div class="up-info">当前：<b>' + esc(upCfg.appName) + "</b> · 版本 <b>" + esc((typeof APP_VERSION !== "undefined") ? APP_VERSION : "?") + "</b> · 通道 <b>" + esc(upChannelLabel(ch)) + "</b></div>" +
    '<div style="font-size:13px;color:#555;margin:6px 0">升级前请先导出数据备份，防止数据丢失。检测只比对当前通道：公开版只检公开新版、内部版只检内部新版，二者<b>不交叉</b>。</div>' +
    '<div class="up-btns">' +
      '<button class="btn-save" onclick="upDoExport()">⬇️ 先导出数据</button>' +
      '<button class="btn-save" onclick="upCheck()">🔄 检测新版</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +
    "</div>" +
    '<div id="upCheckMsg" style="font-size:13px;margin-top:10px;min-height:18px"></div>';
  $("genTitle").textContent = "软件升级";
  $("genBody").innerHTML = html;
  openSheet("sheetGen");
}

function upCheck() {
  var msg = document.getElementById("upCheckMsg");
  if (!upCfg || !upCfg.manifestUrl) { if (msg) msg.innerHTML = '<span class="up-warn">未配置升级服务器地址，请联系管理员或到发布页手动下载。</span>'; return; }
  if (msg) msg.innerHTML = "正在检测…";
  var ch = (typeof upCfg.channel === "function") ? upCfg.channel() : (upCfg.channel || "single");
  fetch(upCfg.manifestUrl, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (m) {
    var entry = m && (m.channels ? m.channels[ch] : m[ch]);
    if (!entry) { if (msg) msg.innerHTML = '<span class="up-warn">升级服务器未返回本通道（' + esc(ch) + '）的信息。</span>'; return; }
    var local = (typeof APP_VERSION !== "undefined") ? String(APP_VERSION) : "";
    var cmp = upCmpVer(entry.version, local);
    if (cmp > 0) {
      if (msg) msg.innerHTML = '<span class="up-ok">发现新版本 <b>' + esc(entry.version) + "</b>（" + esc(upChannelLabel(ch)) + "）</span><br>" + (entry.note ? esc(entry.note) + "<br>" : "") + (entry.url ? '<a href="' + esc(entry.url) + '" target="_blank" rel="noopener" onclick="return upOpenUrl(event, this.href)">点击下载更新包</a>' : "安装包未上公开网盘，请从单位内部渠道获取，或联系管理员。");
    } else if (cmp === 0) {
      if (msg) msg.innerHTML = '<span class="up-ok">已是最新版（' + esc(local) + "）</span>";
    } else {
      if (msg) msg.innerHTML = "当前版本（" + esc(local) + "）已是最新，无需更新。";
    }
  }).catch(function (e) {
    if (msg) msg.innerHTML = '<span class="up-warn">检测失败：' + (e && e.message ? e.message : "网络或服务器不可用") + "。请检查网络后重试。</span>";
  });
}
/* 水利一张图 升级/备份 配置（奇偶双通道：公开/内部） */
upInstall({
  app: "shuili",
  appName: "水利工程基础信息一张图",
  channel: getReleaseChannel,
  fileTag: "shuili",
  exportBase: "水利一张图备份",
  exportDir: "水利一张图备份",
  manifestUrl: "https://020271252c9a4b9fab19848e25a3f6e3.app.workbuddy.link/manifests/shuili.json"
});

// 外部浏览器打开升级链接：WebView 内直接加载百度网盘页会被 302 到 bdnetdisk:// 深链，
// WebView 不识别该协议报 ERR_UNKNOWN_URL_SCHEME；改走 openExternal 由系统浏览器接管。
function upOpenUrl(ev, url) {
  if (ev && ev.preventDefault) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); }
  try { if (window.Android && typeof window.Android.openExternal === "function") { window.Android.openExternal(url); return false; } } catch (e) {}
  try {
    var a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 500);
  } catch (e) { try { window.open(url, "_blank"); } catch (e2) {} }
  return false;
}
window.upOpenUrl = upOpenUrl;

/* ===== GitHub 升级（5090 仓库发布渠道）=====
 * 三应用通用：设置菜单「GitHub 升级（检测新版）」→ 查 GitHub Releases 最新版。
 * 水利奇偶双通道：公开版(奇数)→shuili-yitu-5090pub；内部版(偶数)→shuili-yitu5090。 */
var upGithubCfg = { public: "g101400/shuili-yitu-5090pub", internal: "g101400/shuili-yitu5090" };
function ghChannel() {
  if (typeof getReleaseChannel === "function") { try { return getReleaseChannel(); } catch (e) {} }
  return "single";
}
function ghRepo() {
  var m = (typeof upGithubCfg !== "undefined") ? upGithubCfg : {};
  var ch = ghChannel();
  return m[ch] || m["single"] || "";
}
function ghPlat() {
  var ua = (navigator && navigator.userAgent) || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "win";
  if (/Linux|UOS|Deepin|UnionTech/i.test(ua)) return "uos";
  return "web";
}
function ghAssetLabel(name) {
  name = String(name || "");
  if (/\.apk$/i.test(name)) return "📱 Android";
  if (/Setup\.msi$/i.test(name)) return "🪟 Windows MSI";
  if (/Setup\.exe$/i.test(name)) return "🪟 Windows EXE";
  if (/\.deb$/i.test(name)) {
    var m = name.match(/\.(amd64|loongarch64|arm64|mips64el)\.deb$/i);
    return "🐧 统信UOS " + (m ? m[1] : "deb");
  }
  if (/iOS|可托管/i.test(name)) return "🍎 iOS PWA 托管包";
  return name;
}
function ghOpenUpgrade() {
  upStyle();
  var repo = ghRepo();
  var ch = ghChannel();
  var html =
    '<div class="up-info">当前：<b>' + esc((typeof upCfg !== "undefined" && upCfg.appName) ? upCfg.appName : "") + "</b> · 版本 <b>" + esc((typeof APP_VERSION !== "undefined") ? APP_VERSION : "?") + "</b> · 渠道 <b>" + esc(ch === "public" ? "公开版" : (ch === "internal" ? "内部版" : "不分内外")) + "</b><br>GitHub 仓库：<b>" + esc(repo || "未配置") + "</b></div>" +
    '<div style="font-size:13px;color:#555;margin:6px 0">从 GitHub Releases 检测该渠道最新版并下载四平台安装包（公开版免登录；内部版仓库私有，需 GitHub 账号且有该仓库权限）。</div>' +
    '<div class="up-btns">' +
      '<button class="btn-save" onclick="ghCheck()">🔍 检测 GitHub 新版</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +
    "</div>" +
    '<div id="ghMsg" style="font-size:13px;margin-top:10px;min-height:18px"></div>';
  $("genTitle").textContent = "GitHub 升级";
  $("genBody").innerHTML = html;
  openSheet("sheetGen");
}
function ghCheck() {
  var msg = document.getElementById("ghMsg");
  var repo = ghRepo();
  if (!repo) { if (msg) msg.innerHTML = '<span class="up-warn">未配置 GitHub 仓库，请联系管理员。</span>'; return; }
  if (msg) msg.innerHTML = "正在连接 GitHub 检测…";
  var plat = ghPlat();
  fetch("https://api.github.com/repos/" + repo + "/releases/latest", { cache: "no-store" })
    .then(function (r) {
      if (r.status === 404 || r.status === 401 || r.status === 403) throw new Error("私有仓库需登录或未发布 Release");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (rel) {
      var local = (typeof APP_VERSION !== "undefined") ? String(APP_VERSION) : "";
      var remote = String(rel.tag_name || "").replace(/^v/i, "");
      var cmp = upCmpVer(remote, local);
      var head = (cmp > 0) ? '<span class="up-ok">发现新版本 <b>' + esc(remote) + "</b></span>"
             : (cmp === 0) ? '<span class="up-ok">已是最新（' + esc(local) + "）</span>"
             : '当前版本（' + esc(local) + "）高于 GitHub 最新（" + esc(remote) + "）";
      var assets = (rel.assets || []).map(function (a) {
        var lbl = ghAssetLabel(a.name);
        var on = (lbl.indexOf("Android") >= 0 && plat === "android") ||
                 (lbl.indexOf("Windows") >= 0 && plat === "win") ||
                 (lbl.indexOf("UOS") >= 0 && plat === "uos") ||
                 (lbl.indexOf("iOS") >= 0 && plat === "ios");
        return '<div class="up-row">' + (on ? "<b>▶</b> " : "") + '<span class="up-k">' + esc(lbl) + '</span>　<a href="' + esc(a.browser_download_url) + '" target="_blank" rel="noopener" onclick="return upOpenUrl(event, this.href)">下载</a>　<small>' + esc(a.name) + " (" + (a.size / 1048576).toFixed(1) + "MB)</small></div>";
      }).join("");
      if (msg) msg.innerHTML = head + (rel.body ? "<br><small style='color:#888'>" + esc(rel.body.slice(0, 200)) + "</small>" : "") + "<div style='margin-top:6px'>" + assets + "</div>";
    })
    .catch(function (e) {
      if (msg) msg.innerHTML = '<span class="up-warn">检测失败：' + esc((e && e.message) ? e.message : "网络不可用") + '。</span><div class="up-btns" style="margin-top:8px"><button class="btn-save" onclick="upOpenUrl(event,\'https://github.com/' + repo + '/releases/latest\')">在浏览器打开发布页</button></div>';
    });
}
window.ghOpenUpgrade = ghOpenUpgrade; window.ghCheck = ghCheck;
