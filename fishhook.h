/** 极简版 fishhook：重绑定主二进制 __got/__la_symbol_ptr 中的符号
 *  仅用于 arm64 / iOS，够用即可，无 CydiaSubstrate 依赖
 */
#ifndef FISHHOOK_H
#define FISHHOOK_H
#include <stdio.h>

struct rebinding {
    const char *name;      // 符号名（不带下划线前缀，如 "fopen"）
    void       *replacement;
    void      **replaced;  // 原函数指针输出
};

int rebind_symbols(struct rebinding rebindings[], size_t rebindings_nel);
int rebind_symbols_image(void *header, intptr_t slide,
                         struct rebinding rebindings[], size_t rebindings_nel);

#endif
