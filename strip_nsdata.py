#!/usr/bin/env python3
# 把 Tweak.x 中「NSData swizzle」整段替换为纯 fopen 方案
import re
p = '/var/minis/workspace/warrior/proj/Tweak.x'
s = open(p, encoding='utf-8').read()

start = s.index('// ---------------------------------------------------------------------------\n// 注入: 拦截 main.js 的读取')
end   = s.index('// ---------------------------------------------------------------------------\n// 面板 -> JS 通信')

new_block = '''// ---------------------------------------------------------------------------
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

'''
s = s[:start] + new_block + s[end:]

# 移除 init 中对 NSData swizzle 的调用
s = s.replace('        warrior_swizzle_nsdata();\n', '')
s = s.replace('#import <UIKit/UIKit.h>', '#import <UIKit/UIKit.h>\n#import <objc/runtime.h>')
# 去掉重复的 objc/runtime 导入（若已存在）
s = re.sub(r'(#import <objc/runtime\.h>\n)(?=.*#import <objc/runtime\.h>)', '', s, count=1, flags=re.S)

open(p, 'w', encoding='utf-8').write(s)

# 自检
assert 'warrior_swizzle_nsdata' not in s, 'swizzle 残留'
assert 'warrior_initWithContentsOfFile' not in s and 'g_orig_iwcof' not in s, 'NSData init 残留'
assert 'warrior_fopen' in s and 'rebind_symbols' in s
print('OK, Tweak.x lines =', s.count('\n') + 1)
print('objc/runtime count =', s.count('#import <objc/runtime.h>'))
