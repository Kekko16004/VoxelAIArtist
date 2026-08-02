#!/usr/bin/env python3
"""Ispeziona un .glb: materiali, attributi, quad coincidenti, normali.

Strumento di diagnosi (gitignored, come gli altri tests/.*), non parte di run_all.sh.
Uso: python tests/.glb_inspect.py file.glb
"""
import json
import struct
import sys
from collections import Counter, defaultdict

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2),
      5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    raw = open(path, 'rb').read()
    magic, ver, length = struct.unpack_from('<III', raw, 0)
    assert magic == 0x46546C67, 'non e un glb'
    off, js, bins = 12, None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', raw, off)
        chunk = raw[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        else:
            bins = chunk
        off += 8 + clen + ((-clen) % 4)
    return js, bins


def read_accessor(g, bins, idx):
    a = g['accessors'][idx]
    fmt, sz = CT[a['componentType']]
    n = NC[a['type']]
    bv = g['bufferViews'][a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or (sz * n)
    out = []
    for i in range(a['count']):
        out.append(struct.unpack_from('<' + fmt * n, bins, base + i * stride))
    return out


def main(path):
    g, bins = load(path)
    print('=' * 60)
    print(path)
    print('=' * 60)
    print('meshes:', len(g.get('meshes', [])), ' materials:', len(g.get('materials', [])),
          ' nodes:', len(g.get('nodes', [])), ' skins:', len(g.get('skins', [])),
          ' animations:', len(g.get('animations', [])))
    print('textures:', len(g.get('textures', [])), ' images:', len(g.get('images', [])))

    for an in g.get('animations', []):
        print('  anim:', an.get('name'), 'channels', len(an['channels']))

    for mi, m in enumerate(g.get('meshes', [])):
        print(f"\nmesh[{mi}] name={m.get('name')!r} primitives={len(m['primitives'])}")
        for pi, p in enumerate(m['primitives']):
            attrs = p['attributes']
            mat = g['materials'][p['material']] if 'material' in p else None
            pbr = (mat or {}).get('pbrMetallicRoughness', {})
            bcf = pbr.get('baseColorFactor')
            print(f"  prim[{pi}] attrs={sorted(attrs)} mat={mat.get('name') if mat else None!r}"
                  f" baseColorFactor={bcf} tex={'baseColorTexture' in pbr}"
                  f" doubleSided={mat.get('doubleSided') if mat else None}")

    # analisi geometrica del primo mesh
    m = g['meshes'][0]
    tri_by_plane = defaultdict(list)
    total_tris = 0
    degenerate = 0
    for pi, p in enumerate(m['primitives']):
        pos = read_accessor(g, bins, p['attributes']['POSITION'])
        if 'indices' in p:
            idx = [i[0] for i in read_accessor(g, bins, p['indices'])]
        else:
            idx = list(range(len(pos)))
        total_tris += len(idx) // 3
        for t in range(0, len(idx), 3):
            a, b, c = (pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]])
            key = tuple(sorted(tuple(round(v, 6) for v in q) for q in (a, b, c)))
            tri_by_plane[key].append(pi)
            # area nulla
            u = [b[i] - a[i] for i in range(3)]
            v = [c[i] - a[i] for i in range(3)]
            cr = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            if sum(x * x for x in cr) < 1e-20:
                degenerate += 1

    dup = {k: v for k, v in tri_by_plane.items() if len(v) > 1}
    print(f"\ntriangoli totali: {total_tris}")
    print(f"triangoli COINCIDENTI (stessi 3 vertici): {sum(len(v) for v in dup.values())}"
          f" su {len(dup)} posizioni")
    print(f"triangoli degeneri (area 0): {degenerate}")
    if dup:
        cross = sum(1 for v in dup.values() if len(set(v)) > 1)
        print(f"  di cui fra primitive/materiali DIVERSI: {cross}")
        for k, v in list(dup.items())[:5]:
            print('   ', k, '-> prims', v)

    # vertici totali e COLOR_0
    for pi, p in enumerate(m['primitives'][:3]):
        if 'COLOR_0' in p['attributes']:
            col = read_accessor(g, bins, p['attributes']['COLOR_0'])
            print(f"  prim[{pi}] COLOR_0 presente! primi valori {col[:2]}")


if __name__ == '__main__':
    main(sys.argv[1])
