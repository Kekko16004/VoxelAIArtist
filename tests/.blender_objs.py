import bpy, sys
argv = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=argv[0])
print("=== OGGETTI DOPO IMPORT ===")
for o in bpy.data.objects:
    n = len(o.data.vertices) if o.type == 'MESH' else '-'
    print("  type=%-9s name=%-30s data=%-30s verts=%s parent=%s" % (
        o.type, o.name, getattr(o.data, 'name', '-'), n, o.parent.name if o.parent else None))
print("=== MESH DATABLOCKS ===")
for m in bpy.data.meshes:
    print("  %-30s verts=%d polys=%d users=%d" % (m.name, len(m.vertices), len(m.polygons), m.users))
