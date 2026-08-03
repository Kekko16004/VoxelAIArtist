# Blender-QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere VoxelAIArtist piu' prevedibile e familiare a chi arriva da Blender: il gizmo del rig non salta piu' al primo drag, `Shift+A` crea primitive voxel, `Ctrl+A` seleziona i keyframe nella timeline, e i pannelli riaprono come li avevi lasciati.

**Architecture:** Quattro interventi indipendenti sul frontend. Il bundle `ui/index.html` e' GENERATO da `ui/src/` (moduli concatenati in UN SOLO scope condiviso, senza import/export). Il fix del gizmo aggiunge un listener in fase di capture che risincronizza il proxy prima che TransformControls ne fotografi l'orientamento. Le primitive vivono in un modulo nuovo con funzioni pure (dentro/fuori) piu' un livello UI. La timeline guadagna una selezione totale con scoping per area. La persistenza dei pannelli riusa il meccanismo localStorage che il pannello sinistro ha gia'.

**Tech Stack:** JavaScript ES2020 (nessun bundler: `node ui/build.mjs` concatena), Three.js r128 da CDN, test in Node ESM con DOM/THREE finti, `tests/run_all.sh` come suite unica.

## Global Constraints

- **`ui/index.html` e' GENERATO**: modificare solo `ui/src/`, poi `node ui/build.mjs`. Mai editare il bundle a mano.
- **Prima di ogni build**, verificare che il bundle non sia avanti ai sorgenti: `grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js` deve dare **2 e 2**. Se il bundle ha simboli che i sorgenti non hanno, FERMARSI e riconciliare.
- **Un solo scope condiviso**: i moduli in `ui/src/lib/` sono frammenti concatenati, non moduli ES. Niente `import`/`export`. Le funzioni sono hoistate e visibili fra file; `let`/`const` a livello di file NO (temporal dead zone: vedi il commento in `23-i18n.js:18-26`).
- **Stringhe nuove solo via `t()`**, mai italiano hardcoded, e la chiave va aggiunta a **tutti e 6** i file `ui/locales/{de,en,es,fr,it,pt}.json` (`index.json` e' l'elenco lingue, non un dizionario). Parita' verificata da `tests/run_all.sh:203`.
- **Three.js e' r128**: le API differiscono dalle versioni moderne. Non assumere API nuove.
- **Il tetto sui voxel resta in 2 sole copie**: `voxel_budget_for` in `src/parser.py` e la logica gemella in `ui/src/utils/expand-ops.js`. Mai una terza.
- **Encoding**: i file in `ui/src/` sono UTF-8, la build li legge/scrive latin1 (i byte passano invariati). Non introdurre caratteri non-latin1: la build li rifiuta.
- **Chi sostituisce `currentModelData` deve chiamare `invalidateIncremental()`** prima del `buildModel()`.
- **Verifica finale di ogni task**: `bash tests/run_all.sh` verde, inclusi i cinque test-tripwire del rig (`test_glb_rigged_artifacts`, `test_rig_weights`, `test_channel_keys`, `test_glb_pose_export`, `test_rig_parts_legs`). Un `ReferenceError: <simbolo> is not defined` da questi significa codice motore MANCANTE dai sorgenti, non un test stantio.

---

## File Structure

| File | Responsabilita' | Task |
|------|-----------------|------|
| `ui/src/lib/15-rig.js` | Aggiunge un listener `pointerdown` in capture che risincronizza `gizmoProxy`; il toast Ctrl+A del rig passa a Ctrl+Shift+A e a `t()` | 1, 5 |
| `ui/src/utils/expand-ops.js` | Estrae `voxelBudgetFor(gridSize)` dall'IIFE dentro `expandOps` | 2 |
| `ui/src/lib/35-primitives.js` | **NUOVO**: funzioni pure delle 5 forme + scelta griglia + menu `Shift+A` + dialogo dimensioni | 3, 4 |
| `ui/src/index.template.html` | Markup del menu forme e del dialogo dimensioni | 4 |
| `ui/src/manifest.json` | Registra `lib/35-primitives.js` prima di `lib/18-bootstrap-tail.js` | 3 |
| `ui/src/lib/33-timeline.js` | `tlSelectAllKeys()`, flag area attiva, ramo Ctrl+A nel keydown | 5 |
| `ui/src/lib/01-scene-setup.js` | Il Ctrl+A globale esclude Shift | 5 |
| `ui/src/lib/34-collapsible.js` | Persistenza dei `<details class="rp-section">` del pannello destro | 6 |
| `ui/src/lib/18-bootstrap-tail.js` | Chiama `initRightPanelSections()` | 6 |
| `ui/locales/*.json` (6 file) | Chiavi nuove: primitive + toast del rig | 4, 5 |
| `tests/test_gizmo_first_drag.mjs` | **NUOVO** | 1 |
| `tests/test_primitives.mjs` | **NUOVO** | 3 |
| `tests/test_timeline_select_all.mjs` | **NUOVO** | 5 |
| `tests/test_panel_persist.mjs` | **NUOVO** | 6 |
| `tests/run_all.sh` | Registra i quattro test nuovi | 1, 3, 5, 6 |

---

## Task 1: Fix della posa estranea al primo drag del gizmo

**Files:**
- Modify: `ui/src/lib/15-rig.js:3157` (subito dopo la registrazione di `objectChange`)
- Modify: `ui/src/lib/01-scene-setup.js` — nessuna modifica in questo task
- Test: `tests/test_gizmo_first_drag.mjs` (creare)
- Modify: `tests/run_all.sh`

**Interfaces:**
- Consumes: niente dai task precedenti (e' il primo).
- Produces: nessun simbolo nuovo esportato. Il blocco del gizmo in `15-rig.js` resta delimitato da `let gizmoMode = 'rotate';` (inizio) e dal commento `// Move a joint in rest space` (fine): i test lo estraggono fra questi due marcatori, quindi **non rinominarli**.

### Contesto: la causa, già verificata

In r128 `TransformControls.pointerDown` fa, in quest'ordine:

```
tc128.js:245   this._quaternionStart.copy( this.object.quaternion );   // fotografia
tc128.js:254   this.dragging = true;                                    // -> 'dragging-changed'
tc128.js:256   this.dispatchEvent( _mouseDownEvent );
```

`dragging-changed` chiama `onGizmoDragStart()` (`15-rig.js:3151-3156`), che quindi gira **dopo** la fotografia: qualunque correzione faccia sul proxy arriva tardi. E `onGizmoChange` (`15-rig.js:3228`) scrive la posa in **assoluto**:

```js
const localQ = dragParentQuatInv.clone().multiply(gizmoProxy.quaternion);
rig.pose[bd.name] = [e.x, e.y, e.z];
```

Quindi se al pointerdown il proxy e' disallineato rispetto all'osso, il primo movimento del mouse porta la posa all'orientamento del **proxy**, non a quello dell'osso. A fine drag `onGizmoDragEnd` chiama `syncGizmoToBone()` (`:3264`), il proxy si riallinea e da lì i drag sono corretti: il "solo la prima volta".

**Cosa NON e' ancora isolato:** quale azione lasci il proxy disallineato la prima volta. Il passo 1 lo isola prima di scrivere la fix. Il rimedio scelto copre comunque tutti i candidati, perche' risincronizza a **ogni** pressione.

- [ ] **Step 1: Riprodurre e isolare (systematic-debugging, PRIMA di toccare il codice)**

Usa la skill `superpowers:systematic-debugging`. Avvia l'app (`python main.py`), apri un modello con rig, vai nella scheda Rig e strumenta temporaneamente `onGizmoDragStart` con un log che confronta proxy e osso:

```js
// STRUMENTAZIONE TEMPORANEA — da rimuovere prima del commit
function onGizmoDragStart() {
    if (selectedBoneIndex < 0 || !skeleton) return;
    const bone = skeleton.bones[selectedBoneIndex];
    const qb = new THREE.Quaternion(); bone.getWorldQuaternion(qb);
    const d = Math.abs(qb.dot(gizmoProxy.quaternion));
    console.log('[gizmo] drag start, allineamento proxy/osso =', d.toFixed(6),
                d < 0.999999 ? '<-- PROXY STANTIO' : 'ok');
    // ... resto invariato
}
```

Poi prova in sequenza, loggando quale gesto produce `PROXY STANTIO` al primo drag: (a) prima selezione di un osso col click in viewport; (b) selezione dalla lista ossa; (c) muovere i cursori di posa e poi afferrare il gizmo; (d) fare scrub nella timeline e poi afferrare il gizmo; (e) far girare una clip preset, fermarla, afferrare il gizmo. Annota nel messaggio di commit del passo 6 **quale** percorso lo riproduce: serve a chi verra' dopo. Rimuovi la strumentazione prima di proseguire.

- [ ] **Step 2: Scrivere il test che falisce**

Crea `tests/test_gizmo_first_drag.mjs`. Il test estrae il blocco del gizmo dai **sorgenti** (se il blocco viene rimosso il test non parte nemmeno) e riproduce l'ordine degli eventi di r128. La matematica dei quaternioni e' reale, non stub: senza, l'asserzione sulla posa non significherebbe niente.

```js
/*
 * PRIMO DRAG DEL GIZMO: la posa non deve saltare.
 *
 * In r128 TransformControls fotografa _quaternionStart PRIMA di mettere
 * dragging = true (che e' cio' che emette 'dragging-changed' -> onGizmoDragStart).
 * Se al pointerdown gizmoProxy e' disallineato rispetto all'osso, onGizmoChange —
 * che scrive la posa in ASSOLUTO — porta la posa all'orientamento del proxy.
 * Il rimedio e' un listener pointerdown in CAPTURE su window che risincronizza il
 * proxy prima che TransformControls lo guardi.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/15-rig.js'), 'utf8');
const from = src.indexOf("let gizmoMode = 'rotate';");
const to = src.indexOf('// Move a joint in rest space', from);
if (from < 0 || to < 0) {
    console.log('FAIL: blocco del gizmo non trovato in 15-rig.js (marcatori cambiati?)');
    process.exit(1);
}
const block = src.slice(from, to);
ok(/addEventListener\(\s*'pointerdown'[\s\S]{0,400}?true\s*\)/.test(block),
   'il blocco registra un pointerdown in capture (la fix e\' presente)');
```

Continua lo stesso file con il THREE finto (matematica vera) e l'armatura:

```js
// --- THREE finto: solo cio' che il blocco usa, ma con matematica REALE ---
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
    setFromMatrixPosition(m) { this.x = m.pos.x; this.y = m.pos.y; this.z = m.pos.z; return this; }
}
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    identity() { this.x = this.y = this.z = 0; this.w = 1; return this; }
    invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }   // unitario
    dot(q) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
    multiply(b) {
        const a = this;
        const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
        const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
        const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
        const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
        this.x = x; this.y = y; this.z = z; this.w = w; return this;
    }
    setFromEuler(e) {
        const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
        const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
}
class Euler {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; return this; }
    // XYZ, come THREE: matrice dal quaternione, poi estrazione.
    setFromQuaternion(q) {
        const x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
        const xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
        const yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
        const wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;
        const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
        const m22 = 1 - (xx + zz), m23 = yz - wx;
        const m32 = yz + wx, m33 = 1 - (xx + yy);
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); }
        else { this.x = Math.atan2(m32, m22); this.z = 0; }
        return this;
    }
}
```

E infine l'armatura che riproduce l'ordine di r128 e le asserzioni:

```js
class Obj3D {
    constructor() { this.position = new V3(); this.quaternion = new Quat(); this.rotation = new Euler(); }
    updateMatrixWorld() { }
}
// TransformControls finto: replica SOLO l'ordine di r128 che conta.
class FakeTC {
    constructor() {
        this.dragging = false; this.axis = null; this.object = null;
        this.enabled = false; this.visible = false;
        this._l = {}; this._quaternionStart = new Quat();
    }
    addEventListener(t, f) { (this._l[t] || (this._l[t] = [])).push(f); }
    _emit(t, e) { (this._l[t] || []).forEach(f => f(e)); }
    attach(o) { this.object = o; return this; }
    detach() { this.object = null; return this; }
    setMode() { } setSpace() { } setSize() { }
    // r128 pointerDown: fotografia PRIMA, dragging (e quindi l'evento) DOPO.
    pointerDown() {
        this._quaternionStart.copy(this.object.quaternion);
        this.dragging = true;
        this._emit('dragging-changed', { value: true });
    }
    // Un movimento del mouse: TC scriverebbe una rotazione sul proxy partendo da
    // _quaternionStart. Qui la applichiamo come delta e notifichiamo, come TC.
    pointerMove(deltaQ) {
        this.object.quaternion.copy(new Quat().copy(deltaQ).multiply(this._quaternionStart));
        this._emit('objectChange', {});
    }
    pointerUp() { this.dragging = false; this._emit('dragging-changed', { value: false }); }
}
const THREE = { Object3D: Obj3D, Quaternion: Quat, Euler, Vector3: V3, TransformControls: FakeTC };

// Osso finto: quaternione mondo imposto a mano, genitore identita'.
function makeBone(name, worldQ) {
    return {
        name, isBone: true, parent: null,
        rotation: new Euler(), matrixWorld: { pos: new V3(1, 2, 3) },
        updateWorldMatrix() { }, getWorldQuaternion(q) { return q.copy(worldQ); },
    };
}

const winL = {};
const window_ = { addEventListener(t, f, c) { (winL[t] || (winL[t] = [])).push({ f, capture: !!c }); } };
const dom = { addEventListener() { } };
const api = new Function(
    'THREE', 'scene', 'camera', 'renderer', 'controls', 'gizmoBar', 'window',
    'pushHistory', 'updateBoneMarker', 'updateRotLabels', 'poseRot', 'animSelect',
    'rigPreviewActive', 'weightPaintActive',
    'var skeleton = null, selectedBoneIndex = -1, rig = null, currentAction = null;\n' +
    block +
    '\nreturn { tc: transformControls, proxy: gizmoProxy, syncGizmoToBone,' +
    ' set(s, i, r) { skeleton = s; selectedBoneIndex = i; rig = r; },' +
    ' pose() { return rig.pose; } };'
)(THREE, { add() { } }, {}, { domElement: dom }, { enabled: true },
  { classList: { toggle() { } } }, window_,
  () => { }, () => { }, () => { },
  { x: { value: 0 }, y: { value: 0 }, z: { value: 0 } }, { value: 'none' }, true, false);
```

```js
// --- scenario ---
const REST = new Quat().setFromEuler(new Euler(0, 0, 0));          // osso a riposo
const STALE = new Quat().setFromEuler(new Euler(0.9, 0.3, -0.7));  // proxy stantio
const firePointerDown = () => (winL['pointerdown'] || [])
    .filter(x => x.capture).forEach(x => x.f({ button: 0 }));

function scenario(boneQ, proxyQ, deltaQ) {
    const bone = makeBone('upperArm_R', boneQ);
    const rig = { bones: [{ name: 'upperArm_R' }], pose: {} };
    api.set({ bones: [bone] }, 0, rig);
    api.proxy.quaternion.copy(proxyQ);          // stato di partenza del proxy
    firePointerDown();                          // <-- la fix, se c'e', gira qui
    api.tc.attach(api.proxy);
    api.tc.pointerDown();                       // fotografia + dragging-changed
    api.tc.pointerMove(deltaQ);                 // primo objectChange
    const written = rig.pose['upperArm_R'].slice();
    api.tc.pointerUp();
    return written;
}
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

console.log('[1] proxy STANTIO: il primo objectChange non deve saltare');
// Movimento nullo: la posa scritta deve essere quella dell'OSSO (riposo = 0,0,0),
// non quella del proxy stantio.
ok(near(scenario(REST, STALE, new Quat()), [0, 0, 0]),
   'movimento nullo con proxy stantio -> posa invariata (nessun salto)');

console.log('[2] un movimento vero produce esattamente quel movimento');
const D = new Quat().setFromEuler(new Euler(0, 0, 0.5));
ok(near(scenario(REST, STALE, D), [0, 0, 0.5], 1e-6),
   'delta di 0.5 rad su Z con proxy stantio -> posa = 0.5 rad su Z');

console.log('[3] caso di controllo: proxy GIA\' allineato, nulla cambia');
ok(near(scenario(REST, REST, new Quat()), [0, 0, 0]), 'proxy allineato, movimento nullo');
ok(near(scenario(REST, REST, D), [0, 0, 0.5], 1e-6), 'proxy allineato, delta 0.5 su Z');

console.log('[4] la risincronizzazione non scatta a meta\' trascinamento');
{
    const bone = makeBone('upperArm_R', REST);
    api.set({ bones: [bone] }, 0, { bones: [{ name: 'upperArm_R' }], pose: {} });
    api.proxy.quaternion.copy(REST);
    firePointerDown(); api.tc.attach(api.proxy); api.tc.pointerDown();
    api.tc.pointerMove(D);
    const before = api.proxy.quaternion.clone();
    firePointerDown();                          // pointerdown spurio DURANTE il drag
    ok(Math.abs(api.proxy.quaternion.dot(before)) > 0.999999,
       'un pointerdown durante il drag non risincronizza (non annulla il gesto)');
    api.tc.pointerUp();
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: Eseguire il test e verificare che FALLISCE**

Run: `node tests/test_gizmo_first_drag.mjs`
Expected: FAIL. La prima asserzione (`pointerdown in capture`) fallisce perche' la fix non c'e' ancora; i casi [1] e [2] falliscono perche' la posa scritta segue il proxy stantio invece dell'osso.

- [ ] **Step 4: Implementare la fix**

In `ui/src/lib/15-rig.js`, subito **dopo** la riga `transformControls.addEventListener('objectChange', onGizmoChange);` (`:3157`) e **prima** di `transformControls.enabled = false;`, inserire:

```js
            // PRIMO DRAG: il proxy va riallineato PRIMA che TransformControls lo guardi.
            // In r128 pointerDown fotografa _quaternionStart dal proxy (tc r128 :245) e
            // solo DOPO mette dragging = true (:254), che e' cio' che emette
            // 'dragging-changed' -> onGizmoDragStart. Quindi onGizmoDragStart arriva
            // sempre troppo tardi per correggere un proxy stantio, e onGizmoChange
            // scrive la posa in ASSOLUTO: il primo movimento del mouse portava la posa
            // all'orientamento del PROXY invece che a quello dell'osso (posa "che non
            // c'entra nulla", poi Ctrl+Z, poi tutto bene perche' onGizmoDragEnd
            // risincronizza). Ascoltando in CAPTURE su window arriviamo prima del
            // listener di TC, che e' registrato sul canvas: la fotografia trova un
            // proxy corretto.
            //
            // Non serve sapere QUALE percorso lascia il proxy stantio (selezione osso,
            // scrub della timeline, mixer di una clip...): qui si risincronizza a ogni
            // pressione, quindi vanno tutti bene.
            window.addEventListener('pointerdown', () => {
                // A trascinamento in corso NON si tocca: risincronizzare a meta' gesto
                // butterebbe via la rotazione appena fatta.
                if (transformControls.dragging) return;
                if (!transformControls.enabled || !transformControls.object) return;
                syncGizmoToBone();
            }, true);
```

Note: `syncGizmoToBone` e' una dichiarazione di funzione piu' avanti nello stesso file, quindi e' hoistata ed e' chiamabile da qui. Esce da sola se `!skeleton || selectedBoneIndex < 0` (`:3190`).

- [ ] **Step 5: Eseguire il test e verificare che PASSA**

```bash
node tests/test_gizmo_first_drag.mjs        # tutte le asserzioni OK
grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js   # deve dare 2 e 2
node ui/build.mjs
bash tests/run_all.sh
```

Expected: `test_gizmo_first_drag` verde e suite intera verde. Poi **verifica manuale**: rifai il percorso isolato allo Step 1 e conferma che la posa non salta piu' e che non serve Ctrl+Z.

- [ ] **Step 6: Registrare il test e committare**

In `tests/run_all.sh`, dopo la riga `run "Strumenti rig: specchio, IK, pose (Node)" node tests/test_rig_tools.mjs` (`:106`):

```bash
# 4c-quinquies-bis. Primo drag del gizmo: in r128 TransformControls fotografa
#            _quaternionStart PRIMA di emettere 'dragging-changed', quindi
#            onGizmoDragStart non fa in tempo a correggere un proxy stantio e
#            onGizmoChange (che scrive la posa in ASSOLUTO) portava la posa
#            all'orientamento del proxy: la "posa che non c'entra nulla" al primo
#            movimento, poi Ctrl+Z e da li' tutto bene.
run "Primo drag del gizmo (Node)" node tests/test_gizmo_first_drag.mjs
```

Commit: `fix(rig): risincronizza il gizmo al pointerdown, non a dragging-changed`. Nel corpo del messaggio indica **quale** percorso riproduceva il proxy stantio (isolato allo Step 1).

---

## Task 2: Estrarre `voxelBudgetFor` (refactor a comportamento invariato)

Le primitive devono rispettare il tetto sui voxel, ma in JS la regola **non e' una funzione chiamabile**: e' un IIFE locale dentro `expandOps` (`ui/src/utils/expand-ops.js:26-38`). Estrarla evita una **terza** copia della regola, che CLAUDE.md vieta.

**Files:**
- Modify: `ui/src/utils/expand-ops.js:24-38`
- Test: nessun test nuovo — la parita' Python/JS esistente (`tests/run_all.sh:42`) e' già la rete di sicurezza.

**Interfaces:**
- Produces: `voxelBudgetFor(gridSize)` → `number`. `gridSize` e' `[W, H, D]` (array di 3 numeri) oppure qualunque valore invalido/assente. Restituisce `max(4000000, min(floor(W*H*D/2), 8000000))`, e `4000000` se `gridSize` non e' valido. Consumata dal test del Task 3 e dalla validazione del dialogo nel Task 4.

- [ ] **Step 1: Verificare la baseline verde prima di toccare**

Run: `bash -c 'node tests/ops_parity_js.mjs >/dev/null && echo baseline ok'`
Expected: `baseline ok`. Se già rosso, fermarsi: non e' questo refactor.

- [ ] **Step 2: Estrarre la funzione**

In `ui/src/utils/expand-ops.js`, **prima** di `function expandOps(data) {` (riga 1), inserire:

```js
            // Tetto di celle adatto alla griglia dichiarata: meta' del volume, con
            // minimo il default e massimo il tetto assoluto. Gemella ESATTA di
            // voxel_budget_for() in src/parser.py — CLAUDE.md impone che le due
            // restino identiche, e queste sono le sole due copie della regola.
            // L'8M non e' arbitrario: una cella di Map JS costa ~98 byte, quindi 24M
            // celle = ~2.2 GB e uccidono la tab (riprodotto come OOM di Node).
            const MAX_VOXELS = 4000000;
            const MAX_VOXELS_ABSOLUTE = 8000000;
            function voxelBudgetFor(gridSize) {
                try {
                    if (Array.isArray(gridSize) && gridSize.length === 3) {
                        const w = parseInt(gridSize[0], 10);
                        const h = parseInt(gridSize[1], 10);
                        const d = parseInt(gridSize[2], 10);
                        if (w > 0 && h > 0 && d > 0) {
                            const half = Math.floor((w * h * d) / 2);
                            return Math.max(MAX_VOXELS, Math.min(half, MAX_VOXELS_ABSOLUTE));
                        }
                    }
                } catch (e) { }
                return MAX_VOXELS;
            }
```

Poi **sostituire** le righe 24-38 (le due `const MAX_VOXELS*` locali e l'IIFE `budgetLimit`) con:

```js
                const budgetLimit = voxelBudgetFor((data.metadata && data.metadata.grid_size) || null);
```

Attenzione: le due `const MAX_VOXELS` locali dentro `expandOps` vanno **rimosse** (ora sono a livello di modulo). Non lasciarne copie: sono le uniche due occorrenze in `ui/src/` oltre a `PLUGIN_MAX_VOXELS` in `24-plugins.js`, che e' un'altra cosa e non va toccata.

- [ ] **Step 3: Verificare che la parita' resti identica**

```bash
node ui/build.mjs
bash tests/run_all.sh
```

Expected: `Parita' ops Python <-> JS` verde con lo stesso conteggio di prima (20/20 casi identici), e suite intera verde. Un refactor a comportamento invariato non deve muovere un solo voxel.

- [ ] **Step 4: Commit**

```bash
git add ui/src/utils/expand-ops.js ui/index.html
git commit -m "refactor(ops): estrai voxelBudgetFor, riusabile fuori da expandOps"
```

---

## Task 3: Primitive — le funzioni pure

**Files:**
- Create: `ui/src/lib/35-primitives.js`
- Modify: `ui/src/manifest.json`
- Test: `tests/test_primitives.mjs` (creare)
- Modify: `tests/run_all.sh`

**Interfaces:**
- Consumes: `voxelBudgetFor(gridSize)` dal Task 2.
- Produces:
  - `PRIMITIVE_SHAPES` — array di `{id, i18nKey, ratio, defaultSize, fixedRatio}`. `id` ∈ `'cube'|'pyramid'|'cylinder'|'sphere'|'cone'`.
  - `primitiveShape(id)` → l'elemento di `PRIMITIVE_SHAPES` con quell'`id`, o `null`.
  - `primitiveCells(id, size, height)` → `[{x, y, z}]`, coordinate a partire da `(0,0,0)`, `x`/`z` in `[0, size)`, `y` in `[0, height)`. Array vuoto se i parametri sono invalidi.
  - `primitiveGridFor(size, height, currentGrid)` → `number`: il primo valore standard che contiene la forma, con tetto 512.
  - `primitiveVoxelCount(id, size, height)` → `number`: quanti voxel produrrebbe, **senza costruirli**. Costo `O(size*height)`, non `O(size^2*height)`. `0` se i parametri sono invalidi.
  - Consumate dal Task 4.

**Perche' `primitiveVoxelCount` non puo' essere `primitiveCells().length`:** gira a **ogni battuta di tasto** nel campo Dimensione (`primRefreshInfo`, Task 4), e serve proprio a decidere se la forma sfonda il budget. Contare materializzando significa allocare 134 milioni di oggetti per un cubo 512 — cioe' andare in OOM esattamente nel codice che deve *impedire* l'OOM. E' il difetto che CLAUDE.md documenta (una cella di Map costa ~98 byte, 24M celle = ~2.2 GB e il tab muore): misurato, un `primitiveCells('cube', 512, 512)` fa cadere Node con "Reached heap limit" in ~13 s. Da qui la forma chiusa, verificata identica al ciclo su tutte le misure 1..40 e su 64/100/128.

- [ ] **Step 1: Scrivere il test che fallisce**

Crea `tests/test_primitives.mjs`:

```js
/*
 * PRIMITIVE VOXEL (Shift+A). Le funzioni sono pure — niente DOM, niente THREE —
 * quindi si testano direttamente estraendole dai sorgenti.
 *
 * Le trappole vere, tutte gia' costate un bug in questo progetto:
 *  - una forma che produce ZERO voxel (a 'box' con float e' successo davvero);
 *  - l'errore di mezzo voxel, che rende una sfera di diametro pari sbilenca;
 *  - il guscio esterno "mangiato" di un voxel dal test sul raggio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/35-primitives.js'), 'utf8');
const budgetSrc = fs.readFileSync(path.join(ROOT, 'ui/src/utils/expand-ops.js'), 'utf8');
const bFrom = budgetSrc.indexOf('const MAX_VOXELS = 4000000;');
const bTo = budgetSrc.indexOf('function expandOps');
if (bFrom < 0 || bTo < 0 || bFrom > bTo) {
    console.log('FAIL: voxelBudgetFor non trovata in expand-ops.js (Task 2 fatto?)');
    process.exit(1);
}
// Solo la parte PURA del modulo: si ferma al primo pezzo che tocca il DOM.
const uiMark = '// ===== UI: menu Shift+A e dialogo =====';
const pureEnd = src.indexOf(uiMark);
const pure = pureEnd < 0 ? src : src.slice(0, pureEnd);
const api = new Function(budgetSrc.slice(bFrom, bTo) + pure +
    '\nreturn { PRIMITIVE_SHAPES, primitiveShape, primitiveCells,' +
    ' primitiveGridFor, primitiveVoxelCount, voxelBudgetFor };')();
const IDS = ['cube', 'pyramid', 'cylinder', 'sphere', 'cone'];
```

Le asserzioni, nello stesso file:

```js
console.log('[1] cinque forme, con proporzioni e default dichiarati');
ok(api.PRIMITIVE_SHAPES.length === 5, 'cinque forme');
ok(IDS.every(id => api.primitiveShape(id)), 'ogni id atteso esiste');
ok(api.primitiveShape('sphere').fixedRatio === true, 'la sfera ha proporzione FISSA');
ok(api.primitiveShape('cube').fixedRatio !== true, 'il cubo no');
ok(api.primitiveShape('nope') === null, 'un id sconosciuto da\' null');

console.log('[2] MAI vuote (e\' il bug che colpi\' box con i float)');
for (const id of IDS) {
    for (const s of [1, 2, 3, 8, 16]) {
        const h = Math.max(1, Math.round(s * api.primitiveShape(id).ratio));
        ok(api.primitiveCells(id, s, h).length > 0, `${id} a dimensione ${s} produce voxel`);
    }
}

console.log('[3] simmetria su X e su Z (coglie l\'errore di mezzo voxel)');
for (const id of IDS) {
    for (const s of [4, 5, 8, 9]) {
        const h = Math.max(1, Math.round(s * api.primitiveShape(id).ratio));
        const cells = api.primitiveCells(id, s, h);
        const set = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
        const mirX = cells.every(c => set.has(`${s - 1 - c.x},${c.y},${c.z}`));
        const mirZ = cells.every(c => set.has(`${c.x},${c.y},${s - 1 - c.z}`));
        ok(mirX && mirZ, `${id} dimensione ${s}: simmetrica su X e Z`);
    }
}

console.log('[4] limiti: niente fuori dalla scatola, altezza esatta');
for (const id of IDS) {
    const s = 10, h = Math.max(1, Math.round(s * api.primitiveShape(id).ratio));
    const cells = api.primitiveCells(id, s, h);
    ok(cells.every(c => c.x >= 0 && c.x < s && c.z >= 0 && c.z < s && c.y >= 0 && c.y < h),
       `${id}: ogni voxel dentro ${s}x${h}x${s}`);
    const ys = cells.map(c => c.y);
    ok(Math.min(...ys) === 0 && Math.max(...ys) === h - 1,
       `${id}: occupa esattamente l'altezza chiesta`);
}

console.log('[5] forma');
ok(api.primitiveCells('cube', 6, 4).length === 6 * 6 * 4, 'cubo: pieno esatto');
{
    const cells = api.primitiveCells('cylinder', 9, 12);
    const perLevel = {};
    cells.forEach(c => { perLevel[c.y] = (perLevel[c.y] || 0) + 1; });
    const counts = Object.values(perLevel);
    ok(counts.every(n => n === counts[0]), 'cilindro: stessa sezione a ogni livello');
}
for (const id of ['cone', 'pyramid']) {
    const cells = api.primitiveCells(id, 12, 15);
    const w = {};
    cells.forEach(c => { w[c.y] = Math.max(w[c.y] || 0, 1); });
    const spanAt = y => {
        const xs = cells.filter(c => c.y === y).map(c => c.x);
        return xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0;
    };
    let mono = true;
    for (let y = 1; y < 15; y++) if (spanAt(y) > spanAt(y - 1)) mono = false;
    ok(mono, `${id}: si restringe in modo monotono verso l'alto`);
    ok(spanAt(14) > 0 && spanAt(14) <= 2, `${id}: l'apice e' non vuoto e largo al massimo 2`);
    ok(spanAt(0) === 12, `${id}: la base occupa tutta la dimensione`);
}
{
    const cells = api.primitiveCells('sphere', 8, 8);
    const set = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
    ok(cells.every(c => set.has(`${c.x},${8 - 1 - c.y},${c.z}`)), 'sfera: simmetrica anche su Y');
}
```

```js
console.log('[6] il guscio esterno non e\' mangiato di un voxel');
{
    // A dimensione dispari il livello equatoriale di una sfera deve toccare i due
    // bordi opposti: se il test sul raggio e' troppo severo, non ci arriva.
    const cells = api.primitiveCells('sphere', 9, 9).filter(c => c.y === 4);
    const xs = cells.map(c => c.x);
    ok(Math.min(...xs) === 0 && Math.max(...xs) === 8, 'sfera 9: l\'equatore tocca entrambi i bordi');
}

console.log('[7] scelta della griglia');
ok(api.primitiveGridFor(40, 40, 16) === 48, 'dimensione 40 su griglia 16 -> 48 (non 32)');
ok(api.primitiveGridFor(16, 16, 64) === 64, 'se ci sta gia\', la griglia non cambia');
ok(api.primitiveGridFor(600, 600, 64) === 512, 'dimensione 600 -> si ferma a 512');
ok(api.primitiveGridFor(200, 30, 32) === 256, 'vince la misura piu\' grande fra dimensione e altezza');

console.log('[8] il conteggio in forma chiusa e\' IDENTICO al ciclo sulle celle');
{
    // primitiveVoxelCount e' un secondo modello della stessa geometria: senza questo
    // confronto e' libero di divergere in silenzio, e il budget verrebbe deciso su un
    // numero sbagliato.
    const bad = [];
    for (const id of IDS) {
        const ratio = api.primitiveShape(id).ratio;
        for (let s = 1; s <= 40; s++) {
            for (const h of [1, 2, 3, s, Math.max(1, Math.round(s * ratio)), s * 2]) {
                const a = api.primitiveCells(id, s, h).length;
                const b = api.primitiveVoxelCount(id, s, h);
                if (a !== b) bad.push(`${id} ${s}x${h}: celle=${a} conteggio=${b}`);
            }
        }
    }
    ok(bad.length === 0, `misure 1..40, nessuna divergenza (${bad.length})`);
    if (bad.length) console.log('     ' + bad.slice(0, 6).join('\n     '));
    for (const id of IDS) {
        for (const s of [64, 100, 128]) {
            ok(api.primitiveCells(id, s, s).length === api.primitiveVoxelCount(id, s, s),
               `${id} ${s}: conteggio identico`);
        }
    }
    for (const bad2 of [[0, 4], [4, 0], [NaN, 4]]) {
        ok(api.primitiveVoxelCount('cube', bad2[0], bad2[1]) === 0,
           `conteggio(${bad2[0]},${bad2[1]}) -> 0`);
    }
}

console.log('[9] contare NON deve allocare: 512 va contato, non costruito');
{
    // Questo gruppo tiene in piedi il cap di CLAUDE.md. La regressione da cogliere
    // e' una sola e ha un nome: "semplificare" primitiveVoxelCount in
    // primitiveCells().length. Costa un OOM (misurato: ~13 s e oltre 4 GB su un cubo
    // 512) in una funzione che gira a ogni battuta di tasto nel campo Dimensione.
    //
    // L'asserzione e' STRUTTURALE, non cronometrica: una soglia di tempo o di heap
    // dipenderebbe dal carico della macchina e prima o poi fallirebbe senza una vera
    // regressione. Qui si legge il sorgente e si pretende che il conteggio non passi
    // dal costruttore di celle.
    const from = src.indexOf('function primitiveVoxelCount');
    ok(from >= 0, 'primitiveVoxelCount esiste');
    const body = src.slice(from, src.indexOf('\n            function ', from + 10));
    ok(!/primitiveCells/.test(body),
       'primitiveVoxelCount NON chiama primitiveCells (contare non deve allocare)');

    // E il conteggio a 512 deve comunque tornare il numero giusto: se la forma chiusa
    // sbaglia sulle misure grandi, il budget viene deciso su un numero falso.
    const counts = IDS.map(id => api.primitiveVoxelCount(id, 512, 512));
    ok(counts[0] === 512 * 512 * 512, 'cubo 512 = 134217728 voxel');
    ok(counts.every(n => Number.isFinite(n) && n > 0), 'ogni forma da\' un numero finito');
    ok(counts[3] < counts[2] && counts[2] < counts[0],
       'a 512 sfera < cilindro < cubo (i volumi restano ordinati)');
}

console.log('[10] budget: la forma piu\' costosa va rifiutata, non troncata');
{
    const g = api.primitiveGridFor(512, 512, 64);
    ok(api.primitiveVoxelCount('cube', 512, 512) > api.voxelBudgetFor([g, g, g]),
       'un cubo 512 sfonda il budget (va rifiutato a monte)');
    const g2 = api.primitiveGridFor(64, 64, 64);
    ok(api.primitiveVoxelCount('cube', 64, 64) <= api.voxelBudgetFor([g2, g2, g2]),
       'un cubo 64 sta nel budget');
    ok(api.primitiveVoxelCount('cube', 8, 8) === 512, 'primitiveVoxelCount conta davvero');
}

console.log('[11] parametri invalidi: array vuoto, non un\'eccezione');
for (const bad of [[0, 4], [-3, 4], [4, 0], [NaN, 4], [4, NaN]]) {
    ok(api.primitiveCells('cube', bad[0], bad[1]).length === 0,
       `cube(${bad[0]}, ${bad[1]}) -> vuoto`);
}
ok(api.primitiveCells('nope', 8, 8).length === 0, 'id sconosciuto -> vuoto');

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Eseguire il test e verificare che FALLISCE**

Run: `node tests/test_primitives.mjs`
Expected: FAIL immediato — `ENOENT` su `ui/src/lib/35-primitives.js`, che non esiste ancora.

- [ ] **Step 3: Scrivere l'implementazione minima**

Crea `ui/src/lib/35-primitives.js`. **Rientro di 12 spazi**, come ogni modulo di `ui/src/lib/` (il bundle e' una concatenazione dentro un `<script>`: un rientro diverso non rompe niente ma stona subito nel diff).

```js
            // --- Primitive voxel (Shift+A) --------------------------------------------
            // Un file, due meta': qui sopra la MATEMATICA (funzioni pure, nessun DOM e
            // nessun THREE, testate da tests/test_primitives.mjs estraendo il sorgente);
            // sotto il marcatore "UI" il menu e il dialogo.
            //
            // Coordinate CENTRATE sul centro geometrico: il centro di una misura pari
            // cade a meta' voxel (size 8 -> centro 3.5), quindi lavorare con la distanza
            // dal centro rende ogni forma simmetrica PER COSTRUZIONE. Con l'origine su 0
            // invece una sfera di diametro pari esce sbilenca di un voxel, ed e' un
            // difetto che a occhio non si nota e in Blender si', a specchio fatto.
            //
            // Il raggio del test e' size/2, NON (size-1)/2: il voxel piu' esterno ha il
            // centro a (size-1)/2 dal centro, quindi con il raggio piu' piccolo il guscio
            // esterno risulta mangiato di un voxel. L'asserzione [6] del test copre
            // esattamente questo.
            const PRIMITIVE_GRIDS = [32, 48, 64, 128, 192, 256, 384, 512];

            const PRIMITIVE_SHAPES = [
                { id: 'cube',     i18nKey: 'prim.cube',     ratio: 1.0, defaultSize: 16 },
                { id: 'pyramid',  i18nKey: 'prim.pyramid',  ratio: 1.0, defaultSize: 16 },
                { id: 'cylinder', i18nKey: 'prim.cylinder', ratio: 1.5, defaultSize: 12 },
                { id: 'sphere',   i18nKey: 'prim.sphere',   ratio: 1.0, defaultSize: 16, fixedRatio: true },
                { id: 'cone',     i18nKey: 'prim.cone',     ratio: 1.5, defaultSize: 12 }
            ];

            function primitiveShape(id) {
                for (const s of PRIMITIVE_SHAPES) if (s.id === id) return s;
                return null;
            }

            // Misura intera valida: >= 1 e finita. Un NaN che arriva da un campo di testo
            // vuoto deve produrre ZERO celle, non un ciclo su NaN.
            function primIntOk(v) {
                const n = Number(v);
                return Number.isFinite(n) && Math.floor(n) >= 1;
            }

            // Raggio minimo che tiene l'apice NON vuoto. Su misura pari il voxel piu'
            // interno ha il centro a 0.5 da entrambi gli assi, quindi serve
            // sqrt(0.5^2 + 0.5^2); su misura dispari il centro cade su un voxel e
            // qualunque raggio va bene. Senza questo minimo cono e piramide perdono i
            // livelli in cima e non arrivano all'altezza chiesta.
            const PRIM_APEX_MIN = Math.SQRT1_2;   // ~0.7072

            function primitiveCells(id, size, height) {
                const shape = primitiveShape(id);
                if (!shape || !primIntOk(size) || !primIntOk(height)) return [];
                const S = Math.floor(Number(size));
                const H = Math.floor(Number(height));
                const cx = (S - 1) / 2, cz = (S - 1) / 2, cy = (H - 1) / 2;
                const r = S / 2, ry = H / 2;
                const out = [];
                for (let y = 0; y < H; y++) {
                    // Frazione di altezza al CENTRO della cella: con (y/H) il livello 0
                    // avrebbe raggio pieno e l'ultimo raggio zero, sbilanciato in basso.
                    const t = (y + 0.5) / H;
                    const rAt = Math.max(PRIM_APEX_MIN, r * (1 - t));
                    const dy = y - cy;
                    for (let x = 0; x < S; x++) {
                        const dx = x - cx;
                        for (let z = 0; z < S; z++) {
                            const dz = z - cz;
                            let inside;
                            if (id === 'cube') {
                                inside = true;
                            } else if (id === 'cylinder') {
                                inside = (dx * dx + dz * dz) <= r * r;
                            } else if (id === 'sphere') {
                                // Normalizzata: se un giorno arriva un ellissoide, qui non
                                // cambia niente. Oggi ry === r perche' fixedRatio.
                                inside = (dx * dx) / (r * r) + (dy * dy) / (ry * ry)
                                       + (dz * dz) / (r * r) <= 1;
                            } else if (id === 'cone') {
                                inside = (dx * dx + dz * dz) <= rAt * rAt;
                            } else {   // pyramid: base quadrata che si restringe
                                inside = Math.abs(dx) <= rAt && Math.abs(dz) <= rAt;
                            }
                            if (inside) out.push({ x: x, y: y, z: z });
                        }
                    }
                }
                return out;
            }

            // Quanti interi z in [0,S) soddisfano (z-cz)^2 <= R, con cz = (S-1)/2.
            // Chiuso, ma ESATTO: sqrt da' il candidato e poi si corregge testando il
            // predicato VERO su di esso e sul vicino. Fidarsi della sqrt e' proprio il
            // genere di errore da un voxel che il test di simmetria caccia.
            function primSpanSq(S, R) {
                if (!(R >= 0)) return 0;
                const cz = (S - 1) / 2;
                let k = Math.floor(cz + Math.sqrt(R));
                if (k > S - 1) k = S - 1;
                while (k >= 0 && (k - cz) * (k - cz) > R) k--;
                while (k + 1 <= S - 1 && (k + 1 - cz) * (k + 1 - cz) <= R) k++;
                if (k < 0) return 0;
                return Math.max(0, 2 * k - S + 2);   // simmetrico intorno a cz
            }

            // Come sopra sul predicato |z-cz| <= q: la piramide confronta i valori
            // assoluti, non i quadrati, e in virgola mobile non e' la stessa cosa.
            function primSpanAbs(S, q) {
                if (!(q >= 0)) return 0;
                const cz = (S - 1) / 2;
                let k = Math.floor(cz + q);
                if (k > S - 1) k = S - 1;
                while (k >= 0 && Math.abs(k - cz) > q) k--;
                while (k + 1 <= S - 1 && Math.abs(k + 1 - cz) <= q) k++;
                if (k < 0) return 0;
                return Math.max(0, 2 * k - S + 2);
            }

            // CONTA senza costruire: vedi la nota nelle Interfaces. Le condizioni sono
            // le STESSE di primitiveCells, riscritte per riga invece che per cella; il
            // test [8] pretende che i due numeri coincidano, altrimenti la forma chiusa
            // e' un secondo modello della geometria libero di divergere.
            function primitiveVoxelCount(id, size, height) {
                const shape = primitiveShape(id);
                if (!shape || !primIntOk(size) || !primIntOk(height)) return 0;
                const S = Math.floor(Number(size));
                const H = Math.floor(Number(height));
                if (id === 'cube') return S * S * H;
                const cx = (S - 1) / 2, cy = (H - 1) / 2;
                const r = S / 2, ry = H / 2;
                let n = 0;
                for (let y = 0; y < H; y++) {
                    const t = (y + 0.5) / H;
                    const rAt = Math.max(PRIM_APEX_MIN, r * (1 - t));
                    const dy = y - cy;
                    if (id === 'pyramid') {
                        const w = primSpanAbs(S, rAt);
                        n += w * w;
                        continue;
                    }
                    for (let x = 0; x < S; x++) {
                        const dx = x - cx;
                        if (id === 'cylinder') {
                            n += primSpanSq(S, r * r - dx * dx);
                        } else if (id === 'cone') {
                            n += primSpanSq(S, rAt * rAt - dx * dx);
                        } else {   // sphere
                            const rest = 1 - (dx * dx) / (r * r) - (dy * dy) / (ry * ry);
                            n += primSpanSq(S, rest * r * r);
                        }
                    }
                }
                return n;
            }

            // Prima griglia standard che contiene la forma. Non RIMPICCIOLISCE mai la
            // griglia corrente: se la forma ci sta gia', l'oggetto nuovo eredita quella
            // dell'utente invece di scendere al minimo che basta.
            function primitiveGridFor(size, height, currentGrid) {
                const need = Math.max(1, Math.round(Number(size) || 0), Math.round(Number(height) || 0));
                const cur = Math.round(Number(currentGrid) || 0);
                if (cur > 0 && cur >= need) return cur;
                for (const g of PRIMITIVE_GRIDS) if (g >= need) return g;
                return PRIMITIVE_GRIDS[PRIMITIVE_GRIDS.length - 1];
            }
```

Il marcatore `// ===== UI: menu Shift+A e dialogo =====` **non va scritto adesso**: lo aggiunge il Task 4. Finche' non c'e', il test prende tutto il file (`pureEnd < 0` → `pure = src`), che a questo punto e' solo matematica. E' voluto: cosi' il Task 3 sta in piedi da solo.

- [ ] **Step 4: Registrare il modulo nel manifest**

In `ui/src/manifest.json`, inserire `"lib/35-primitives.js"` **dopo** `"lib/34-collapsible.js"` e **prima** di `"lib/18-bootstrap-tail.js"`:

```json
  "lib/33-timeline.js",
  "lib/34-collapsible.js",
  "lib/35-primitives.js",
  "lib/18-bootstrap-tail.js"
]
```

`18-bootstrap-tail.js` e' **ultimo per contratto, non per numero**: e' lui che chiama `buildModel()` e `animate()`. Metterci dopo qualcosa lo trasformerebbe in un modulo di mezzo.

- [ ] **Step 5: Eseguire il test e verificare che PASSA**

```bash
node tests/test_primitives.mjs
node ui/build.mjs && bash tests/run_all.sh
```

Expected: `test_primitives.mjs` esce 0, `0 FAIL`. La suite intera resta verde: questo task **non** tocca codice esistente oltre al manifest, quindi qualunque rosso altrove non viene da qui.

Se una forma fallisce l'asserzione `[4]` "occupa esattamente l'altezza chiesta", il colpevole e' quasi sempre `PRIM_APEX_MIN`: senza il minimo, cono e piramide si spengono prima della cima.

- [ ] **Step 6: Registrare il test in run_all.sh e committare**

In `tests/run_all.sh`, dopo il blocco `run "Chiavi i18n complete" ...` **no** — va **prima** di quel blocco, subito dopo `run "Voxelizzazione GLB (Node)" ...` (riga 171), così i test i18n restano in fondo come oggi:

```bash
# 4d-ter. Primitive voxel (Shift+A). Le trappole sono tre e tutte gia' viste in
#         questo progetto: una forma che produce ZERO voxel (a 'box' con i float
#         e' successo davvero), l'errore di mezzo voxel che rende sbilenca una
#         sfera di diametro pari, e il guscio esterno mangiato di un voxel da un
#         test sul raggio troppo severo. Il test controlla anche che la forma piu'
#         costosa venga RIFIUTATA a monte invece di essere troncata.
run "Primitive voxel (Node)" node tests/test_primitives.mjs
```

```bash
git add ui/src/lib/35-primitives.js ui/src/manifest.json tests/test_primitives.mjs tests/run_all.sh ui/index.html
git commit -m "feat(primitive): forme pure cubo/piramide/cilindro/sfera/cono"
```

---

## Task 4: Primitive — menu Shift+A, dialogo e creazione

**Files:**
- Modify: `ui/src/lib/35-primitives.js` (append, dopo il marcatore UI)
- Modify: `ui/src/index.template.html` (markup dell'overlay)
- Modify: `ui/locales/{it,en,de,es,fr,pt}.json` (**6** file, non 8)
- Modify: `ui/src/lib/18-bootstrap-tail.js` (una riga di init)

**Interfaces:**
- Consumes: `PRIMITIVE_SHAPES`, `primitiveShape`, `primitiveCells`, `primitiveGridFor`, `primitiveVoxelCount` (Task 3); `voxelBudgetFor` (Task 2); e dal codice esistente: `createObject(data, opts)` e `selectActiveObjectAndRefresh(id)` (`04-objects.js:12`, `:486`), `activeColorHex` (`09-editing-engine.js:6`), `isTypingTarget(e)` (`01-scene-setup.js:265`), `pushHistory()` (`13-history.js`), `t(key)` (`23-i18n.js`), `buildModel()`, `invalidateIncremental()`.
- Produces: `initPrimitives()` — aggancia la scorciatoia; idempotente. Chiamata da `18-bootstrap-tail.js`.

- [ ] **Step 1: Aggiungere il markup dell'overlay**

In `ui/src/index.template.html`, **subito dopo** il blocco `<div id="importOverlay" ...>` e il suo `</div>` di chiusura (riga 3099 e seguenti), inserire:

```html
    <!-- Primitive (Shift+A). Due schermate nello stesso overlay: prima la scelta
         della forma, poi le misure. Stile inline come importOverlay: in questo
         progetto non esiste una classe .modal-overlay condivisa, e inventarla qui
         vorrebbe dire riscrivere anche gli overlay esistenti. -->
    <div id="primOverlay" style="display:none; position:fixed; inset:0; z-index:95; align-items:center; justify-content:center; background:var(--overlay-scrim);">
      <div class="glass" style="min-width:320px; max-width:420px; padding:20px; border-radius:var(--radius-md); display:flex; flex-direction:column; gap:14px;">
        <div id="primStepShape">
          <div class="section-title" data-i18n="prim.title">Aggiungi primitiva</div>
          <div id="primShapeList" style="display:flex; flex-direction:column; gap:6px; margin-top:10px;"></div>
        </div>
        <div id="primStepSize" style="display:none;">
          <div class="section-title"><span id="primChosenName"></span></div>
          <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px;">
            <span data-i18n="prim.size">Dimensione</span>
            <input type="number" id="primSize" min="1" max="512" step="1" style="width:90px;">
          </label>
          <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px;">
            <span data-i18n="prim.height">Altezza</span>
            <input type="number" id="primHeight" min="1" max="512" step="1" style="width:90px;">
          </label>
          <label style="display:flex; align-items:center; gap:8px; margin-top:8px;">
            <input type="checkbox" id="primKeepRatio" checked>
            <span data-i18n="prim.keepRatio">Mantieni proporzione</span>
          </label>
          <div id="primInfo" style="font-size:12px; color:var(--text-secondary); margin-top:10px;"></div>
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
            <button id="primCancel" class="btn" data-i18n="prim.cancel">Annulla</button>
            <button id="primCreate" class="btn btn-primary" data-i18n="prim.create">Crea</button>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Aggiungere le chiavi i18n in tutti e 6 i file**

`ui/locales/` ha **6 dizionari** (`de`, `en`, `es`, `fr`, `it`, `pt`); `index.json` e' l'elenco delle lingue, **non** un dizionario, e va lasciato stare. Il controllo in `run_all.sh:203` pretende le stesse chiavi ovunque e **rifiuta i valori vuoti**, quindi vanno tradotte tutte e 6, non lasciate in inglese.

Chiavi da aggiungere (13 per file):

| chiave | it | en |
|---|---|---|
| `prim.title` | Aggiungi primitiva | Add primitive |
| `prim.cube` | Cubo | Cube |
| `prim.pyramid` | Piramide | Pyramid |
| `prim.cylinder` | Cilindro | Cylinder |
| `prim.sphere` | Sfera | Sphere |
| `prim.cone` | Cono | Cone |
| `prim.size` | Dimensione | Size |
| `prim.height` | Altezza | Height |
| `prim.keepRatio` | Mantieni proporzione | Keep ratio |
| `prim.create` | Crea | Create |
| `prim.cancel` | Annulla | Cancel |
| `prim.info` | {n} voxel, griglia {g} | {n} voxels, grid {g} |
| `prim.tooBig` | Troppi voxel ({n}): riduci la dimensione | Too many voxels ({n}): reduce the size |

Le altre quattro lingue:

- **de**: `Primitiv hinzufügen`, `Würfel`, `Pyramide`, `Zylinder`, `Kugel`, `Kegel`, `Größe`, `Höhe`, `Seitenverhältnis beibehalten`, `Erstellen`, `Abbrechen`, `{n} Voxel, Raster {g}`, `Zu viele Voxel ({n}): Größe verringern`
- **es**: `Añadir primitiva`, `Cubo`, `Pirámide`, `Cilindro`, `Esfera`, `Cono`, `Tamaño`, `Altura`, `Mantener proporción`, `Crear`, `Cancelar`, `{n} vóxeles, cuadrícula {g}`, `Demasiados vóxeles ({n}): reduce el tamaño`
- **fr**: `Ajouter une primitive`, `Cube`, `Pyramide`, `Cylindre`, `Sphère`, `Cône`, `Taille`, `Hauteur`, `Conserver les proportions`, `Créer`, `Annuler`, `{n} voxels, grille {g}`, `Trop de voxels ({n}) : réduisez la taille`
- **pt**: `Adicionar primitiva`, `Cubo`, `Pirâmide`, `Cilindro`, `Esfera`, `Cone`, `Tamanho`, `Altura`, `Manter proporção`, `Criar`, `Cancelar`, `{n} voxels, grade {g}`, `Voxels em excesso ({n}): reduza o tamanho`

I segnaposto `{n}` e `{g}` devono comparire **in tutte** le lingue: sono la terza guardia i18n del progetto (coerenza dei segnaposto), e una lingua che ne perde uno mostra un buco al posto del numero.

- [ ] **Step 3: Scrivere l'UI**

In coda a `ui/src/lib/35-primitives.js`, dopo la parte pura, aggiungere il marcatore **esatto** che il test usa come confine (`tests/test_primitives.mjs` taglia lì) e il codice:

```js
            // ===== UI: menu Shift+A e dialogo =====
            // Da qui in giu' si tocca il DOM: il test estrae SOLO la parte sopra questo
            // marcatore. Se il marcatore cambia testo, il test si porta dietro il DOM e
            // fallisce con "document is not defined" — e' voluto che sia rumoroso.
            let primShapeId = null;
            let primKeepRatioPref = true;

            function primEl(id) { return document.getElementById(id); }

            function primClose() {
                const ov = primEl('primOverlay');
                if (ov) ov.style.display = 'none';
                primShapeId = null;
            }

            function primOpen() {
                const ov = primEl('primOverlay');
                if (!ov) return;
                primShapeId = null;
                primEl('primStepShape').style.display = '';
                primEl('primStepSize').style.display = 'none';
                const list = primEl('primShapeList');
                list.innerHTML = '';
                PRIMITIVE_SHAPES.forEach((s, i) => {
                    const b = document.createElement('button');
                    b.className = 'btn';
                    b.textContent = t(s.i18nKey);
                    b.style.textAlign = 'left';
                    b.addEventListener('click', () => primPickShape(s.id));
                    list.appendChild(b);
                    if (i === 0) setTimeout(() => b.focus(), 0);
                });
                ov.style.display = 'flex';
            }

            function primPickShape(id) {
                const s = primitiveShape(id);
                if (!s) return;
                primShapeId = id;
                primEl('primStepShape').style.display = 'none';
                primEl('primStepSize').style.display = '';
                primEl('primChosenName').textContent = t(s.i18nKey);
                const sizeEl = primEl('primSize'), hEl = primEl('primHeight');
                sizeEl.value = String(s.defaultSize);
                hEl.value = String(Math.max(1, Math.round(s.defaultSize * s.ratio)));
                // La sfera non ha un'altezza indipendente: un'altezza diversa dal
                // diametro non e' una sfera, e' un ellissoide (fuori scopo).
                const keep = primEl('primKeepRatio');
                keep.checked = s.fixedRatio ? true : primKeepRatioPref;
                keep.disabled = !!s.fixedRatio;
                hEl.disabled = !!s.fixedRatio;
                primRefreshInfo();
                // Il campo principale parte a fuoco E selezionato: chi sa gia' la misura
                // digita e preme Invio senza toccare il mouse.
                setTimeout(() => { sizeEl.focus(); sizeEl.select(); }, 0);
            }

            // Misure correnti, gia' pulite: mai NaN, mai sotto 1, mai sopra 512.
            function primReadDims() {
                const s = primitiveShape(primShapeId);
                let size = Math.round(Number(primEl('primSize').value));
                if (!Number.isFinite(size)) size = 1;
                size = Math.min(512, Math.max(1, size));
                let h;
                if (s && s.fixedRatio) {
                    h = size;
                } else if (primEl('primKeepRatio').checked) {
                    h = Math.max(1, Math.round(size * (s ? s.ratio : 1)));
                } else {
                    h = Math.round(Number(primEl('primHeight').value));
                    if (!Number.isFinite(h)) h = 1;
                }
                h = Math.min(512, Math.max(1, h));
                return { size: size, height: h };
            }

            function primRefreshInfo() {
                if (!primShapeId) return;
                const d = primReadDims();
                if (primEl('primKeepRatio').checked || primitiveShape(primShapeId).fixedRatio) {
                    primEl('primHeight').value = String(d.height);
                }
                const g = primitiveGridFor(d.size, d.height, primCurrentGrid());
                const n = primitiveVoxelCount(primShapeId, d.size, d.height);
                const budget = voxelBudgetFor([g, g, g]);
                const info = primEl('primInfo'), btn = primEl('primCreate');
                if (n > budget) {
                    // Rifiutare, non troncare: una forma tagliata a meta' e' peggio di un
                    // messaggio chiaro. Il tetto e' quello di CLAUDE.md, non un numero nuovo.
                    // t(key, vars) interpola da solo i {segnaposto} (23-i18n.js:49): niente
                    // .replace() a mano, che salterebbe la lingua di ripiego.
                    info.textContent = t('prim.tooBig', { n: n });
                    btn.disabled = true;
                } else {
                    info.textContent = t('prim.info', { n: n, g: g });
                    btn.disabled = false;
                }
            }

            function primCurrentGrid() {
                const g = (typeof currentModelData !== 'undefined' && currentModelData.metadata
                    && currentModelData.metadata.grid_size) || null;
                return Array.isArray(g) ? Math.max(g[0], g[1], g[2]) : 16;
            }

            function primCreate() {
                if (!primShapeId) return;
                const d = primReadDims();
                const g = primitiveGridFor(d.size, d.height, primCurrentGrid());
                // CONTARE PRIMA, costruire dopo: invertire i due passaggi rimette
                // l'allocazione da 134 milioni di celle proprio davanti al controllo
                // che deve impedirla. Il bottone e' gia' disabilitato in questo caso,
                // ma Invio e un doppio clic arrivano lo stesso.
                const n = primitiveVoxelCount(primShapeId, d.size, d.height);
                if (!n || n > voxelBudgetFor([g, g, g])) return;
                const cells = primitiveCells(primShapeId, d.size, d.height);
                if (!cells.length) return;
                pushHistory();
                // Centrata su XZ e appoggiata a y=0, come gli asset del pack
                // (normalize_asset): una primitiva che nasce in un angolo va spostata
                // a mano ogni volta.
                const ox = Math.floor((g - d.size) / 2), oz = Math.floor((g - d.size) / 2);
                const color = (typeof activeColorHex === 'string') ? activeColorHex : '#CCCCCC';
                const voxels = cells.map(c => ({ x: c.x + ox, y: c.y, z: c.z + oz, color: color }));
                const obj = createObject({
                    metadata: { name: t(primitiveShape(primShapeId).i18nKey), grid_size: [g, g, g] },
                    voxels: voxels
                });
                primClose();
                // setActiveObject (dentro selectActiveObjectAndRefresh) invalida gia' lo
                // stato incrementale e fa il buildModel: CLAUDE.md lo impone a chi
                // sostituisce currentModelData, e passando di qui e' gratis.
                selectActiveObjectAndRefresh(obj.id);
            }

            function initPrimitives() {
                const ov = primEl('primOverlay');
                if (!ov || ov.dataset.primInit === '1') return;   // idempotente
                ov.dataset.primInit = '1';
                primEl('primCancel').addEventListener('click', primClose);
                primEl('primCreate').addEventListener('click', primCreate);
                primEl('primSize').addEventListener('input', primRefreshInfo);
                primEl('primHeight').addEventListener('input', primRefreshInfo);
                primEl('primKeepRatio').addEventListener('change', () => {
                    const s = primitiveShape(primShapeId);
                    if (s && !s.fixedRatio) primKeepRatioPref = primEl('primKeepRatio').checked;
                    primRefreshInfo();
                });
                // Clic sullo sfondo = annulla, come importOverlay.
                ov.addEventListener('click', e => { if (e.target === ov) primClose(); });
                ov.addEventListener('keydown', e => {
                    if (e.key === 'Escape') { e.preventDefault(); primClose(); }
                    else if (e.key === 'Enter' && primShapeId && !primEl('primCreate').disabled) {
                        e.preventDefault(); primCreate();
                    }
                });
                window.addEventListener('keydown', e => {
                    // Shift+A e' libero: l'unico shiftKey a tastiera nel progetto e'
                    // Ctrl+Shift+Z in 13-history.js. Ctrl/Alt esclusi per non rubare
                    // Ctrl+Shift+A, che dal Task 5 e' del rig.
                    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
                    if (e.key !== 'A' && e.key !== 'a') return;
                    if (isTypingTarget(e)) return;
                    if (ov.style.display !== 'none') return;   // gia' aperto
                    e.preventDefault();
                    primOpen();
                });
            }
```

- [ ] **Step 4: Chiamare `initPrimitives()` al bootstrap e dichiarare l'overlay alla timeline**

In `ui/src/lib/18-bootstrap-tail.js`, **subito dopo** la riga `if (typeof initCollapsibleSections === 'function') initCollapsibleSections(document);` (`:118`) e **prima** di `animate();`:

```js
            if (typeof initPrimitives === 'function') initPrimitives();
```

La guardia `typeof` non e' cerimonia: e' lo stile di quel file, e tiene in piedi il bootstrap se il modulo sparisce dal manifest.

Poi in `ui/src/lib/33-timeline.js`, dentro `tlModalOpen()` (`:622`), aggiungere `'primOverlay'` all'elenco:

```js
                const ids = ['settingsOverlay', 'helpOverlay', 'importOverlay',
                    'autosaveHistoryOverlay', 'loaderOverlay', 'primOverlay'];
```

Senza questa riga, con il dialogo aperto e la timeline visibile lo Spazio farebbe partire il playback mentre l'utente sta digitando una misura. Il controllo si basa sul `display === 'flex'`, che e' esattamente come `primOpen()` mostra l'overlay.

- [ ] **Step 5: Verificare**

```bash
node ui/build.mjs && bash tests/run_all.sh
```

Expected: tutto verde. In particolare `Chiavi i18n complete` deve stampare `6 lingue, 661 chiavi ciascuna` (648 + 13); se dice 5 lingue o segnala chiavi mancanti, un file e' rimasto indietro. `Bootstrap del bundle (DOM finto)` e' l'altro guardiano: se `initPrimitives` tocca un id che nel template non esiste, muore lì e non a runtime.

Prova manuale: Shift+A su ogni forma; Invio subito dopo l'apertura; Esc; una dimensione oltre 512; il clic sullo sfondo.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/35-primitives.js ui/src/index.template.html ui/src/lib/18-bootstrap-tail.js ui/locales/*.json ui/index.html
git commit -m "feat(primitive): menu Shift+A con dialogo dimensione/altezza"
```

---

## Task 5: Ctrl+A seleziona tutti i keyframe

Tre file da toccare **insieme**, perche' oggi Ctrl+A e' rivendicato da due punti e la timeline lo scarta a priori (`33-timeline.js:1293`).

**Files:**
- Modify: `ui/src/lib/33-timeline.js` (`:43` area-flag, `:622` no, `:1279-1293` scorciatoie, nuovo `tlSelectAllKeys`)
- Modify: `ui/src/lib/15-rig.js:3410-3421` (Ctrl+A → Ctrl+Shift+A, toast su `t()`)
- Modify: `ui/src/lib/01-scene-setup.js:312` (escludere Shift)
- Modify: `ui/locales/{it,en,de,es,fr,pt}.json`
- Test: `tests/test_timeline_select_all.mjs` (creare)
- Modify: `tests/run_all.sh`

**Interfaces:**
- Produces: `tlSelectAllKeys()` → `boolean` (`true` se ha toccato la selezione, `false` se non c'era nulla da selezionare); `tlAreaActive()` → `boolean`.
- Consumes: `tlActiveAnim()`, `tlKeyTimesByBone(anim)`, `tlIsSelectedKey(bone, t)`, `tlSelected`, `tlRedraw()`, `tlUpdateToolbar()`, `tlChanMenuOpen()`, `tlCloseChanMenu()` (tutte in `33-timeline.js`).

- [ ] **Step 1: Scrivere il test che fallisce**

Crea `tests/test_timeline_select_all.mjs`:

```js
/*
 * CTRL+A NELLA TIMELINE = seleziona tutti i keyframe.
 *
 * Tre cose si rompono facilmente, e il test le tiene ferme tutte e tre:
 *  1. Ctrl+A era scartato a monte (`if (ev.ctrlKey ...) return`, 33-timeline.js),
 *     quindi non arrivava mai: il ramo nuovo deve stare PRIMA di quel filtro.
 *  2. Ctrl+A e' rivendicato da altri due punti (gizmo globale in 01-scene-setup.js,
 *     rig in 15-rig.js). Fuori dall'area timeline l'evento NON va consumato,
 *     altrimenti si spegne il gizmo; dentro, va consumato del tutto.
 *  3. Ctrl+Shift+A e' del rig: la timeline non deve rubarlo.
 *
 * Le funzioni pure sulla selezione si estraggono dai sorgenti; il resto e' un
 * modello del comportamento delle scorciatoie, verificato contro le stesse
 * condizioni scritte nel sorgente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const tlSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/33-timeline.js'), 'utf8');
const rigSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/15-rig.js'), 'utf8');
const sceneSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/01-scene-setup.js'), 'utf8');

// --- 1. le funzioni di selezione, estratte dal sorgente vero ---------------
const F1 = tlSrc.indexOf('function tlKeyTimesByBone(');
const F2 = tlSrc.indexOf('function tlSelectAllKeys(');
if (F1 < 0 || F2 < 0) {
    console.log('FAIL: tlKeyTimesByBone o tlSelectAllKeys non trovate in 33-timeline.js');
    process.exit(1);
}
const endOf = (src, from) => {
    // Fine della funzione: prima riga che chiude a rientro 12 (stile del progetto).
    const close = src.indexOf('\n            }', from);
    return close < 0 ? src.length : close + '\n            }'.length;
};
const harness = `
    let tlSelected = [];
    let redraws = 0, toolbarUpdates = 0;
    function tlRedraw() { redraws++; }
    function tlUpdateToolbar() { toolbarUpdates++; }
    function tlChanMenuOpen() { return chanOpen; }
    function tlCloseChanMenu() { chanOpen = false; closedChanMenu++; }
    let chanOpen = false, closedChanMenu = 0;
    let ACTIVE_ANIM = null;
    function tlActiveAnim() { return ACTIVE_ANIM; }
    function tlIsSelectedKey(bone, t) {
        return tlSelected.some(s => s.bone === bone && Math.abs(s.t - t) < 1e-6);
    }
`;
const api = new Function(harness
    + tlSrc.slice(F1, endOf(tlSrc, F1))
    + tlSrc.slice(F2, endOf(tlSrc, F2))
    + `
    return {
        selectAll: tlSelectAllKeys,
        setAnim: a => { ACTIVE_ANIM = a; },
        setChanOpen: v => { chanOpen = v; },
        sel: () => tlSelected,
        stats: () => ({ redraws, toolbarUpdates, closedChanMenu })
    };`)();

// Animazione con 3 ossa e conteggi DIVERSI: un bug che seleziona solo la prima
// traccia, o solo la prima chiave di ognuna, passerebbe con conteggi uguali.
const ANIM = { name: 'test', tracks: [
    { bone: 'hips',        keys: [{ t: 0 }, { t: 0.5 }, { t: 1 }] },
    { bone: 'upperArm_R',  keys: [{ t: 0 }, { t: 0.25 }] },
    { bone: 'upperArm_L',  keys: [{ t: 0.75 }] }
] };
const TOTAL = 6;
```

Le asserzioni, nello stesso file:

```js
console.log('[1] seleziona TUTTE le chiavi di TUTTE le tracce');
api.setAnim(ANIM);
ok(api.selectAll() === true, 'la prima chiamata riporta true');
ok(api.sel().length === TOTAL, `${TOTAL} chiavi selezionate (trovate ${api.sel().length})`);
ok(api.sel().filter(s => s.bone === 'hips').length === 3, 'hips: 3');
ok(api.sel().filter(s => s.bone === 'upperArm_R').length === 2, 'upperArm_R: 2');
ok(api.sel().filter(s => s.bone === 'upperArm_L').length === 1, 'upperArm_L: 1');
ok(api.sel().every(s => typeof s.bone === 'string' && typeof s.t === 'number'),
   'la forma e\' {bone, t}: Canc e il trascinamento multiplo la usano cosi\'');
ok(api.stats().redraws > 0 && api.stats().toolbarUpdates > 0,
   'ridisegna e riabilita il pulsante Elimina');

console.log('[2] ripremuto svuota; da selezione parziale seleziona tutto');
ok(api.selectAll() === true && api.sel().length === 0, 'tutto selezionato -> svuota');
api.selectAll();
api.sel().pop();                      // selezione parziale: 5 su 6
ok(api.selectAll() === true && api.sel().length === TOTAL,
   'selezione parziale -> seleziona tutto, non svuota');

console.log('[3] preset (sola lettura): nessuna chiave da selezionare');
// tlActiveAnim() restituisce null per una preset, e tlKeyTimesByBone(null) da' {}:
// non esistono rombi selezionabili. Il no-op e' il comportamento ONESTO.
api.setAnim(null);
const before = api.sel().length;
ok(api.selectAll() === false, 'su una preset riporta false (nessuna operazione)');
ok(api.sel().length === before, 'e non tocca la selezione');

console.log('[4] chiude prima il menu dei canali, che ha la priorita\' sui tasti');
api.setAnim(ANIM);
api.setChanOpen(true);
const c0 = api.stats().closedChanMenu;
api.selectAll();
ok(api.stats().closedChanMenu === c0 + 1, 'il menu dei canali viene chiuso');

console.log('[5] il ramo nuovo sta PRIMA del filtro che scartava Ctrl');
{
    const kd = tlSrc.indexOf("window.addEventListener('keydown'");
    const block = tlSrc.slice(kd, kd + 3000);
    const iSelectAll = block.indexOf('tlSelectAllKeys');
    const iCtrlFilter = block.indexOf('if (ev.ctrlKey || ev.metaKey || ev.altKey) return;');
    ok(iSelectAll > 0, 'la scorciatoia chiama tlSelectAllKeys');
    ok(iCtrlFilter > 0 && iSelectAll < iCtrlFilter,
       'il ramo Ctrl+A precede il filtro che scarta ctrlKey (altrimenti e\' morto)');
    ok(/!ev\.shiftKey/.test(block.slice(iSelectAll - 400, iSelectAll)),
       'il ramo esclude shiftKey: Ctrl+Shift+A resta del rig');
    ok(/stopImmediatePropagation/.test(block.slice(iSelectAll - 400, iSelectAll + 400)),
       'consuma l\'evento, cosi\' il gizmo globale non scatta anche lui');
}

console.log('[6] l\'area timeline e\' un flag, non hit-testing');
ok(/function tlAreaActive\(/.test(tlSrc), 'tlAreaActive esiste');
ok(/pointerenter|pointerover/.test(tlSrc) && /pointerleave/.test(tlSrc),
   'il flag si aggiorna col puntatore');
ok(/focusin/.test(tlSrc), 'e col focus: Ctrl+A funziona subito dopo aver cliccato una chiave');

console.log('[7] il rig e\' passato a Ctrl+Shift+A, senza italiano hardcoded');
{
    const i = rigSrc.indexOf('tlSetKeyAllBones(true)');
    ok(i > 0, 'il ramo del rig esiste ancora');
    const ctx = rigSrc.slice(Math.max(0, i - 700), i);
    ok(/ev\.shiftKey/.test(ctx), 'il ramo del rig richiede shiftKey');
    ok(!/Tutte le ossa selezionate per Keyframe/.test(rigSrc),
       'il toast italiano hardcoded e\' sparito');
    ok(/t\(\s*'rig\.allBonesKeyed'\s*\)/.test(rigSrc), 'il toast passa da t()');
}

console.log('[8] il gizmo globale non risponde piu\' a Ctrl+Shift+A');
{
    const i = sceneSrc.indexOf("e.key.toLowerCase() === 'a'");
    ok(i > 0, 'il ramo del gizmo globale esiste');
    const line = sceneSrc.slice(i - 200, i + 60);
    ok(/!e\.shiftKey/.test(line), 'esclude shiftKey (altrimenti sgancia il gizmo di nascosto)');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Eseguire il test e verificare che FALLISCE**

Run: `node tests/test_timeline_select_all.mjs`
Expected: `FAIL: tlKeyTimesByBone o tlSelectAllKeys non trovate` ed exit 1 — `tlSelectAllKeys` non esiste ancora.

- [ ] **Step 3: Implementare in 33-timeline.js**

**(a)** Accanto agli altri flag di stato, dopo `let tlRowsBuilt = '';` (`:49`):

```js
            let tlAreaHover = false;        // puntatore sopra il dock
            let tlAreaFocus = false;        // focus dentro il dock
```

**(b)** Dopo `tlIsSelectedKey` (`:389-391`), aggiungere:

```js
            // L'area e' "attiva" col puntatore sopra il dock OPPURE col focus dentro:
            // dopo aver cliccato una chiave il mouse spesso si sposta, e pretendere che
            // resti fermo renderebbe la scorciatoia inaffidabile. Un solo booleano per
            // ciascuna condizione, nessun hit-testing.
            function tlAreaActive() {
                return tlVisible && (tlAreaHover || tlAreaFocus);
            }

            // Ctrl+A: seleziona tutti i keyframe dell'animazione attiva.
            // Riporta false se non c'era nulla da fare (nessuna clip modificabile, o
            // clip senza chiavi), cosi' il chiamante sa se ha senso consumare l'evento.
            //
            // Toggle deliberato: ripremendo con tutto selezionato la selezione si svuota.
            // Blender separa A (seleziona) da Alt+A (deseleziona), ma qui Ctrl+A e' la
            // SOLA scorciatoia di selezione, e senza il toggle non ci sarebbe modo di
            // deselezionare da tastiera.
            function tlSelectAllKeys() {
                // Il menu dei canali si prende i tasti quando e' aperto: va chiuso prima,
                // altrimenti resta a schermo sopra una selezione che e' cambiata sotto.
                if (tlChanMenuOpen()) tlCloseChanMenu();
                const anim = tlActiveAnim();
                const times = tlKeyTimesByBone(anim);
                const all = [];
                Object.keys(times).forEach(bone => {
                    times[bone].forEach(t0 => all.push({ bone: bone, t: t0 }));
                });
                if (!all.length) return false;
                const allAlready = all.every(k => tlIsSelectedKey(k.bone, k.t))
                    && tlSelected.length === all.length;
                tlSelected = allAlready ? [] : all;
                // La selezione NON e' stato del documento: nessun pushHistory().
                tlRedraw();
                tlUpdateToolbar();
                return true;
            }
```

**(c)** Nel keydown in capture (`:1279`), inserire il ramo **prima** del filtro `if (ev.ctrlKey || ev.metaKey || ev.altKey) return;` (`:1293`) e **dopo** il controllo su `isTypingTarget`/`isRange`:

```js
                    if (isTypingTarget(ev) || isRange) return;
                    // Ctrl+A appartiene alla timeline solo quando si e' DENTRO la sua
                    // area: fuori resta del gizmo globale (01-scene-setup.js). Shift e Alt
                    // esclusi: Ctrl+Shift+A e' del rig (15-rig.js).
                    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey
                        && (ev.key === 'a' || ev.key === 'A')) {
                        if (!tlAreaActive() || tlModalOpen()) return;
                        if (tlSelectAllKeys()) {
                            ev.preventDefault();
                            ev.stopImmediatePropagation();
                        }
                        return;
                    }
                    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
```

**(d)** Dove il dock viene inizializzato — accanto ai listener di `tlResizeEl` (`:1256` circa), dentro la stessa funzione di init:

```js
                if (tlDock) {
                    tlDock.addEventListener('pointerenter', () => { tlAreaHover = true; });
                    tlDock.addEventListener('pointerleave', () => {
                        // Durante un trascinamento di chiavi il puntatore esce spesso dal
                        // dock: azzerare qui spegnerebbe la scorciatoia a meta' gesto.
                        if (!tlKeyDrag && !tlScrubbing) tlAreaHover = false;
                    });
                    tlDock.addEventListener('focusin', () => { tlAreaFocus = true; });
                    tlDock.addEventListener('focusout', () => { tlAreaFocus = false; });
                }
```

- [ ] **Step 4: Spostare il Ctrl+A del rig su Ctrl+Shift+A**

In `ui/src/lib/15-rig.js:3409-3421`, sostituire il ramo con:

```js
                // Ctrl+SHIFT+A: ambito "inserisci chiave su tutte le ossa".
                // Ctrl+A liscio e' della timeline (seleziona i keyframe): erano due
                // funzioni diverse sulla stessa scorciatoia, e vinceva chi capitava.
                if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'a' || ev.key === 'A')) {
                    ev.preventDefault();
                    if (typeof window.tlSetKeyAllBones === 'function') {
                        window.tlSetKeyAllBones(true);
                        rigToast(t('rig.allBonesKeyed'));
                    }
                }
```

e aggiungere, **una volta**, un helper accanto agli altri di quel file (subito prima di `window.poseClipboard = null;`, `:3404`):

```js
            // Toast di conferma. Prima ogni scorciatoia si ricostruiva il proprio div con
            // 200 caratteri di style inline: una copia per messaggio, e nessuna traducibile.
            function rigToast(msg) {
                const el = document.createElement('div');
                el.className = 'rig-toast';
                el.textContent = msg;
                document.body.appendChild(el);
                setTimeout(() => {
                    el.style.opacity = '0';
                    setTimeout(() => el.remove(), 300);
                }, 1500);
            }
```

Il CSS in `ui/src/index.template.html`, accanto alle altre regole (dopo `.rp-section > summary:hover`, `:340`):

```css
        .rig-toast {
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            background: var(--accent-primary); color: #fff; padding: 8px 16px;
            border-radius: var(--radius-md); z-index: 9999; pointer-events: none;
            transition: opacity .3s; font-size: 12px;
        }
```

Nota: lo style inline vecchio usava `var(--primary)`, che **non esiste** fra le custom property del progetto (sono `--accent-primary`, `--glass-bg`, ...), quindi lo sfondo del toast era trasparente. La classe usa il nome giusto.

C'e' un secondo toast identico per "Posa Copiata!" a `15-rig.js:3436-3439` (Ctrl+C): portarlo su `rigToast(t('rig.poseCopied'))` nello stesso passaggio — e' la stessa violazione i18n, a due righe di distanza, e lasciarla vorrebbe dire ripassare dallo stesso file.

- [ ] **Step 5: Escludere Shift dal gizmo globale**

In `ui/src/lib/01-scene-setup.js:312`:

```js
                // Shift escluso: Ctrl+Shift+A e' del rig. Senza questo controllo la
                // scorciatoia del rig sgancerebbe il gizmo globale di nascosto.
                if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
```

- [ ] **Step 6: Aggiungere le chiavi i18n (6 file)**

| chiave | it | en |
|---|---|---|
| `rig.allBonesKeyed` | Tutte le ossa attive per i keyframe | All bones set for keyframing |
| `rig.poseCopied` | Posa copiata | Pose copied |

- **de**: `Alle Knochen für Keyframes aktiv`, `Pose kopiert`
- **es**: `Todos los huesos activos para keyframes`, `Pose copiada`
- **fr**: `Tous les os actifs pour les keyframes`, `Pose copiée`
- **pt**: `Todos os ossos ativos para keyframes`, `Pose copiada`

- [ ] **Step 7: Verificare che il test PASSA**

```bash
node tests/test_timeline_select_all.mjs
node ui/build.mjs && bash tests/run_all.sh
```

Expected: `0 FAIL`, suite verde, `6 lingue, 663 chiavi ciascuna`.

Prova manuale, nell'ordine — e' il punto in cui le tre scorciatoie si pestano i piedi:
1. Timeline aperta, mouse sopra, Ctrl+A → tutti i rombi selezionati, Elimina attivo.
2. Ancora Ctrl+A → selezione vuota.
3. Mouse **fuori** dal dock, Ctrl+A → il gizmo globale si aggancia/sgancia come prima.
4. Ctrl+Shift+A nel Rig → toast tradotto, con lo sfondo colorato.
5. Su una clip preset, Ctrl+A → non accade nulla e il gizmo **non** scatta.

- [ ] **Step 8: Registrare il test e committare**

In `tests/run_all.sh`, subito dopo il blocco `run "Primitive voxel (Node)" ...`:

```bash
# 4d-quater. Ctrl+A nella timeline = seleziona tutti i keyframe. La scorciatoia era
#         rivendicata da TRE punti (timeline, gizmo globale, rig) e la timeline la
#         scartava a monte con `if (ev.ctrlKey ...) return`, quindi non ci arrivava
#         mai. Il test verifica sia la selezione (tutte le tracce, conteggi diversi,
#         toggle) sia lo scoping: dentro l'area consuma l'evento, fuori lo lascia
#         passare al gizmo, e Ctrl+Shift+A resta del rig.
run "Ctrl+A sui keyframe (Node)" node tests/test_timeline_select_all.mjs
```

```bash
git add ui/src/lib/33-timeline.js ui/src/lib/15-rig.js ui/src/lib/01-scene-setup.js \
        ui/src/index.template.html ui/locales/*.json \
        tests/test_timeline_select_all.mjs tests/run_all.sh ui/index.html
git commit -m "feat(timeline): Ctrl+A seleziona tutti i keyframe, rig su Ctrl+Shift+A"
```

---

## Task 6: Persistenza dei pannelli del pannello destro

Il pannello sinistro persiste gia' (Task 3 di `34-collapsible.js`). Il pannello destro usa `<details class="rp-section">` con `id` stabili (`rpOutliner`, `rpProperties`, `rpPalette`, `rpView`): basta salvare quali `id` sono chiusi in localStorage e ripristinarli al bootstrap.

**Files:**
- Modify: `ui/src/lib/34-collapsible.js` (aggiungere `initRightPanelPersist()`)
- Modify: `ui/src/lib/18-bootstrap-tail.js` (una riga di init)
- Test: `tests/test_panel_persist.mjs` (creare)
- Modify: `tests/run_all.sh`

**Interfaces:**
- Produces: `initRightPanelPersist()` — idempotente, chiamata da `18-bootstrap-tail.js`.
- Consumes: `localStorage` (chiave `voxelai.rpSections`), `document.querySelectorAll('.rp-section[id]')`.

- [ ] **Step 1: Scrivere il test che fallisce**

Crea `tests/test_panel_persist.mjs`:

```js
/*
 * PERSISTENZA DEI PANNELLI DEL PANNELLO DESTRO.
 *
 * I quattro <details class="rp-section"> (Outliner, Proprieta', Palette, Vista)
 * devono ricordare il loro stato aperto/chiuso tra una sessione e l'altra.
 * Il test estrae initRightPanelPersist() dal sorgente e la esegue contro un DOM
 * finto, verificando che lo stato venga salvato e ripristinato.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/34-collapsible.js'), 'utf8');
const MARK = 'function initRightPanelPersist(';
if (src.indexOf(MARK) < 0) {
    console.log('FAIL: initRightPanelPersist non trovata in 34-collapsible.js');
    process.exit(1);
}
const from = src.indexOf(MARK);
// Fine della funzione: prima riga che chiude a rientro 12.
const to = src.indexOf('\n            }', from) + '\n            }'.length;

// --- DOM finto ---
const store = {};
const ls = {
    getItem: k => store[k] !== undefined ? store[k] : null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
};
// Quattro <details> con id stabili, come nel template. Ogni "sessione" costruisce
// pannelli NUOVI: un riavvio e' un DOM nuovo, non gli stessi oggetti riusati.
// (Riusare gli stessi renderebbe il test contraddittorio con l'idempotenza:
// la seconda chiamata deve essere un no-op sugli STESSI nodi, ma deve ripristinare
// lo stato su nodi FRESCHI. Sono due casi diversi, e vanno tenuti separati.)
function makeDetails(id, open) {
    return {
        id, open,
        dataset: {},
        addEventListener(ev, fn) { this['_' + ev] = fn; }
    };
}
function makePanels() {
    return [
        makeDetails('rpOutliner', true),
        makeDetails('rpProperties', true),
        makeDetails('rpPalette', true),
        makeDetails('rpView', false)    // l'unico senza `open` nel template
    ];
}
let panels = makePanels();
const doc = {
    querySelectorAll: sel => sel === '.rp-section[id]' ? panels : []
};

const api = new Function('document', 'localStorage',
    src.slice(from, to) + '\nreturn { initRightPanelPersist };')(doc, ls);
```

Le asserzioni:

```js
console.log('[1] al primo avvio (nessun dato salvato) lo stato del template e\' rispettato');
api.initRightPanelPersist();
ok(panels[0].open === true,  'rpOutliner: aperto (default template)');
ok(panels[3].open === false, 'rpView: chiuso (default template)');
ok(ls.getItem('voxelai.rpSections') === null,
   'senza azioni dell\'utente non scrive nulla: il default del template resta l\'autorita\'');

console.log('[2] chiudere un pannello lo salva in localStorage');
// L'utente chiude rpOutliner: <details> aggiorna `open` e POI emette 'toggle'.
panels[0].open = false;
panels[0]._toggle();
const saved = JSON.parse(ls.getItem('voxelai.rpSections') || '[]');
ok(saved.includes('rpOutliner'), 'rpOutliner compare fra i chiusi');
ok(!saved.includes('rpView'),
   'rpView non compare: era chiuso per default, non per una scelta dell\'utente');

console.log('[3] riaprire un pannello lo rimuove dalla lista');
panels[0].open = true;
panels[0]._toggle();
ok(!JSON.parse(ls.getItem('voxelai.rpSections') || '[]').includes('rpOutliner'),
   'rpOutliner rimosso dopo la riapertura');

console.log('[4] idempotente: sugli STESSI nodi la seconda chiamata non fa nulla');
const before = panels[0]._toggle;
api.initRightPanelPersist();
ok(panels[0]._toggle === before, 'il listener non viene sostituito (niente doppie scritture)');

console.log('[5] al RIAVVIO (DOM nuovo) lo stato salvato viene ripristinato');
ls.setItem('voxelai.rpSections', JSON.stringify(['rpPalette']));
panels = makePanels();              // sessione nuova: nodi freschi, flag pulito
api.initRightPanelPersist();
ok(panels[2].open === false, 'rpPalette ripristinato CHIUSO');
ok(panels[0].open === true,  'rpOutliner resta aperto');
ok(panels[3].open === true,
   'rpView torna APERTO: non e\' nella lista dei chiusi, e la lista salvata batte il default del template');

console.log('[6] dato corrotto in localStorage: si riparte dal template, senza eccezioni');
ls.setItem('voxelai.rpSections', '{non json');
panels = makePanels();
let threw = false;
try { api.initRightPanelPersist(); } catch (e) { threw = true; }
ok(!threw, 'non solleva');
ok(panels[0].open === true && panels[3].open === false, 'stato del template intatto');

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Eseguire il test e verificare che FALLISCE**

Run: `node tests/test_panel_persist.mjs`
Expected: `FAIL: initRightPanelPersist non trovata in 34-collapsible.js` ed exit 1.

- [ ] **Step 3: Implementare in 34-collapsible.js**

In coda a `ui/src/lib/34-collapsible.js`, dopo la chiusura di `initCollapsibleSections` (`:87`):

```js
            const RP_LS_KEY = 'voxelai.rpSections';

            function initRightPanelPersist() {
                const panels = document.querySelectorAll('.rp-section[id]');
                if (!panels.length || panels[0].dataset.rpPersist === '1') return;
                // Carica la lista degli id CHIUSI salvati. Se non c'e' nulla, lo stato
                // del template e' quello giusto (tre aperti, uno chiuso): non toccare.
                let closed;
                try {
                    const raw = localStorage.getItem(RP_LS_KEY);
                    closed = raw ? new Set(JSON.parse(raw)) : null;
                } catch (e) { closed = null; }
                panels.forEach(panel => {
                    panel.dataset.rpPersist = '1';
                    if (closed !== null) panel.open = !closed.has(panel.id);
                    panel.addEventListener('toggle', () => {
                        let cur;
                        try {
                            const raw = localStorage.getItem(RP_LS_KEY);
                            cur = new Set(raw ? JSON.parse(raw) : []);
                        } catch (e) { cur = new Set(); }
                        if (panel.open) cur.delete(panel.id);
                        else cur.add(panel.id);
                        try {
                            localStorage.setItem(RP_LS_KEY, JSON.stringify([...cur]));
                        } catch (e) { /* storage non disponibile */ }
                    });
                });
            }
```

Nota: il listener e' `'toggle'`, non `'click'`: `<details>` emette `toggle` quando `open` cambia, sia da click che da codice. Usare `'click'` richiederebbe di leggere `open` in modo asincrono (il click precede il cambio di stato); `'toggle'` arriva dopo, quando `open` e' gia' aggiornato.

- [ ] **Step 4: Chiamare `initRightPanelPersist()` al bootstrap**

In `ui/src/lib/18-bootstrap-tail.js`, subito dopo la riga `if (typeof initPrimitives === 'function') initPrimitives();` (aggiunta dal Task 4):

```js
            if (typeof initRightPanelPersist === 'function') initRightPanelPersist();
```

- [ ] **Step 5: Verificare che il test PASSA**

```bash
node tests/test_panel_persist.mjs
node ui/build.mjs && bash tests/run_all.sh
```

Expected: `0 FAIL`, suite verde.

Prova manuale: chiudi "Palette Colori", ricarica la pagina — deve restare chiusa. Riaprila, ricarica — deve restare aperta.

- [ ] **Step 6: Registrare il test e committare**

In `tests/run_all.sh`, subito dopo il blocco `run "Ctrl+A sui keyframe (Node)" ...`:

```bash
# 4d-quinquies. Persistenza dei pannelli del pannello destro: i quattro <details
#         class="rp-section"> (Outliner, Proprieta', Palette, Vista) devono
#         ricordare il loro stato aperto/chiuso tra una sessione e l'altra.
run "Persistenza pannelli destro (Node)" node tests/test_panel_persist.mjs
```

```bash
git add ui/src/lib/34-collapsible.js ui/src/lib/18-bootstrap-tail.js \
        tests/test_panel_persist.mjs tests/run_all.sh ui/index.html
git commit -m "feat(ui): pannelli destro ricordano stato aperto/chiuso"
```

---

## Verifica finale

Da eseguire **dopo l'ultimo commit**, non task per task.

- [ ] **1. Il bundle non e' avanti ai sorgenti**

```bash
grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js
```

Expected: **2 e 2**. Se il bundle ha simboli che i sorgenti non hanno, **fermarsi**: `node ui/build.mjs` li cancellerebbe. E' successo davvero il 2026-08-02 e si e' portato via ~500 righe di motore di rigging. Verificato allineato in sede di design, ma va ricontrollato prima di ogni build.

- [ ] **2. Build e suite completa**

```bash
node ui/build.mjs && bash tests/run_all.sh
```

Expected: `TUTTI I CONTROLLI SUPERATI`, con:
- i **quattro** test nuovi verdi (`Primitive voxel`, `Ctrl+A sui keyframe`, `Persistenza pannelli destro`, `Gizmo: primo trascinamento`);
- `Chiavi i18n complete` → `6 lingue, 663 chiavi ciascuna` (648 + 13 primitive + 2 rig);
- i **cinque test-tripwire** del rig verdi (`test_glb_rigged_artifacts`, `test_rig_weights`, `test_channel_keys`, `test_glb_pose_export`, `test_rig_parts_legs`).

Un `ReferenceError: <simbolo> is not defined` da uno dei cinque tripwire significa che **manca codice motore nei sorgenti**, non che il test e' vecchio. Non liquidarlo come preesistente perche' fallisce anche a HEAD: anche HEAD puo' essere rotto.

- [ ] **3. Il cap sui voxel esiste ancora in esattamente due copie**

```bash
grep -rn "8000000\|MAX_VOXELS_ABSOLUTE" src/parser.py ui/src/
```

Expected: le occorrenze in `src/parser.py` (`voxel_budget_for`) e in `ui/src/utils/expand-ops.js` (`voxelBudgetFor`). **Nessuna** in `35-primitives.js`: le primitive chiamano la funzione, non ricopiano la regola. `PLUGIN_MAX_VOXELS` in `24-plugins.js` e' un'altra cosa e non conta.

- [ ] **4. Prova manuale**

Le quattro richieste, nell'ordine in cui sono state chieste:

1. **Rig**: seleziona un osso, posalo, salva la posa. Poi cambia clip / rientra nel Rig e trascina l'osso: al **primo** colpo la posa deve partire da dov'era, senza salti e senza bisogno di Ctrl+Z.
2. **Shift+A**: una forma per ciascuna delle cinque. Invio subito dopo l'apertura (deve creare col default); Esc; una dimensione oltre 512; il clic sullo sfondo. La forma nasce centrata e appoggiata a terra, del colore attivo.
3. **Ctrl+A**: col mouse sulla timeline seleziona tutti i rombi ed abilita Elimina; ripremuto svuota; col mouse **fuori** aggancia/sgancia il gizmo come prima; `Ctrl+Shift+A` nel Rig mostra il toast tradotto **con lo sfondo colorato** (prima era trasparente, `var(--primary)` non esiste).
4. **Pannelli**: chiudi "Palette Colori", ricarica → resta chiusa. Riaprila, ricarica → resta aperta.

---

## Note di copertura

Cosa questo piano **non** fa, per scelta gia' discussa:

- **Ellissoidi** o primitive con tre misure indipendenti. La sfera ha `fixedRatio`, e il campo Altezza le resta disabilitato.
- **Rendere annullabile l'aggiunta di un oggetto.** `pushHistory()` non ripristina aggiunte/eliminazioni di oggetti (`13-history.js:6-10`): dopo una primitiva, Ctrl+Z riporta voxel e oggetto attivo, ma l'oggetto vuoto resta nell'outliner. E' il comportamento gia' esistente di Nuovo/Duplica, non una regressione introdotta qui.
- **Selezione a rettangolo** dei keyframe, o Ctrl+A per selezionare ossa nella viewport 3D.
- **La semantica delle op.** Le primitive producono voxel piatti, non op compatte: la parita' Python/JS non e' toccata. L'estrazione di `voxelBudgetFor` e' un refactor a comportamento invariato, coperto dal test di parita' esistente.

Due punti in cui il piano **corregge la spec** (`docs/superpowers/specs/2026-08-03-blender-qol-design.md`), verificati sui sorgenti:

- La spec dice **8** file di lingua: sono **6** (`de`, `en`, `es`, `fr`, `it`, `pt`). `index.json` e' l'elenco delle lingue, non un dizionario, ed e' escluso dal controllo in `run_all.sh:207`.
- La spec dice che su una clip preset «la selezione avviene comunque, ma i pulsanti restano disabilitati». **Non puo' accadere**: `tlActiveAnim()` riporta `null` per una preset e `tlKeyTimesByBone(null)` riporta `{}`, quindi una preset non ha rombi selezionabili. Il comportamento onesto e' che Ctrl+A sia un no-op, ed e' quello che il test asserisce (`tlSelectAllKeys()` → `false`).

Una terza cosa emersa scrivendo il piano, non prevista dalla spec: il toast del rig usa `var(--primary)`, che **non esiste** fra le custom property del progetto (sono `--accent-primary`, `--glass-bg`, …), quindi ha sempre avuto lo sfondo trasparente. Il Task 5 riscrive comunque quelle righe per l'i18n, e la classe `.rig-toast` usa il nome giusto.
