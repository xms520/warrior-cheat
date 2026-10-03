/**
 *  Warrior 1.0.4 修改脚本 v1.0.8
 *
 *  ★ v1.0.8 诊断版：把「定时循环」与「功能操作」两个变量彻底分开
 *    - 点击功能 = **立即执行一次**（无定时器、无循环）
 *    - 另设「自动」开关：打开后才启动 200ms 循环（持续生效）
 *    ⇒ 若「单次点击」就崩 → 是操作本身非法
 *    ⇒ 若「单次点击」正常、打开「自动」才崩 → 是循环/时序问题
 *
 *  v1.0.7 已修：删除 cc.director.getScheduler().schedule(fn, 0, ...)
 *              （cocos 源码会对 target 做 cc.assertID + 读 __instanceId，传数字 0 非法）
 *
 *  每次点击都会把环境快照落盘：[ENV] fc=? bBl=? nb=? ne=? nx=? nl=? units=?
 */
(function () {
  if (window.__WARRIOR_CHEAT__) return;

  var C = {
    version: '1.0.8',
    kill: false, god: false, auto: false,
    speed: 1.0,
    err: '', _errN: 0, _dbgN: 0,
    _spd: null, _timer: null, _tickN: 0
  };
  window.__WARRIOR_CHEAT__ = C;

  /* ---------------- 落盘日志 ---------------- */
  function wlog(msg, force) {
    if (!force && C._dbgN++ > 40) return;
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '') + 'warrior_dbg.txt';
      var old = (typeof fu.getStringFromFile === 'function') ? (fu.getStringFromFile(p) || '') : '';
      fu.writeStringToFile((old + msg + '\n').slice(-8000), p);   // 内容在前
    } catch (x) {}
  }
  function fail(where, e) {
    if (C._errN++ > 25) return;
    C.err = where + ': ' + ((e && e.message) ? e.message : String(e));
    wlog('[ERR] ' + C.err, true);
  }

  /* ---------------- 安全访问链 ---------------- */
  function step(name, fn) {
    try { var v = fn(); return v; }
    catch (e) { fail('access:' + name, e); return undefined; }
  }
  function FC()   { return step('fc', function () { return window.$fc || null; }); }
  function BM()   { return step('battleMgr', function () { var f = FC(); return f ? (f.battleMgr || null) : null; }); }
  function BBl()  { return step('bBl', function () { var m = BM(); return m ? (m.bBl || null) : null; }); }
  function NB()   { return step('nb', function () { var b = BBl(); return b ? (b.nb || null) : null; }); }
  function CTX()  { return step('ne', function () { var b = BBl(); return b ? (b.ne || null) : null; }); }
  function ME()   { return step('nx', function () { var c = CTX(); return c ? (c.nx || null) : null; }); }

  function inBattle() {
    var b = BBl(); if (!b) return false;
    try { if (typeof b.nl === 'function') return !!b.nl(); } catch (e) { fail('nl', e); }
    return !!CTX();
  }
  function CAMP() { var m = ME(); try { return (m && m.hD) ? m.hD.biI : -1; } catch (e) { return -1; } }
  function UNITS() {
    try {
      var c = CTX(); if (!c || !c.fu) return null;
      var arr = c.fu.bkN;
      return (arr && typeof arr.length === 'number') ? arr : null;
    } catch (e) { fail('units', e); return null; }
  }
  function campOf(e) { try { return (e && e.hD) ? e.hD.biI : null; } catch (x) { return null; } }

  /* ---------------- 环境快照（每次操作前都要） ---------------- */
  function envSnapshot(tag) {
    var s = [];
    s.push('fc=' + (FC() ? 'Y' : 'N'));
    var b = BBl();  s.push('bBl=' + (b ? 'Y' : 'N'));
    s.push('nb=' + (NB() ? 'Y' : 'N'));
    s.push('ne=' + (CTX() ? 'Y' : 'N'));
    s.push('nx=' + (ME() ? 'Y' : 'N'));
    try { s.push('nl=' + (b && typeof b.nl === 'function' ? b.nl() : '?')); } catch (e) { s.push('nl=E'); }
    var u = UNITS(); s.push('units=' + (u ? u.length : 'null'));
    // 关键：确认命令方法存在
    var nb = NB();
    s.push('bAj=' + (nb && typeof nb.bAj === 'function' ? 'Y' : 'N'));
    s.push('bAk=' + (nb && typeof nb.bAk === 'function' ? 'Y' : 'N'));
    wlog('[ENV' + (tag ? ':' + tag : '') + '] ' + s.join(' '), true);
  }

  /* ---------------- 操作（全部一次性，可单独调用） ---------------- */
  function doGod() {
    envSnapshot('god');
    var nb = NB();
    if (!nb || typeof nb.bAj !== 'function') { wlog('[FAIL] god: nb.bAj missing', true); return false; }
    try { nb.bAj(); wlog('[OK] god cmd pushed', true); return true; }
    catch (e) { fail('doGod', e); return false; }
  }
  function doKill() {
    envSnapshot('kill');
    var nb = NB();
    if (!nb || typeof nb.bAk !== 'function') { wlog('[FAIL] kill: nb.bAk missing', true); return false; }
    try { nb.bAk(); wlog('[OK] kill cmd pushed', true); return true; }
    catch (e) { fail('doKill', e); return false; }
  }
  var A_SPEED = 22;
  function doSpeed() {
    envSnapshot('speed');
    if (!C._spd) { try { C._spd = new WeakMap(); } catch (e) { fail('WeakMap', e); return false; } }
    var mc = CAMP(); if (mc < 0) { wlog('[FAIL] speed: camp<0', true); return false; }
    var list = UNITS(); if (!list) { wlog('[FAIL] speed: units null', true); return false; }
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
    wlog('[OK] speed applied to ' + n + ' units (x' + mult + ')', true);
    return true;
  }

  /* ---------------- 自动循环（仅在 auto=true 时启动） ---------------- */
  function tick() {
    C._tickN++;
    try {
      if (!inBattle()) { if (C._tickN < 3) wlog('[T] not in battle', true); return; }
      if (C.god) doGod();
      if (C.kill) doKill();
      if (C.speed > 1) doSpeed();
    } catch (e) { fail('tick', e); }
  }
  function startLoop() {
    if (C._timer) return;
    try {
      C._timer = setInterval(tick, 200);
      wlog('[OK] auto loop started id=' + C._timer, true);
    } catch (e) {
      fail('setInterval', e);
      try {
        cc.director.getScheduler().schedule(tick, cc.game, 0.2, false, -1, 0);
        wlog('[OK] auto loop started via Scheduler(cc.game)', true);
      } catch (e2) { fail('Scheduler', e2); }
    }
  }
  function stopLoop() {
    if (!C._timer) return;
    try { clearInterval(C._timer); } catch (e) {}
    C._timer = null;
    wlog('[OK] auto loop stopped', true);
  }

  /* ---------------- 面板桥 ----------------
   *  ★ 关键：点击 = 立即执行一次，不依赖任何定时器
   *    'auto' 开关单独控制循环
   */
  C.set = function (k, v) {
    try {
      if (k === 'speed') {
        C.speed = Number(v) || 1.0;
        wlog('[SET] speed=' + C.speed, true);
        doSpeed();                                   // 立即生效一次
        return C.speed;
      }
      if (k === 'auto') {
        C.auto = !!v;
        if (C.auto) startLoop(); else stopLoop();
        wlog('[SET] auto=' + C.auto, true);
        return C.auto;
      }
      C[k] = !!v;
      wlog('[SET] ' + k + '=' + C[k], true);
      if (k === 'kill' && C.kill) doKill();          // 立即入队一次
      if (k === 'god')            doGod();           // 开/关都入队（命令是切换式）
    } catch (e) { fail('set', e); }
    return C[k];
  };
  C.probe = function () { envSnapshot('probe'); return C.status(); };
  C.status = function () {
    return JSON.stringify({ kill: C.kill, god: C.god, speed: C.speed, auto: C.auto,
                            err: C.err, tick: C._tickN });
  };
  window.warriorCheatSet = C.set;
  window.warriorCheatProbe = C.probe;
  window.warriorCheatStatus = C.status;

  wlog('[OK] cheat v' + C.version + ' loaded (no timer yet), path=' + (window.__WR_PATH__ || '?'), true);
})();
