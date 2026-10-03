// ============================================================================
//  Warrior 助手 dylib  (游戏: BingoGame-mobile 1.0.4 / com.fightingstars.games.warrior)
//  引擎: Cocos Creator 2.4.11 + cocos2d-x C++ + V8 (jsb)
//
//  ★ 本版本(v1.0.3)注入方案：**纯运行时 evalString，不碰文件系统**
//
//  为什么不再 hook 文件读取：
//    v1.0.0~v1.0.2 用 fopen/NSData 替换 main.js 内容注入，
//    在非越狱(全能签/侧载)环境下会阻塞资源加载（引导卡住），
//    因为脚本文件由 CResourcesManager 的 IO 流程读取，替换会导致其读取/校验时序异常。
//
//  现方案（零文件 IO、零副作用）：
//    1) 轮询等待 se::ScriptEngine 单例可用 且 引擎已完成引擎初始化
//    2) 调用 se::ScriptEngine::evalString(...) 直接执行 cheat.js 源码
//    3) 完全绕开文件读取 / 完整性校验，对引导流程零影响
//
//  偏移来源：本二进制静态反汇编 + LC_FUNCTION_STARTS 验证（仅 1.0.4 / arm64 有效）
//    se::ScriptEngine::getInstance() = 0x1011846C8
//    se::ScriptEngine::evalString   = 0x101186FE8  (函数体 0x101186FE8-0x101187440)
// ============================================================================

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <mach-o/dyld.h>
#import <mach-o/loader.h>
#import <objc/runtime.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <limits.h>
#include <unistd.h>
#include <pthread.h>

#include "cheat_js.h"      // kCheatJS —— cheat.js 源码（明文 C 字符串）

// ---------------------------------------------------------------------------
// 日志（写沙盒 tmp，非越狱环境同样可写）
// ---------------------------------------------------------------------------
static FILE *warrior_log_fp(void) {
    static FILE *fp = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *d = NSTemporaryDirectory();
        if (!d.length) d = @"/tmp";
        NSString *p = [d stringByAppendingPathComponent:@"warrior.log"];
        fp = fopen(p.UTF8String, "a");
    });
    return fp;
}
#define WLOG(fmt, ...) do { \
    NSLog(@"[WARRIOR] " fmt, ##__VA_ARGS__); \
    FILE *fp_ = warrior_log_fp(); \
    if (fp_) { fprintf(fp_, "[WARRIOR] " fmt "\n", ##__VA_ARGS__); fflush(fp_); } \
} while (0)

// ---------------------------------------------------------------------------
// 主可执行文件基址
// ---------------------------------------------------------------------------
static uintptr_t warrior_main_base(void) {
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
        const struct mach_header *h = _dyld_get_image_header(i);
        if (h && h->filetype == MH_EXECUTE) return (uintptr_t)h;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// ScriptEngine 求值
// ---------------------------------------------------------------------------
typedef void *(*warrior_getengine_t)(void);
typedef bool  (*warrior_eval_t)(void *engine, const char *script, long len, const char *file, int line);
static warrior_getengine_t g_getEngine = NULL;
static warrior_eval_t      g_evalString = NULL;

// 直接求值（必须在 JS 线程 = 主线程调用）
static bool warrior_eval_now(const char *js) {
    if (!g_getEngine || !g_evalString || !js) return false;
    void *se = g_getEngine();
    if (!se) return false;
    bool ok = false;
    @try { ok = g_evalString(se, js, (long)strlen(js), "warrior_cheat", 0); }
    @catch (NSException *e) { WLOG("eval exception: %s", e.reason.UTF8String); }
    return ok;
}

// ---------------------------------------------------------------------------
// 注入：轮询到引擎「真正就绪」后 evalString(cheat.js)
//
//  ⚠️ 崩溃教训（v1.0.3→v1.0.4）：
//     v1.0.3 在引擎未就绪时反复调用 evalString，命中了引擎初始化中的危险窗口 → 原生崩溃。
//     v1.0.4 起：调用前**自行检查引擎关键字段**（与 evalString 内部实现一致），
//     未就绪则直接返回、绝不触碰引擎。
//
//  evalString(this, ...) 内部前置校验（反汇编实证 @0x101186FE8）：
//      ldr x24, [x0, #0x180]        ; jsThread
//      bl  pthread_self
//      cmp x0, x24 ; b.ne -> return 0   ; 非 JS 线程直接返回，不触碰其他字段
//      然后才 ldr x0, [x19, #0x88] / [x19, #0x90]  (isolate / context)
//  ⇒ 若 this[0x180] 为 0（引擎未初始化完），调用会走 "失败" 路径，
//    但在初始化进行中该字段可能是垃圾值/半初始态，故必须自己先判。
// ---------------------------------------------------------------------------
static BOOL  g_injected = NO;
static int   g_tryCount = 0;
#define  WARRIOR_MAX_TRY  400      // 400 × 0.25s ≈ 100s，覆盖冷启动+资源热更

// 读取引擎关键字段（未就绪/非法返回 NO，绝不调用引擎方法）
static BOOL warrior_engine_ready(void *se) {
    if (!se) return NO;
    // ⚠️ 指针合法性粗校验（防止半构造对象）
    uintptr_t p = (uintptr_t)se;
    if (p < 0x100000000UL || (p & 7)) return NO;

    uintptr_t jsThread = 0, isolate = 0, context = 0;
    @try {
        jsThread = *(uintptr_t *)((uintptr_t)se + 0x180);
        isolate  = *(uintptr_t *)((uintptr_t)se + 0x88);
        context  = *(uintptr_t *)((uintptr_t)se + 0x90);
    } @catch (NSException *e) { return NO; }

    // jsThread 必须是当前线程（主线程），否则 evalString 会直接返回 0
    if (jsThread == 0 || jsThread != (uintptr_t)pthread_self()) return NO;
    if (isolate == 0 || context == 0) return NO;
    return YES;
}

// 注入前先设置可写路径（cheat.js 用 window.__WR_PATH__ 拼日志路径）
static char  g_wr_path[PATH_MAX] = {0};
static NSString *warrior_writable_path(void) {
    if (g_wr_path[0]) return [NSString stringWithUTF8String:g_wr_path];
    NSString *d = NSTemporaryDirectory();
    if (!d.length) d = @"/tmp/";
    if (![d hasSuffix:@"/"]) d = [d stringByAppendingString:@"/"];
    strncpy(g_wr_path, d.UTF8String, sizeof(g_wr_path) - 1);
    return d;
}

static void warrior_try_inject(void) {
    if (g_injected) return;
    g_tryCount++;

    if (!g_getEngine || !g_evalString) return;

    void *se = NULL;
    @try { se = g_getEngine(); } @catch (NSException *e) { se = NULL; }
    if (!se) {
        if (g_tryCount % 20 == 0) WLOG("wait: scriptEngine not created yet");
        return;
    }

    // ★ 关键：未就绪绝不调用，直接等下一轮（避免触发引擎初始化中的危险窗口）
    if (!warrior_engine_ready(se)) {
        if (g_tryCount % 20 == 0) {
            uintptr_t jt = 0, iso = 0, ctx = 0;
            @try {
                jt  = *(uintptr_t *)((uintptr_t)se + 0x180);
                iso = *(uintptr_t *)((uintptr_t)se + 0x88);
                ctx = *(uintptr_t *)((uintptr_t)se + 0x90);
            } @catch (NSException *e) {}
            WLOG("wait: engine not ready jsThread=%p isolate=%p ctx=%p self=%p (try#%d)",
                 (void *)jt, (void *)iso, (void *)ctx, (void *)pthread_self(), g_tryCount);
        }
        return;
    }

    // 标记「即将调用」，若此后崩溃，日志能证明是 evalString 触发
    WLOG("calling evalString (engine=%p, try#%d)", se, g_tryCount);

    // 一次只做一次注入尝试；prelude 与主脚本合并为一次调用，减少引擎交互
    NSString *path = warrior_writable_path();
    NSString *src = [NSString stringWithFormat:@"window.__WR_PATH__=%@;\n%s",
                     [NSString stringWithFormat:@"\"%@\"", path],
                     kCheatJS];
    bool ok = warrior_eval_now(src.UTF8String);
    WLOG("eval cheat.js => %s (engine=%p, try#%d)", ok ? "OK" : "FAILED", se, g_tryCount);

    if (ok) {
        g_injected = YES;
        WLOG("=========== cheat injected ===========");
    }
}

static void warrior_schedule_poll(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        warrior_try_inject();
        if (g_injected) return;
        if (g_tryCount >= WARRIOR_MAX_TRY) { WLOG("give up after %d tries", g_tryCount); return; }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{ warrior_schedule_poll(); });
    });
}

// ---------------------------------------------------------------------------
// 面板 -> JS 通信
// ---------------------------------------------------------------------------
static void warrior_eval_js(NSString *js) {
    if (!js.length) return;
    if (![NSThread isMainThread]) {
        NSString *s = [js copy];
        dispatch_async(dispatch_get_main_queue(), ^{ warrior_eval_now(s.UTF8String); });
        return;
    }
    warrior_eval_now(js.UTF8String);
}
static void warrior_eval_fmt(NSString *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    warrior_eval_js(s);
}

// ===========================================================================
//  悬浮球 + 控制面板
// ===========================================================================
@interface WarriorPassWindow : UIWindow
@end
@implementation WarriorPassWindow
// ⚠️ 触摸透传必须在 UIWindow 子类上重写；子视图上重写无效。
//    承载视图 rootViewController.view 铺满窗口且 pointInside 恒 YES，必须排除。
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *hit = [super hitTest:point withEvent:event];
    if (hit == self) return nil;
    if (hit == self.rootViewController.view) return nil;
    return hit;
}
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event {
    for (UIView *v in self.subviews) {
        if (v == self.rootViewController.view) continue;
        if (v.hidden || v.alpha <= 0.01) continue;
        if ([v pointInside:[v convertPoint:point fromView:self] withEvent:event]) return YES;
    }
    return NO;
}
@end

@interface WarriorButton : UIView
@end
@interface WarriorPanel : UIView
@end

static WarriorPassWindow *g_win = nil;
static WarriorButton *g_ball = nil;
static WarriorPanel *g_panel = nil;

static BOOL   g_kill = NO;
static BOOL   g_god  = NO;
static double g_speed = 1.0;

static UILabel  *g_lblStatus = nil;
static UIButton *g_btnKill = nil, *g_btnGod = nil, *g_btnSpeed = nil;

static UIColor *wr_green(void) { return [UIColor colorWithRed:0.18 green:0.72 blue:0.35 alpha:1]; }
static UIColor *wr_gray(void)  { return [UIColor colorWithWhite:0.35 alpha:1]; }

static void warrior_refresh_panel(void) {
    if (!g_btnKill) return;
    g_btnKill.backgroundColor = g_kill ? wr_green() : wr_gray();
    [g_btnKill setTitle:(g_kill ? @"秒杀 开" : @"秒杀 关") forState:UIControlStateNormal];
    g_btnGod.backgroundColor  = g_god ? wr_green() : wr_gray();
    [g_btnGod setTitle:(g_god ? @"无敌 开" : @"无敌 关") forState:UIControlStateNormal];
    [g_btnSpeed setTitle:[NSString stringWithFormat:@"移速 x%.1f", g_speed] forState:UIControlStateNormal];
    g_btnSpeed.backgroundColor = (g_speed > 1.0001) ? wr_green() : wr_gray();
    if (g_lblStatus) {
        g_lblStatus.text = @"[WARRIOR] " "Warrior 助手已加载";
    }
}

@implementation WarriorButton
- (instancetype)initWithFrame:(CGRect)f {
    if ((self = [super initWithFrame:f])) {
        self.backgroundColor = [UIColor colorWithRed:0 green:0 blue:0 alpha:0.55];
        self.layer.cornerRadius = f.size.width / 2.0;
        self.layer.borderWidth = 1.0;
        self.layer.borderColor = [UIColor whiteColor].CGColor;
        UILabel *l = [[UILabel alloc] initWithFrame:self.bounds];
        l.text = @"W"; l.textColor = [UIColor whiteColor];
        l.font = [UIFont boldSystemFontOfSize:18];
        l.textAlignment = NSTextAlignmentCenter;
        l.userInteractionEnabled = NO;
        [self addSubview:l];
    }
    return self;
}
@end

@implementation WarriorPanel
- (instancetype)initWithFrame:(CGRect)f {
    self = [super initWithFrame:f];
    if (!self) return self;
    self.backgroundColor = [UIColor colorWithRed:0.08 green:0.09 blue:0.12 alpha:0.94];
    self.layer.cornerRadius = 12;
    self.layer.borderWidth = 1;
    self.layer.borderColor = [UIColor colorWithWhite:1 alpha:0.25].CGColor;

    CGFloat W = f.size.width, H = f.size.height;
    UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(12, 8, W - 24, 24)];
    title.text = @"Warrior 助手 v1.0.3";
    title.textColor = [UIColor whiteColor];
    title.font = [UIFont boldSystemFontOfSize:15];
    [self addSubview:title];

    g_lblStatus = [[UILabel alloc] initWithFrame:CGRectMake(12, 32, W - 24, 18)];
    g_lblStatus.text = @"等待战斗...";
    g_lblStatus.textColor = [UIColor colorWithWhite:0.7 alpha:1];
    g_lblStatus.font = [UIFont systemFontOfSize:11];
    [self addSubview:g_lblStatus];

    CGFloat y = 58, bw = W - 24, bh = 40;
    g_btnKill = [UIButton buttonWithType:UIButtonTypeCustom];
    g_btnKill.frame = CGRectMake(12, y, bw, bh);
    g_btnKill.layer.cornerRadius = 8;
    g_btnKill.titleLabel.font = [UIFont boldSystemFontOfSize:15];
    [g_btnKill addTarget:self action:@selector(onKill) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:g_btnKill];

    y += bh + 10;
    g_btnGod = [UIButton buttonWithType:UIButtonTypeCustom];
    g_btnGod.frame = CGRectMake(12, y, bw, bh);
    g_btnGod.layer.cornerRadius = 8;
    g_btnGod.titleLabel.font = [UIFont boldSystemFontOfSize:15];
    [g_btnGod addTarget:self action:@selector(onGod) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:g_btnGod];

    y += bh + 10;
    g_btnSpeed = [UIButton buttonWithType:UIButtonTypeCustom];
    g_btnSpeed.frame = CGRectMake(12, y, bw, bh);
    g_btnSpeed.layer.cornerRadius = 8;
    g_btnSpeed.titleLabel.font = [UIFont boldSystemFontOfSize:15];
    [g_btnSpeed addTarget:self action:@selector(onSpeed) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:g_btnSpeed];

    UIButton *close = [UIButton buttonWithType:UIButtonTypeCustom];
    close.frame = CGRectMake(W - 34, 6, 28, 28);
    [close setTitle:@"×" forState:UIControlStateNormal];
    [close setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
    [close addTarget:self action:@selector(onClose) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:close];

    warrior_refresh_panel();
    return self;
}
- (void)onKill {
    g_kill = !g_kill;
    warrior_eval_fmt(@"window.warriorCheatSet&&window.warriorCheatSet('kill',%@);", g_kill ? @"true" : @"false");
    warrior_refresh_panel();
}
- (void)onGod {
    g_god = !g_god;
    warrior_eval_fmt(@"window.warriorCheatSet&&window.warriorCheatSet('god',%@);", g_god ? @"true" : @"false");
    warrior_refresh_panel();
}
- (void)onSpeed {
    static const double steps[] = {1.0, 2.0, 3.0, 5.0, 10.0};
    static int idx = 0;
    idx = (idx + 1) % 5;
    g_speed = steps[idx];
    warrior_eval_fmt(@"window.warriorCheatSet&&window.warriorCheatSet('speed',%.2f);", g_speed);
    warrior_refresh_panel();
}
- (void)onClose { [g_panel removeFromSuperview]; g_panel = nil; }
@end

// --------------------------- 悬浮球交互 ---------------------------
static CGPoint g_ballStart;
static BOOL    g_ballMoved = NO;

@interface WarriorBall : WarriorButton
@end
@implementation WarriorBall
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    g_ballMoved = NO;
    g_ballStart = [[touches anyObject] locationInView:g_win];
}
- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    CGPoint p = [[touches anyObject] locationInView:g_win];
    CGFloat dx = p.x - g_ballStart.x, dy = p.y - g_ballStart.y;
    if (dx * dx + dy * dy > 100.0) g_ballMoved = YES;   // 10pt 阈值，防手抖
    if (g_ballMoved) {
        CGPoint c = self.center;
        c.x += dx; c.y += dy;
        self.center = c;
        g_ballStart = p;
    }
}
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    if (!g_ballMoved) [self openPanel];
}
- (void)openPanel {
    if (g_panel) { [g_panel removeFromSuperview]; g_panel = nil; return; }
    CGFloat W = 220, H = 210;
    CGFloat x = g_win.bounds.size.width - W - 12;
    if (x < 12) x = 12;
    CGFloat y = MAX(60, self.center.y - H / 2);
    g_panel = [[WarriorPanel alloc] initWithFrame:CGRectMake(x, y, W, H)];
    [g_win addSubview:g_panel];
}
@end

static void warrior_install_ui(void) {
    if (g_win) return;
    UIWindowScene *scene = nil;
    for (UIScene *s in UIApplication.sharedApplication.connectedScenes) {
        if ([s isKindOfClass:[UIWindowScene class]] && s.activationState != UISceneActivationStateBackground) {
            scene = (UIWindowScene *)s; break;
        }
    }
    CGRect frame = [UIScreen mainScreen].bounds;
    if (scene) g_win = [[WarriorPassWindow alloc] initWithWindowScene:scene];
    else       g_win = [[WarriorPassWindow alloc] initWithFrame:frame];
    g_win.frame = frame;
    g_win.windowLevel = UIWindowLevelAlert + 100;
    g_win.backgroundColor = [UIColor clearColor];
    g_win.rootViewController = [[UIViewController alloc] init];
    // ★ 承载视图必须不可交互，否则铺满全屏、pointInside 恒 YES → 吞掉所有触摸
    g_win.rootViewController.view.userInteractionEnabled = NO;
    g_win.rootViewController.view.backgroundColor = [UIColor clearColor];
    if (scene) g_win.windowScene = scene;
    g_win.hidden = NO;

    CGFloat bs = 46;
    g_ball = [[WarriorBall alloc] initWithFrame:CGRectMake(frame.size.width - bs - 12,
                                                           frame.size.height * 0.35, bs, bs)];
    [g_win addSubview:g_ball];
    WLOG("UI installed");
}

// ===========================================================================
//  初始化（constructor 只做零风险的事，其余全部延迟到主线程）
// ===========================================================================
__attribute__((constructor))
static void warrior_init(void) {
    @autoreleasepool {
        WLOG("=========== Warrior dylib loaded (v1.0.3) ===========");
        uintptr_t base = warrior_main_base();
        WLOG("main base = 0x%lx", (unsigned long)base);
        if (base) {
            g_getEngine  = (warrior_getengine_t)(base + 0x11846C8UL);  // se::ScriptEngine::getInstance()
            g_evalString = (warrior_eval_t)(base + 0x1186FE8UL);       // se::ScriptEngine::evalString
            WLOG("getInstance=%p evalString=%p", (void *)g_getEngine, (void *)g_evalString);
        }
        // ⚠️ 不做任何文件 hook、不 swizzle 任何系统类
        dispatch_async(dispatch_get_main_queue(), ^{
            warrior_install_ui();
            warrior_schedule_poll();   // 轮询等引擎就绪 → evalString(cheat.js)
        });
        WLOG("init done");
    }
}
