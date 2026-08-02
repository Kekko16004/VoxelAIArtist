"""Localizza i triangoli fantasma residui: quale oggetto/materiale/primitiva.

Uso: blender.exe -b --factory-startup --python tests/.blender_ghost_where.py -- <file.glb>

Dev tool gitignorato. Serve a capire se i fantasma restanti vengono da una
primitiva precisa (bug di indici) o sono sparsi su tutta la mesh (bug di
vertici/skinning).
"""
import bpy, sys
from collections import Counter

argv = sys.argv[sys.argv.index("--") + 1:]
GLB = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

VOXEL = 0.01
LIMIT = VOXEL * 2.0

per_mat = Counter()
per_ob = Counter()
samples = []

for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
    me = ob.data
    me.calc_loop_triangles()
    mw = ob.matrix_world
    for tri in me.loop_triangles:
        vs = [mw @ me.vertices[i].co for i in tri.vertices]
        e = max((vs[0] - vs[1]).length, (vs[1] - vs[2]).length, (vs[2] - vs[0]).length)
        if e <= LIMIT:
            continue
        mi = tri.material_index
        mname = me.materials[mi].name if mi < len(me.materials) and me.materials[mi] else "<none>"
        per_mat[mname] += 1
        per_ob[ob.name] += 1
        if len(samples) < 12:
            samples.append((mname, e, tri.vertices[:], [tuple(round(c, 4) for c in v) for v in vs]))

print("== fantasma per oggetto ==")
for k, v in per_ob.most_common():
    print("  %-40s %d" % (k, v))
print("== fantasma per materiale ==")
for k, v in per_mat.most_common():
    print("  %-40s %d" % (k, v))
print("== campioni ==")
for mname, e, vidx, vs in samples:
    print("  mat=%-10s lato=%.4f vidx=%s" % (mname, e, list(vidx)))
    print("     %s" % (vs,))
