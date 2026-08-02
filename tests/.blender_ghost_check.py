"""Conta DENTRO Blender i triangoli fantasma di un .glb (dev tool, gitignorato).

Uso: blender.exe -b --factory-startup --python tests/.blender_ghost_check.py -- <file.glb>

Serve a misurare il sintomo che l'utente vedeva: linee/schegge che attraversano
il modello e "colori sminchiati". Nascono da una primitiva glTF senza `indices`,
che per specifica si disegna prendendo i vertici IN SEQUENZA: triangoli enormi e
sottili sparsi su tutto il corpo. Qui li si conta dal lato di chi apre il file,
non dal nostro esportatore, che e' l'unico punto di vista che conta.

Un voxel scalato a 0.01 ha lato 0.01 m, quindi ogni triangolo di una faccia sana
ha lato <= ~0.0142 m (diagonale). Tutto cio' che supera due voxel e' geometria
che non dovrebbe esistere.
"""
import bpy, sys

argv = sys.argv[sys.argv.index("--") + 1:]
GLB = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

VOXEL = 0.01
LIMIT = VOXEL * 2.0

tot = 0
ghosts = 0
worst = 0.0
long_edges = 0

for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
    me = ob.data
    me.calc_loop_triangles()
    mw = ob.matrix_world
    for tri in me.loop_triangles:
        tot += 1
        vs = [mw @ me.vertices[i].co for i in tri.vertices]
        e = max((vs[0] - vs[1]).length, (vs[1] - vs[2]).length, (vs[2] - vs[0]).length)
        if e > worst:
            worst = e
        if e > LIMIT:
            ghosts += 1
        if e > 0.1:
            long_edges += 1

print("== triangoli fantasma ==")
print("  file            : %s" % GLB)
print("  triangoli totali: %d" % tot)
print("  lato massimo    : %.4f m (sano <= %.4f)" % (worst, LIMIT))
print("  oltre 2 voxel   : %d" % ghosts)
print("  oltre 0.10 m    : %d" % long_edges)
print("RESULT %s" % ("OK" if ghosts == 0 else "GHOSTS"))
