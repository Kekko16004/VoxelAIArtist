# Materiali con texture + i18n universale — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere un pannello Materiali (texture su tutte e 6 le facce, mutuamente esclusivo col colore) nel tab *Disegna*, con round-trip completo su salvataggio/import ed export; e rendere traducibile ogni testo utente del frontend, con un test che impedisce la ricomparsa del debito.

**Architecture:** I materiali vivono in un nuovo modulo `ui/src/lib/36-materials.js`. Ogni voxel porta `color` (sempre) e `material` (opzionale, id): il colore è la tinta media della texture, quindi ogni percorso che consuma hex continua a funzionare e un id orfano degrada da solo a tinta unita. Internamente il raggruppamento passa da un **token** (`#RRGGBB` o `@m1`) così i ~15 call site che trattano il valore di `voxelMap` come stringa non cambiano forma. Il formato compatto `ops` non viene toccato: i materiali viaggiano in `metadata.material_map`, riversata sui voxel dopo l'espansione. Per l'i18n si introduce prima una guardia con baseline decrescente, poi si estraggono le stringhe.

**Tech Stack:** JavaScript ES2020 in scope condiviso (nessun import/export), Three.js r128 da CDN, Node 18+ per build e test, `bash tests/run_all.sh` come suite.

## Global Constraints

- `ui/index.html` è **generato** da `node ui/build.mjs`. Non modificarlo a mano. Prima di ogni build verificare che il bundle non sia avanti ai sorgenti: `grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js` deve dare lo stesso numero da entrambi i lati.
- I moduli in `ui/src/**` sono letti/scritti in **latin1**: niente bullet, emoji, virgolette tipografiche o trattini lunghi nel codice. Nei file `ui/locales/*.json` gli accenti sono ammessi (sono serviti come JSON, non concatenati nel bundle).
- I moduli sono frammenti di **un solo scope condiviso**: nessun `import`/`export`, nessun `"use strict"`, indentazione a **12 spazi** in cima a ogni riga.
- Nessun testo destinato all'utente è hardcoded: nel template si annota con `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`, nel JS si passa da `t('chiave')`.
- Ogni chiave nuova va aggiunta a **tutte e 6 le lingue** (`it, en, es, de, fr, pt` in `ui/locales/`, con `it` sorgente). Il test *Chiavi i18n complete* di `run_all.sh` impone parità esatta e vieta i valori vuoti.
- `it.json` è la sorgente: i suoi valori **sono** i testi italiani reali già presenti nel template. `ui/annotate-i18n.mjs` annota per valore, quindi una chiave con il testo italiano esatto viene agganciata da sola.
- Il formato compatto `ops` (`src/parser.py::expand_ops` e `ui/src/utils/expand-ops.js::expandOps`) **non si tocca** in questo lavoro. Nessuna modifica accoppiata, nessun rischio sulla parità.
- Un voxel ha **sempre** `color`; `material` è opzionale e non autoritativo (id orfano → si usa il colore).
- Le texture si ridimensionano a **max 128x128** con `THREE.NearestFilter` e `THREE.RepeatWrapping`.
- Libreria personale in `localStorage['voxelai-material-library']`, tetto **40 voci**.
- Ogni task termina con `bash tests/run_all.sh` verde e un commit.

---

## Struttura dei file

**Creati**

| File | Responsabilità |
|---|---|
| `ui/src/lib/36-materials.js` | Unico proprietario dei materiali: store del progetto, id, `tokenOf`/`decodeToken`, import texture, cache dei `MeshStandardMaterial`, selezione attiva, libreria personale, UI del pannello |
| `tests/test_materials.mjs` | Il modulo sopra + round-trip del payload + regole del greedy mesh |
| `tests/test_i18n_hardcoded.mjs` | Guardia anti-hardcode con baseline decrescente |

**Modificati**

| File | Modifica |
|---|---|
| `ui/src/manifest.json` | Inserisce `lib/36-materials.js` dopo `lib/35-primitives.js` |
| `ui/src/index.template.html` | Pannello Materiali nel tab Disegna + annotazioni i18n mancanti |
| `ui/src/lib/03-voxel-map.js` | `voxelMap` contiene token; `syncVoxelsFromMap` li decodifica |
| `ui/src/lib/05-build-model.js` | Raggruppa per token, materiale THREE da `threeMaterialFor` |
| `ui/src/lib/28-incremental.js` | Idem sul percorso rapido + firma palette + swatch con miniatura |
| `ui/src/lib/11-symmetry-tools.js` | `setActiveColor` azzera il materiale attivo |
| `ui/src/lib/14-tools-actions.js` | Le celle scritte usano il token attivo; contagocce legge il token |
| `ui/src/lib/07-save-payload.js` | Emette `metadata.materials` + `metadata.material_map` |
| `ui/src/lib/04-objects.js` | `applyMaterialMap` dopo `expandOps` |
| `ui/src/lib/02-io-files.js` | Idem sul percorso "incolla JSON" |
| `ui/src/lib/06-export-obj.js` | Greedy mesh per token, UV, `.mtl` con `map_Kd`, ZIP quando servono PNG |
| `ui/src/lib/16-export-glb.js` | Raggruppa per token, attributo `uv`, texture incorporata |
| `ui/locales/*.json` (6) | Chiavi `materials.*` e tutte quelle dello sweep |
| `tests/test_incremental.mjs` | Casi con materiali |
| `tests/run_all.sh` | Registra i due test nuovi |
| `CLAUDE.md` | La regola i18n + il formato dei materiali |

---

## Fase A — la regola i18n e la sua guardia

### Task 1: Guardia anti-hardcode + regola nel CLAUDE.md

**Files:**
- Create: `tests/test_i18n_hardcoded.mjs`
- Modify: `tests/run_all.sh`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: il file `tests/test_i18n_hardcoded.mjs` espone una costante `BASELINE = { template: N, js: M }` che i task successivi abbassano. Nessuna API JS consumata da altri task.

- [ ] **Step 1: Scrivere il test che fallisce**

Crea `tests/test_i18n_hardcoded.mjs`:

```js
#!/usr/bin/env node
// Guardia anti-hardcode i18n.
//
// Perche' una BASELINE invece di zero: al momento in cui questa guardia nasce il
// debito esiste gia' (~50 testi nel template, ~280 stringhe nei moduli). Un test
// assoluto sarebbe rosso da subito e verrebbe ignorato. Con la baseline il test e'
// verde adesso e diventa rosso se qualcuno AGGIUNGE debito: ogni passo dello sweep
// abbassa i numeri, e a zero il meccanismo si rimuove.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ABBASSARE a ogni passo dello sweep. Non alzare mai.
const BASELINE = { template: 9999, js: 9999 };

// File dove una stringa italiana NON e' testo per l'utente. Motivare ogni voce.
const JS_ALLOW = new Set([
  'lib/22-screens.js',   // CSS inline iniettato via textContent: non e' testo
]);

let failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail}`); failures.push(name); }
}

// --- strip dei commenti -------------------------------------------------
// Scorre il carattere tracciando i delimitatori di stringa. Uno strip ingenuo
// (regex su //) scambierebbe la barra dentro 'http://x' per l'inizio di un
// commento e taglierebbe via il resto della riga, nascondendo stringhe vere.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += (n === undefined ? '' : n); i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// Parole che rendono una stringa "italiano per l'utente" al di la' di ogni dubbio.
const IT_WORDS = /\b(il|lo|la|le|gli|un|una|del|della|dei|delle|per|con|sul|sulla|nel|nella|non|che|questo|questa|sono|essere|puoi|devi|verra|verranno|seleziona|scegli|salva|carica|crea|elimina|annulla|modifica|aggiungi|nessun|nessuna|errore|attenzione|impossibile)\b/i;

function scanJs() {
  const libDir = path.join(ROOT, 'ui/src/lib');
  let count = 0;
  for (const f of fs.readdirSync(libDir).sort()) {
    if (!f.endsWith('.js')) continue;
    if (JS_ALLOW.has('lib/' + f)) continue;
    const src = stripComments(fs.readFileSync(path.join(libDir, f), 'latin1'));
    const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = m[2];
      if (val.length < 4) continue;
      if (IT_WORDS.test(val)) count++;
    }
  }
  return count;
}

function scanTemplate() {
  const html = fs.readFileSync(path.join(ROOT, 'ui/src/index.template.html'), 'latin1');
  let count = 0;
  // Elementi foglia con testo: <tag ...>testo</tag> senza altri tag dentro.
  const re = /<(label|button|option|p|div|span|h1|h2|h3|td|th|a)\b([^>]*)>([^<>]*[A-Za-z]{3,}[^<>]*)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[2], text = m[3].trim();
    if (!text) continue;
    if (/data-i18n\s*=/.test(attrs)) continue;
    count++;
  }
  // title= e placeholder= senza il rispettivo data-i18n-*
  const reT = /<[a-z][^>]*\btitle\s*=\s*"[^"]{3,}"[^>]*>/gi;
  while ((m = reT.exec(html)) !== null) {
    if (!/data-i18n-title\s*=/.test(m[0])) count++;
  }
  const reP = /<[a-z][^>]*\bplaceholder\s*=\s*"[^"]{3,}"[^>]*>/gi;
  while ((m = reP.exec(html)) !== null) {
    if (!/data-i18n-placeholder\s*=/.test(m[0])) count++;
  }
  return count;
}

console.log('test_i18n_hardcoded');

const tpl = scanTemplate();
const js = scanJs();
console.log(`  (rilevati: template=${tpl} js=${js} | baseline template=${BASELINE.template} js=${BASELINE.js})`);

check('il debito nel template non sale', tpl <= BASELINE.template,
  `${tpl} > ${BASELINE.template}: estrai la stringa in una chiave i18n invece di allargare la baseline`);
check('il debito nei moduli JS non sale', js <= BASELINE.js,
  `${js} > ${BASELINE.js}: usa t('chiave') invece di una stringa italiana`);

// Lo strip dei commenti e' il punto fragile della guardia: se sbagliasse,
// il conteggio crollerebbe e il test passerebbe sempre. Lo verifichiamo.
const probe = stripComments(`const a = 'http://esempio/con la barra'; // via il commento\nconst b = 1;`);
check('lo strip non scambia // dentro una stringa per un commento',
  probe.includes('http://esempio/con la barra'), 'la stringa e\' stata troncata dallo strip');
check('lo strip toglie davvero i commenti di riga',
  !probe.includes('via il commento'), 'il commento e\' sopravvissuto');
check('lo strip toglie i commenti di blocco',
  !stripComments('a /* con la nota */ b').includes('con la nota'), 'commento di blocco sopravvissuto');

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
```

- [ ] **Step 2: Eseguirlo per leggere i numeri reali**

Run: `node tests/test_i18n_hardcoded.mjs`
Expected: PASS, e nella riga `(rilevati: ...)` compaiono i due conteggi veri.

- [ ] **Step 3: Fissare la baseline sui numeri rilevati**

Sostituisci `const BASELINE = { template: 9999, js: 9999 };` con i due numeri esatti appena stampati. Non arrotondare verso l'alto: la baseline deve essere **stretta**, altrimenti lascia spazio a nuovo debito.

- [ ] **Step 4: Verificare che la guardia abbia i denti**

Aggiungi temporaneamente in fondo a `ui/src/lib/34-collapsible.js` la riga
`const _probe = 'questo e\' un testo per la prova della guardia';`
poi esegui `node tests/test_i18n_hardcoded.mjs`.
Expected: FAIL su *il debito nei moduli JS non sale*.
Rimuovi la riga e riesegui: PASS.

- [ ] **Step 5: Registrare il test nella suite**

In `tests/run_all.sh`, accanto agli altri `node tests/...mjs`, aggiungi:

```bash
run "Guardia i18n (niente testi hardcoded)" node tests/test_i18n_hardcoded.mjs
```

(usa la stessa forma delle righe vicine: se la funzione si chiama diversamente, copia lo stile del test node piu' vicino nel file).

- [ ] **Step 6: Scrivere la regola nel CLAUDE.md**

In `CLAUDE.md`, dentro `## Conventions & gotchas`, aggiungi:

```markdown
- **Nessun testo per l'utente e' hardcoded — mai, in nessun punto del frontend.**
  Nel template si annota con `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`;
  nel JS si passa da `t('chiave')`. La regola copre anche **guide, hint, conferme,
  messaggi d'errore e testi costruiti a runtime**: nei template literal si usano i
  segnaposto `{nome}` di `t()`, non la concatenazione.
  La lingua sorgente e' `ui/locales/it.json` — i suoi valori SONO i testi italiani
  reali, ed e' da li' che `ui/annotate-i18n.mjs` annota il template per valore. Una
  stringa nuova si aggiunge prima in `it.json`, poi nelle altre 5 lingue (il test
  "Chiavi i18n complete" pretende parita' esatta).
  `t()` e' chiamabile prima di `bootI18n` e in quel caso ritorna la chiave nuda:
  non e' un bug da aggirare con un fallback italiano hardcoded.
  `tests/test_i18n_hardcoded.mjs` e' la guardia. Se fallisce, la stringa va
  estratta, non aggiunta all'allow-list.
```

- [ ] **Step 7: Eseguire tutta la suite**

Run: `bash tests/run_all.sh`
Expected: tutti verdi, incluso il test nuovo.

- [ ] **Step 8: Commit**

```bash
git add tests/test_i18n_hardcoded.mjs tests/run_all.sh CLAUDE.md
git commit -m "test(i18n): guardia anti-hardcode con baseline decrescente + regola nel contesto"
```

---

## Fase B — Materiali

### Task 2: Il modulo materiali (store, id, token)

**Files:**
- Create: `ui/src/lib/36-materials.js`
- Create: `tests/test_materials.mjs`
- Modify: `ui/src/manifest.json`
- Modify: `tests/run_all.sh`

**Interfaces:**
- Produces:
  - `materialsOfProject() -> Array<Material>`
  - `materialById(id) -> Material | null`
  - `addMaterial(def) -> Material` (assegna l'id libero, ritorna l'oggetto inserito)
  - `removeMaterial(id) -> boolean`
  - `nextMaterialId(existingIds) -> string` (`'m1'`, `'m2'`, … primo intero libero)
  - `tokenOf(v) -> string`
  - `decodeToken(tok) -> { color: string, material: string|null }`
  - `isMaterialToken(tok) -> boolean`
  - `Material` = `{ id, name, texture: {data,w,h}|null, color, roughness, metalness, emissive }`

- [ ] **Step 1: Scrivere il test che fallisce**

Crea `tests/test_materials.mjs`:

```js
#!/usr/bin/env node
// Materiali: store, id, token. Il modulo e' un frammento di scope condiviso,
// quindi lo si carica con new Function come fa test_incremental.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail || ''}`); failures.push(name); }
}

function loadMaterials() {
  const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  return new Function('currentModelData', 'localStorage', src + `
   ;return { materialsOfProject, materialById, addMaterial, removeMaterial,
             nextMaterialId, tokenOf, decodeToken, isMaterialToken,
             averageColorFromPixels, setActiveMaterial, getActiveMaterialId };`);
}

console.log('test_materials');

const fakeStore = (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
})();

const model = { metadata: {}, voxels: [] };
const api = loadMaterials()(model, fakeStore);

// --- id ---
check('il primo id e\' m1', api.nextMaterialId([]) === 'm1', api.nextMaterialId([]));
check('l\'id e\' il primo intero LIBERO, non l\'ultimo+1',
  api.nextMaterialId(['m1', 'm3']) === 'm2', api.nextMaterialId(['m1', 'm3']));

// --- store ---
const legno = api.addMaterial({ name: 'Legno', color: '#8B5A2B', roughness: 0.7 });
check('addMaterial assegna un id', legno.id === 'm1', legno.id);
check('addMaterial normalizza i campi mancanti',
  legno.metalness === 0 && legno.emissive === 0 && legno.texture === null,
  JSON.stringify(legno));
check('il materiale finisce in metadata.materials',
  model.metadata.materials.length === 1, JSON.stringify(model.metadata.materials));
check('materialById lo ritrova', api.materialById('m1').name === 'Legno');
check('materialById su id ignoto da\' null', api.materialById('m99') === null);
const pietra = api.addMaterial({ name: 'Pietra', color: '#888888' });
check('il secondo materiale prende m2', pietra.id === 'm2', pietra.id);
check('removeMaterial toglie', api.removeMaterial('m1') === true && api.materialsOfProject().length === 1);
check('removeMaterial su id ignoto da\' false', api.removeMaterial('m1') === false);

// --- token ---
check('tokenOf di un voxel senza materiale e\' il colore maiuscolo',
  api.tokenOf({ color: '#ab12cd' }) === '#AB12CD', api.tokenOf({ color: '#ab12cd' }));
check('tokenOf di un voxel con materiale e\' @id',
  api.tokenOf({ color: '#888888', material: 'm2' }) === '@m2');
check('isMaterialToken distingue', api.isMaterialToken('@m2') === true && api.isMaterialToken('#AABBCC') === false);

const dec = api.decodeToken('@m2');
check('decodeToken risolve il colore dal materiale',
  dec.material === 'm2' && dec.color === '#888888', JSON.stringify(dec));
const decOrfano = api.decodeToken('@m77');
check('un token orfano degrada a tinta unita neutra',
  decOrfano.material === null && /^#[0-9A-F]{6}$/.test(decOrfano.color), JSON.stringify(decOrfano));
const decCol = api.decodeToken('#AABBCC');
check('decodeToken di un colore non inventa materiali',
  decCol.material === null && decCol.color === '#AABBCC', JSON.stringify(decCol));
check('tokenOf e decodeToken sono inverse sui colori',
  api.tokenOf(api.decodeToken('#AABBCC')) === '#AABBCC');
check('tokenOf e decodeToken sono inverse sui materiali',
  api.tokenOf(api.decodeToken('@m2')) === '@m2');

// --- tinta media ---
// 2 pixel rossi + 2 pixel neri (RGBA) -> #800000 circa.
const px = [255,0,0,255, 255,0,0,255, 0,0,0,255, 0,0,0,255];
const avg = api.averageColorFromPixels(px);
check('la tinta media e\' la media dei canali', avg === '#800000', avg);
// I pixel TRASPARENTI non devono tirare la media verso il nero: sono assenza di
// colore, non colore nero. Una texture con bordo trasparente diventerebbe scura.
const px2 = [255,0,0,255, 0,0,0,0];
check('i pixel trasparenti sono ignorati', api.averageColorFromPixels(px2) === '#FF0000',
  api.averageColorFromPixels(px2));

// --- selezione attiva ---
api.setActiveMaterial('m2');
check('setActiveMaterial imposta', api.getActiveMaterialId() === 'm2');
api.setActiveMaterial(null);
check('setActiveMaterial(null) azzera', api.getActiveMaterialId() === null);

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
```

- [ ] **Step 2: Eseguirlo per vederlo fallire**

Run: `node tests/test_materials.mjs`
Expected: FAIL — `ENOENT` su `ui/src/lib/36-materials.js`.

- [ ] **Step 3: Scrivere il modulo**

Crea `ui/src/lib/36-materials.js` (12 spazi di indentazione, latin1, niente caratteri accentati nei commenti):

```js
            // ===== MATERIALI CON TEXTURE =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // MODELLO DEI DATI. Un voxel ha SEMPRE `color` e FACOLTATIVAMENTE `material`
            // (l'id di una voce di metadata.materials). Il colore di un voxel texturizzato
            // e' la tinta media della sua texture: cosi' ogni percorso che pretende un hex
            // (.vox, .schem, le swatch, l'OBJ senza texture) continua a funzionare senza
            // sapere che i materiali esistono, e un id ORFANO degrada da solo a tinta
            // unita. E' il "materiale neutro" richiesto, ottenuto senza un ramo dedicato.
            //
            // TOKEN. Dentro voxelMap si usa una stringa sola: '#RRGGBB' per un colore,
            // '@m1' per un materiale. Serve a tenere invariati i confronti sparsi per
            // l'editor che trattano quel valore come stringa opaca.

            const MATERIAL_LIB_KEY = 'voxelai-material-library';
            const MATERIAL_LIB_MAX = 40;
            const MATERIAL_TEXTURE_MAX = 128;
            const MATERIAL_FALLBACK_COLOR = '#CCCCCC';

            let activeMaterialId = null;

            function materialsOfProject() {
                if (!currentModelData) return [];
                if (!currentModelData.metadata) currentModelData.metadata = {};
                if (!Array.isArray(currentModelData.metadata.materials)) {
                    currentModelData.metadata.materials = [];
                }
                return currentModelData.metadata.materials;
            }

            function materialById(id) {
                if (!id) return null;
                const list = materialsOfProject();
                for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
                return null;
            }

            // Primo intero LIBERO, non ultimo+1: dopo aver cancellato m2 il prossimo
            // materiale riempie il buco invece di far crescere i numeri all'infinito.
            function nextMaterialId(existingIds) {
                const taken = new Set(existingIds || []);
                let n = 1;
                while (taken.has('m' + n)) n++;
                return 'm' + n;
            }

            function normalizeMaterial(def, id) {
                const clamp01 = (v, dflt) => {
                    const n = Number(v);
                    if (!isFinite(n)) return dflt;
                    return Math.min(1, Math.max(0, n));
                };
                return {
                    id: id,
                    name: (def && def.name) ? String(def.name) : id,
                    texture: (def && def.texture && def.texture.data) ? {
                        data: def.texture.data,
                        w: Number(def.texture.w) || 0,
                        h: Number(def.texture.h) || 0
                    } : null,
                    color: (def && typeof def.color === 'string' && def.color[0] === '#')
                        ? def.color.toUpperCase() : MATERIAL_FALLBACK_COLOR,
                    roughness: clamp01(def && def.roughness, 0.6),
                    metalness: clamp01(def && def.metalness, 0),
                    emissive: clamp01(def && def.emissive, 0)
                };
            }

            function addMaterial(def) {
                const list = materialsOfProject();
                const id = (def && def.id && !materialById(def.id))
                    ? def.id
                    : nextMaterialId(list.map(m => m.id));
                const mat = normalizeMaterial(def, id);
                list.push(mat);
                return mat;
            }

            function removeMaterial(id) {
                const list = materialsOfProject();
                for (let i = 0; i < list.length; i++) {
                    if (list[i].id === id) {
                        list.splice(i, 1);
                        if (activeMaterialId === id) activeMaterialId = null;
                        return true;
                    }
                }
                return false;
            }

            function isMaterialToken(tok) {
                return typeof tok === 'string' && tok.charAt(0) === '@';
            }

            function tokenOf(v) {
                if (!v) return MATERIAL_FALLBACK_COLOR;
                if (v.material) return '@' + v.material;
                return (v.color || MATERIAL_FALLBACK_COLOR).toUpperCase();
            }

            // Ritorna SEMPRE un colore valido. Un token materiale il cui id non esiste
            // piu' (file importato senza le sue definizioni) diventa tinta unita neutra.
            function decodeToken(tok) {
                if (isMaterialToken(tok)) {
                    const id = tok.slice(1);
                    const mat = materialById(id);
                    if (!mat) return { color: MATERIAL_FALLBACK_COLOR, material: null };
                    return { color: mat.color, material: id };
                }
                const c = (typeof tok === 'string' && tok.charAt(0) === '#')
                    ? tok.toUpperCase() : MATERIAL_FALLBACK_COLOR;
                return { color: c, material: null };
            }

            // Tinta media di una texture, da usare come `color` del materiale.
            // I pixel trasparenti sono SALTATI: sono assenza di colore, non nero, e
            // includerli scurirebbe ogni texture con bordo o buco trasparente.
            function averageColorFromPixels(data) {
                let r = 0, g = 0, b = 0, n = 0;
                for (let i = 0; i + 3 < data.length; i += 4) {
                    const a = data[i + 3];
                    if (a === 0) continue;
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
                }
                if (n === 0) return MATERIAL_FALLBACK_COLOR;
                const hx = v => Math.round(v / n).toString(16).toUpperCase().padStart(2, '0');
                return '#' + hx(r) + hx(g) + hx(b);
            }

            function getActiveMaterialId() { return activeMaterialId; }

            function setActiveMaterial(id) {
                activeMaterialId = id || null;
            }
```

- [ ] **Step 4: Eseguire il test**

Run: `node tests/test_materials.mjs`
Expected: PASS su tutti i controlli.

- [ ] **Step 5: Registrare il modulo nel manifest**

In `ui/src/manifest.json`, inserisci `"lib/36-materials.js",` **dopo** `"lib/35-primitives.js",` e prima di `"lib/18-bootstrap-tail.js"`.

- [ ] **Step 6: Registrare il test nella suite**

In `tests/run_all.sh` aggiungi accanto agli altri:

```bash
run "Materiali (store, token, tinta media)" node tests/test_materials.mjs
```

- [ ] **Step 7: Ricostruire e verificare**

```bash
grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js
node ui/build.mjs
bash tests/run_all.sh
```
Expected: i due `grep` danno lo stesso numero; build senza errori; suite verde.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/36-materials.js ui/src/manifest.json tests/test_materials.mjs tests/run_all.sh ui/index.html
git commit -m "feat(materiali): modulo con store, id, token e tinta media"
```

---

### Task 3: Import della texture e materiali THREE

**Files:**
- Modify: `ui/src/lib/36-materials.js`
- Modify: `tests/test_materials.mjs`

**Interfaces:**
- Consumes: `materialById`, `isMaterialToken`, `averageColorFromPixels`, `MATERIAL_TEXTURE_MAX` (Task 2)
- Produces:
  - `importTextureFile(file) -> Promise<{ data, w, h, color }>` — ridimensiona a max 128x128, ritorna data URL PNG e tinta media
  - `threeMaterialFor(token, opts) -> THREE.MeshStandardMaterial` con `opts = { wireframe }`
  - `clearMaterialCache()` — da chiamare quando una definizione cambia o si cambia oggetto
  - `fitTextureSize(w, h, max) -> { w, h }` — pura, testabile senza canvas

- [ ] **Step 1: Aggiungere i test che falliscono**

In `tests/test_materials.mjs`, prima del blocco finale `if (failures.length)`, aggiungi:

```js
// --- ridimensionamento ---
const api2 = api; // stesso modulo
check('una texture piccola non viene ingrandita',
  JSON.stringify(api2.fitTextureSize(32, 16, 128)) === JSON.stringify({ w: 32, h: 16 }),
  JSON.stringify(api2.fitTextureSize(32, 16, 128)));
check('una texture grande rientra nel lato massimo',
  JSON.stringify(api2.fitTextureSize(512, 256, 128)) === JSON.stringify({ w: 128, h: 64 }),
  JSON.stringify(api2.fitTextureSize(512, 256, 128)));
check('il lato lungo comanda anche in verticale',
  JSON.stringify(api2.fitTextureSize(100, 400, 128)) === JSON.stringify({ w: 32, h: 128 }),
  JSON.stringify(api2.fitTextureSize(100, 400, 128)));
check('nessun lato scende sotto 1 pixel',
  api2.fitTextureSize(1000, 3, 128).h === 1, JSON.stringify(api2.fitTextureSize(1000, 3, 128)));
```

e allarga la lista di ritorno di `loadMaterials()` con `fitTextureSize`.

- [ ] **Step 2: Eseguire per vederlo fallire**

Run: `node tests/test_materials.mjs`
Expected: FAIL — `fitTextureSize is not defined`.

- [ ] **Step 3: Implementare**

In fondo a `ui/src/lib/36-materials.js`:

```js
            // Il lato lungo comanda, l'altro segue in proporzione, minimo 1 pixel.
            // Una texture gia' piccola NON viene ingrandita: ingrandirla non aggiunge
            // dettaglio e gonfia il base64 dentro il .voxai.
            function fitTextureSize(w, h, max) {
                const M = max || MATERIAL_TEXTURE_MAX;
                if (w <= M && h <= M) return { w: w, h: h };
                const k = M / Math.max(w, h);
                return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
            }

            // Legge un File immagine, lo ridimensiona su canvas e ne ricava la tinta
            // media dallo STESSO canvas (un secondo passaggio sull'originale non
            // aggiungerebbe precisione e costerebbe un'altra decodifica).
            function importTextureFile(file) {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(file);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const size = fitTextureSize(img.width, img.height, MATERIAL_TEXTURE_MAX);
                            const cv = document.createElement('canvas');
                            cv.width = size.w; cv.height = size.h;
                            const ctx = cv.getContext('2d');
                            // NearestFilter a valle: qui teniamo il ridimensionamento
                            // netto, altrimenti la voxel art esce sfocata gia' in origine.
                            ctx.imageSmoothingEnabled = false;
                            ctx.drawImage(img, 0, 0, size.w, size.h);
                            const px = ctx.getImageData(0, 0, size.w, size.h).data;
                            resolve({
                                data: cv.toDataURL('image/png'),
                                w: size.w, h: size.h,
                                color: averageColorFromPixels(px)
                            });
                        } catch (e) { reject(e); }
                        finally { URL.revokeObjectURL(url); }
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
                    img.src = url;
                });
            }

            // --- cache dei materiali THREE ---------------------------------------
            // Un MeshStandardMaterial per token, riusato da entrambi i percorsi di
            // rendering. Senza cache ogni pennellata ricreerebbe la texture (upload
            // sulla GPU a ogni tratto) invece di riusarla.
            let _materialCache = new Map();

            function clearMaterialCache() {
                _materialCache.forEach(m => {
                    if (m.map && m.map.dispose) m.map.dispose();
                    if (m.dispose) m.dispose();
                });
                _materialCache = new Map();
            }

            function threeMaterialFor(token, opts) {
                const wire = !!(opts && opts.wireframe);
                const key = token + (wire ? '|w' : '');
                const hit = _materialCache.get(key);
                if (hit) return hit;

                const dec = decodeToken(token);
                const def = dec.material ? materialById(dec.material) : null;
                const mat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(dec.color),
                    roughness: def ? def.roughness : 0.2,
                    metalness: def ? def.metalness : 0.1,
                    wireframe: wire
                });
                if (def && def.emissive > 0) {
                    mat.emissive = new THREE.Color(dec.color);
                    mat.emissiveIntensity = def.emissive;
                }
                if (def && def.texture && def.texture.data) {
                    const tex = new THREE.TextureLoader().load(def.texture.data, () => {
                        if (typeof requestRender === 'function') requestRender();
                    });
                    // Voxel art: nessuna interpolazione, e una ripetizione per voxel
                    // (l'UV oltre 1 serve al greedy mesh dell'export).
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    mat.map = tex;
                    // Col map, `color` moltiplica la texture: bianco = texture pura.
                    mat.color = new THREE.Color(0xffffff);
                }
                _materialCache.set(key, mat);
                return mat;
            }
```

- [ ] **Step 4: Eseguire il test**

Run: `node tests/test_materials.mjs`
Expected: PASS.

- [ ] **Step 5: Build + suite**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/36-materials.js tests/test_materials.mjs ui/index.html
git commit -m "feat(materiali): import texture ridimensionata e cache dei materiali THREE"
```

---

### Task 4: Rendering per token (percorso completo e incrementale)

**Files:**
- Modify: `ui/src/lib/05-build-model.js:78-116`
- Modify: `ui/src/lib/28-incremental.js:89-115`, `:169-217`, `:259-309`, `:322-334`
- Modify: `tests/test_incremental.mjs`

**Interfaces:**
- Consumes: `tokenOf`, `decodeToken`, `isMaterialToken`, `threeMaterialFor`, `materialById` (Task 2-3)
- Produces: `visibleByColor` / `meshByColor` / `visibleColorByKey` continuano a chiamarsi così ma le loro **chiavi sono token**; `renderPaletteSwatches(tokensOverride)` accetta token.

- [ ] **Step 1: Estendere il test dell'incrementale**

In `tests/test_incremental.mjs`, aggiungi in coda (adattando i nomi degli helper già presenti nel file):

```js
// --- materiali -------------------------------------------------------------
// Il percorso rapido deve raggruppare per TOKEN, non per colore: due voxel dello
// stesso colore ma con materiali diversi sono due mesh diverse, e la firma della
// palette deve accorgersene (altrimenti le swatch non si aggiornano mai).
{
  const st = freshState([
    { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },
    { x: 2, y: 0, z: 0, color: '#8B5A2B' }
  ]);
  const keys = Array.from(st.getState().visibleByColor.keys()).sort();
  check('due voxel stesso colore ma materiale diverso danno due gruppi',
    keys.length === 2 && keys.includes('@m1') && keys.includes('#8B5A2B'),
    JSON.stringify(keys));
}
{
  const st = freshState([{ x: 0, y: 0, z: 0, color: '#8B5A2B' }]);
  const sigPrima = st.getState().paletteSignature;
  st.applyVoxelEdits([{ x: 0, y: 0, z: 0, color: '@m1' }]);
  check('la firma della palette reagisce al passaggio colore -> materiale',
    st.getState().paletteSignature !== sigPrima,
    `${sigPrima} -> ${st.getState().paletteSignature}`);
}
```

`freshState(voxels)` è l'helper che il file già usa per preparare `currentModelData`, `voxelMap` e chiamare `primeIncrementalState`. Se nel file ha un altro nome, usa quello: **non** duplicarlo.

Nell'helper, la `voxelMap` va popolata col token (`v.material ? '@'+v.material : v.color.toUpperCase()`), non col solo colore. Aggiungi `paletteSignature` alla lista esposta dal `getState` del test.

- [ ] **Step 2: Eseguire per vederlo fallire**

Run: `node tests/test_incremental.mjs`
Expected: FAIL — un solo gruppo `#8B5A2B` invece di due; firma invariata.

- [ ] **Step 3: Portare `buildModel` sul token**

In `ui/src/lib/05-build-model.js` sostituisci il blocco palette (riga 48-49):

```js
                const uniqueColors = [...new Set(voxels.map(v => v.color.toUpperCase()))];
                renderPaletteSwatches(uniqueColors);
```

con:

```js
                // Token, non colori: due voxel dello stesso colore con materiali
                // diversi sono due voci di palette distinte (vedi 36-materials.js).
                const uniqueTokens = [...new Set(voxels.map(v => tokenOf(v)))];
                renderPaletteSwatches(uniqueTokens);
```

e il blocco di costruzione (righe 79-116):

```js
                    const colorGroups = {};
                    visibleVoxels.forEach(v => {
                        const c = v.color.toUpperCase();
                        if (!colorGroups[c]) colorGroups[c] = [];
                        colorGroups[c].push(v);
                    });
```

diventa:

```js
                    const colorGroups = {};
                    visibleVoxels.forEach(v => {
                        const c = tokenOf(v);
                        if (!colorGroups[c]) colorGroups[c] = [];
                        colorGroups[c].push(v);
                    });
```

e dentro `Object.keys(colorGroups).forEach(colorHex => {` sostituisci la creazione del materiale:

```js
                        const material = new THREE.MeshStandardMaterial({
                            color: new THREE.Color(colorHex),
                            roughness: 0.2,
                            metalness: 0.1,
                            wireframe: toggleWireframe.checked
                        });
```

con:

```js
                        // Materiale condiviso e messo in cache per token: ricrearlo a
                        // ogni rebuild rifarebbe l'upload della texture sulla GPU.
                        const material = threeMaterialFor(colorHex, { wireframe: toggleWireframe.checked });
```

**Attenzione:** `disposeMesh()` (riga 191-193 dello stesso file) libera il materiale del mesh. Ora i materiali sono condivisi dalla cache, quindi vanno protetti come già lo è la geometria. Sostituisci:

```js
                const mat = m.material;
                if (Array.isArray(mat)) mat.forEach(x => x && x.dispose && x.dispose());
                else if (mat && typeof mat.dispose === 'function') mat.dispose();
```

con:

```js
                // Stessa trappola della geometria condivisa: i materiali dei voxel
                // vengono dalla cache di 36-materials.js e sono condivisi fra i mesh
                // e fra i rebuild. Liberarli qui li rendeva invalidi per gli altri
                // (texture nera, mesh non disegnati). Sono marcati userData.shared e
                // si liberano solo da clearMaterialCache().
                const disposeMat = x => {
                    if (!x || typeof x.dispose !== 'function') return;
                    if (x.userData && x.userData.shared) return;
                    x.dispose();
                };
                const mat = m.material;
                if (Array.isArray(mat)) mat.forEach(disposeMat);
                else disposeMat(mat);
```

e in `threeMaterialFor` (`36-materials.js`, Task 3) marca il materiale prima di metterlo in cache, subito prima di `_materialCache.set(key, mat);`:

```js
                mat.userData = mat.userData || {};
                mat.userData.shared = true;   // protetto da disposeMesh()
```

- [ ] **Step 4: Portare l'incrementale sul token**

In `ui/src/lib/28-incremental.js`:

1. In `primeIncrementalState` (riga ~94), sostituisci `const hex = (v.color || '').toUpperCase();` con `const hex = tokenOf(v);`.
2. In `rebuildColorMesh` (riga ~195), sostituisci il blocco `const material = new THREE.MeshStandardMaterial({...});` con `const material = threeMaterialFor(colorHex, { wireframe: toggleWireframe.checked });`.
3. In `applyVoxelEdits` (riga ~263), `const nowColor = nowVisible ? (voxelMap.get(k) || '').toUpperCase() : undefined;` diventa:

```js
                        // voxelMap contiene gia' il TOKEN (vedi 03-voxel-map.js): non
                        // va maiuscolizzato, perche' '@m1' e '@M1' sono id diversi.
                        const nowColor = nowVisible ? (voxelMap.get(k) || undefined) : undefined;
```

4. Sempre in `applyVoxelEdits`, la fabbricazione del voxel di ripiego (riga ~282) `: { x: x, y: y, z: z, color: nowColor };` diventa:

```js
                                : Object.assign({ x: x, y: y, z: z }, decodeToken(nowColor));
```

5. `voxelArrayAdd` (riga ~136) riceve un token e deve scriverlo scomposto:

```js
            function voxelArrayAdd(x, y, z, token) {
                const arr = currentModelData.voxels;
                const k = vkey(x, y, z);
                const existing = voxelIndex.get(k);
                const targetPart = getTargetPartForVoxel(x, y, z);
                const dec = decodeToken(token);
                if (existing !== undefined) {          // gia' presente: solo ricolora
                    arr[existing].color = dec.color;
                    if (dec.material) arr[existing].material = dec.material;
                    else delete arr[existing].material;
                    if (targetPart) arr[existing].part = targetPart;
                    return;
                }
                const newVoxel = { x: x, y: y, z: z, color: dec.color };
                if (dec.material) newVoxel.material = dec.material;
                if (targetPart) newVoxel.part = targetPart;
                arr.push(newVoxel);
                voxelIndex.set(k, arr.length - 1);
            }
```

e la chiamata corrispondente (riga ~241) `else voxelArrayAdd(c.x, c.y, c.z, (c.color || '').toUpperCase());` diventa `else voxelArrayAdd(c.x, c.y, c.z, c.color);` (la cella porta gia' il token).

- [ ] **Step 5: Swatch con miniatura**

In `28-incremental.js` sostituisci `renderPaletteSwatches` (righe 322-334):

```js
            // Disegna le swatch della palette dai TOKEN attualmente visibili.
            // Un token materiale mostra la miniatura della texture; un token colore
            // il colore pieno. Il click seleziona l'uno o l'altro, coerentemente con
            // la mutua esclusione fra colore e materiale.
            function renderPaletteSwatches(tokensOverride) {
                const tokens = tokensOverride
                    || (visibleByColor ? Array.from(visibleByColor.keys()) : []);
                paletteEl.innerHTML = '';
                tokens.forEach(tok => {
                    const s = document.createElement('div');
                    s.className = 'swatch';
                    const dec = decodeToken(tok);
                    const def = dec.material ? materialById(dec.material) : null;
                    s.style.backgroundColor = dec.color;
                    if (def && def.texture && def.texture.data) {
                        s.style.backgroundImage = `url(${def.texture.data})`;
                        s.style.backgroundSize = 'cover';
                        s.style.imageRendering = 'pixelated';
                        s.title = t('materials.swatchMaterialTitle', { name: def.name });
                        s.addEventListener('click', () => setActiveMaterialAndSync(dec.material));
                    } else {
                        s.title = t('materials.swatchColorTitle', { color: dec.color });
                        s.addEventListener('click', () => setActiveColor(dec.color));
                    }
                    paletteEl.appendChild(s);
                });
            }
```

Le due chiavi vanno aggiunte in tutte e 6 le lingue (Task 6 le raccoglie tutte insieme; se il pannello non c'è ancora, aggiungile subito qui — `t()` su chiave mancante ritorna la chiave nuda e romperebbe il titolo):

`it.json`: `"materials.swatchMaterialTitle": "{name} - clic per usare questo materiale"`, `"materials.swatchColorTitle": "{color} - clic per usarlo come colore attivo"`.
Traduzioni: en `"{name} - click to use this material"` / `"{color} - click to use as active color"`; es `"{name} - clic para usar este material"` / `"{color} - clic para usarlo como color activo"`; de `"{name} - klicken, um dieses Material zu verwenden"` / `"{color} - klicken, um es als aktive Farbe zu verwenden"`; fr `"{name} - cliquer pour utiliser ce materiau"` / `"{color} - cliquer pour l'utiliser comme couleur active"`; pt `"{name} - clique para usar este material"` / `"{color} - clique para usa-lo como cor ativa"`.

`setActiveMaterialAndSync` arriva nel Task 5; finché non esiste, il click su una swatch materiale lancerebbe un `ReferenceError`. Per non lasciare un buco fra i due task, aggiungi **subito** in `36-materials.js` la versione minima, che il Task 5 completerà:

```js
            // Ponte fra la palette e la selezione attiva. Il Task successivo ci
            // aggancia anche l'interfaccia (evidenza sul pannello, colore smorzato).
            function setActiveMaterialAndSync(id) {
                setActiveMaterial(id);
                if (typeof refreshMaterialSelectionUI === 'function') refreshMaterialSelectionUI();
            }
```

- [ ] **Step 6: Eseguire i test**

Run: `node tests/test_incremental.mjs && node tests/test_materials.mjs`
Expected: PASS entrambi.

- [ ] **Step 7: Build + suite**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Expected: verde. Se `test_bootstrap.mjs` segnala un simbolo non definito, è perché `36-materials.js` sta **dopo** i suoi consumatori nel manifest: le dichiarazioni di funzione sono hoistate nello scope condiviso, quindi va bene, ma una `const` letta a livello top prima del modulo no — verifica di non aver spostato costanti fuori dalle funzioni.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/05-build-model.js ui/src/lib/28-incremental.js ui/src/lib/36-materials.js tests/test_incremental.mjs ui/locales/*.json ui/index.html
git commit -m "feat(materiali): rendering raggruppato per token nei due percorsi"
```

---

### Task 5: Token nella voxelMap, editing e mutua esclusione

**Files:**
- Modify: `ui/src/lib/03-voxel-map.js`
- Modify: `ui/src/lib/11-symmetry-tools.js:149-154`
- Modify: `ui/src/lib/14-tools-actions.js`
- Modify: `ui/src/lib/36-materials.js`
- Modify: `tests/test_materials.mjs`

**Interfaces:**
- Consumes: `tokenOf`, `decodeToken`, `setActiveMaterial`, `getActiveMaterialId` (Task 2)
- Produces:
  - `activeToken() -> string` — `'@'+activeMaterialId` se c'è un materiale attivo, altrimenti `activeColorHex`
  - `refreshMaterialSelectionUI()` — aggiorna evidenza e smorzatura (definita qui, usata dal Task 6)

- [ ] **Step 1: Aggiungere i test che falliscono**

In `tests/test_materials.mjs`, prima del blocco finale:

```js
// --- mutua esclusione -------------------------------------------------------
// Il requisito e' simmetrico: scegliere un materiale toglie il colore, scegliere
// un colore toglie il materiale. Lo verifichiamo su activeToken(), che e' l'unico
// punto da cui l'editing legge "cosa sto posando".
{
  const shared = { activeColorHex: '#FF0000' };
  const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  const mod = new Function('currentModelData', 'localStorage', 'activeColorHex', src + `
   ;return { activeToken, setActiveMaterial, getActiveMaterialId,
             setColorClearsMaterial: (hex) => { setActiveMaterial(null); } };`)(
    { metadata: { materials: [{ id: 'm1', name: 'X', color: '#00FF00', texture: null, roughness: 0.5, metalness: 0, emissive: 0 }] } },
    fakeStore, shared.activeColorHex);
  check('senza materiale attivo si posa il colore', mod.activeToken() === '#FF0000', mod.activeToken());
  mod.setActiveMaterial('m1');
  check('col materiale attivo si posa il materiale', mod.activeToken() === '@m1', mod.activeToken());
  mod.setColorClearsMaterial('#0000FF');
  check('scegliere un colore azzera il materiale', mod.getActiveMaterialId() === null);
  check('e si torna a posare il colore', mod.activeToken() === '#FF0000', mod.activeToken());
}
```

- [ ] **Step 2: Eseguire per vederlo fallire**

Run: `node tests/test_materials.mjs`
Expected: FAIL — `activeToken is not defined`.

- [ ] **Step 3: Implementare `activeToken` e l'interfaccia**

In fondo a `ui/src/lib/36-materials.js`:

```js
            // Cosa si sta posando adesso. Unico punto da cui l'editing lo legge:
            // finche' passa da qui, la mutua esclusione non puo' essere aggirata.
            function activeToken() {
                if (activeMaterialId && materialById(activeMaterialId)) return '@' + activeMaterialId;
                return (typeof activeColorHex === 'string' && activeColorHex)
                    ? activeColorHex.toUpperCase() : MATERIAL_FALLBACK_COLOR;
            }

            // Evidenza sulla scheda del materiale attivo e colore "smorzato" quando un
            // materiale ha la precedenza. Smorzato con una classe, NON disabled: l'input
            // deve restare cliccabile, perche' cliccarlo e' proprio il modo per tornare
            // al colore.
            function refreshMaterialSelectionUI() {
                const panel = document.getElementById('materialsPanel');
                if (panel) {
                    panel.querySelectorAll('.material-card').forEach(el => {
                        el.classList.toggle('active', el.dataset.materialId === activeMaterialId);
                    });
                }
                const swatchRow = document.getElementById('activeColorRow');
                if (swatchRow) swatchRow.classList.toggle('muted-by-material', !!activeMaterialId);
                const label = document.getElementById('activeMaterialName');
                if (label) {
                    const def = activeMaterialId ? materialById(activeMaterialId) : null;
                    label.textContent = def ? def.name : '';
                }
            }
```

- [ ] **Step 4: `voxelMap` porta il token**

In `ui/src/lib/03-voxel-map.js`, in `rebuildVoxelMap` sostituisci

```js
                    voxelMap.set(`${v.x},${v.y},${v.z}`, v.color.toUpperCase());
```

con

```js
                    // Il valore e' un TOKEN ('#RRGGBB' o '@m1'), non un colore: vedi
                    // 36-materials.js. Le decine di confronti sparsi per l'editor lo
                    // trattano come stringa opaca e restano invariati.
                    voxelMap.set(`${v.x},${v.y},${v.z}`, tokenOf(v));
```

e in `syncVoxelsFromMap` sostituisci

```js
                const rebuilt = [...voxelMap.entries()].map(([k, color]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    const base = { x, y, z, color };
```

con

```js
                const rebuilt = [...voxelMap.entries()].map(([k, token]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    const dec = decodeToken(token);
                    const base = { x, y, z, color: dec.color };
                    if (dec.material) base.material = dec.material;
```

- [ ] **Step 5: Il colore azzera il materiale**

In `ui/src/lib/11-symmetry-tools.js` sostituisci `setActiveColor`:

```js
            function setActiveColor(hex) {
                activeColorHex = hex.toUpperCase();
                activeColorInput.value = hex.toLowerCase();
                activeColorHexEl.textContent = activeColorHex;
                // Mutua esclusione: scegliere un colore toglie la selezione al materiale.
                if (typeof setActiveMaterial === 'function') {
                    setActiveMaterial(null);
                    if (typeof refreshMaterialSelectionUI === 'function') refreshMaterialSelectionUI();
                }
            }
```

- [ ] **Step 6: L'editing usa il token attivo**

In `ui/src/lib/14-tools-actions.js` cerca ogni punto che scrive `activeColorHex` in una cella o nella `voxelMap`:

```bash
grep -n "activeColorHex" ui/src/lib/14-tools-actions.js
```

Sostituisci **solo le scritture** (`voxelMap.set(..., activeColorHex)`, `{ x, y, z, color: activeColorHex }`, `cells.push({... color: activeColorHex })`) con `activeToken()`. Non toccare gli usi che servono all'anteprima ghost verde (lì serve un colore vero: usa `decodeToken(activeToken()).color`).

Nel contagocce (`pick`), sostituisci la lettura del colore sotto il cursore con:

```js
                    // Il contagocce su un voxel texturizzato seleziona il suo MATERIALE:
                    // e' il comportamento atteso e cade fuori gratis dal token.
                    const tok = voxelMap.get(`${cell.x},${cell.y},${cell.z}`);
                    if (typeof isMaterialToken === 'function' && isMaterialToken(tok)) {
                        setActiveMaterialAndSync(tok.slice(1));
                    } else {
                        setActiveColor(decodeToken(tok).color);
                    }
```

adattando `cell` al nome della variabile già usata in quel punto.

- [ ] **Step 7: Eseguire i test**

Run: `node tests/test_materials.mjs && node tests/test_incremental.mjs`
Expected: PASS.

- [ ] **Step 8: Build + suite**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Expected: verde.

- [ ] **Step 9: Commit**

```bash
git add ui/src/lib/03-voxel-map.js ui/src/lib/11-symmetry-tools.js ui/src/lib/14-tools-actions.js ui/src/lib/36-materials.js tests/test_materials.mjs ui/index.html
git commit -m "feat(materiali): token nella voxelMap, editing e mutua esclusione col colore"
```

---

### Task 6: Il pannello nel tab Disegna

**Files:**
- Modify: `ui/src/index.template.html` (fra il blocco *Strumenti di Modifica* e `<!-- ===== Plugin / Script utente`, riga ~2523)
- Modify: `ui/src/lib/36-materials.js`
- Modify: `ui/locales/it.json`, `en.json`, `es.json`, `de.json`, `fr.json`, `pt.json`

**Interfaces:**
- Consumes: `addMaterial`, `removeMaterial`, `materialsOfProject`, `importTextureFile`, `setActiveMaterialAndSync`, `refreshMaterialSelectionUI`, `clearMaterialCache` (Task 2-5)
- Produces: `renderMaterialsPanel()` — ridisegna la griglia; da chiamare dopo ogni load/import/cambio oggetto

- [ ] **Step 1: Aggiungere le chiavi in `it.json`**

```json
  "materials.sectionTitle": "Materiali",
  "materials.hint": "Un materiale applica la stessa texture a tutte e 6 le facce del voxel. Selezionarne uno disattiva il colore attivo.",
  "materials.empty": "Nessun materiale. Creane uno per usare le texture.",
  "materials.new": "+ Nuovo materiale",
  "materials.namePlaceholder": "Nome del materiale",
  "materials.texture": "Texture",
  "materials.chooseFile": "Scegli immagine",
  "materials.roughness": "Ruvidita",
  "materials.metalness": "Metallicita",
  "materials.emissive": "Emissivo",
  "materials.create": "Crea",
  "materials.cancel": "Annulla",
  "materials.delete": "Elimina",
  "materials.deleteTitle": "Elimina il materiale",
  "materials.duplicate": "Duplica",
  "materials.duplicateTitle": "Duplica il materiale",
  "materials.saveToLibrary": "Salva in libreria",
  "materials.saveToLibraryTitle": "Salva questo materiale nella libreria personale",
  "materials.library": "Libreria personale",
  "materials.libraryEmpty": "La libreria e vuota.",
  "materials.libraryFull": "La libreria e piena ({max} materiali): eliminane uno prima di salvarne altri.",
  "materials.importFromLibrary": "Importa",
  "materials.noTexture": "Nessuna texture scelta",
  "materials.textureError": "Impossibile leggere l'immagine scelta.",
  "materials.nameRequired": "Dai un nome al materiale.",
  "materials.confirmDelete": "Eliminare il materiale \"{name}\"? I voxel che lo usano torneranno a tinta unita."
```

- [ ] **Step 2: Tradurre le stesse chiavi nelle altre 5 lingue**

Aggiungi le stesse 25 chiavi a `en.json`, `es.json`, `de.json`, `fr.json`, `pt.json`. Esempio per `en.json`:

```json
  "materials.sectionTitle": "Materials",
  "materials.hint": "A material applies the same texture to all 6 faces of the voxel. Selecting one disables the active color.",
  "materials.empty": "No materials yet. Create one to use textures.",
  "materials.new": "+ New material",
  "materials.namePlaceholder": "Material name",
  "materials.texture": "Texture",
  "materials.chooseFile": "Choose image",
  "materials.roughness": "Roughness",
  "materials.metalness": "Metalness",
  "materials.emissive": "Emissive",
  "materials.create": "Create",
  "materials.cancel": "Cancel",
  "materials.delete": "Delete",
  "materials.deleteTitle": "Delete the material",
  "materials.duplicate": "Duplicate",
  "materials.duplicateTitle": "Duplicate the material",
  "materials.saveToLibrary": "Save to library",
  "materials.saveToLibraryTitle": "Save this material to your personal library",
  "materials.library": "Personal library",
  "materials.libraryEmpty": "The library is empty.",
  "materials.libraryFull": "The library is full ({max} materials): delete one before saving more.",
  "materials.importFromLibrary": "Import",
  "materials.noTexture": "No texture chosen",
  "materials.textureError": "Could not read the chosen image.",
  "materials.nameRequired": "Give the material a name.",
  "materials.confirmDelete": "Delete material \"{name}\"? Voxels using it will go back to a solid color."
```

Fai lo stesso per es/de/fr/pt mantenendo **identici** i segnaposto `{max}` e `{name}`.

- [ ] **Step 3: Verificare la parità delle chiavi**

Run: `bash tests/run_all.sh`
Expected: il test *Chiavi i18n complete* passa. Se fallisce, una lingua ha una chiave in meno o un valore vuoto.

- [ ] **Step 4: Aggiungere il pannello al template**

In `ui/src/index.template.html`, subito **prima** di `<!-- ===== Plugin / Script utente (API sandboxata) ===== -->`:

```html
                <!-- ===== Materiali (texture su tutte e 6 le facce) ===== -->
                <div>
                    <div class="section-title" data-i18n="materials.sectionTitle">Materiali</div>
                    <div class="controls-group glass" id="materialsPanel" style="padding:14px; display:flex; flex-direction:column; gap:10px;">
                        <div style="font-size:11px; color:var(--text-muted, #9ca3af); line-height:1.4;"
                            data-i18n="materials.hint">
                            Un materiale applica la stessa texture a tutte e 6 le facce del voxel. Selezionarne uno disattiva il colore attivo.
                        </div>
                        <div id="materialsGrid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(64px,1fr)); gap:8px;"></div>
                        <p id="materialsEmpty" style="font-size:11px; color:var(--text-secondary); margin:0;"
                            data-i18n="materials.empty">Nessun materiale. Creane uno per usare le texture.</p>
                        <button class="btn btn-secondary" id="newMaterialBtn" style="padding:8px; font-size:12px;"
                            data-i18n="materials.new">+ Nuovo materiale</button>
                        <div id="materialForm" style="display:none; flex-direction:column; gap:8px;">
                            <input type="text" id="materialName" class="text-input"
                                data-i18n-placeholder="materials.namePlaceholder" placeholder="Nome del materiale">
                            <input type="file" id="materialTextureInput" accept="image/*" style="font-size:11px;">
                            <div class="control-row">
                                <label data-i18n="materials.roughness">Ruvidita</label>
                                <input type="range" id="materialRoughness" min="0" max="1" step="0.05" value="0.6">
                            </div>
                            <div class="control-row">
                                <label data-i18n="materials.metalness">Metallicita</label>
                                <input type="range" id="materialMetalness" min="0" max="1" step="0.05" value="0">
                            </div>
                            <div class="control-row">
                                <label data-i18n="materials.emissive">Emissivo</label>
                                <input type="range" id="materialEmissive" min="0" max="1" step="0.05" value="0">
                            </div>
                            <div class="btn-group" style="grid-template-columns:1fr 1fr;">
                                <button class="btn btn-primary" id="materialCreateBtn" style="padding:8px; font-size:12px;"
                                    data-i18n="materials.create">Crea</button>
                                <button class="btn btn-secondary" id="materialCancelBtn" style="padding:8px; font-size:12px;"
                                    data-i18n="materials.cancel">Annulla</button>
                            </div>
                        </div>
                        <div class="section-title" style="font-size:11px; margin-top:4px;" data-i18n="materials.library">Libreria personale</div>
                        <div id="materialLibraryGrid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(64px,1fr)); gap:8px;"></div>
                    </div>
                </div>

```

- [ ] **Step 5: Aggiungere lo stile della scheda**

Nel blocco `<style>` del template, accanto a `.swatch`:

```css
        .material-card { position: relative; aspect-ratio: 1; border-radius: 8px; border: 2px solid transparent; background-size: cover; image-rendering: pixelated; cursor: pointer; }
        .material-card.active { border-color: var(--accent-primary); }
        .material-card .material-card-name { position: absolute; left: 0; right: 0; bottom: 0; font-size: 9px; text-align: center; background: rgba(0,0,0,.55); border-radius: 0 0 6px 6px; padding: 1px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .muted-by-material { opacity: .45; }
```

- [ ] **Step 6: Implementare la UI del pannello**

In fondo a `ui/src/lib/36-materials.js`:

```js
            // --- UI del pannello ---------------------------------------------------
            function materialCardEl(def, onClick) {
                const el = document.createElement('div');
                el.className = 'material-card';
                el.dataset.materialId = def.id;
                el.style.backgroundColor = def.color;
                if (def.texture && def.texture.data) el.style.backgroundImage = `url(${def.texture.data})`;
                const nm = document.createElement('div');
                nm.className = 'material-card-name';
                nm.textContent = def.name;
                el.appendChild(nm);
                el.addEventListener('click', onClick);
                return el;
            }

            function renderMaterialsPanel() {
                const grid = document.getElementById('materialsGrid');
                if (!grid) return;
                const list = materialsOfProject();
                grid.innerHTML = '';
                list.forEach(def => {
                    const el = materialCardEl(def, () => setActiveMaterialAndSync(def.id));
                    el.title = def.name;
                    el.addEventListener('contextmenu', ev => {
                        ev.preventDefault();
                        if (!confirm(t('materials.confirmDelete', { name: def.name }))) return;
                        removeMaterial(def.id);
                        clearMaterialCache();
                        renderMaterialsPanel();
                        if (typeof buildModel === 'function') buildModel(false);
                    });
                    grid.appendChild(el);
                });
                const empty = document.getElementById('materialsEmpty');
                if (empty) empty.style.display = list.length ? 'none' : '';
                renderMaterialLibrary();
                refreshMaterialSelectionUI();
            }

            // --- libreria personale -------------------------------------------------
            function loadMaterialLibrary() {
                try {
                    const raw = localStorage.getItem(MATERIAL_LIB_KEY);
                    const arr = raw ? JSON.parse(raw) : [];
                    return Array.isArray(arr) ? arr : [];
                } catch (e) { return []; }
            }

            function saveMaterialLibrary(arr) {
                try { localStorage.setItem(MATERIAL_LIB_KEY, JSON.stringify(arr.slice(0, MATERIAL_LIB_MAX))); }
                catch (e) { /* quota piena: la libreria e' un comfort, non un dato critico */ }
            }

            function renderMaterialLibrary() {
                const grid = document.getElementById('materialLibraryGrid');
                if (!grid) return;
                grid.innerHTML = '';
                loadMaterialLibrary().forEach(def => {
                    const el = materialCardEl(def, () => {
                        // Importare RINUMERA: due progetti diversi possono aver usato m1
                        // per materiali diversi, e sovrascrivere ne perderebbe uno.
                        const copia = addMaterial(Object.assign({}, def, { id: null }));
                        clearMaterialCache();
                        renderMaterialsPanel();
                        setActiveMaterialAndSync(copia.id);
                    });
                    el.title = t('materials.importFromLibrary') + ': ' + def.name;
                    grid.appendChild(el);
                });
            }

            (function initMaterialsPanel() {
                const newBtn = document.getElementById('newMaterialBtn');
                const form = document.getElementById('materialForm');
                if (!newBtn || !form) return;   // pagina senza il pannello (es. settings.html)
                let pendingTexture = null;

                newBtn.addEventListener('click', () => {
                    form.style.display = (form.style.display === 'none') ? 'flex' : 'none';
                });
                document.getElementById('materialCancelBtn').addEventListener('click', () => {
                    form.style.display = 'none';
                    pendingTexture = null;
                });
                document.getElementById('materialTextureInput').addEventListener('change', async e => {
                    const f = e.target.files && e.target.files[0];
                    if (!f) { pendingTexture = null; return; }
                    try { pendingTexture = await importTextureFile(f); }
                    catch (err) { pendingTexture = null; alert(t('materials.textureError')); }
                });
                document.getElementById('materialCreateBtn').addEventListener('click', () => {
                    const name = (document.getElementById('materialName').value || '').trim();
                    if (!name) { alert(t('materials.nameRequired')); return; }
                    const def = addMaterial({
                        name: name,
                        texture: pendingTexture ? { data: pendingTexture.data, w: pendingTexture.w, h: pendingTexture.h } : null,
                        // Senza texture il materiale e' una tinta unita col colore
                        // attivo: e' comunque utile per ruvidita'/metallicita'/emissivo.
                        color: pendingTexture ? pendingTexture.color : (typeof activeColorHex === 'string' ? activeColorHex : MATERIAL_FALLBACK_COLOR),
                        roughness: parseFloat(document.getElementById('materialRoughness').value),
                        metalness: parseFloat(document.getElementById('materialMetalness').value),
                        emissive: parseFloat(document.getElementById('materialEmissive').value)
                    });
                    const lib = loadMaterialLibrary();
                    if (lib.length < MATERIAL_LIB_MAX) { lib.push(def); saveMaterialLibrary(lib); }
                    form.style.display = 'none';
                    document.getElementById('materialName').value = '';
                    document.getElementById('materialTextureInput').value = '';
                    pendingTexture = null;
                    renderMaterialsPanel();
                    setActiveMaterialAndSync(def.id);
                });
                renderMaterialsPanel();
            })();
```

- [ ] **Step 7: Build e prova a schermo**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Poi apri l'app (`python main.py`), vai nel tab *Disegna*: il pannello Materiali sta **sopra** quello dei plugin. Crea un materiale con un PNG, posalo su qualche voxel, verifica che il colore attivo si smorzi e che cliccare l'input colore riporti al colore.

- [ ] **Step 8: Commit**

```bash
git add ui/src/index.template.html ui/src/lib/36-materials.js ui/locales/*.json ui/index.html
git commit -m "feat(materiali): pannello nel tab Disegna, tradotto in tutte le lingue"
```

---

### Task 7: Round-trip su salvataggio e import

**Files:**
- Modify: `ui/src/lib/07-save-payload.js:56-84`
- Modify: `ui/src/lib/04-objects.js:75-105`
- Modify: `ui/src/lib/02-io-files.js`
- Modify: `tests/test_materials.mjs`

**Interfaces:**
- Consumes: `materialsOfProject` (Task 2)
- Produces:
  - `buildMaterialMap(voxels) -> Array<Array>` — `[["m1", x,y,z, x,y,z], …]`, stessa forma di una op `set`
  - `applyMaterialMap(data) -> data` — riversa `metadata.material_map` sui voxel già espansi, in loco

- [ ] **Step 1: Aggiungere i test che falliscono**

In `tests/test_materials.mjs`:

```js
// --- round-trip attraverso il formato compatto ------------------------------
// Le ops sanno esprimere SOLO colori. I materiali viaggiano in
// metadata.material_map e vengono riversati sui voxel DOPO l'espansione, cosi'
// expand_ops/expandOps (e la loro parita' Python<->JS) non si toccano.
{
  const srcMat = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  const srcSave = fs.readFileSync(path.join(ROOT, 'ui/src/lib/07-save-payload.js'), 'latin1');
  const model = {
    metadata: { name: 'T', grid_size: [4,4,4], materials: [
      { id: 'm1', name: 'Legno', color: '#8B5A2B', texture: null, roughness: .7, metalness: 0, emissive: 0 }] },
    voxels: [
      { x:0, y:0, z:0, color: '#8B5A2B', material: 'm1' },
      { x:1, y:0, z:0, color: '#8B5A2B', material: 'm1' },
      { x:2, y:0, z:0, color: '#FF0000' }
    ]
  };
  const mod = new Function('currentModelData', 'localStorage', srcMat + srcSave + `
   ;return { buildMaterialMap, applyMaterialMap, buildObjectPayload };`)(model, fakeStore);

  const mm = mod.buildMaterialMap(model.voxels);
  check('material_map raggruppa per id come una op set',
    JSON.stringify(mm) === JSON.stringify([['m1', 0,0,0, 1,0,0]]), JSON.stringify(mm));
  check('i voxel senza materiale non finiscono nella mappa',
    JSON.stringify(mm).indexOf('2,0,0') === -1 && mm.length === 1);

  const payload = mod.buildObjectPayload(model);
  check('il payload porta le definizioni dei materiali',
    payload.metadata.materials.length === 1, JSON.stringify(payload.metadata.materials));
  check('il payload porta la material_map',
    JSON.stringify(payload.metadata.material_map) === JSON.stringify([['m1', 0,0,0, 1,0,0]]),
    JSON.stringify(payload.metadata.material_map));
  check('la palette resta di soli colori (ops intatte)',
    Object.values(payload.palette).every(c => typeof c === 'string' && c[0] === '#'),
    JSON.stringify(payload.palette));

  // Ricarica: i voxel arrivano espansi e SENZA materiale, la mappa li ripristina.
  const espansi = { metadata: payload.metadata, voxels: [
    { x:0, y:0, z:0, color: '#8B5A2B' },
    { x:1, y:0, z:0, color: '#8B5A2B' },
    { x:2, y:0, z:0, color: '#FF0000' }
  ]};
  mod.applyMaterialMap(espansi);
  check('applyMaterialMap ripristina il materiale sui voxel giusti',
    espansi.voxels[0].material === 'm1' && espansi.voxels[1].material === 'm1'
    && espansi.voxels[2].material === undefined,
    JSON.stringify(espansi.voxels));

  // Un file senza definizioni: la mappa c'e' ma i materiali no.
  const orfano = { metadata: { material_map: [['m9', 0,0,0]] }, voxels: [{ x:0, y:0, z:0, color: '#123456' }] };
  mod.applyMaterialMap(orfano);
  check('un id senza definizione non viene applicato (tinta unita)',
    orfano.voxels[0].material === undefined, JSON.stringify(orfano.voxels));

  // Nessuna mappa: nulla deve rompersi.
  const semplice = { metadata: {}, voxels: [{ x:0, y:0, z:0, color: '#123456' }] };
  mod.applyMaterialMap(semplice);
  check('un file senza material_map passa indenne', semplice.voxels[0].material === undefined);
}
```

- [ ] **Step 2: Eseguire per vederlo fallire**

Run: `node tests/test_materials.mjs`
Expected: FAIL — `buildMaterialMap is not defined`.

- [ ] **Step 3: Implementare in `07-save-payload.js`**

In cima al file, prima di `buildObjectPayload`:

```js
            // Le ops compatte sanno esprimere SOLO colori (palette -> hex): non c'e'
            // posto dove mettere un materiale. Invece di allargare la semantica delle
            // ops - il che richiederebbe una modifica ACCOPPIATA a expand_ops in
            // src/parser.py e a expandOps in ui/src/utils/expand-ops.js, il punto piu'
            // sorvegliato del repo - i materiali viaggiano in un elenco a parte, nella
            // stessa forma di una op `set`: id + triplette. Si riversa sui voxel DOPO
            // l'espansione (applyMaterialMap), quindi il contratto ops resta intatto e
            // il generatore AI, che di materiali non sa nulla, continua a funzionare.
            function buildMaterialMap(voxels) {
                const byId = new Map();
                (voxels || []).forEach(v => {
                    if (!v || !v.material || v._hidden) return;
                    let arr = byId.get(v.material);
                    if (!arr) { arr = []; byId.set(v.material, arr); }
                    arr.push(v.x, v.y, v.z);
                });
                const out = [];
                byId.forEach((coords, id) => out.push([id].concat(coords)));
                return out;
            }

            // Riversa metadata.material_map sui voxel gia' espansi. Un id privo di
            // definizione viene IGNORATO: il voxel resta a tinta unita, che e' il
            // comportamento richiesto per i file importati senza texture.
            function applyMaterialMap(data) {
                if (!data || !data.metadata) return data;
                const map = data.metadata.material_map;
                if (!Array.isArray(map) || !Array.isArray(data.voxels)) return data;
                const known = new Set((data.metadata.materials || []).map(m => m.id));
                const byKey = new Map();
                map.forEach(entry => {
                    if (!Array.isArray(entry) || entry.length < 4) return;
                    const id = entry[0];
                    if (!known.has(id)) return;
                    for (let i = 1; i + 2 < entry.length; i += 3) {
                        byKey.set(entry[i] + ',' + entry[i + 1] + ',' + entry[i + 2], id);
                    }
                });
                if (byKey.size === 0) return data;
                data.voxels.forEach(v => {
                    const id = byKey.get(v.x + ',' + v.y + ',' + v.z);
                    if (id) v.material = id;
                });
                return data;
            }
```

Poi, nei **due** rami di `buildObjectPayload` (parti e piatto), sostituisci il `return` finale in modo che il metadata porti i materiali. Nel ramo con le parti:

```js
                    return {
                        metadata: withMaterials({
                            name: meta.name || "voxel_model",
                            grid_size: meta.grid_size || [16, 16, 16]
                        }, meta, voxels),
                        palette: palette,
                        parts: parts
                    };
```

e nel ramo piatto:

```js
                return {
                    metadata: withMaterials({
                        name: meta.name || "voxel_model",
                        grid_size: meta.grid_size || [16, 16, 16]
                    }, meta, voxels),
                    palette: palette,
                    ops: ops
                };
```

con l'aiutante, subito sotto `applyMaterialMap`:

```js
            // Aggiunge materiali e mappa al metadata SOLO se ce ne sono: un progetto
            // senza materiali continua a produrre file identici a prima.
            function withMaterials(out, meta, voxels) {
                const defs = (meta && Array.isArray(meta.materials)) ? meta.materials : [];
                const map = buildMaterialMap(voxels);
                if (defs.length) out.materials = defs;
                if (map.length) out.material_map = map;
                return out;
            }
```

- [ ] **Step 4: Applicare la mappa in ingresso**

In `ui/src/lib/04-objects.js`, in `loadSceneFromParsed`, sostituisci

```js
            const data = expandOps(parsed);
```

con

```js
            // expandOps NON conosce i materiali (le ops sono di soli colori):
            // si riversano subito dopo, dalla mappa nel metadata.
            const data = applyMaterialMap(expandOps(parsed));
```

Fai la stessa sostituzione in **ogni** punto di `04-objects.js` dove compare `expandOps(` — inclusi il ramo `parsed.objects` e `appendSceneFromParsed`. Trovali con:

```bash
grep -n "expandOps(" ui/src/lib/*.js
```

e avvolgi ognuno in `applyMaterialMap(...)` **tranne** quelli dentro `ui/src/utils/expand-ops.js` (che è l'implementazione) e quelli nei test.

- [ ] **Step 5: Rinfrescare il pannello dopo un caricamento**

Sempre in `04-objects.js`, in fondo a `loadSceneFromParsed` e a `setActiveObject`, aggiungi:

```js
            // Il pannello mostra i materiali del progetto ATTIVO, e la cache dei
            // MeshStandardMaterial e' indicizzata per id: cambiando oggetto gli id
            // possono voler dire materiali diversi.
            if (typeof clearMaterialCache === 'function') clearMaterialCache();
            if (typeof renderMaterialsPanel === 'function') renderMaterialsPanel();
```

- [ ] **Step 6: Eseguire i test**

Run: `node tests/test_materials.mjs`
Expected: PASS.

- [ ] **Step 7: Build + suite + prova manuale**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Poi nell'app: crea un materiale, posalo, salva il progetto, ricarica la pagina, riapri il progetto. La texture deve tornare.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/07-save-payload.js ui/src/lib/04-objects.js ui/src/lib/02-io-files.js tests/test_materials.mjs ui/index.html
git commit -m "feat(materiali): round-trip su salvataggio e import senza toccare il contratto ops"
```

---

### Task 8: Export OBJ/MTL con texture

**Files:**
- Modify: `ui/src/lib/06-export-obj.js:1-74` (greedyMesh), `:76-104` (mtl), `:106-161` (obj + bottone)
- Modify: `tests/test_materials.mjs`

**Interfaces:**
- Consumes: `tokenOf`, `decodeToken`, `isMaterialToken`, `materialById` (Task 2), `createZipBlob`, `downloadBlob` (`29-zip.js`)
- Produces:
  - `matNameFor(token) -> string` (accetta token, non più solo hex)
  - i quad di `greedyMesh` guadagnano `token` accanto a `color`, e `uw`/`uh` (estensione in voxel del quad, sorgente degli UV)
  - `textureFileName(id) -> string` — `tex_m1.png`

- [ ] **Step 1: Aggiungere i test che falliscono**

In `tests/test_materials.mjs`:

```js
// --- greedy mesh e UV -------------------------------------------------------
{
  const srcMat = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  const srcObj = fs.readFileSync(path.join(ROOT, 'ui/src/lib/06-export-obj.js'), 'latin1');
  // Il file registra listener su bottoni: stub minimo del DOM.
  const doc = { getElementById: () => ({ addEventListener: () => {} }), createElement: () => ({ style: {}, click: () => {} }) };
  const model = { metadata: { materials: [
    { id: 'm1', name: 'A', color: '#8B5A2B', texture: { data: 'data:image/png;base64,AAA', w: 8, h: 8 }, roughness: .5, metalness: 0, emissive: 0 }] }, voxels: [] };
  const mod = new Function('currentModelData', 'localStorage', 'document', 'URL',
    srcMat + srcObj + `;return { greedyMesh, matNameFor, buildMtlText, textureFileName };`)(
    model, fakeStore, doc, { createObjectURL: () => 'blob:', revokeObjectURL: () => {} });

  // Due voxel affiancati, stesso token: il mesher li unisce in un quad 2x1.
  const uniti = mod.greedyMesh([
    { x:0, y:0, z:0, color: '#8B5A2B', material: 'm1' },
    { x:1, y:0, z:0, color: '#8B5A2B', material: 'm1' }
  ]);
  const sopra = uniti.filter(q => q.normal[1] === 1);
  check('il mesher unisce due voxel dello stesso token', sopra.length === 1, JSON.stringify(sopra.map(q=>q.token)));
  check('il quad unito porta l\'estensione in voxel per gli UV',
    sopra[0].uw * sopra[0].uh === 2, JSON.stringify({ uw: sopra[0].uw, uh: sopra[0].uh }));

  // Stesso colore, materiali diversi: NON si uniscono, altrimenti l'export
  // applicherebbe una sola texture a entrambi.
  const divisi = mod.greedyMesh([
    { x:0, y:0, z:0, color: '#8B5A2B', material: 'm1' },
    { x:1, y:0, z:0, color: '#8B5A2B' }
  ]);
  check('il mesher NON unisce token diversi',
    divisi.filter(q => q.normal[1] === 1).length === 2,
    JSON.stringify(divisi.filter(q => q.normal[1] === 1).length));

  check('matNameFor di un token materiale e\' un nome OBJ valido',
    mod.matNameFor('@m1') === 'mat_m1' && !/[#@]/.test(mod.matNameFor('@m1')), mod.matNameFor('@m1'));
  check('matNameFor di un colore e\' invariato', mod.matNameFor('#AABBCC') === 'mat_AABBCC');
  check('textureFileName e\' stabile', mod.textureFileName('m1') === 'tex_m1.png');

  const mtl = mod.buildMtlText([{ x:0,y:0,z:0, color:'#8B5A2B', material:'m1' }]);
  check('il .mtl referenzia il PNG', mtl.indexOf('map_Kd tex_m1.png') !== -1, mtl);
  check('il .mtl tiene anche Kd, cosi\' resta sensato senza i PNG',
    /newmtl mat_m1[\s\S]*?Kd 0\.5451/.test(mtl), mtl);
}
```

- [ ] **Step 2: Eseguire per vederlo fallire**

Run: `node tests/test_materials.mjs`
Expected: FAIL — il mesher unisce token diversi, `textureFileName` non esiste.

- [ ] **Step 3: Portare `greedyMesh` sul token**

In `ui/src/lib/06-export-obj.js`, dentro `greedyMesh`, sostituisci ogni `map.set(key, vx.color.toUpperCase())` con `map.set(key, tokenOf(vx))`, e i due confronti di crescita:

```js
                                    if (m && m.color === start.color && m.back === start.back) wq++; else break;
```
```js
                                        if (!(m && m.color === start.color && m.back === start.back)) { grow = false; break; }
```

restano identici nella forma — cambia solo cosa contiene `start.color`, che ora è un token. Rinomina però il campo emesso per non far credere che sia un hex, sostituendo la `push`:

```js
                                quads.push({ verts, color: start.color, normal });
```

con:

```js
                                // `token` e' cio' su cui il mesher ha unito ('#RRGGBB' o
                                // '@m1'); `uw`/`uh` sono l'estensione del quad in VOXEL e
                                // servono agli UV: la texture si ripete una volta per
                                // voxel invece di stirarsi su tutto il quad.
                                quads.push({ verts, color: start.color, token: start.color, normal, uw: wq, uh: hq });
```

adattando i nomi `wq`/`hq` a quelli reali del ciclo in quel punto.

- [ ] **Step 4: `matNameFor`, `textureFileName`, `.mtl`**

```js
            // Nome materiale per un TOKEN, ripulito perche' sia un token OBJ/MTL valido
            // (Blender e' schizzinoso: niente '#', niente '@').
            function matNameFor(token) {
                if (isMaterialToken(token)) return `mat_${token.slice(1)}`;
                return `mat_${token.replace('#', '').toUpperCase()}`;
            }

            function textureFileName(id) { return `tex_${id}.png`; }
```

e `buildMtlText`:

```js
            function buildMtlText(voxelsOverride) {
                let mtlText = `# Voxel Materials File\n# Exported from VoxelAIArtist\n\n`;
                const allVoxels = voxelsOverride || currentModelData.voxels || [];
                const uniqueTokens = [...new Set(allVoxels.map(v => tokenOf(v)))];
                uniqueTokens.forEach(token => {
                    const dec = decodeToken(token);
                    const def = dec.material ? materialById(dec.material) : null;
                    const hex = dec.color.replace('#', '');
                    const r = parseInt(hex.substring(0, 2), 16) / 255.0;
                    const g = parseInt(hex.substring(2, 4), 16) / 255.0;
                    const b = parseInt(hex.substring(4, 6), 16) / 255.0;
                    mtlText += `newmtl ${matNameFor(token)}\n`;
                    // Kd resta anche con la texture: un .mtl aperto SENZA i PNG accanto
                    // mostra allora la tinta media invece del bianco.
                    mtlText += `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}\n`;
                    mtlText += `Ka ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}\n`;
                    mtlText += `Ks 0.0000 0.0000 0.0000\n`;
                    mtlText += `Ns 1.0000\n`;
                    mtlText += `d 1.0000\n`;
                    mtlText += `illum 1\n`;
                    if (def && def.texture && def.texture.data) {
                        mtlText += `map_Kd ${textureFileName(def.id)}\n`;
                    }
                    mtlText += `\n`;
                });
                return mtlText;
            }
```

- [ ] **Step 5: UV nell'OBJ**

In `buildObjText`, aggiungi accanto a `vIndex`/`nIndex` un indice per gli UV e usa `q.uw`/`q.uh`:

```js
                const tIndex = new Map(); const tLines = [];
                const tId = (u, v) => {
                    const key = `${u},${v}`;
                    let id = tIndex.get(key);
                    if (id === undefined) { tLines.push(`vt ${u} ${v}`); id = tLines.length; tIndex.set(key, id); }
                    return id;
                };
```

e sostituisci il corpo del `quads.forEach`:

```js
                quads.forEach(q => {
                    const mat = matNameFor(q.token);
                    const ni = nId(q.normal);
                    const ids = q.verts.map(p => vId(p));
                    // UV 0..uw / 0..uh con wrap `repeat`: un quad che copre 3x2 voxel
                    // ripete la texture 3x2 volte. Con 0..1 la texture si stirerebbe
                    // sul quad intero e i voxel uniti dal greedy mesh sembrerebbero
                    // un blocco solo.
                    const uvs = [tId(0, 0), tId(0, q.uh), tId(q.uw, q.uh), tId(q.uw, 0)];
                    const line = `f ${ids.map((id, i) => `${id}/${uvs[i]}/${ni}`).join(' ')}`;
                    (facesByMat[mat] = facesByMat[mat] || []).push(line);
                });
```

e la riga che concatena i blocchi:

```js
                objText += vLines.join('\n') + '\n' + tLines.join('\n') + '\n' + nLines.join('\n') + '\n\n';
```

- [ ] **Step 6: ZIP quando ci sono texture**

Sostituisci il listener del bottone export OBJ:

```js
            // Con le texture i file diventano N+2 e scaricarli uno a uno e' scomodo
            // (e i browser bloccano i download multipli). Senza texture resta il doppio
            // download di prima: nessuna regressione per chi non usa i materiali.
            function texturedMaterialsInUse(voxels) {
                const ids = new Set(voxels.filter(v => v.material).map(v => v.material));
                const out = [];
                ids.forEach(id => {
                    const def = materialById(id);
                    if (def && def.texture && def.texture.data) out.push(def);
                });
                return out;
            }

            function dataUrlToBytes(dataUrl) {
                const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                const bin = atob(b64);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            }

            document.getElementById('exportObjBtn').addEventListener('click', () => {
                const meta = currentModelData.metadata || {};
                const name = (meta.name || "voxel_model").replace(/\s+/g, '_');
                const voxels = currentModelData.voxels || [];
                const textured = texturedMaterialsInUse(voxels);
                if (textured.length === 0) {
                    downloadFile(buildMtlText(), `${name}.mtl`, 'text/plain');
                    setTimeout(() => downloadFile(buildObjText(`${name}.mtl`), `${name}.obj`, 'text/plain'), 150);
                    return;
                }
                const files = [
                    { name: `${name}.obj`, data: buildObjText(`${name}.mtl`) },
                    { name: `${name}.mtl`, data: buildMtlText() }
                ];
                textured.forEach(def => files.push({ name: textureFileName(def.id), data: dataUrlToBytes(def.texture.data) }));
                downloadBlob(createZipBlob(files), `${name}.zip`);
            });
```

Verifica in `ui/src/lib/29-zip.js` la firma esatta accettata da `createZipBlob` (nome del campo dei contenuti e se accetta `Uint8Array` oltre alle stringhe); se differisce, adegua **questa** chiamata, non il modulo zip.

- [ ] **Step 7: Eseguire i test**

Run: `node tests/test_materials.mjs && bash tests/run_all.sh`
Expected: verde. Il test dello ZIP e quello del pack non devono regredire.

- [ ] **Step 8: Prova in Blender (manuale, consigliata)**

Esporta un modello con una texture, apri lo ZIP, importa l'`.obj` con `.mtl` e PNG nella stessa cartella: la texture deve ripetersi una volta per voxel, non stirarsi.

- [ ] **Step 9: Commit**

```bash
git add ui/src/lib/06-export-obj.js tests/test_materials.mjs ui/index.html
git commit -m "feat(materiali): export OBJ/MTL con UV e texture, in ZIP quando servono i PNG"
```

---

### Task 9: Export GLB con texture

**Files:**
- Modify: `ui/src/lib/16-export-glb.js:66-131`
- Modify: `ui/src/lib/15-rig.js` (il raggruppamento in `buildSkinnedMesh`)

**Interfaces:**
- Consumes: `tokenOf`, `decodeToken`, `materialById`, `threeMaterialFor` (Task 2-3)
- Produces: nessuna API nuova.

- [ ] **Step 1: Aggiungere gli UV alla mesh statica**

In `buildStaticExportMesh`, sostituisci il raggruppamento:

```js
                    const byColor = {};
                    partData.voxels.forEach(v => {
                        if (!byColor[v.color]) byColor[v.color] = [];
                        byColor[v.color].push(v);
                    });
```

con:

```js
                    // Per TOKEN, non per colore: due voxel dello stesso colore con
                    // materiali diversi vogliono due materiali glTF distinti.
                    const byColor = {};
                    partData.voxels.forEach(v => {
                        const tok = tokenOf(v);
                        if (!byColor[tok]) byColor[tok] = [];
                        byColor[tok].push(v);
                    });
```

Aggiungi l'array `uvs` accanto a `positions`/`normals`:

```js
                    const positions = [], normals = [], uvs = [], indices = []; let vbase = 0;
```

e dentro il ciclo delle facce sostituisci il ciclo dei 4 vertici:

```js
                                for (let k = 0; k < 4; k++) {
                                    const vt = f.v[k];
                                    positions.push((v.x + vt[0] * s - o.x) * K,
                                        (v.y + vt[1] * s - o.y) * K,
                                        (v.z + vt[2] * s - o.z) * K);
                                    normals.push(f.n[0], f.n[1], f.n[2]);
                                }
```

con:

```js
                                for (let k = 0; k < 4; k++) {
                                    const vt = f.v[k];
                                    positions.push((v.x + vt[0] * s - o.x) * K,
                                        (v.y + vt[1] * s - o.y) * K,
                                        (v.z + vt[2] * s - o.z) * K);
                                    normals.push(f.n[0], f.n[1], f.n[2]);
                                    // CUBE_FACES ha winding coerente su tutte e 6 le
                                    // facce, quindi lo stesso quadrato UV vale per
                                    // ognuna: e' esattamente "la stessa texture su
                                    // tutte e 6 le facce".
                                    uvs.push(UV_UNIT[k][0], UV_UNIT[k][1]);
                                }
```

con la costante dichiarata accanto a `CUBE_FACES`, in cima al file:

```js
            const UV_UNIT = [[0, 0], [0, 1], [1, 1], [1, 0]];
```

Registra l'attributo accanto agli altri:

```js
                    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
```

- [ ] **Step 2: Materiale con texture nell'export**

Sostituisci la creazione del materiale:

```js
                        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.25, side: THREE.FrontSide });
                        mat.name = hexColor;
```

con:

```js
                        const dec = decodeToken(hexColor);
                        const def = dec.material ? materialById(dec.material) : null;
                        // FrontSide, non DoubleSide: vedi il commento sopra sul culling
                        // per-parte. Vale anche coi materiali texturizzati.
                        const mat = new THREE.MeshStandardMaterial({
                            color: col,
                            roughness: def ? def.roughness : 0.35,
                            metalness: def ? def.metalness : 0.25,
                            side: THREE.FrontSide
                        });
                        if (def && def.emissive > 0) {
                            mat.emissive = new THREE.Color(dec.color).convertSRGBToLinear();
                            mat.emissiveIntensity = def.emissive;
                        }
                        if (def && def.texture && def.texture.data) {
                            const tex = new THREE.TextureLoader().load(def.texture.data);
                            tex.magFilter = THREE.NearestFilter;
                            tex.minFilter = THREE.NearestFilter;
                            tex.wrapS = THREE.RepeatWrapping;
                            tex.wrapT = THREE.RepeatWrapping;
                            tex.name = 'tex_' + def.id;
                            mat.map = tex;
                            // In glTF il colore finale e' baseColorFactor * texture:
                            // il fattore deve restare BIANCO, altrimenti si moltiplica
                            // due volte la tinta (stessa trappola dell'invariante 6 sul
                            // COLOR_0, vedi CLAUDE.md).
                            mat.color = new THREE.Color(0xffffff);
                        }
                        mat.name = hexColor;
```

Nota: `col` è calcolato più sopra come `new THREE.Color(hexColor).convertSRGBToLinear()`. Sostituisci quella riga con `const col = new THREE.Color(decodeToken(hexColor).color).convertSRGBToLinear();`, altrimenti `new THREE.Color('@m1')` produrrebbe nero.

- [ ] **Step 3: Stessa cosa sul percorso riggato**

In `ui/src/lib/15-rig.js`, trova il raggruppamento per colore di `buildSkinnedMesh` (`grep -n "byColor\|v.color" ui/src/lib/15-rig.js`) e applica le stesse tre modifiche: chiave = `tokenOf(v)`, colore del materiale = `decodeToken(tok).color`, aggiunta dell'attributo `uv` con `UV_UNIT`.

**Le 6 invarianti del `CLAUDE.md` restano ferme.** In particolare la 6: `outMesh.geometry.deleteAttribute('color')` in `exportGLB` **non** va rimossa — la texture non sostituisce COLOR_0, e lasciarlo darebbe di nuovo il colore al quadrato. E la 5: `deformsAlike` continua a decidere il culling; il token non c'entra col culling.

- [ ] **Step 4: Verificare che il rig non sia regredito**

Run: `node tests/test_glb_rigged_artifacts.mjs && node tests/test_glb_pose_export.mjs && node tests/test_rig_weights.mjs`
Expected: PASS. Un `ReferenceError` qui significa che manca codice **nei sorgenti**, non che il test è vecchio: fermati e riconcilia.

- [ ] **Step 5: Build + suite**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/16-export-glb.js ui/src/lib/15-rig.js ui/index.html
git commit -m "feat(materiali): GLB con UV e texture incorporata, statico e riggato"
```

---

### Task 10: Documentare il formato nel CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Scrivere la sezione**

Dopo la sezione *Compact model format*, aggiungi:

```markdown
### Materiali con texture

Un voxel ha **sempre** `color` e **facoltativamente** `material` (l'id di una voce
di `metadata.materials`). Il colore di un voxel texturizzato e' la tinta media
della texture: cosi' ogni percorso che pretende un hex (`.vox`, `.schem`, le
swatch, l'OBJ senza texture) funziona senza sapere che i materiali esistono, e un
id **orfano degrada da solo a tinta unita** — che e' il "materiale neutro"
richiesto per i file importati senza texture, ottenuto senza un ramo dedicato.

Le ops compatte sanno esprimere solo colori. I materiali NON vi entrano: viaggiano
in `metadata.material_map` (`[["m1", x,y,z, x,y,z], ...]`, stessa forma di una op
`set`) e vengono riversati sui voxel **dopo** l'espansione da `applyMaterialMap()`
in `07-save-payload.js`. Quindi `expand_ops` (Python) e `expandOps` (JS) **restano
intatti**: nessuna modifica accoppiata, la parita' ops non e' in gioco, e il
generatore AI continua a produrre ops di soli colori valide al 100%.

Internamente il raggruppamento passa da un **token**: `#RRGGBB` per un colore,
`@m1` per un materiale. E' il valore che sta dentro `voxelMap`, ed e' cosi' che i
~15 confronti sparsi per l'editor (che lo trattano come stringa opaca) sono
rimasti invariati. `tokenOf(v)` e `decodeToken(tok)` in `36-materials.js` sono
l'unico punto di conversione nelle due direzioni; `activeToken()` e' l'unico punto
da cui l'editing legge cosa si sta posando, ed e' li' che vive la mutua esclusione
colore/materiale.

I `MeshStandardMaterial` sono **condivisi e messi in cache** per token
(`threeMaterialFor`) e marcati `userData.shared`, come la `BoxGeometry`: liberarli
in `disposeMesh()` li renderebbe invalidi per gli altri mesh. Si liberano solo da
`clearMaterialCache()`, che va chiamata quando cambia una definizione o l'oggetto
attivo.

Negli export, gli UV di un quad greedy-meshed vanno `0..uw` / `0..uh` con wrap
`repeat`: la texture si ripete **una volta per voxel** invece di stirarsi sul quad
unito. Il greedy mesher unisce quindi solo facce con lo **stesso token**. Nel GLB
il `baseColorFactor` di un materiale texturizzato resta **bianco**: e' la stessa
trappola dell'invariante 6 (colore moltiplicato due volte).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: formato dei materiali e invarianti nel contesto di progetto"
```

---

## Fase C — Sweep i18n

Ogni task della fase segue lo **stesso ciclo**, ripetuto per intero:

1. Estrarre le stringhe del gruppo in chiavi `it.json` (il valore italiano è il testo esatto già presente).
2. Tradurle in `en/es/de/fr/pt`.
3. Sostituire nel codice: nel template basta l'annotazione automatica (`node ui/annotate-i18n.mjs`); nel JS si passa a `t('chiave')` o `t('chiave', {var})`.
4. `node tests/test_i18n_hardcoded.mjs` per leggere il conteggio nuovo.
5. **Abbassare** `BASELINE` ai numeri appena letti.
6. `node ui/build.mjs && bash tests/run_all.sh`.
7. Commit.

### Task 11: Template

**Files:**
- Modify: `ui/src/index.template.html`
- Modify: `ui/locales/*.json` (6)
- Modify: `tests/test_i18n_hardcoded.mjs` (baseline)

- [ ] **Step 1: Elencare i testi non annotati**

```bash
node tests/test_i18n_hardcoded.mjs
grep -n 'data-i18n' ui/src/index.template.html | wc -l
```

Poi individua i nodi rimasti confrontando: ogni `<label>`, `<button>`, `<option>`, `<p>`, `<div class="section-title">` con testo e senza `data-i18n`.

- [ ] **Step 2: Aggiungere le chiavi in `it.json`**

Con il **testo italiano esatto** già nel template, così l'annotatore le aggancia da solo. Esempi reali rilevati:

```json
  "draw.activeColor": "Colore Attivo",
  "draw.undo": "Annulla",
  "draw.redo": "Ripeti",
  "draw.hintView": "Modalita Vista: trascina per orbitare. Scegli uno strumento per modificare il modello.",
  "rig.sectionTitle": "Scheletro & Rigging",
  "rig.rotateSkeleton": "Ruota Scheletro",
  "settings.gridRecommended": "64 (consigliata)",
  "settings.fontSystem": "Sistema",
  "settings.fontMono": "Monospazio"
```

**Attenzione ai simboli.** `↶ Annulla` e `↷ Ripeti` hanno un carattere che in latin1 non esiste: nel template restano nel markup, ma la chiave i18n deve coprire **solo la parola**. Ristruttura il bottone così:

```html
                            <button class="btn btn-secondary" id="undoBtn" disabled
                                style="padding:8px; font-size:12px;"><span aria-hidden="true">&#8630;</span> <span data-i18n="draw.undo">Annulla</span></button>
```

I nomi propri (`Plus Jakarta Sans`, `Georgia (serif)`) **non** si traducono: lasciali, e se la guardia li conta, il conteggio resta comunque sotto baseline perché sono pochi e fissi.

- [ ] **Step 3: Tradurre nelle altre 5 lingue**

Stesse chiavi in `en/es/de/fr/pt`.

- [ ] **Step 4: Annotare e verificare**

```bash
node ui/annotate-i18n.mjs
node tests/test_i18n_hardcoded.mjs
```
Expected: il conteggio `template=` è sceso; i nodi hanno guadagnato `data-i18n`.

- [ ] **Step 5: Abbassare la baseline**

Aggiorna `BASELINE.template` al numero appena letto.

- [ ] **Step 6: Build + suite**

```bash
node ui/build.mjs && bash tests/run_all.sh
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/index.template.html ui/locales/*.json tests/test_i18n_hardcoded.mjs ui/index.html
git commit -m "i18n: estratte le stringhe residue del template"
```

---

### Task 12: La guida (`31-help.js`)

**Files:**
- Modify: `ui/src/lib/31-help.js`
- Modify: `ui/locales/*.json` (6)
- Modify: `tests/test_i18n_hardcoded.mjs` (baseline)

**Interfaces:**
- Consumes: `t` (`23-i18n.js`)

- [ ] **Step 1: Vedere quante sono**

```bash
grep -c "'" ui/src/lib/31-help.js
sed -n '1,80p' ui/src/lib/31-help.js
```

Il modulo costruisce le sezioni della guida come strutture dati: titoli, scorciatoie, descrizioni. Sono ~84 stringhe.

- [ ] **Step 2: Estrarle con namespace `help.*`**

Per ogni voce, una chiave `help.<sezione>.<voce>`. Esempio di trasformazione:

```js
                { title: 'Strumenti', items: [
                    { key: 'B', desc: 'Piazza un voxel' },
                ]}
```

diventa

```js
                { title: t('help.tools.title'), items: [
                    { key: 'B', desc: t('help.tools.place') },
                ]}
```

con `it.json`:

```json
  "help.tools.title": "Strumenti",
  "help.tools.place": "Piazza un voxel"
```

**Il momento della valutazione conta.** Se le sezioni sono in una costante a livello di modulo, `t()` gira **prima** che i dizionari siano caricati e la guida resta in italiano anche cambiando lingua. Sposta la costante dentro una funzione chiamata all'apertura della guida:

```js
            // Le stringhe si risolvono all'APERTURA, non al caricamento del modulo:
            // a livello top i18nDict e' ancora vuoto (vedi il commento su `var` in
            // 23-i18n.js) e la guida resterebbe congelata nella lingua d'avvio.
            function helpSections() {
                return [ /* ... */ ];
            }
```

e usa `helpSections()` dove prima si leggeva la costante.

- [ ] **Step 3: Tradurre nelle altre 5 lingue**

- [ ] **Step 4: Verificare a schermo**

Apri l'app, cambia lingua in inglese, premi F1: la guida deve essere in inglese.

- [ ] **Step 5: Abbassare la baseline e chiudere**

```bash
node tests/test_i18n_hardcoded.mjs   # leggi js=N
# aggiorna BASELINE.js = N
node ui/build.mjs && bash tests/run_all.sh
git add ui/src/lib/31-help.js ui/locales/*.json tests/test_i18n_hardcoded.mjs ui/index.html
git commit -m "i18n: guida tradotta e risolta all'apertura"
```

---

### Task 13: Moduli rig (`15-rig.js`, `32-rig-tools.js`, `33-timeline.js`)

**Files:**
- Modify: `ui/src/lib/15-rig.js`, `ui/src/lib/32-rig-tools.js`, `ui/src/lib/33-timeline.js`
- Modify: `ui/locales/*.json` (6)
- Modify: `tests/test_i18n_hardcoded.mjs` (baseline)

- [ ] **Step 1: Elencare le stringhe**

```bash
grep -n "alert(\|confirm(\|prompt(\|textContent =\|\.title =" ui/src/lib/15-rig.js ui/src/lib/32-rig-tools.js ui/src/lib/33-timeline.js
```

- [ ] **Step 2: Estrarre con namespace `rig.*` e `timeline.*`**

I testi costruiti per concatenazione diventano segnaposto. Esempio:

```js
                alert('Osso ' + b.name + ' non trovato nella posa.');
```
diventa
```js
                alert(t('rig.boneNotInPose', { name: b.name }));
```
con `it.json`: `"rig.boneNotInPose": "Osso {name} non trovato nella posa."`

**I nomi delle ossa (`upperArm_R`, `spine`) non si traducono**: sono identificatori del formato, e tradurli romperebbe i preset e il round-trip del rig.

- [ ] **Step 3: Tradurre nelle altre 5 lingue**

- [ ] **Step 4: Verificare che i test del rig non regrediscano**

```bash
node tests/test_anim_presets.mjs && node tests/test_rig_weights.mjs && node tests/test_channel_keys.mjs && node tests/test_rig_parts_legs.mjs
```
Expected: PASS.

- [ ] **Step 5: Abbassare la baseline e chiudere**

```bash
node tests/test_i18n_hardcoded.mjs
# aggiorna BASELINE.js
node ui/build.mjs && bash tests/run_all.sh
git add ui/src/lib/15-rig.js ui/src/lib/32-rig-tools.js ui/src/lib/33-timeline.js ui/locales/*.json tests/test_i18n_hardcoded.mjs ui/index.html
git commit -m "i18n: moduli rig, timeline e strumenti scheletro"
```

---

### Task 14: I moduli restanti e la baseline a zero

**Files:**
- Modify: `ui/src/lib/{01-scene-setup,02-io-files,04-objects,08-generate-ai,09-editing-engine,10-extrude-core,11-symmetry-tools,14-tools-actions,19-prefs,20-formats,21-project,24-plugins,25-properties,26-settings-modal,27-pack,28-incremental,30-import-glb}.js`
- Modify: `ui/locales/*.json` (6)
- Modify: `tests/test_i18n_hardcoded.mjs`

- [ ] **Step 1: Lavorare un modulo alla volta**

Per ciascuno: estrai le stringhe con il namespace del modulo (`project.*`, `formats.*`, `objects.*`, `pack.*`, `settings.*`, `plugins.*`, `tools.*`, `prefs.*`), traducile, sostituisci con `t()`. Dopo ogni modulo esegui `node tests/test_i18n_hardcoded.mjs` e abbassa la baseline: così un errore resta circoscritto a un commit.

Casi da trattare esplicitamente:

- `24-plugins.js` — il **codice** degli script d'esempio resta com'è (è codice), ma i suoi **commenti in italiano** sono testo che l'utente legge nell'editor: traducili con `t()` e interpolali nel sorgente d'esempio.
- `22-screens.js` — resta nell'allow-list: il CSS iniettato non è testo.
- `08-generate-ai.js` — i prompt inviati al backend **non** si traducono (`assets/prompts/` è fuori perimetro): traduci solo i messaggi mostrati all'utente.

- [ ] **Step 2: Portare la baseline a zero**

Quando entrambi i conteggi sono 0, sostituisci in `tests/test_i18n_hardcoded.mjs`:

```js
const BASELINE = { template: 0, js: 0 };
```

con:

```js
// Sweep concluso: la guardia e' ASSOLUTA. Nessuna baseline da alzare — se questo
// test fallisce, una stringa nuova e' stata scritta hardcoded: va estratta.
const BASELINE = { template: 0, js: 0 };
```

e in `check()` cambia i messaggi da "non sale" a "e' zero":

```js
check('nessun testo hardcoded nel template', tpl === 0,
  `${tpl} testi senza data-i18n: estraili in chiavi i18n`);
check('nessun testo hardcoded nei moduli JS', js === 0,
  `${js} stringhe italiane: usa t('chiave')`);
```

- [ ] **Step 3: Aggiornare la regola nel CLAUDE.md**

Sostituisci l'ultima riga della regola aggiunta nel Task 1:

```markdown
  `tests/test_i18n_hardcoded.mjs` e' la guardia. Se fallisce, la stringa va
  estratta, non aggiunta all'allow-list.
```

con:

```markdown
  `tests/test_i18n_hardcoded.mjs` e' la guardia ed e' ASSOLUTA (zero tolleranza:
  la baseline decrescente e' servita solo durante lo sweep del 2026-08-04 ed e'
  stata rimossa). Se fallisce, la stringa va estratta, non aggiunta all'allow-list.
```

- [ ] **Step 4: Prova finale in tutte le lingue**

Apri l'app e passa per ognuna delle 6 lingue: nessun testo deve restare in italiano (a parte i nomi propri dei font). Controlla in particolare la guida (F1), il pannello materiali, il rig e i messaggi d'errore.

- [ ] **Step 5: Suite completa**

```bash
node ui/build.mjs && bash tests/run_all.sh
```
Expected: tutto verde.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib ui/locales/*.json tests/test_i18n_hardcoded.mjs CLAUDE.md ui/index.html
git commit -m "i18n: sweep completato, la guardia diventa assoluta"
```

---

## Note per chi esegue

- **Prima di ogni `node ui/build.mjs`**: `grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js`. Se il bundle ha simboli che i sorgenti non hanno, **fermati**: il bundle è avanti e rigenerarlo distruggerebbe codice. Il recupero è documentato in `CLAUDE.md`.
- **Un `ReferenceError` da `test_glb_rigged_artifacts`, `test_rig_weights`, `test_channel_keys`, `test_glb_pose_export` o `test_rig_parts_legs`** significa che manca codice **nei sorgenti**, non che il test è stale. Non liquidarlo come pre-esistente: anche HEAD può essere rotto.
- **Latin1**: se `node ui/build.mjs` si lamenta di un carattere non rappresentabile, hai scritto un bullet, un trattino lungo o una virgoletta tipografica in un file di `ui/src/`. Nei `ui/locales/*.json` gli accenti sono invece ammessi.
- **Non toccare** `src/parser.py::expand_ops` né `ui/src/utils/expand-ops.js`: questo lavoro è progettato apposta per non richiederlo.
