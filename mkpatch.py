#!/usr/bin/env python3
# 生成 "原 main.js + 注入脚本" 的 *ze* 加密文件，并导出 C 数组
import sys, os, zlib
sys.path.insert(0, '/var/minis/workspace/warrior/ipa')
from cano import w, b_, dec

KEY = w(b'237GaogniB!@#$1sdf546685')
DELTA = 0x9E3779B9
M = 0xFFFFFFFF

def xxtea_enc(v, k):
    n = len(v)
    if n < 2: return v
    q = 6 + 52 // n
    z = v[n-1]; s = 0
    while q > 0:
        s = (s + DELTA) & M; e = (s >> 2) & 3
        for p in range(0, n-1):
            y = v[p+1]
            mx = (((z >> 5) ^ ((y << 2) & M)) + ((y >> 3) ^ ((z << 4) & M))) & M
            mx ^= ((s ^ y) + (k[(p & 3) ^ e] ^ z)) & M
            z = (v[p] + mx) & M; v[p] = z
        y = v[0]
        mx = (((z >> 5) ^ ((y << 2) & M)) + ((y >> 3) ^ ((z << 4) & M))) & M
        mx ^= ((s ^ y) + (k[((n-1) & 3) ^ e] ^ z)) & M
        z = (v[n-1] + mx) & M; v[n-1] = z
        q -= 1
    return v

def make_blob(plain: bytes) -> bytes:
    comp = zlib.compress(plain, 9)
    if len(comp) % 4: comp += b'\x00' * (4 - len(comp) % 4)
    enc = b_(xxtea_enc(w(comp), list(KEY)))
    return b'*ze*\x00' + enc

if __name__ == '__main__':
    main_js = open('/var/minis/workspace/warrior/src/main.js', 'rb').read()
    cheat = open('/var/minis/workspace/warrior/proj/cheat.js', 'rb').read()
    combo = main_js + b'\n' + cheat + b'\n'
    blob = make_blob(combo)

    # 自检：用解密流程还原
    assert blob[:4] == b'*ze*', 'header'
    out = b_(dec(list(w(blob[5:])), list(KEY)))
    back = zlib.decompress(out)
    assert back == combo, 'roundtrip mismatch!'
    print('plain %d -> blob %d, roundtrip OK' % (len(combo), len(blob)))

    # 导出 C 数组
    lines = []
    lines.append('/* auto-generated: encrypted (original main.js + cheat.js), *ze* XXTEA+zlib */')
    lines.append('#ifndef WARRIOR_PATCH_H')
    lines.append('#define WARRIOR_PATCH_H')
    lines.append('#define WARRIOR_PATCH_LEN %d' % len(blob))
    lines.append('static const unsigned char kPatchedMainJS[%d] = {' % len(blob))
    for i in range(0, len(blob), 16):
        chunk = blob[i:i+16]
        lines.append('  ' + ', '.join('0x%02x' % b for b in chunk) + ',')
    lines.append('};')
    lines.append('#endif')
    open('/var/minis/workspace/warrior/proj/patch_js.h', 'w').write('\n'.join(lines)+'\n')
    print('wrote patch_js.h')
