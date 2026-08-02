# DIAGNOSTICA (non un test): rende il modello POSATO e conta i buchi PASSANTI.
#
# Con film_transparent, alpha==0 = nessuna geometria colpita. Un pixel ad alpha 0
# raggiungibile dal bordo dell'immagine e' semplicemente sfondo; uno NON
# raggiungibile e' racchiuso dalla silhouette, cioe' un buco attraverso il
# modello: esattamente il sintomo "si vede dentro" di Blender.
#
# Uso: blender -b -P tests/.blender_render_holes.py -- <file.glb> <out.png> [--workbench]
import bpy, sys, os
from collections import deque

argv = sys.argv[sys.argv.index('--') + 1:]
PATH, OUT = argv[0], argv[1]
WORKBENCH = '--workbench' in argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=PATH)

# L'importer si crea una Icosphere di servizio in 'glTF_not_exported': fuori.
for c in list(bpy.data.collections):
    if c.name == 'glTF_not_exported':
        for o in list(c.objects):
            bpy.data.objects.remove(o, do_unlink=True)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print('RENDER: mesh in scena =', [o.name for o in meshes])

sc = bpy.context.scene
# il nome dell'enum EEVEE cambia fra le versioni di Blender: si prende quello che c'e'.
ENGINES = sc.render.bl_rna.properties['engine'].enum_items.keys()
EEVEE = next((e for e in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE') if e in ENGINES), 'CYCLES')
sc.render.engine = 'BLENDER_WORKBENCH' if WORKBENCH else EEVEE
sc.render.resolution_x, sc.render.resolution_y = 400, 620
sc.render.resolution_percentage = 100
sc.render.film_transparent = True
sc.render.image_settings.file_format = 'PNG'
sc.render.image_settings.color_mode = 'RGBA'
sc.render.filepath = OUT

# Camera ortografica frontale, inquadratura fissa: i due render sono confrontabili
# pixel per pixel.
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 1.05
cam = bpy.data.objects.new('cam', cam_data)
cam.location = (0.0, -3.0, 0.46)
cam.rotation_euler = (1.5707963, 0.0, 0.0)   # guarda lungo +Y
sc.collection.objects.link(cam)
sc.camera = cam

if not WORKBENCH:
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4.0
    sun.rotation_euler = (0.5, 0.2, 0.3)
    sc.collection.objects.link(sun)
    w = bpy.data.worlds.new('w'); sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.6

bpy.ops.render.render(write_still=True)

# --- conteggio dei buchi racchiusi ---------------------------------------
img = bpy.data.images.load(os.path.abspath(OUT))
W, H = img.size
px = list(img.pixels)          # RGBA float, riga per riga dal basso
alpha = [px[i * 4 + 3] for i in range(W * H)]
opaque = [a > 0.5 for a in alpha]

seen = bytearray(W * H)
dq = deque()
for x in range(W):
    for y in (0, H - 1):
        i = y * W + x
        if not opaque[i] and not seen[i]:
            seen[i] = 1; dq.append(i)
for y in range(H):
    for x in (0, W - 1):
        i = y * W + x
        if not opaque[i] and not seen[i]:
            seen[i] = 1; dq.append(i)
while dq:
    i = dq.popleft()
    x, y = i % W, i // W
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < W and 0 <= ny < H:
            j = ny * W + nx
            if not opaque[j] and not seen[j]:
                seen[j] = 1; dq.append(j)

holes = [i for i in range(W * H) if not opaque[i] and not seen[i]]
# componenti connesse dei buchi, per sapere se sono tanti piccoli o pochi grandi
hs = set(holes)
comp, visited = [], set()
for i in holes:
    if i in visited: continue
    n, dq2 = 0, deque([i]); visited.add(i)
    while dq2:
        k = dq2.popleft(); n += 1
        x, y = k % W, k // W
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            j = ny * W + nx
            if 0 <= nx < W and 0 <= ny < H and j in hs and j not in visited:
                visited.add(j); dq2.append(j)
    comp.append(n)
comp.sort(reverse=True)
body = sum(1 for o in opaque if o)
print(f'RENDER {os.path.basename(OUT)} ({"workbench" if WORKBENCH else "eevee"}): '
      f'pixel corpo {body}, BUCHI PASSANTI {len(holes)} px in {len(comp)} zone; '
      f'le piu grandi {comp[:8]}')
