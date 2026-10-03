/**
 *  Warrior 1.0.4 修改脚本 v1.0.9
 *
 *  ★ 关键发现（v1.0.8 日志）：
 *      [ENV:speed] fc=N bBl=N nb=N ne=N nx=N
 *    ⇒ 注入时游戏全局 $fc **尚未创建**（注入时机早于游戏主体初始化）。
 *      我的代码在 fc 不存在时直接 return，并未操作任何游戏对象。
 *
 *  ★ v1.0.9 改动：
 *    1) 加载后**等待 $fc / cc 就绪**，就绪前不做任何游戏对象操作
 *    2) 等待机制优先级：cc.director 事件 → setInterval → 原生 pump(warriorTick)
 *    3) 暴露 window.warriorTick() 供原生侧低频推动（双保险）
 *    4) 日志改为**内存缓冲 + 每 8 条落盘一次**（IO 降低 ~90%，排除 IO 因素）
 *    5) 上下文探测：打印 window/globalThis/cc/jsb 类型，确认执行上下文
 */
(function () {
  if (window.__WARRIOR_CHEAT__) return;

  var C = {
    version: '1.0.9',
    kill: false, god: false, auto: false,
    speed: 1.0,
    ready: false,
    err: '', _errN: 0,
    _spd: null,
    _timer: null,
    _tickN: 0,
    _pumpN: 0,
    _buf: []
  };
  window.__WARRIOR_CHEAT__ = C;

  /* ---------------- 日志：内存缓冲 + 批量落盘 ---------------- */
  function flush() {
    if (!C._buf.length) return;
    var s = C._buf.join('\n');
    C._buf = [];
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '') + 'warrior_dbg.txt';
      var old = (typeof fu.getStringFromFile === 'function') ? (fu.getStringFromFile(p) || '') : '';
      fu.writeStringToFile((old + s + '\n').slice(-8000), p);   // 内容在前
    } catch (x) {}
  }
  function log(s) {
    C._buf.push(s);
    if (C._buf.length >= 8) flush();
  }
  function logNow(s) { C._buf.push(s); flush(); }
  function fail(where, e) {
    if (C._errN++ > 20) return;
    C.err = where + ': ' + ((e && e.message) ? e.message : String(e));
    logNow('[ERR] ' + C.err);
  }

  /* ---------------- 上下文探测（只做一次） ---------------- */
  function probeContext() {
    var s = [];
    s.push('win=' + (typeof window));
    s.push('gthis=' + (typeof globalThis));
    try { s.push('same=' + (window === globalThis)); } catch (e) { s.push('same=?'); }
    s.push('cc=' + (typeof cc));
    s.push('jsb=' + (typeof jsb));
    try { s.push('wkeys=' + (window ? Object.keys(window).length : -1)); } catch (e) { s.push('wkeys=?'); }
    try { s.push('hasFC=' + (window.$fc ? 'Y' : 'N')); } catch (e) { s.push('hasFC=?'); }
    logNow('[CTX] ' + s.join(' '));
  }

  /* ---------------- 就绪判定 ---------------- */
  function FC()  { try { return window.$fc || null; } catch (e) { return null; } }
  function BBl() { try { var f = FC(); return (f && f.battleMgr && f.battleMgr.bBl) ? f.battleMgr.bBl : null; } catch (e) { return null; } }
  function NB()  { try { var b = BBl(); return (b && b.nb) ? b.nb : null; } catch (e) { return null; } }
  function CTX() { try { var b = BBl(); return (b && b.ne) ? b.ne : null; } catch (e) { return null; } }
  function ME()  { try { var c = CTX(); return (c && c.nx) ? c.nx : null; } catch (e) { return null; } }
  function inBattle() {
    try {
      var b = BBl(); if (!b) return false;
      if (typeof b.nl === 'function') return !!b.nl();
    } catch (e) {}
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

  // 游戏根对象是否就绪（battleMgr 存在即认为可工作）
  function gameReady() { return !!BBl(); }

  /* ---------------- 功能（全部一次性、极保守） ---------------- */
  function doGod() {
    var nb = NB();
    if (!nb || typeof nb.bAj !== 'function') { log('[SKIP] god: nb.bAj missing'); return false; }
    try { nb.bAj(); logNow('[OK] god pushed'); return true; }
    catch (e) { fail('doGod', e); return false; }
  }
  function doKill() {
    var nb = NB();
    if (!nb || typeof nb.bAk !== 'function') { log('[SKIP] kill: nb.bAk missing'); return false; }
    try { nb.bAk(); logNow('[OK] kill pushed'); return true; }
    catch (e) { fail('doKill', e); return false; }
  }
  var A_SPEED = 22;
  function doSpeed() {
    if (!C._spd) { try { C._spd = new WeakMap(); } catch (e) { fail('WeakMap', e); return false; } }
    var mc = CAMP(); if (mc < 0) { log('[SKIP] speed: camp<0'); return false; }
    var list = UNITS(); if (!list) { log('[SKIP] speed: units null'); return false; }
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

  /* ---------------- 每帧/周期任务 ---------------- */
  function onFrame(src) {
    C._tickN++;
    try {
      if (!gameReady()) {
        // 每 ~2 秒报一次等待状态
        if (C._tickN % 10 === 1) log('[..] waiting game: tick#' + C._tickN + ' src=' + src +
                                     ' fc=' + (FC() ? 'Y' : 'N'));
        return;
      }
      if (!C.ready) {
        C.ready = true;
        logNow('[OK] game ready! bBl=' + (BBl() ? 'Y' : 'N') + ' nb=' + (NB() ? 'Y' : 'N') +
               ' src=' + src + ' tick#' + C._tickN);
      }
      if (!C.auto) return;                 // 未开"自动"时，只响应按钮
      if (!inBattle()) return;
      if (C.god)  doGod();
      if (C.kill) doKill();
      if (C.speed > 1) doSpeed();
    } catch (e) { fail('onFrame', e); }
  }

  /* ---------------- 驱动（多重兜底） ---------------- */
  function startDriver() {
    if (C._timer || C._drvEvent) return;
    // 1) cocos 事件（最可靠，引擎自带逐帧派发）
    try {
      if (typeof cc !== 'undefined' && cc.director && cc.Director) {
        var EV = cc.Director.EVENT_AFTER_UPDATE;
        if (EV) {
          cc.director.on(EV, function () { onFrame('evt'); });
          C._drvEvent = true;
          logNow('[OK] driver=cc.director.EVENT_AFTER_UPDATE');
          return;
        }
      }
    } catch (e) { log('[..] cc event driver fail: ' + e); }
    // 2) setInterval
    try {
      C._timer = setInterval(function () { onFrame('timer'); }, 250);
      logNow('[OK] driver=setInterval id=' + C._timer);
      return;
    } catch (e) { log('[..] setInterval fail: ' + e); }
    logNow('[!!] no driver available (waiting for native pump)');
  }

  // 原生侧低频 pump 会调用它
  window.warriorTick = function () { C._pumpN++; onFrame('pump'); };

  /* ---------------- 面板桥 ---------------- */
  C.set = function (k, v) {
    try {
      if (k === 'speed') {
        C.speed = Number(v) || 1.0;
        logNow('[SET] speed=' + C.speed + (C.ready ? '' : ' (NOT ready)'));
        if (C.ready) doSpeed();
        return C.speed;
      }
      if (k === 'auto') {
        C.auto = !!v;
        logNow('[SET] auto=' + C.auto + (C.ready ? '' : ' (NOT ready)'));
        return C.auto;
      }
      C[k] = !!v;
      logNow('[SET] ' + k + '=' + C[k] + (C.ready ? '' : ' (NOT ready)'));
      if (!C.ready) return C[k];             // ★ 未就绪：只记录，不操作
      if (k === 'kill' && C.kill) doKill();
      if (k === 'god') doGod();
    } catch (e) { fail('set', e); }
    return C[k];
  };
  C.probe = function () {
    logNow('[PROBE] fc=' + (FC() ? 'Y' : 'N') + ' bBl=' + (BBl() ? 'Y' : 'N') +
           ' nb=' + (NB() ? 'Y' : 'N') + ' ready=' + C.ready + ' tick=' + C._tickN + ' pump=' + C._pumpN);
    return C.status();
  };
  C.status = function () {
    return JSON.stringify({ ready: C.ready, kill: C.kill, god: C.god, speed: C.speed,
                            auto: C.auto, err: C.err, tick: C._tickN, pump: C._pumpN });
  };
  window.warriorCheatSet = C.set;
  window.warriorCheatProbe = C.probe;
  window.warriorCheatStatus = C.status;

  /* ---------------- 启动 ---------------- */
  probeContext();
  logNow('[OK] cheat v' + C.version + ' loaded, path=' + (window.__WR_PATH__ || '?'));
  startDriver();
  // 若 cc 尚不存在，稍后用 setInterval 重试启动驱动
  var bootTry = 0;
  var bootTimer = setInterval(function () {
    bootTry++;
    if (C._drvEvent) { clearInterval(bootTimer); return; }
    if (typeof cc !== 'undefined') { startDriver(); }
    if (bootTry > 40) { clearInterval(bootTimer); logNow('[!!] driver boot give up'); }
  }, 500);
})();
