"""Probe di un .glb DENTRO Blender headless: dice dove finisce davvero il modello.

Uso:  blender.exe -b --factory-startup --python tests/.blender_probe.py -- <file.glb>

Stampa una riga per oggetto (tipo, location, scale, bbox mondo) piu' il verdetto
sui due sintomi riportati: armatura non a 0,0,0 e mesh che non e' quella attesa.
Serve a verificare l'export senza aprire la GUI e senza fidarsi a occhio.
"""
import bpy, sys, os

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)

print("PROBE_BEGIN")
print("PROBE file=%s" % os.path.basename(path))
for c in bpy.data.collections:
    print("PROBE collection=%s objects=%d" % (c.name, len(c.objects)))

for ob in bpy.data.objects:
    loc = tuple(round(v, 4) for v in ob.location)
    scl = tuple(round(v, 4) for v in ob.scale)
    par = ob.parent.name if ob.parent else None
    print("PROBE object=%s type=%s loc=%s scale=%s parent=%s" % (ob.name, ob.type, loc, scl, par))
    if ob.type == 'MESH':
        ws = [ob.matrix_world @ v.co for v in ob.data.vertices]
        if ws:
            xs = [v.x for v in ws]; ys = [v.y for v in ws]; zs = [v.z for v in ws]
            print("PROBE   mesh_verts=%d bbox_min=(%.3f,%.3f,%.3f) bbox_max=(%.3f,%.3f,%.3f)"
                  % (len(ws), min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)))
            print("PROBE   materials=%d" % len(ob.data.materials))
    if ob.type == 'ARMATURE':
        print("PROBE   bones=%d show_shapes=%s" % (len(ob.data.bones), ob.data.show_bone_custom_shapes))
        n_shape = sum(1 for pb in ob.pose.bones if pb.custom_shape)
        print("PROBE   bones_with_custom_shape=%d" % n_shape)
        root = [b for b in ob.data.bones if b.parent is None]
        for b in root:
            hl = tuple(round(v, 3) for v in (ob.matrix_world @ b.head_local))
            print("PROBE   root_bone=%s head_world=%s" % (b.name, hl))

print("PROBE actions=%d" % len(bpy.data.actions))
for a in bpy.data.actions:
    print("PROBE action=%s frames=%s" % (a.name, tuple(round(f, 2) for f in a.frame_range)))
print("PROBE_END")
