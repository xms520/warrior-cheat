/**
 *  Warrior 1.0.4 修改脚本 v1.0.4
 *  环境: Cocos Creator 2.4.11 + cocos2d-x + V8 (jsb)
 *  注入: 原生侧 ScriptEngine::evalString 直接执行本源码（无文件 IO）
 *
 *  ★ v1.0.4 修复「开启功能闪退」：
 *    1) 无敌改为「完全照抄游戏内置 GM 命令 H」的数值模板 + 前置检查，
 *       避免 hpMax 旧值为 0 时 beJ 内部 `beu/i` 除零产生 NaN。
 *    2) 移速**不再重定义 beZ getter**（defineProperty 会破坏 V8 内联缓存、
 *       可能被原生层持有旧描述符而崩溃），改为 beJ(speed, 增量) 差值写入。
 *    3) 秒杀严格照抄游戏内置命令 I：`e.hX(me, e.hv.beu)`（只传 2 参）。
 *    4) 所有写操作前做「战斗就绪 + 属性就绪 + 数值合法」三重校验。
 *    5) 异常落盘到 window.__WR_PATH__ + warrior_dbg.txt，便于诊断。
 */
(function () {
  if (window.__WARRIOR_CHEAT__) return;

  var C = {
    version: '1.0.4',
    kill: false,      // 秒杀
    god: false,       // 无敌
    speed: 1.0,       // 移动速度倍率
    err: '',
    _errN: 0,
    _spd: null        // WeakMap: hv -> 已施加的 speed 增量
  };
  window.__WARRIOR_CHEAT__ = C;

  /* ---------------- 日志（仅异常时落盘，避免 IO 压力） ---------------- */
  function fail(where, e) {
    C.err = where + ': ' + ((e && e.message) ? e.message : String(e));
    if (C._errN++ > 20) return;
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '') + 'warrior_dbg.txt';
      var old = (typeof fu.getStringFromFile === 'function') ? (fu.getStringFromFile(p) || '') : '';
      // cocos 签名: writeStringToFile(content, fullPath)
      fu.writeStringToFile((old + C.err + '\n').slice(-4000), p);
    } catch (x) {}
  }
  function ok(msg) {
    try {
      var fu = (typeof jsb !== 'undefined') && jsb.fileUtils;
      if (!fu || typeof fu.writeStringToFile !== 'function') return;
      var p = (window.__WR_PATH__ || '') + 'warrior_dbg.txt';
      fu.writeStringToFile(msg + '\n', p);
    } catch (x) {}
  }

  /* ---------------- 安全访问器 ---------------- */
  function FC()   { try { return window.$fc || null; } catch (e) { return null; } }
  function BI()   { try { var f = FC(); return (f && f.battleMgr && f.battleMgr.bBl) ? f.battleMgr.bBl : null; } catch (e) { return null; } }
  function CTX()  { var b = BI(); try { return (b && b.ne) ? b.ne : null; } catch (e) { return null; } }
  // 战斗是否进行中（bBl.nl() 返回 this.mG）
  function inBattle() {
    var b = BI(); if (!b) return false;
    try { if (typeof b.nl === 'function') return !!b.nl(); } catch (e) {}
    return !!CTX();
  }
  function ME()   { var c = CTX(); try { return (c && c.nx) ? c.nx : null; } catch (e) { return null; } }
  function CAMP() { var m = ME(); try { return (m && m.hD) ? m.hD.biI : -1; } catch (e) { return -1; } }
  function UNITS(){ var c = CTX(); try { return (c && c.fu && c.fu.bkN) ? c.fu.bkN : []; } catch (e) { return []; } }
  function campOf(e) { try { return (e && e.hD) ? e.hD.biI : null; } catch (x) { return null; } }

  /* ---------------- 属性枚举（实测 AttributeTableEnum） ---------------- */
  var A_HPMAX = 5, A_AP = 7, A_SP = 8, A_ATKSPD = 20, A_CASTSPD = 21, A_SPEED = 22, A_DMGRED = 36;
  var BIG_HP = 3147483648;

  /* ---------------- 无敌（照抄游戏内置 GM 命令 H 的数值模板） ----------------
   *  内置源码:
   *    if (i.hv.bfG() < 3147483648) {
   *        i.hv.beJ(hpMax, 3147483648);  i.hv.beu = i.hv.bev;
   *        i.hv.beJ(ap, 1e5); i.hv.beJ(sp, 1e5);
   *        i.hv.beJ(speed, 15e3);         // ★ 移速已拆出，避免与移速功能叠加
   *        i.hv.beJ(atkSpeed, 1e4); i.hv.beJ(castSpeed, 1e4);
   *        i.hv.beJ(finalDamageRed, 1e4);
   *    }
   *  ⚠️ 必须保留 bfG() 前置检查：hpMax 旧值为 0 时 beJ 内部 `beu/i` 会除零 → NaN → 崩
   */
  function godOn(hv) {
    if (!hv || typeof hv.beJ !== 'function') return;
    var already = false;
    try { already = (typeof hv.bfG === 'function') && (hv.bfG() >= BIG_HP); } catch (e) {}
    if (!already) {
      // 再确认旧上限非 0（bev 来自属性表；若为 0 会导致除零）
      var oldMax = 0;
      try { oldMax = hv.bev; } catch (e) { oldMax = 0; }
      if (!(oldMax > 0)) { fail('godOn', 'hpMax<=0, skip'); return; }
      hv.beJ(A_HPMAX, BIG_HP);
      try { hv.beu = hv.bev; } catch (e) {}
      hv.beJ(A_AP, 1e5);
      hv.beJ(A_SP, 1e5);
      hv.beJ(A_ATKSPD, 1e4);
      hv.beJ(A_CASTSPD, 1e4);
      hv.beJ(A_DMGRED, 1e4);
      try { hv.beD = 1; } catch (e) {}    // 死亡自动回满（游戏内建）
    }
    // 维持满血
    try { if (hv.beu < hv.bev) hv.beu = hv.bev; } catch (e) {}
  }
  function godOff(hv) {
    if (!hv || typeof hv.beK !== 'function') return;
    try {
      hv.beK(A_HPMAX, BIG_HP);
      hv.beK(A_AP, 1e5);
      hv.beK(A_SP, 1e5);
      hv.beK(A_ATKSPD, 1e4);
      hv.beK(A_CASTSPD, 1e4);
      hv.beK(A_DMGRED, 1e4);
      hv.beD = 0;
    } catch (e) { fail('godOff', e); }
  }

  function applyGod() {
    var mc = CAMP(); if (mc < 0) return;
    var list = UNITS();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv) continue;
        if (campOf(e) !== mc) continue;                    // 仅己方
        if (C.god) {
          godOn(e.hv);
          e.__wg = 1;
        } else if (e.__wg) {
          godOff(e.hv);
          e.__wg = 0;
        }
      } catch (err) { fail('applyGod', err); }
    }
  }

  /* ---------------- 秒杀（照抄游戏内置 GM 命令 I） ----------------
   *  内置源码:
   *    var i = t.gi(e.cXZ);                       // 施法者(自己)
   *    i && t.fu.bkN.forEach(function(t) {
   *        if (t.hx && t.hD.biI !== i.hD.biI) {   // 有输入 且 不同阵营
   *            t.hX(i, t.hv.beu);                 // ★ 只传 2 参
   *            a.default.GJ(t, 0, 0);             // 死亡表现(内部函数, 外部不可达; hX 内部已含 GL)
   *        }
   *    });
   */
  function applyKill() {
    var m = ME(); if (!m || !m.hv) return;
    var mc = CAMP();
    var list = UNITS();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv || e === m) continue;
        if (campOf(e) === mc) continue;                    // 仅敌方
        if (typeof e.hX !== 'function') continue;          // 必须有受击方法
        var dmg = e.hv.beu;
        if (!(dmg > 0)) continue;                          // 血量为 0/NaN 跳过
        e.hX(m, dmg);                                      // 伤害=目标当前血 → 一击必杀
      } catch (err) { fail('applyKill', err); }
    }
  }

  /* ---------------- 移速（beJ(speed, 增量)，绝不改 getter） ----------------
   *  beZ.get = beI(A_SPEED)；beJ(A_SPEED, v) 会对属性表做加法。
   *  用 WeakMap 记录每个属性对象已施加的增量，做到可逆、幂等。
   *  ⚠️ 绝不 Object.defineProperty(proto,'beZ')：会破坏 V8 内联缓存 → 崩溃
   */
  function applySpeed() {
    if (!C._spd) { try { C._spd = new WeakMap(); } catch (e) { return; } }
    var mc = CAMP(); if (mc < 0) return;
    var mult = C.speed || 1;
    var list = UNITS();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      try {
        if (!e || !e.hv) continue;
        if (campOf(e) !== mc) continue;                    // 仅己方
        var hv = e.hv;
        if (typeof hv.beI !== 'function' || typeof hv.beJ !== 'function') continue;
        var cur = hv.beI(A_SPEED);
        if (typeof cur !== 'number' || !isFinite(cur)) continue;
        var applied = C._spd.get(hv) || 0;
        var base = cur - applied;                          // 还原基准值
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

  /* ---------------- 主循环 ---------------- */
  function tick() {
    try {
      if (!inBattle()) return;
      if (!CTX()) return;
      if (C.god) applyGod();
      if (C.kill) applyKill();
      if (C.speed && C.speed !== 1) applySpeed();
    } catch (e) { fail('tick', e); }
  }
  function startLoop() {
    try {
      if (typeof cc !== 'undefined' && cc.director && typeof cc.director.getScheduler === 'function') {
        // 每帧检查，但内部有开关判断，开销可忽略
        cc.director.getScheduler().schedule(function () { tick(); }, 0, 1 / 60, false, 1, 0);
        return;
      }
    } catch (e) {}
    try { setInterval(tick, 150); } catch (e) {}
  }
  startLoop();

  /* ---------------- 原生面板桥 ---------------- */
  C.set = function (k, v) {
    if (k === 'speed') { C.speed = Number(v) || 1.0; return C.speed; }
    C[k] = !!v;
    if (k === 'god' && !v) applyGod();   // 关闭时立刻还原
    return C[k];
  };
  C.status = function () {
    return JSON.stringify({ kill: C.kill, god: C.god, speed: C.speed, err: C.err });
  };
  window.warriorCheatSet = C.set;
  window.warriorCheatStatus = C.status;

  ok('[WARRIOR] cheat v' + C.version + ' loaded, path=' + (window.__WR_PATH__ || '?'));
})();
