# DIAGNOSTICA (non un test): importa un .glb in Blender e misura i BUCHI della
# mesh nella posa con cui arriva.
#
# Un guscio voxel chiuso non ha spigoli di bordo (ogni spigolo appartiene a 2
# facce). La mesh esportata e' un vertex-soup (4 vertici per quad, niente
# saldatura), quindi si fonde per distanza prima di contare: dopo il merge, uno
# spigolo con UNA sola faccia e' un vero bordo del guscio -> buco.
#
# Uso: blender -b -P tests/.blender_holes.py -- <file.glb>
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
PATH = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=PATH)

# NB: l'importer glTF di Blender crea da se' una 'Icosphere' di servizio che non
# sta nella scena; misurare bpy.data.objects la includerebbe e falserebbe il bbox.
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
print(f'IMPORT: {len(meshes)} mesh, {len(arms)} armature')
for a in arms:
    print(f'  armature {a.name}: loc={tuple(round(v,4) for v in a.location)} '
          f'scale={tuple(round(v,4) for v in a.scale)} ossa={len(a.data.bones)}')
    print(f'  action assegnata: {a.animation_data.action.name if a.animation_data and a.animation_data.action else "(nessuna)"}')
print(f'ACTIONS nel file: {[a.name for a in bpy.data.actions]}')

import bmesh
for ob in meshes:
    # geometria a RIPOSO (senza modificatori): e' quella scritta nel file
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    boundary = [e for e in bm.edges if len(e.link_faces) == 1]
    nonman = [e for e in bm.edges if len(e.link_faces) > 2]
    print(f'\nMESH {ob.name}: {len(ob.data.vertices)} vert, {len(ob.data.polygons)} facce')
    print(f'  dopo merge: {len(bm.verts)} vert, {len(bm.edges)} spigoli')
    print(f'  SPIGOLI DI BORDO (buchi nel guscio): {len(boundary)}')
    print(f'  spigoli non-manifold (>2 facce): {len(nonman)}')
    # materiali: doubleSided/backface culling
    for m in ob.data.materials[:3]:
        print(f'  mat {m.name}: use_backface_culling={m.use_backface_culling}')
    if len(ob.data.materials) > 3:
        print(f'  ... e altri {len(ob.data.materials)-3} materiali')
    culled = sum(1 for m in ob.data.materials if m.use_backface_culling)
    print(f'  materiali con backface culling: {culled}/{len(ob.data.materials)}')
    bm.free()

    # --- geometria VALUTATA (con armature + posa/action): le fessure vere ---
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    bm2 = bmesh.new(); bm2.from_mesh(me)
    bmesh.ops.remove_doubles(bm2, verts=bm2.verts, dist=1e-5)
    b2 = [e for e in bm2.edges if len(e.link_faces) == 1]
    print(f'  POSATO: {len(bm2.verts)} vert dopo merge, spigoli di bordo {len(b2)}')
    # ampiezza delle fessure: per ogni spigolo di bordo, distanza dal bordo piu'
    # vicino che NON e' suo vicino -> quanto e' larga l'apertura
    mw = ob.matrix_world
    ws = [(mw @ e.verts[0].co, mw @ e.verts[1].co) for e in b2]
    print(f'  bbox posato: X[{min(min(a.x,b.x) for a,b in ws):.3f},{max(max(a.x,b.x) for a,b in ws):.3f}]'
          if ws else '  nessun bordo')
    bm2.free()
    bpy.data.meshes.remove(me)

# bbox globale della mesh valutata, per confronto con .expect.json
dg = bpy.context.evaluated_depsgraph_get()
lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
for ob in meshes:
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    for v in me.vertices:
        w = ob.matrix_world @ v.co
        for i in range(3):
            lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    bpy.data.meshes.remove(me)
print(f'\nBBOX posato (Blender Z-up): X[{lo.x:.3f},{hi.x:.3f}] Y[{lo.y:.3f},{hi.y:.3f}] Z[{lo.z:.3f},{hi.z:.3f}]')
print(f'  larghezza X {hi.x-lo.x:.3f}  altezza Z {hi.z-lo.z:.3f}')
