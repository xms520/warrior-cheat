// ============================================================================
//  Warrior 助手 dylib  (游戏: BingoGame-mobile 1.0.4 / com.fightingstars.games.warrior)
//  引擎: Cocos Creator 2.4.11 + cocos2d-x C++ + V8  (jsb, 非 JSC)
//
//  实现思路（全部基于静态逆向实测，非猜测）:
//   1) 游戏脚本(*.js)是 Cocos Creator 标准 *ze* 加密(XXTEA + zlib)。
//      解密函数 0x1010AE0A4: 标记 "*e*"(3) XXTEA / "*ze*"(5) XXTEA+zlib
//                            "*z*"(3) zlib    / "*xor*"(5) 异或
//      XXTEA 密钥 = "237GaogniB" + 15 字节常量(0x102B60E35) 经 0x1000204F8 XOR 变换
//                  => "237GaogniB!@#$1sdf546685"
//   2) 注入方式: 拦截 main.js 的读取，返回「原始 main.js + cheat.js」重新加密后的数据。
//      游戏自行解密并 evalString，cheat.js 即在引擎内执行（无需 V8 ABI / 无需内联 hook）。
//   3) 面板 -> JS: 调用 ScriptEngine::evalString 入口(0x101186CB4) 执行
//      window.warriorCheatSet(...)，由 cheat.js 落到实际战斗数值。
//
//  ⚠️ 偏移量(0x1011xxxx)来自本二进制静态反汇编：仅对 1.0.4 / arm64 有效，
//     换包必须重新定位。所有偏移已在代码中标注来源。
// ============================================================================

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <mach-o/dyld.h>
#import <mach-o/loader.h>
#import <limits.h>
#import <stdarg.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <dlfcn.h>

#include "fishhook.h"
#include "patch_js.h"      // kPatchedMainJS / WARRIOR_PATCH_LEN (原 main.js + cheat.js，*ze* 加密)

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
#define WLOG(fmt, ...) do { \
    NSLog(@"[WARRIOR] " fmt, ##__VA_ARGS__); \
    FILE *fp_ = fopen("/tmp/warrior.log", "a"); \
    if (fp_) { fprintf(fp_, "[WARRIOR] " fmt "\n", ##__VA_ARGS__); fclose(fp_); } \
} while (0)

// ---------------------------------------------------------------------------
// 主可执行文件基址（用于按偏移调用游戏内部函数）
// ---------------------------------------------------------------------------
static uintptr_t warrior_main_base(void) {
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
        const struct mach_header *h = _dyld_get_image_header(i);
        if (h && h->filetype == MH_EXECUTE) {
            return (uintptr_t)h;
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// 注入: 拦截 main.js 的读取
//
//  路径判定（反汇编实测，cocos2d-x 2.4.11 FileUtilsApple::getContents @0x1000396F0）:
//      adrp/add -> "rb" ; bl _fopen ; bl _ftell ; bl _fread ; bl _fclose
//    ⇒ 脚本文件读取走 **fopen**，故只 hook fopen 即可，零副作用。
//
//  ⚠️ 不要 swizzle -[NSData initWithContentsOfFile:]：
//     它是 NSData 全家族共用方法，会波及微信/抖音等 SDK 的配置读取，
//     导致引导中断（登录框不弹）。本版本已删除全部 NSData swizzle。
//
//  补丁内容 = 原始 main.js + cheat.js，已按游戏自身算法(*ze* = XXTEA+zlib)重新加密，
//  游戏解密后原样 evalString，cheat.js 即在引擎内执行。
// ---------------------------------------------------------------------------
static FILE *(*g_orig_fopen)(const char *, const char *) = NULL;
static char  g_tmp_mainjs[PATH_MAX] = {0};
static int   g_inject_hits = 0;

static BOOL warrior_is_main_js(const char *path) {
    if (!path || !*path) return NO;
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    return strcmp(base, "main.js") == 0;
}

// 首次命中时把补丁落盘为独立文件（避免递归 fopen 自身）
static const char *warrior_tmp_mainjs_path(void) {
    if (g_tmp_mainjs[0]) return g_tmp_mainjs;
    NSString *dir = NSTemporaryDirectory();
    if (!dir.length) return NULL;
    NSString *p = [dir stringByAppendingPathComponent:@"warrior_main.js"];
    FILE *f = g_orig_fopen(p.UTF8String, "wb");
    if (!f) { WLOG("write tmp main.js failed"); return NULL; }
    size_t w = fwrite(kPatchedMainJS, 1, WARRIOR_PATCH_LEN, f);
    fclose(f);
    if (w != WARRIOR_PATCH_LEN) { WLOG("write tmp main.js short %zu", w); return NULL; }
    strncpy(g_tmp_mainjs, p.UTF8String, sizeof(g_tmp_mainjs) - 1);
    WLOG("tmp patched main.js -> %s (%d bytes)", g_tmp_mainjs, WARRIOR_PATCH_LEN);
    return g_tmp_mainjs;
}

static FILE *warrior_fopen(const char *path, const char *mode) {
    if (warrior_is_main_js(path) && mode && mode[0] == 'r') {
        // 只拦读取；写模式(main.js 不会被写)放行
        const char *t = warrior_tmp_mainjs_path();
        if (t) {
            g_inject_hits++;
            WLOG("INJECT fopen #%d  %s", g_inject_hits, path);
            return g_orig_fopen(t, mode);
        }
    }
    return g_orig_fopen(path, mode);
}

// ---------------------------------------------------------------------------
// 面板 -> JS 通信
// ---------------------------------------------------------------------------
// ScriptEngine::evalString(this, script, length, fileName, lineno)  —— 成员函数
//   单例: se::ScriptEngine::getInstance() = 0x1011846C8  (静态反汇编实测; 懒加载 0x1b0 字节对象)
//   成员: se::ScriptEngine::evalString(...) = 0x101186FE8
//         函数边界由 LC_FUNCTION_STARTS 解析验证: 0x101186FE8-0x101187440 (size 0x458)
//         该函数内含字符串 "ScriptEngine::evalString script %s, failed!" (0x102FF23D3, 引用点 0x1011872F0)
//         入口处有 pthread_self()==this[0x180] 的 JS 线程校验（非 JS 线程会直接返回 0，安全）
//   调用约定: evalString(engine, script, len, fileOrLine, line) —— 传 "warrior_cheat" + 0 两种解释都安全
typedef void *(*warrior_getengine_t)(void);
typedef bool  (*warrior_eval_t)(void *engine, const char *script, long len, const char *file, int line);
static warrior_getengine_t g_getEngine = NULL;
static warrior_eval_t      g_evalString = NULL;

static void warrior_eval(const char *js) {
    if (!g_getEngine || !g_evalString || !js) return;
    @try {
        // evalString 内部要求 JS 线程（cocos2d-x iOS 的 JS 线程即主线程）
        if (![NSThread isMainThread]) {
            NSString *s = [NSString stringWithUTF8String:js];
            dispatch_async(dispatch_get_main_queue(), ^{
                warrior_eval(s.UTF8String);
            });
            return;
        }
        void *se = g_getEngine();
        if (!se) { WLOG("eval: scriptEngine is null"); return; }
        g_evalString(se, js, (long)strlen(js), "warrior_cheat", 0);
    }
    @catch (NSException *e) { WLOG("eval exception: %s", e.reason.UTF8String); }
}

static void warrior_eval_fmt(NSString *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    if (!s) return;
    warrior_eval(s.UTF8String);
}

// ===========================================================================
//  悬浮球 + 控制面板
// ===========================================================================
@interface WarriorPassWindow : UIWindow
@end
@implementation WarriorPassWindow
// ⚠️ 触摸透传必须在 UIWindow 子类上重写；子视图上重写无效。
//    根因：rootViewController.view 默认铺满窗口且 pointInside 恒 YES，
//    会吃掉所有空白区触摸 → 必须把它排除掉。
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *hit = [super hitTest:point withEvent:event];
    if (hit == self) return nil;                                  // 窗口自身不算命中
    if (hit == self.rootViewController.view) return nil;           // 承载视图不算命中
    return hit;
}
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event {
    for (UIView *v in self.subviews) {
        if (v == self.rootViewController.view) continue;           // 跳过承载视图
        if (v.hidden || v.alpha <= 0.01) continue;
        if ([v pointInside:[v convertPoint:point fromView:self] withEvent:event]) return YES;
    }
    return NO;                                                     // 其余区域不接管
}
@end

@interface WarriorPanel : UIView
@end

@interface WarriorButton : UIView
@end

static WarriorPassWindow *g_win = nil;
static WarriorButton *g_ball = nil;
static WarriorPanel *g_panel = nil;

static BOOL  g_kill = NO;
static BOOL  g_god  = NO;
static double g_speed = 1.0;

// 状态文件（与 cheat.js 的轮询通道通信，独立于 evalString ABI）
static void warrior_write_state(void) {
    @try {
        NSString *dir = NSTemporaryDirectory();
        if (!dir.length) return;
        NSString *p = [dir stringByAppendingPathComponent:@"warrior_state.txt"];
        NSString *s = [NSString stringWithFormat:@"kill=%d,god=%d,speed=%.2f\n",
                       g_kill ? 1 : 0, g_god ? 1 : 0, g_speed];
        [s writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    } @catch (NSException *e) {}
}

// 面板控件
static UILabel *g_lblStatus = nil;
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
    if (g_lblStatus) g_lblStatus.text = @"Warrior 助手 已注入";
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
    title.text = @"Warrior 助手 v1.0";
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
    warrior_write_state();
    warrior_refresh_panel();
}
- (void)onGod {
    g_god = !g_god;
    warrior_eval_fmt(@"window.warriorCheatSet&&window.warriorCheatSet('god',%@);", g_god ? @"true" : @"false");
    warrior_write_state();
    warrior_refresh_panel();
}
- (void)onSpeed {
    static const double steps[] = {1.0, 2.0, 3.0, 5.0, 10.0};
    static int idx = 0;
    idx = (idx + 1) % 5;
    g_speed = steps[idx];
    warrior_eval_fmt(@"window.warriorCheatSet&&window.warriorCheatSet('speed',%.2f);", g_speed);
    warrior_write_state();
    warrior_refresh_panel();
}
- (void)onClose {
    [g_panel removeFromSuperview];
    g_panel = nil;
}
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
    // ★ 关键：承载视图必须不可交互，否则它铺满全屏、pointInside 恒 YES → 吞掉所有触摸
    g_win.rootViewController.view.userInteractionEnabled = NO;
    g_win.rootViewController.view.backgroundColor = [UIColor clearColor];
    // ⚠️ 仅 hidden=NO 不参与触摸派发，必须绑定 windowScene（或用 makeKeyAndVisible）
    if (scene) g_win.windowScene = scene;
    g_win.hidden = NO;

    CGFloat bs = 46;
    g_ball = [[WarriorBall alloc] initWithFrame:CGRectMake(frame.size.width - bs - 12,
                                                           frame.size.height * 0.35, bs, bs)];
    [g_win addSubview:g_ball];
    WLOG("UI installed");
}

// ===========================================================================
//  初始化
// ===========================================================================
__attribute__((constructor))
static void warrior_init(void) {
    @autoreleasepool {
        unlink("/tmp/warrior.log");
        WLOG("=========== Warrior 助手 dylib loaded ===========");
        uintptr_t base = warrior_main_base();
        WLOG("main base = 0x%lx", (unsigned long)base);

        // 1) 注入: 脚本读取拦截
        struct rebinding rb[] = { {"fopen", (void *)warrior_fopen, (void **)&g_orig_fopen} };
        int r = rebind_symbols(rb, 1);
        WLOG("fishhook fopen ret=%d", r);

        // 2) 面板 -> JS 求值入口（偏移来自本二进制静态反汇编）
        if (base) {
            g_getEngine  = (warrior_getengine_t)(base + 0x11846C8UL);  // se::ScriptEngine::getInstance()
            g_evalString = (warrior_eval_t)(base + 0x1186FE8UL);       // se::ScriptEngine::evalString
            WLOG("getInstance=%p evalString=%p", (void *)g_getEngine, (void *)g_evalString);
        }

        // 3) UI
        dispatch_async(dispatch_get_main_queue(), ^{ warrior_install_ui(); });

        WLOG("init done");
    }
}
