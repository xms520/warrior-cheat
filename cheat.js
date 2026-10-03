/**
 *  Warrior 1.0.4 修改脚本 v1.0.6
 *  环境: Cocos Creator 2.4.11 + cocos2d-x + V8 (jsb)
 *  注入: 原生 ScriptEngine::evalString 直接执行（已验证 OK）
 *
 *  ★★ v1.0.6 关键修正：不再自己调实体受击函数，改为**调用游戏自己的命令队列**
 *
 *  教训：v1.0.4 直接调用 e.hX(me, dmg) 在战斗帧之外触发内部死亡处理链
 *        （GL(this) → 事件/表现同步），导致**原生层崩溃**（JS try/catch 抓不到，
 *         warrior_dbg.txt 无任何异常记录即为证据）。
 *
 *  正解：游戏内置 GM 面板「无敌模式」按钮的真实实现就是
 *          $fc.battleMgr.bBl.nb.bAj()      // bAj = 入队 cmdId 407 ($ug.H) 无敌
 *          $fc.battleMgr.bBl.nb.bAk()      // bAk = 入队 cmdId 408 ($ug.I) 秒杀
 *        命令由**战斗帧循环**取出执行（bzX），时机与上下文完全正确。
 *  ⇒ 我们照抄，绝不自己遍历实体调 hX。
 *
 *  移速：无内置命令，用 beJ(A_SPEED, delta) 差值写入（走 default 分支，纯写属性表，安全）。
 */
(function () {
  if (window.__WARRIOR_CHEAT__) return;

  var C = {
    version: '1.0.6',
    kill: false,      // 秒杀
    god: false,       // 无敌
    speed: 1.0,       // 移动速度倍率
    err: '',
    _errN: 0,
    _spd: null,       // WeakMap: hv -> 已施加的 speed 增量
    _lastGodPush: 0,
    _lastKillPush: 0
  };
  window.__WARRIOR_CHEAT__ = C;

  /* ---------------- 日志（异常 + 功能开关，均落盘便于定位） ---------------- */
  function wlog(msg) {
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '') + 'warrior_dbg.txt';
      var old = (typeof fu.getStringFromFile === 'function') ? (fu.getStringFromFile(p) || '') : '';
      // ⚠️ cocos 签名: writeStringToFile(content, fullPath) —— 内容在前
      fu.writeStringToFile((old + msg + '\n').slice(-4000), p);
    } catch (x) {}
  }
  function fail(where, e) {
    if (C._errN++ > 30) return;
    C.err = where + ': ' + ((e && e.message) ? e.message : String(e));
    wlog('[ERR] ' + C.err);
  }

  /* ---------------- 安全访问器 ---------------- */
  function FC()  { try { return window.$fc || null; } catch (e) { return null; } }
  function BBl() {
    try { var f = FC(); return (f && f.battleMgr && f.battleMgr.bBl) ? f.battleMgr.bBl : null; }
    catch (e) { return null; }
  }
  // ★ 命令控制器（与游戏 GM 面板同一个对象）
  function NB() {
    var b = BBl();
    try { return (b && b.nb) ? b.nb : null; } catch (e) { return null; }
  }
  function CTX() { var b = BBl(); try { return (b && b.ne) ? b.ne : null; } catch (e) { return null; } }
  function inBattle() {
    var b = BBl(); if (!b) return false;
    try { if (typeof b.nl === 'function') return !!b.nl(); } catch (e) {}
    return !!CTX();
  }
  function ME()    { var c = CTX(); try { return (c && c.nx) ? c.nx : null; } catch (e) { return null; } }
  function CAMP()  { var m = ME(); try { return (m && m.hD) ? m.hD.biI : -1; } catch (e) { return -1; } }
  function UNITS() { var c = CTX(); try { return (c && c.fu && c.fu.bkN) ? c.fu.bkN : []; } catch (e) { return []; } }
  function campOf(e) { try { return (e && e.hD) ? e.hD.biI : null; } catch (x) { return null; } }

  /* ---------------- 无敌 / 秒杀：走游戏自己的命令队列 ----------------
   *  等价于 GM 面板点击「无敌模式」。
   *  ⚠️ 命令是「入队」，由战斗帧循环执行 → 执行时机正确，不会原生崩溃。
   */
  function pushGod() {
    var nb = NB();
    if (!nb || typeof nb.bAj !== 'function') return false;
    try { nb.bAj(); return true; } catch (e) { fail('pushGod', e); return false; }
  }
  function pushKill() {
    var nb = NB();
    if (!nb || typeof nb.bAk !== 'function') return false;
    try { nb.bAk(); return true; } catch (e) { fail('pushKill', e); return false; }
  }
  // 判断无敌是否已生效（内置命令设 hpMax=3147483648）
  function godApplied() {
    var m = ME(); if (!m || !m.hv) return false;
    try { return (typeof m.hv.bfG === 'function') && m.hv.bfG() >= 3147483648; } catch (e) { return false; }
  }

  /* ---------------- 移速（beJ 差值，走 default 分支纯写属性表） ----------------
   *  beZ.get = beI(A_SPEED)。用 WeakMap 记录每个属性对象已施加的增量 → 可逆幂等。
   *  ⚠️ 绝不 Object.defineProperty(proto,'beZ')（破坏 V8 内联缓存 → 崩）
   */
  var A_SPEED = 22;
  function applySpeed() {
    if (!C._spd) { try { C._spd = new WeakMap(); } catch (e) { return; } }
    var mc = CAMP(); if (mc < 0) return;
    var mult = C.speed || 1;
    var list = UNITS();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv) continue;
        if (campOf(e) !== mc) continue;                 // 仅己方
        var hv = e.hv;
        if (typeof hv.beI !== 'function' || typeof hv.beJ !== 'function') continue;
        var cur = hv.beI(A_SPEED);
        if (typeof cur !== 'number' || !isFinite(cur)) continue;
        var applied = C._spd.get(hv) || 0;
        var base = cur - applied;                        // 还原基准值
        if (!(base > 0)) continue;
        var want = Math.round(base * mult);
        var delta = want - cur;
        if (delta !== 0) {
          hv.beJ(A_SPEED, delta);
          C._spd.set(hv, applied + delta);
        }
      } catch (err) { fail('applySpeed', err); }
    }
  }

  /* ---------------- 主循环 ----------------
   *  无敌：每秒检查一次，未生效才重新入队（命令是切换式，避免反复切）
   *  秒杀：每 0.5 秒入队一次（持续清理新出现的敌人）
   *  移速：每帧维护
   */
  function tick() {
    try {
      if (!inBattle()) return;
      var now = Date.now();
      if (C.god && (now - C._lastGodPush) > 1000) {
        if (!godApplied()) { if (pushGod()) C._lastGodPush = now; }
        else C._lastGodPush = now;
      }
      if (C.kill && (now - C._lastKillPush) > 500) {
        if (pushKill()) C._lastKillPush = now;
      }
      if (C.speed > 1) applySpeed();
    } catch (e) { fail('tick', e); }
  }
  function startLoop() {
    try {
      if (typeof cc !== 'undefined' && cc.director && typeof cc.director.getScheduler === 'function') {
        cc.director.getScheduler().schedule(function () { tick(); }, 0, 1 / 60, false, 1, 0);
        return;
      }
    } catch (e) {}
    try { setInterval(tick, 150); } catch (e) {}
  }
  startLoop();

  /* ---------------- 原生面板桥 ---------------- */
  C.set = function (k, v) {
    try {
      if (k === 'speed') {
        C.speed = Number(v) || 1.0;
        wlog('[SET] speed=' + C.speed);
        return C.speed;
      }
      C[k] = !!v;
      wlog('[SET] ' + k + '=' + C[k]);
      if (k === 'god' && !C.god) {           // 关闭无敌 → 再入队一次切回
        C._lastGodPush = 0;
        pushGod();
      }
      if (k === 'god' && C.god) { C._lastGodPush = 0; }
      if (k === 'kill' && C.kill) { C._lastKillPush = 0; }
    } catch (e) { fail('set', e); }
    return C[k];
  };
  C.status = function () {
    return JSON.stringify({ kill: C.kill, god: C.god, speed: C.speed, err: C.err });
  };
  window.warriorCheatSet = C.set;
  window.warriorCheatStatus = C.status;

  wlog('[OK] cheat v' + C.version + ' loaded, path=' + (window.__WR_PATH__ || '?'));
})();
