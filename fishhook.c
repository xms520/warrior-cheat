/** 极简 fishhook (arm64) — 重绑定主可执行文件 __got / __la_symbol_ptr
 *  参考 facebook/fishhook (BSD)，裁剪至最小实现。
 */
#include "fishhook.h"
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <mach/mach.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <mach/vm_map.h>
#include <libkern/OSCacheControl.h>

#ifdef __LP64__
typedef struct mach_header_64 mach_header_t;
typedef struct segment_command_64 segment_command_t;
typedef struct section_64 section_t;
typedef struct nlist_64 nlist_t;
#define LC_SEGMENT_ARCH_DEP LC_SEGMENT_64
#else
typedef struct mach_header mach_header_t;
typedef struct segment_command segment_command_t;
typedef struct section section_t;
typedef struct nlist nlist_t;
#define LC_SEGMENT_ARCH_DEP LC_SEGMENT
#endif

struct rebindings_entry {
    struct rebinding *rebindings;
    size_t rebindings_nel;
    struct rebindings_entry *next;
};
static struct rebindings_entry *_rebindings_head;

static int prepend_rebindings(struct rebindings_entry **r, struct rebinding rebindings[], size_t nel) {
    struct rebindings_entry *n = malloc(sizeof(struct rebindings_entry));
    if (!n) return -1;
    n->rebindings = malloc(sizeof(struct rebinding) * nel);
    if (!n->rebindings) { free(n); return -1; }
    memcpy(n->rebindings, rebindings, sizeof(struct rebinding) * nel);
    n->rebindings_nel = nel;
    n->next = *r;
    *r = n;
    return 0;
}

static void perform_rebinding_with_section(struct rebindings_entry *rebindings,
        section_t *section, intptr_t slide, nlist_t *symtab,
        char *strtab, uint32_t *indirect_symtab) {
    if (!symtab || !strtab || !indirect_symtab) return;
    const bool is_lazy    = (strcmp(section->sectname, "__la_symbol_ptr") == 0);
    const bool is_nonlazy = (strcmp(section->sectname, "__got") == 0);
    if (!is_lazy && !is_nonlazy) return;

    uint32_t *indirect_symbol_indices = indirect_symtab + section->reserved1;
    void **indirect_symbol_bindings = (void **)((uintptr_t)slide + section->addr);

    vm_size_t pagesize = 4096;
    host_page_size(mach_host_self(), &pagesize);
    if (!pagesize) pagesize = 4096;

    // 整段一次性改写为可写(COW)，避免逐项算页
    void *sec_start = (void *)((uintptr_t)indirect_symbol_bindings & ~(pagesize - 1));
    size_t sec_len = section->size + ((uintptr_t)indirect_symbol_bindings - (uintptr_t)sec_start);
    vm_protect(mach_task_self(), (vm_address_t)sec_start, (vm_size_t)sec_len, false,
               VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY);

    for (uint32_t i = 0; i < section->size / sizeof(void *); i++) {
        uint32_t symtab_index = indirect_symbol_indices[i];
        if (symtab_index == INDIRECT_SYMBOL_ABS || symtab_index == INDIRECT_SYMBOL_LOCAL ||
            symtab_index == (INDIRECT_SYMBOL_LOCAL | INDIRECT_SYMBOL_ABS)) continue;

        uint32_t strtab_offset = symtab[symtab_index].n_un.n_strx;
        char *symbol_name = strtab + strtab_offset;
        bool has_underscore = (symbol_name[0] == '_' && symbol_name[1] != 0);
        const char *cmp_name = &symbol_name[has_underscore ? 1 : 0];

        struct rebindings_entry *cur = rebindings;
        while (cur) {
            for (uint32_t j = 0; j < cur->rebindings_nel; j++) {
                if (strcmp(cmp_name, cur->rebindings[j].name) == 0) {
                    if (cur->rebindings[j].replaced != NULL &&
                        indirect_symbol_bindings[i] != cur->rebindings[j].replacement) {
                        *(cur->rebindings[j].replaced) = indirect_symbol_bindings[i];
                    }
                    indirect_symbol_bindings[i] = cur->rebindings[j].replacement;
                    sys_icache_invalidate(sec_start, sec_len);
                    goto symbol_loop;
                }
            }
            cur = cur->next;
        }
    symbol_loop:;
    }
}

int rebind_symbols_image(void *header, intptr_t slide,
                         struct rebinding rebindings[], size_t rebindings_nel) {
    if (prepend_rebindings(&_rebindings_head, rebindings, rebindings_nel) < 0) return -1;

    mach_header_t *mh = (mach_header_t *)header;
    uintptr_t cur = (uintptr_t)header + sizeof(mach_header_t);
    uintptr_t end = cur + mh->sizeofcmds;

    uintptr_t linkedit_base = 0;
    nlist_t *symtab = NULL;
    char *strtab = NULL;
    uint32_t *indirect_symtab = NULL;

    // 第一遍: 确定 __LINKEDIT 基址
    for (uintptr_t p = cur; p < end; ) {
        struct load_command *lc = (struct load_command *)p;
        if (lc->cmd == LC_SEGMENT_ARCH_DEP) {
            segment_command_t *seg = (segment_command_t *)lc;
            if (strcmp(seg->segname, "__LINKEDIT") == 0) {
                linkedit_base = (uintptr_t)slide + seg->vmaddr - seg->fileoff;
            }
        }
        p += lc->cmdsize;
    }
    if (!linkedit_base) linkedit_base = (uintptr_t)slide;

    // 第二遍: symtab / dysymtab
    for (uintptr_t p = cur; p < end; ) {
        struct load_command *lc = (struct load_command *)p;
        if (lc->cmd == LC_SYMTAB) {
            struct symtab_command *sc = (struct symtab_command *)lc;
            symtab = (nlist_t *)(linkedit_base + sc->symoff);
            strtab = (char *)(linkedit_base + sc->stroff);
        } else if (lc->cmd == LC_DYSYMTAB) {
            struct dysymtab_command *dc = (struct dysymtab_command *)lc;
            indirect_symtab = (uint32_t *)(linkedit_base + dc->indirectsymoff);
        }
        p += lc->cmdsize;
    }

    // 第三遍: 处理 __got / __la_symbol_ptr
    for (uintptr_t p = cur; p < end; ) {
        struct load_command *lc = (struct load_command *)p;
        if (lc->cmd == LC_SEGMENT_ARCH_DEP) {
            segment_command_t *seg = (segment_command_t *)lc;
            section_t *sections = (section_t *)(p + sizeof(segment_command_t));
            for (uint32_t j = 0; j < seg->nsects; j++) {
                section_t *sect = &sections[j];
                uint32_t t = sect->flags & SECTION_TYPE;
                if (t == S_LAZY_SYMBOL_POINTERS || t == S_NON_LAZY_SYMBOL_POINTERS) {
                    perform_rebinding_with_section(_rebindings_head, sect, slide, symtab, strtab, indirect_symtab);
                }
            }
        }
        p += lc->cmdsize;
    }
    return 0;
}

int rebind_symbols(struct rebinding rebindings[], size_t rebindings_nel) {
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count; i++) {
        const struct mach_header *h = _dyld_get_image_header(i);
        if (!h || h->filetype != MH_EXECUTE) continue;   // 只处理主可执行文件
        return rebind_symbols_image((void *)h, _dyld_get_image_vmaddr_slide(i),
                                    rebindings, rebindings_nel);
    }
    return -1;
}
