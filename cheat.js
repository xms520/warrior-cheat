/**
 *  Warrior 1.0.4 修改脚本 v1.0.10
 *
 *  ★ v1.0.9 日志结论：
 *      src=evt  → cc.director 事件驱动正常，**cc 存在、上下文正确**！
 *      fc=N 持续 14 分钟（tick#3461）→ $fc 读不到
 *    ⚠️ 主日志被 slice(-8000) 截断，看不到开头的 [CTX]。
 *
 *  ★ v1.0.10 改动：
 *    1) 诊断写入**独立文件 warrior_ctx.txt**（每次覆盖，永不截断、永远是最新状态）
 *    2) 穷举查找 $fc：window / globalThis / bare(function 作用域) / cc / 场景对象图
 *    3) 探测 window.debugCmd（游戏 GM 面板注册点，若存在说明游戏主逻辑已跑）
 *    4) 主日志 waiting 降到每 200 tick、最多 15 条（不再刷屏）
 *    5) 一旦找到 $fc，记录来源（对定位 global 差异至关重要）
 */
(function () {
  if (window.__WARRIOR_CHEAT__) return;

  var C = {
    version: '1.0.10',
    kill: false, god: false, auto: false,
    speed: 1.0,
    ready: false, fcSource: 'none',
    err: '', _errN: 0,
    _spd: null, _timer: null, _tickN: 0, _waitLogN: 0,
    _buf: []
  };
  window.__WARRIOR_CHEAT__ = C;

  /* ================= 独立诊断文件（覆盖写，不累积、不截断） ================= */
  function writeCtx(s) {
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '/tmp/') + 'warrior_ctx.txt';
      fu.writeStringToFile(s, p);          // ★ 覆盖写（内容在前）
    } catch (e) {}
  }

  /* ================= 主日志（内存缓冲 + 批量落盘） ================= */
  function flush() {
    if (!C._buf.length) return;
    var s = C._buf.join('\n'); C._buf = [];
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '/tmp/') + 'warrior_dbg.txt';
      var old = (typeof fu.getStringFromFile === 'function') ? (fu.getStringFromFile(p) || '') : '';
      fu.writeStringToFile((old + s + '\n').slice(-8000), p);
    } catch (x) {}
  }
  function log(s) { C._buf.push(s); if (C._buf.length >= 8) flush(); }
  function logNow(s) { C._buf.push(s); flush(); }
  function fail(where, e) {
    if (C._errN++ > 20) return;
    C.err = where + ': ' + ((e && e.message) ? e.message : String(e));
    logNow('[ERR] ' + C.err);
  }

  /* ================= 穷举查找 $fc ================= */
  // 在真正的全局作用域里求值（Function 构造的函数运行于全局作用域）
  function globalEval(expr) {
    try { return Function('return (' + expr + ');')(); } catch (e) { return undefined; }
  }
  function findFC() {
    // 1) 各种 window 别名
    try { if (window && window.$fc) return { src: 'window', obj: window.$fc }; } catch (e) {}
    try { if (globalThis && globalThis.$fc) return { src: 'globalThis', obj: globalThis.$fc }; } catch (e) {}
    try { if (self && self.$fc) return { src: 'self', obj: self.$fc }; } catch (e) {}
    // 2) 全局作用域直接取（关键：验证 window/globalThis 差异）
    var g = globalEval('typeof $fc !== "undefined" ? $fc : null');
    if (g) return { src: 'globalScope', obj: g };
    // 3) cc 上
    try { if (cc && cc.$fc) return { src: 'cc', obj: cc.$fc }; } catch (e) {}
    // 4) cc.game 上
    try { if (cc && cc.game && cc.game.$fc) return { src: 'cc.game', obj: cc.game.$fc }; } catch (e) {}
    return null;
  }
  // 场景对象图里找 GM 面板悬浮球（游戏 GM 面板的注册点）
  function deepFind(root, pred, depth) {
    if (!root || depth > 5) return null;
    try { if (pred(root)) return root; } catch (e) {}
    var ch = null;
    try { ch = root.children || root._children; } catch (e) {}
    if (ch && ch.length) {
      for (var i = 0; i < ch.length; i++) {
        var r = deepFind(ch[i], pred, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  /* ================= 环境快照（写入独立文件） ================= */
  function snapshotCtx() {
    var L = [];
    function put(k, v) { L.push(k + '=' + v); }
    function safe(fn, d) { try { return fn(); } catch (e) { return d; } }

    put('ver', C.version);
    put('tick', C._tickN);
    put('ready', C.ready ? 'Y' : 'N');
    put('fcSource', C.fcSource);
    put('same', safe(function () { return window === globalThis ? 'Y' : 'N'; }, '?'));
    put('typeof_window', safe(function () { return typeof window; }, '?'));
    put('typeof_globalThis', safe(function () { return typeof globalThis; }, '?'));
    put('typeof_cc', safe(function () { return typeof cc; }, '?'));
    put('typeof_jsb', safe(function () { return typeof jsb; }, '?'));
    put('win.$fc', safe(function () { return window.$fc ? 'Y' : 'N'; }, '?'));
    put('gt.$fc', safe(function () { return globalThis.$fc ? 'Y' : 'N'; }, '?'));
    put('globalScope.$fc', safe(function () { return globalEval('typeof $fc !== "undefined" && !!$fc') ? 'Y' : 'N'; }, '?'));
    put('typeof_$fc', safe(function () { return globalEval('typeof $fc'); }, '?'));
    put('win.debugCmd', safe(function () { return window.debugCmd ? 'Y' : 'N'; }, '?'));
    put('globalScope.debugCmd', safe(function () { return globalEval('typeof debugCmd !== "undefined" && !!debugCmd') ? 'Y' : 'N'; }, '?'));
    put('win.__require', safe(function () { return typeof window.__require; }, '?'));
    put('cc.game', safe(function () { return (cc && cc.game) ? 'Y' : 'N'; }, '?'));
    put('cc.director', safe(function () { return (cc && cc.director) ? 'Y' : 'N'; }, '?'));
    put('scene', safe(function () {
      var s = cc.director.getScene(); return s ? (s.name || '?') : 'null';
    }, '?'));
    put('sceneChildren', safe(function () {
      var s = cc.director.getScene(); return s && s.children ? s.children.length : -1;
    }, '?'));
    put('floatBtn', safe(function () {
      var s = cc.director.getScene();
      var n = deepFind(s, function (x) { return x && x.name === '__floatBtn__'; }, 0);
      return n ? 'Y' : 'N';
    }, '?'));
    put('battleMgr', safe(function () {
      var f = null;
      try { f = window.$fc; } catch (e) {}
      return (f && f.battleMgr) ? 'Y' : 'N';
    }, '?'));
    // ★ 关键：dump window / globalThis 的 key（判断两者是否同一对象、游戏全局挂在哪）
    put('winKeys', safe(function () { return Object.keys(window).length; }, '?'));
    put('gtKeys', safe(function () { return Object.keys(globalThis).length; }, '?'));
    put('winKeyList', safe(function () {
      var ks = Object.keys(window);
      // 优先展示含 $ / cc / game / debug 的 key
      var hot = ks.filter(function (k) { return /[$]/.test(k) || /^(cc|jsb|game|debug|GameData|msg|net)/i.test(k); });
      return hot.slice(0, 60).join(',') || '(none)';
    }, '?'));
    put('gtKeyList', safe(function () {
      var ks = Object.keys(globalThis);
      var hot = ks.filter(function (k) { return /[$]/.test(k) || /^(cc|jsb|game|debug|GameData|msg|net)/i.test(k); });
      return hot.slice(0, 60).join(',') || '(none)';
    }, '?'));
    put('err', C.err || '-');
    put('buf', C._buf.length);
    writeCtx(L.join('\n') + '\n');
  }

  /* ================= 就绪判定（用 findFC 的结果） ================= */
  var _FC = null;
  function FC() {
    if (_FC) return _FC;
    var r = findFC();
    if (r) { _FC = r.obj; C.fcSource = r.src; }
    return _FC;
  }
  function BBl() { try { var f = FC(); return (f && f.battleMgr && f.battleMgr.bBl) ? f.battleMgr.bBl : null; } catch (e) { return null; } }
  function NB()  { try { var b = BBl(); return (b && b.nb) ? b.nb : null; } catch (e) { return null; } }
  function CTX() { try { var b = BBl(); return (b && b.ne) ? b.ne : null; } catch (e) { return null; } }
  function ME()  { try { var c = CTX(); return (c && c.nx) ? c.nx : null; } catch (e) { return null; } }
  function inBattle() {
    try { var b = BBl(); if (!b) return false; if (typeof b.nl === 'function') return !!b.nl(); } catch (e) {}
    return !!CTX();
  }
  function CAMP() { try { var m = ME(); return (m && m.hD) ? m.hD.biI : -1; } catch (e) { return -1; } }
  function UNITS() {
    try {
      var c = CTX(); if (!c || !c.fu) return null;
      var arr = c.fu.bkN;
      return (arr && typeof arr.length === 'number') ? arr : null;
    } catch (e) { fail('units', e); return null; }
  }
  function campOf(e) { try { return (e && e.hD) ? e.hD.biI : null; } catch (x) { return null; } }
  function gameReady() { return !!BBl(); }

  /* ================= 功能 ================= */
  function doGod() {
    var nb = NB();
    if (!nb || typeof nb.bAj !== 'function') { logNow('[SKIP] god: nb.bAj missing'); return false; }
    try { nb.bAj(); logNow('[OK] god pushed (src=' + C.fcSource + ')'); return true; }
    catch (e) { fail('doGod', e); return false; }
  }
  function doKill() {
    var nb = NB();
    if (!nb || typeof nb.bAk !== 'function') { logNow('[SKIP] kill: nb.bAk missing'); return false; }
    try { nb.bAk(); logNow('[OK] kill pushed (src=' + C.fcSource + ')'); return true; }
    catch (e) { fail('doKill', e); return false; }
  }
  var A_SPEED = 22;
  function doSpeed() {
    if (!C._spd) { try { C._spd = new WeakMap(); } catch (e) { fail('WeakMap', e); return false; } }
    var mc = CAMP(); if (mc < 0) { logNow('[SKIP] speed: camp<0'); return false; }
    var list = UNITS(); if (!list) { logNow('[SKIP] speed: units null'); return false; }
    var mult = C.speed || 1, n = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv) continue;
        if (campOf(e) !== mc) continue;
        var hv = e.hv;
        if (typeof hv.beI !== 'function' || typeof hv.beJ !== 'function') continue;
        var cur = hv.beI(A_SPEED);
        if (typeof cur !== 'number' || !isFinite(cur)) continue;
        var applied = C._spd.get(hv) || 0;
        var base = cur - applied;
        if (!(base > 0)) continue;
        var delta = Math.round(base * mult) - cur;
        if (delta !== 0) { hv.beJ(A_SPEED, delta); C._spd.set(hv, applied + delta); n++; }
      } catch (err) { fail('speed item', err); }
    }
    logNow('[OK] speed x' + mult + ' -> ' + n + ' units');
    return true;
  }

  /* ================= 帧任务 ================= */
  function onFrame(src) {
    C._tickN++;
    try {
      // 每帧刷新独立诊断文件（覆盖写，永远最新）
      if (C._tickN % 5 === 1) snapshotCtx();

      if (!gameReady()) {
        if (C._tickN % 200 === 1 && C._waitLogN++ < 15) {
          log('[..] waiting: tick#' + C._tickN + ' src=' + src +
              ' fc=' + (FC() ? 'Y' : 'N') + ' src=' + C.fcSource +
              ' cc=' + (typeof cc) + ' scene=' + (function () {
                try { var s = cc.director.getScene(); return s ? s.name : 'null'; } catch (e) { return '?'; }
              })());
        }
        return;
      }
      if (!C.ready) {
        C.ready = true;
        logNow('[OK] READY! fcSource=' + C.fcSource + ' bBl=Y nb=' + (NB() ? 'Y' : 'N') +
               ' tick#' + C._tickN + ' src=' + src);
        snapshotCtx();
      }
      if (!C.auto) return;
      if (!inBattle()) return;
      if (C.god)  doGod();
      if (C.kill) doKill();
      if (C.speed > 1) doSpeed();
    } catch (e) { fail('onFrame', e); }
  }

  /* ================= 驱动 ================= */
  function startDriver() {
    if (C._drvEvent || C._timer) return;
    try {
      if (typeof cc !== 'undefined' && cc.director && cc.Director && cc.Director.EVENT_AFTER_UPDATE) {
        cc.director.on(cc.Director.EVENT_AFTER_UPDATE, function () { onFrame('evt'); });
        C._drvEvent = true;
        logNow('[OK] driver=cc.director.EVENT_AFTER_UPDATE');
        return;
      }
    } catch (e) { log('[..] evt driver fail: ' + e); }
    try {
      C._timer = setInterval(function () { onFrame('timer'); }, 250);
      logNow('[OK] driver=setInterval id=' + C._timer);
    } catch (e) { logNow('[!!] no driver: ' + e); }
  }
  window.warriorTick = function () { onFrame('pump'); };

  /* ================= 面板桥 ================= */
  C.set = function (k, v) {
    try {
      if (k === 'speed') {
        C.speed = Number(v) || 1.0;
        logNow('[SET] speed=' + C.speed + (C.ready ? '' : ' (NOT ready, fc=' + C.fcSource + ')'));
        if (C.ready) doSpeed();
        snapshotCtx();
        return C.speed;
      }
      if (k === 'auto') { C.auto = !!v; logNow('[SET] auto=' + C.auto); return C.auto; }
      C[k] = !!v;
      logNow('[SET] ' + k + '=' + C[k] + (C.ready ? '' : ' (NOT ready, fc=' + C.fcSource + ')'));
      snapshotCtx();
      if (!C.ready) return C[k];
      if (k === 'kill' && C.kill) doKill();
      if (k === 'god') doGod();
    } catch (e) { fail('set', e); }
    return C[k];
  };
  C.probe = function () { snapshotCtx(); logNow('[PROBE] fc=' + (FC() ? 'Y' : 'N') + ' src=' + C.fcSource); return C.status(); };
  C.status = function () {
    return JSON.stringify({ ready: C.ready, fcSource: C.fcSource, kill: C.kill, god: C.god,
                            speed: C.speed, auto: C.auto, err: C.err, tick: C._tickN });
  };
  window.warriorCheatSet = C.set;
  window.warriorCheatProbe = C.probe;
  window.warriorCheatStatus = C.status;

  /* ================= 启动 ================= */
  snapshotCtx();
  logNow('[OK] cheat v' + C.version + ' loaded, path=' + (window.__WR_PATH__ || '?'));
  startDriver();
  var bootTry = 0;
  var bootTimer = setInterval(function () {
    bootTry++;
    if (C._drvEvent) { clearInterval(bootTimer); return; }
    if (typeof cc !== 'undefined') startDriver();
    if (bootTry > 40) { clearInterval(bootTimer); logNow('[!!] driver boot give up'); }
  }, 500);
})();
