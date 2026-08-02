import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
print("DOPO read_factory_settings(use_empty=True):", [o.name for o in bpy.data.objects])
