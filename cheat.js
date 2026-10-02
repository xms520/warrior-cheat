/**
 *  Warrior 1.0.4 修改脚本（cocos creator 2.4.11 / V8）
 *  注入时机：hook ScriptEngine::onGetStringFromFile(0x101158fd4)，读 main.js 后 evalString 本脚本
 *  运行前提：window.$fc / $fc.battleMgr.bBl 由游戏自身创建
 */
(function () {
  if (window.__WARRIOR_CHEAT__) return;

  var C = {
    version: '1.0.0',
    kill: false,      // 秒杀
    god: false,       // 无敌
    speed: 1.0,       // 移动速度倍率
    _speedPatched: false,
    _godApplied: false,
    _lastErr: ''
  };
  window.__WARRIOR_CHEAT__ = C;

  /* ---------- 基础访问器（全部空安全） ---------- */
  function FC() { try { return window.$fc || null; } catch (e) { return null; } }
  function battleInst() {
    try { var f = FC(); return (f && f.battleMgr && f.battleMgr.bBl) ? f.battleMgr.bBl : null; }
    catch (e) { return null; }
  }
  function ctx() { var b = battleInst(); try { return (b && b.ne) ? b.ne : null; } catch (e) { return null; } }
  function units() {
    var c = ctx(); if (!c) return [];
    try { return (c.fu && c.fu.bkN) ? c.fu.bkN : []; } catch (e) { return []; }
  }
  function me() { var c = ctx(); try { return (c && c.nx) ? c.nx : null; } catch (e) { return null; } }
  function myCamp() { var m = me(); try { return (m && m.hD) ? m.hD.biI : -1; } catch (e) { return -1; } }
  function campOf(e) { try { return (e && e.hD) ? e.hD.biI : null; } catch (err) { return null; } }

  /* ---------- 属性枚举（实测 AttributeTableEnum） ---------- */
  var ATTR = { hpMax: 5, ap: 7, sp: 8, atkSpeed: 20, speed: 22, finalDamageRed: 36 };
  var BIG_HP = 3147483648;
  var MAX_RED = 1e4;

  /* ---------- 移速：重定义 beZ getter（返回 GameAttriTableEnum.speed） ---------- */
  function patchSpeed() {
    if (C._speedPatched) return;
    var u = units(); if (!u.length) return;
    var proto = Object.getPrototypeOf(u[0]);
    while (proto) {
      var d = null;
      try { d = Object.getOwnPropertyDescriptor(proto, 'beZ'); } catch (e) {}
      if (d && typeof d.get === 'function') {
        var orig = d.get;
        Object.defineProperty(proto, 'beZ', {
          configurable: true,
          enumerable: !!d.enumerable,
          get: function () { return orig.call(this) * (C.speed || 1); }
        });
        C._speedPatched = true;
        return;
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  /* ---------- 无敌：完全复刻游戏内置 GM 命令 H($ug.H) 的数值模板 ---------- */
  function godOn(e) {
    var hv = e.hv; if (!hv) return;
    if (typeof hv.beJ === 'function') {
      hv.beJ(ATTR.hpMax, BIG_HP);
      hv.beJ(ATTR.ap, 1e5);
      hv.beJ(ATTR.sp, 1e5);
      hv.beJ(ATTR.speed, 15000);
      hv.beJ(ATTR.atkSpeed, 1e4);
      hv.beJ(ATTR.finalDamageRed, MAX_RED);
    }
    try { hv.beu = hv.bev; } catch (err) {}
    try { hv.beD = 1; } catch (err) {}      // 死亡时自动回满（游戏内建机制）
    e.__wg = true;
  }
  function godOff(e) {
    var hv = e.hv; if (!hv) return;
    if (typeof hv.beK === 'function') {
      hv.beK(ATTR.hpMax, BIG_HP);
      hv.beK(ATTR.ap, 1e5);
      hv.beK(ATTR.sp, 1e5);
      hv.beK(ATTR.speed, 15000);
      hv.beK(ATTR.atkSpeed, 1e4);
      hv.beK(ATTR.finalDamageRed, MAX_RED);
    }
    try { hv.beD = 0; } catch (err) {}
    e.__wg = false;
  }

  function applyGod() {
    var mc = myCamp();
    if (mc < 0) return;
    var list = units();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv) continue;
        if (campOf(e) !== mc) continue;           // 只作用于己方阵营
        if (C.god) {
          if (!e.__wg) godOn(e);
          if (e.hv.beu < e.hv.bev) e.hv.beu = e.hv.bev;   // 持续满血
        } else if (e.__wg) {
          godOff(e);
        }
      } catch (err) {}
    }
    C._godApplied = C.god;
  }

  /* ---------- 秒杀：对敌方调用实体受击函数 hX(attacker, damage=目标当前HP) ---------- */
  function applyKill() {
    var m = me(); if (!m) return;
    var mc = myCamp();
    var list = units();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv || e === m) continue;
        if (campOf(e) === mc) continue;           // 只打敌方
        if (!(e.hv.beu > 0)) continue;
        if (typeof e.hX === 'function') {
          e.hX(m, e.hv.beu, null);                // 伤害 = 目标满血 → 一击必杀
        } else {
          e.hv.beu = 0;                           // 兜底：直接置 0
        }
      } catch (err) { C._lastErr = '' + err; }
    }
  }

  /* ---------- 主循环 ---------- */
  /* 状态来源(二选一，互为兜底):
   *  1) window.warriorCheatSet()  —— 原生面板通过 ScriptEngine::evalString 调用
   *  2) 状态文件轮询 —— jsb.fileUtils 读取原生面板写的 warrior_state.txt
   */
  function pollStateFile() {
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.getStringFromFile !== 'function') return;
      var p = (typeof fu.getWritablePath === 'function' ? fu.getWritablePath() : '') + 'warrior_state.txt';
      var s = fu.getStringFromFile(p);
      if (!s || typeof s !== 'string') return;
      var m = /kill=(\d+),god=(\d+),speed=([0-9.]+)/.exec(s);
      if (!m) return;
      var k = m[1] === '1', g = m[2] === '1', sp = parseFloat(m[3]) || 1;
      if (k !== C.kill || g !== C.god || sp !== C.speed) {
        C.kill = k; C.god = g; C.speed = sp;
        console.log('[WARRIOR] state from file: kill=' + k + ' god=' + g + ' speed=' + sp);
      }
    } catch (e) {}
  }

  function tick() {
    try {
      pollStateFile();
      if (!ctx()) return;
      if (C.speed && C.speed !== 1) patchSpeed();
      applyGod();
      if (C.kill) applyKill();
    } catch (e) { C._lastErr = '' + e; }
  }
  setInterval(tick, 120);

  /* ---------- 原生面板桥 ---------- */
  C.set = function (k, v) {
    if (k === 'speed') { C.speed = Number(v) || 1.0; return C.speed; }
    C[k] = !!v;
    if (k === 'god' && !v) applyGod();   // 立刻还原
    return C[k];
  };
  C.status = function () {
    return JSON.stringify({ kill: C.kill, god: C.god, speed: C.speed, err: C._lastErr });
  };
  window.warriorCheatSet = C.set;
  window.warriorCheatStatus = C.status;

  try { console.log('[WARRIOR] cheat v' + C.version + ' loaded, waiting for $fc ...'); } catch (e) {}
})();
