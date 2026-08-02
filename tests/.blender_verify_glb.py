"""Verifica DENTRO Blender che un .glb esportato da VoxelAIArtist sia sano.

Uso: blender.exe -b --factory-startup --python tests/.blender_verify_glb.py -- <file.glb> [altezza_attesa_m]

Se accanto al .glb c'e' un <file.glb>.expect.json (lo scrive .glb_export_harness.mjs)
si verifica anche che la SILHOUETTE ALL'APERTURA coincida con quella che l'app
mostra a schermo: e' il controllo che manca a tutti gli altri, perche' un modello
esportato in T-pose mentre nell'editor sta in piedi passa ogni verifica di
posizione e scala e resta comunque sbagliato per chi lo apre.

Controlla cio' che l'utente vede davvero aprendo il file:
  1. l'armatura e' a 0,0,0 con scala 1 (niente "applica trasformazioni" a mano);
  2. la mesh e' figlia dell'armatura, a 0,0,0 scala 1, centrata su X/Y e coi piedi a Z=0;
  3. a RIPOSO il modificatore Armature non deforma nulla: se le inverse bind matrices
     sono sbagliate il modello si accartoccia gia' al frame 0, ed e' il sintomo peggiore
     perche' sembra "la mesh sbagliata";
  4. le animazioni spostano il modello di quantita' SENSATE: le tracce di posizione sono
     in unita' voxel e vanno riscalate con le ossa, altrimenti un bob di 0.12 voxel
     diventa 0.12 metri e il personaggio schizza via;
  5. la mesh ha i suoi materiali e non e' un guscio vuoto.

Esce con codice != 0 se un controllo fallisce, cosi' si incatena in run_all.sh.
"""
import bpy, sys, os, json
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]
GLB = path
expect_h = float(argv[1]) if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)

fails = []
def ok(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)

def near(a, b, eps):
    return abs(a - b) <= eps

# L'Icosphere in glTF_not_exported e' una forma d'osso creata dall'IMPORTATORE
# Blender (>=4.0), non e' roba nostra: si ignora esplicitamente.
arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
shape_meshes = {o.name for c in bpy.data.collections if c.name == 'glTF_not_exported' for o in c.objects}
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name not in shape_meshes]

print("== struttura ==")
# Il percorso statico (nessun rig) esporta solo mesh: si verifica quel che ha senso.
STATIC = len(arms) == 0
if STATIC:
    print("  (nessuna armatura: modello statico)")
    ok(len(meshes) >= 1, "almeno una mesh (%d)" % len(meshes))
else:
    ok(len(arms) == 1, "una sola armatura (trovate %d)" % len(arms))
    ok(len(meshes) == 1, "una sola mesh del modello (trovate %d)" % len(meshes))
if not meshes:
    print("RESULT FAIL")
    sys.exit(1)

if STATIC:
    # Ogni parte deve essere a 0,0,0 scala 1: la scala e' cotta nei vertici, non
    # su un Empty padre che l'utente dovrebbe applicare a mano.
    for m in meshes:
        ok(all(near(v, 0, 1e-5) for v in m.location), "'%s' a 0,0,0" % m.name)
        ok(all(near(v, 1, 1e-5) for v in m.scale), "'%s' a scala 1" % m.name)
        ok(len(m.data.materials) > 0, "'%s' ha materiali (%d)" % (m.name, len(m.data.materials)))
    arm = None
    mesh = meshes[0]
else:
    arm, mesh = arms[0], meshes[0]
    ok(all(near(v, 0, 1e-5) for v in arm.location), "armatura a 0,0,0 (loc=%s)" % ([round(v, 5) for v in arm.location],))
    ok(all(near(v, 1, 1e-5) for v in arm.scale), "armatura a scala 1 (scale=%s)" % ([round(v, 5) for v in arm.scale],))
    ok(all(near(v, 0, 1e-5) for v in mesh.location), "mesh a 0,0,0 (loc=%s)" % ([round(v, 5) for v in mesh.location],))
    ok(all(near(v, 1, 1e-5) for v in mesh.scale), "mesh a scala 1 (scale=%s)" % ([round(v, 5) for v in mesh.scale],))
    ok(mesh.parent is arm, "mesh imparentata all'armatura (parent=%s)" % (mesh.parent.name if mesh.parent else None))
    ok(len(mesh.data.materials) > 0, "materiali presenti (%d)" % len(mesh.data.materials))
    ok(len(mesh.data.vertices) > 0, "vertici presenti (%d)" % len(mesh.data.vertices))

print("== collocazione nello spazio ==")
# Nello statico il modello e' spezzato in una mesh per parte: l'ingombro e'
# l'unione di tutte, altrimenti "centrato" sarebbe falso per costruzione.
co = [m.matrix_world @ v.co for m in meshes for v in m.data.vertices]
xs = [c.x for c in co]; ys = [c.y for c in co]; zs = [c.z for c in co]
w, d, h = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
print("  bbox X[%.3f,%.3f] Y[%.3f,%.3f] Z[%.3f,%.3f]  (%.3f x %.3f x %.3f m)"
      % (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs), w, d, h))
ok(near(min(zs), 0.0, 1e-3), "piedi sul pavimento: Z minimo = %.4f" % min(zs))
ok(near((min(xs) + max(xs)) / 2, 0.0, 1e-3), "centrato su X: centro = %.4f" % ((min(xs) + max(xs)) / 2))
ok(near((min(ys) + max(ys)) / 2, 0.0, 1e-3), "centrato su Y: centro = %.4f" % ((min(ys) + max(ys)) / 2))
if expect_h is not None:
    ok(near(h, expect_h, expect_h * 0.02), "altezza attesa ~%.3f m (misurata %.3f)" % (expect_h, h))

if STATIC:
    print("")
    if fails:
        print("RESULT FAIL (%d controlli falliti)" % len(fails))
        for f in fails:
            print("   - " + f)
        sys.exit(1)
    print("RESULT OK")
    sys.exit(0)

print("== scheletro ==")
roots = [b for b in arm.data.bones if b.parent is None]
ok(len(roots) >= 1, "almeno un osso radice (%d)" % len(roots))
blen = [b.length for b in arm.data.bones]
ok(min(blen) > 1e-5, "nessun osso di lunghezza zero (min=%.5f)" % min(blen))
ok(max(blen) < max(1.0, h), "ossa in scala col modello (max=%.4f, altezza=%.4f)" % (max(blen), h))
# Ogni vertice deve essere pesato, altrimenti pezzi di modello restano indietro.
vg_names = {g.name for g in mesh.vertex_groups}
bone_names = {b.name for b in arm.data.bones}
ok(vg_names <= bone_names, "i gruppi di vertici corrispondono a ossa esistenti")
unweighted = sum(1 for v in mesh.data.vertices if not v.groups or all(g.weight == 0 for g in v.groups))
ok(unweighted == 0, "nessun vertice senza peso (%d)" % unweighted)

print("== posa all'apertura ==")
# QUESTO e' il controllo che mancava. Si misura la mesh COME VIENE VALUTATA
# adesso, cioe' con la posa che il file porta con se', e la si confronta con la
# silhouette che l'app mostra a schermo (scritta dall'harness in .expect.json).
# Un export in T-pose di un personaggio che nell'editor sta in piedi supera
# ogni controllo di origine/scala e resta comunque sbagliato: solo qui casca.
def posed_bbox():
    d = bpy.context.evaluated_depsgraph_get()
    e = mesh.evaluated_get(d)
    m = e.to_mesh()
    pts = [mesh.matrix_world @ v.co for v in m.vertices]
    e.to_mesh_clear()
    return (min(p.x for p in pts), max(p.x for p in pts),
            min(p.y for p in pts), max(p.y for p in pts),
            min(p.z for p in pts), max(p.z for p in pts))

bpy.context.view_layer.update()
pminx, pmaxx, pminy, pmaxy, pminz, pmaxz = posed_bbox()
print("  posata X[%.3f,%.3f] Y[%.3f,%.3f] Z[%.3f,%.3f]  (%.3f x %.3f x %.3f m)"
      % (pminx, pmaxx, pminy, pmaxy, pminz, pmaxz,
         pmaxx - pminx, pmaxy - pminy, pmaxz - pminz))

# L'importatore glTF di Blender ASSEGNA un'action da solo: le sue tracce
# sovrascrivono la posa sui soli osso che anima, quindi "come si apre" e "posa
# statica" sono due cose diverse. Si misurano entrambe e si dice quale e' quale.
had_action = bool(arm.animation_data and arm.animation_data.action)
if had_action:
    print("  (all'import Blender ha assegnato l'action '%s')" % arm.animation_data.action.name)
    arm.animation_data.action = None
    bpy.context.view_layer.update()
    pminx, pmaxx, pminy, pmaxy, pminz, pmaxz = posed_bbox()
    print("  senza action X[%.3f,%.3f] Y[%.3f,%.3f] Z[%.3f,%.3f]  (%.3f x %.3f x %.3f m)"
          % (pminx, pmaxx, pminy, pmaxy, pminz, pmaxz,
             pmaxx - pminx, pmaxy - pminy, pmaxz - pminz))

exp_path = GLB + ".expect.json"
if os.path.exists(exp_path):
    with open(exp_path) as fh:
        exp = json.load(fh)
    # Tolleranza generosa: l'export quantizza le posizioni in float32 e Blender
    # ricostruisce lo skinning per conto suo. Si vuole intercettare una posa
    # SBAGLIATA (decine di cm), non l'ultimo millimetro.
    tol = max(0.01, 0.03 * (pmaxz - pminz))
    for axis, lo, hi in (("X", pminx, pmaxx), ("Y", pminy, pmaxy), ("Z", pminz, pmaxz)):
        elo, ehi = exp[axis.lower()]
        d = max(abs(lo - elo), abs(hi - ehi))
        ok(d <= tol, "posa come nell'app su %s: atteso [%.3f,%.3f] trovato [%.3f,%.3f] (scarto %.3f <= %.3f)"
           % (axis, elo, ehi, lo, hi, d, tol))
else:
    print("  (nessun .expect.json accanto al glb: confronto con l'app saltato)")

print("== deformazione a riposo ==")
# Con l'armatura in posa di riposo il modificatore non deve muovere NIENTE.
for pb in arm.pose.bones:
    pb.matrix_basis.identity()
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
ev = mesh.evaluated_get(dg)
em = ev.to_mesh()
dev = max((mesh.matrix_world @ mesh.data.vertices[i].co - (mesh.matrix_world @ em.vertices[i].co)).length
          for i in range(len(em.vertices)))
ev.to_mesh_clear()
ok(dev < 1e-4, "a riposo la pelle non si deforma (scarto max %.6f m)" % dev)

print("== animazioni ==")
acts = list(bpy.data.actions)
ok(len(acts) > 0, "clip presenti (%d)" % len(acts))
if not arm.animation_data:
    arm.animation_data_create()
for act in acts:
    arm.animation_data.action = act
    f0, f1 = act.frame_range
    worst = 0.0
    for f in range(int(f0), int(f1) + 1, max(1, int((f1 - f0) / 8) or 1)):
        bpy.context.scene.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        em = ev.to_mesh()
        m = max((mesh.matrix_world @ v.co).length for v in em.vertices)
        ev.to_mesh_clear()
        worst = max(worst, m)
    # Limite generoso: una clip sana muove il modello di poco piu' del suo ingombro.
    # Una traccia di posizione non riscalata lo manda a decine di metri.
    limit = max(1.0, 4.0 * max(w, d, h))
    ok(worst < limit, "clip '%s': resta in scena (max %.3f m < %.3f)" % (act.name, worst, limit))
bpy.context.scene.frame_set(int(bpy.context.scene.frame_start))

print("")
if fails:
    print("RESULT FAIL (%d controlli falliti)" % len(fails))
    for f in fails:
        print("   - " + f)
    sys.exit(1)
print("RESULT OK")
