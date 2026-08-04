# Materiali con texture + i18n universale — design

Data: 2026-08-04
Stato: approvato per la pianificazione

## Obiettivo

Due lavori distinti, richiesti insieme, con un ordine che li rende complementari:

1. **i18n universale.** Nessun testo utente hardcoded in nessun punto del frontend —
   template, codice JS, guide, messaggi d'errore, testi generati a runtime. La regola
   entra nel `CLAUDE.md` e diventa *eseguibile* grazie a un test-guardia.
2. **Pannello materiali** nel tab *Disegna*, sopra quello dei plugin. Permette di creare
   materiali con una texture (applicata a tutte e 6 le facce del voxel) più
   ruvidità/metallicità/emissivo. Selezionare un materiale annulla il colore attivo e
   viceversa.

L'ordine è: regola + guardia → materiali → sweep i18n del resto. Invertirlo farebbe
aggiungere debito i18n (i testi del pannello nuovo) nello stesso momento in cui lo si
sta ripagando.

## Decisioni prese col committente

| Domanda | Risposta |
|---|---|
| Fin dove arrivano le texture nell'export | Tutto: `.voxai`/JSON, ZIP, OBJ/MTL con PNG, GLB incorporato. Vincolo esplicito: JSON e `.voxai` devono essere **reimportabili**; un file senza texture deve ricadere su un **materiale neutro a tinta unita** |
| Come il voxel lega il materiale | Campo `material` **accanto** a `color` (non un `color` polimorfo) |
| Ampiezza dell'i18n | Tutto il frontend in un colpo (template + guida + moduli JS) |
| Dove vivono i materiali | Nel progetto **e** in una libreria personale riutilizzabile |
| Cosa contiene un materiale | Texture + ruvidità + metallicità + emissivo |

## Parte 1 — i18n universale

### 1a. La regola nel CLAUDE.md

Nuova sezione in *Conventions & gotchas*:

- Nessun testo destinato all'utente è hardcoded. Nel template si annota con
  `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`; nel JS si passa da
  `t('chiave')`.
- La lingua sorgente è `ui/locales/it.json`: i suoi valori **sono** i testi italiani
  reali. Una stringa nuova si aggiunge prima lì, poi nelle altre 6 lingue.
- La regola copre anche **guide, hint, conferme, messaggi d'errore e testi costruiti a
  runtime** (template literal inclusi: si usano i placeholder `{nome}` di `t()`, non la
  concatenazione).
- `t()` è chiamabile prima di `bootI18n` e in quel caso ritorna la chiave nuda: non è un
  bug da aggirare con un fallback italiano hardcoded.
- Il test `tests/test_i18n_hardcoded.mjs` è la guardia. Se fallisce, la stringa va
  estratta, non aggiunta all'allow-list.

### 1b. La guardia (`tests/test_i18n_hardcoded.mjs`)

Scanner deterministico, senza dipendenze, in due metà:

- **Template**: elementi foglia con testo non vuoto e senza `data-i18n`, più
  `title=` / `placeholder=` senza il corrispettivo `data-i18n-*`. Ignora i nodi di solo
  simboli/numeri (`↶`, `#6366F1`, `+90°`) — quelli non si traducono.
- **Moduli JS**: letterali stringa che contengono parole italiane, dopo aver rimosso i
  commenti (lo strip dei commenti è il punto delicato: uno strip ingenuo scambia `//`
  dentro una stringa per un commento; lo scanner scorre il carattere e traccia i
  delimitatori).

Falsi positivi legittimi, da allow-list nominale e motivata:

- `22-screens.js` — CSS inline iniettato (`.launcher-recent-del{...}`): non è testo.
- `24-plugins.js` — il **codice** degli script d'esempio è codice; i suoi *commenti in
  italiano* però sono testo che l'utente legge, quindi vanno tradotti.
- Nomi di font in `<option>` (`Plus Jakarta Sans`, `Georgia (serif)`): nomi propri.
  `Sistema` e `Monospazio` invece si traducono.

**Baseline decrescente.** Alla nascita la guardia registra il conteggio corrente
(rilevato: ~50 testi nel template, ~280 stringhe nei moduli JS, di cui 84 nella sola
guida `31-help.js`) e fallisce solo se il numero **sale**. Ogni passo dello sweep abbassa
la baseline. A sweep concluso la baseline è 0 e il meccanismo si rimuove: il test diventa
assoluto.

### 1c. Lo sweep

Chiavi nuove con namespace per modulo: `help.*`, `rig.*`, `project.*`, `formats.*`,
`objects.*`, `settings.*`, `materials.*`. Ogni chiave aggiunta a tutte e 7 le lingue —
il test *"Chiavi i18n complete"* di `run_all.sh` già impone parità esatta e assenza di
valori vuoti, quindi una lingua dimenticata fa fallire la suite.

Per il template, `ui/annotate-i18n.mjs` fa il lavoro da sé: annota per **valore**
partendo da `it.json`, quindi basta aggiungere la chiave col testo italiano esatto già
presente nel template. È idempotente e girato a ogni build.

## Parte 2 — Materiali

### Formato dei dati

Nel modello:

```json
{
  "metadata": {
    "materials": [{
      "id": "m1",
      "name": "Legno",
      "texture": { "data": "data:image/png;base64,...", "w": 128, "h": 128 },
      "color": "#8B5A2B",
      "roughness": 0.7,
      "metalness": 0.0,
      "emissive": 0.0
    }]
  },
  "voxels": [{ "x": 0, "y": 0, "z": 0, "color": "#8B5A2B", "material": "m1" }]
}
```

Due invarianti che rendono il formato indistruttibile:

1. **`color` è sempre presente** e vale la tinta media della texture. Ogni percorso che
   pretende un hex — `.vox` (RGB puro), `.schem`, le swatch della palette, l'OBJ senza
   texture — continua a funzionare senza sapere che i materiali esistono.
2. **`material` è opzionale e non autoritativo.** Un id che non trova riscontro in
   `metadata.materials` ricade sul colore. È così che si ottiene il "materiale neutro a
   tinta unita" richiesto per i file importati senza texture: nessun ramo di codice
   dedicato, solo l'assenza di una voce.

### Token interno (perché non è una contraddizione col campo separato)

`voxelMap` è una `Map<"x,y,z", string>` e mezza dozzina di confronti dipende dal valore
essendo una stringa sola (`14-tools-actions.js:179`, `:368`, `12-extrude-logic.js:132`,
`01-scene-setup.js:372`). Dentro la mappa si usa quindi un **token**: `#RRGGBB` per un
colore, `@<id>` per un materiale. `syncVoxelsFromMap()` decodifica il token nei due campi
quando scrive i voxel.

Il campo separato resta il formato su disco — è la decisione presa. Il token è solo la
rappresentazione interna del raggruppamento, e serve a tenere il diff contenuto sui ~15
call site di `activeColorHex`. Una funzione sola in entrambe le direzioni:

- `tokenOf(v)` → `v.material ? '@' + v.material : v.color.toUpperCase()`
- `decodeToken(tok)` → `{ color, material }`, risolvendo il colore di fallback dal
  materiale

Gli **id** sono `m1`, `m2`, … assegnati dal primo intero libero nel progetto. Pescare un
materiale dalla libreria personale in un progetto che ha già quell'id lo **rinumera** e
aggiorna i voxel: due progetti diversi non possono litigare su `m1`.

Le **swatch della palette** (`renderPaletteSwatches`, `28-incremental.js:322`) mostrano la
miniatura della texture come `background-image` per un token materiale e il colore pieno
per un token colore; il click seleziona l'uno o l'altro, coerentemente con la mutua
esclusione.

### Nuovo modulo: `ui/src/lib/36-materials.js`

Inserito nel manifest **dopo** `35-primitives.js` e prima di `18-bootstrap-tail.js`.
Responsabilità unica: possedere i materiali e la loro UI. Espone:

- `materialsOfProject()` / `materialById(id)` / `addMaterial(def)` / `removeMaterial(id)`
- `tokenOf(v)` / `decodeToken(tok)` / `isMaterialToken(tok)`
- `threeMaterialFor(token, opts)` — costruisce e **mette in cache** il
  `MeshStandardMaterial`, con `map` (`NearestFilter`, `RepeatWrapping`) o `color`
- `importTextureFile(file)` — ridimensiona a max 128×128 su canvas, ricava la tinta media
  dallo stesso canvas, ritorna il data URL
- `activeMaterialId` e `setActiveMaterial(id | null)`
- libreria personale in `localStorage['voxelai-material-library']`, tetto di **40 voci**
  (le texture pesano più di una posa, che ne ha 60), sul modello di `POSE_LIB_KEY`
  (`32-rig-tools.js:370`)

`emissive` è un **numero 0..1**, l'intensità: in glTF diventa `emissiveFactor` =
`color × emissive`, così un materiale luminoso brilla della propria tinta e non serve un
secondo selettore di colore nell'interfaccia.

Il ridimensionamento a 128×128 con `NearestFilter` non è arbitrario: la voxel art non
vuole interpolazione, e una texture 4K in base64 dentro ogni `.voxai` renderebbe i
progetti enormi e l'autosave lento.

### Rendering

`05-build-model.js:81` e il percorso incrementale (`28-incremental.js`) raggruppano per
`tokenOf(v)` invece che per `v.color`; il materiale THREE viene da `threeMaterialFor()`.
Resta **una draw call per token**, come oggi per colore, e il raycast per-voxel è intatto.

La `BoxGeometry` di Three mappa già UV 0..1 su ciascuna delle 6 facce: "stessa texture su
tutte e 6 le facce" non richiede geometria nuova.

**Punto più a rischio dell'intero lavoro**: `computePaletteSignature()` nell'incrementale.
Se la firma non include i token materiale, le swatch non si aggiornano quando cambia il
set di materiali. `tests/test_incremental.mjs` è il giudice — impone equivalenza fra
percorso incrementale e rebuild completo, e va esteso a un modello con materiali.

### Editing e mutua esclusione

`activeColorHex` resta il colore. Si aggiunge `activeMaterialId` (null = si posa colore).
Le celle scritte usano il token, quindi i call site cambiano di una parola.

Regola d'interfaccia, come richiesto:

- click su un materiale → `activeMaterialId = id`; l'input colore si smorza (classe CSS,
  non `disabled`: deve restare cliccabile per tornare al colore) e l'etichetta mostra il
  nome del materiale;
- input colore, contagocce su un voxel non texturizzato, o click su una swatch-colore →
  `activeMaterialId = null` e il materiale perde l'evidenza.

Il contagocce su un voxel **texturizzato** seleziona il suo materiale: è il
comportamento che l'utente si aspetta e cade fuori gratis dal token.

### Pannello (template)

Nel tab `data-panel="draw"`, fra la sezione *Strumenti di Modifica* e *Plugin & Script*:
`section-title` con `data-i18n="materials.sectionTitle"` e un `controls-group glass`
`id="materialsPanel"` con griglia dei materiali (miniatura + nome), `+ Nuovo materiale`
(dialogo con file immagine, nome, tre cursori), duplica/elimina, e il ponte con la
libreria personale. Tutto annotato `data-i18n*` dalla nascita.

### Export

**OBJ/MTL.** `matNameFor(token)` accetta il token. Per un materiale:
`newmtl mat_m1`, `map_Kd tex_m1.png`, e `Kd` = colore di fallback (così un `.mtl` aperto
senza i PNG resta sensato). Gli UV: il greedy mesher unisce facce coplanari, quindi un
quad copre `w × h` voxel e gli UV vanno `0..w` / `0..h` con wrap `repeat` — la texture si
ripete **una volta per voxel** invece di stirarsi sul quad. Serve emettere le righe `vt`
e passare le facce a `f v/vt/vn`. Il greedy mesher deve inoltre unire solo facce con lo
**stesso token**, non solo lo stesso colore.

Poiché i file diventano N+2, **quando il modello ha materiali con texture l'export OBJ
produce uno ZIP** (`29-zip.js`, già presente e testato) con obj+mtl+png. Senza materiali
resta il doppio download sfalsato attuale: nessuna regressione per chi non usa texture.

**GLB.** `buildStaticExportMesh` (`16-export-glb.js:33`) raggruppa per token e aggiunge
l'attributo `uv` (0..1 per faccia); `buildSkinnedMesh` (`15-rig.js`) fa lo stesso per il
riggato. `GLTFExporter` in modalità binaria incorpora l'immagine. Le 6 invarianti del
`CLAUDE.md` restano ferme — in particolare la **rimozione dell'attributo `color` prima
dell'export** (invariante 6): la texture non la sostituisce, e lasciarlo darebbe di nuovo
`baseColorFactor * COLOR_0`.

**Progetto e ZIP del pack.** `metadata.materials` viaggia nel payload, quindi `.voxai`,
JSON e autosave hanno il round-trip gratis. L'export ZIP del pack include i PNG.

### Import

- JSON/`.voxai` con `metadata.materials` → ripristino completo.
- JSON con `material` ma senza `metadata.materials` → tinta unita dal `color`
  (l'invariante 2 in azione).
- `.vox` / `.schem` / GLB → nessun materiale, comportamento invariato.

## Test

| File | Cosa tiene fermo |
|---|---|
| `tests/test_materials.mjs` (nuovo) | round-trip del formato; fallback su `material` orfano; `tokenOf`/`decodeToken` come inverse; mutua esclusione colore↔materiale; raggruppamento del renderer per token; UV `0..w`/`0..h` del greedy mesh; il greedy mesh **non** unisce token diversi; tinta media |
| `tests/test_i18n_hardcoded.mjs` (nuovo) | la baseline non sale; lo strip dei commenti non scambia `//` dentro una stringa per un commento |
| `tests/test_incremental.mjs` (esteso) | equivalenza incrementale↔rebuild **con materiali**; la firma della palette reagisce al cambio di materiale |
| `run_all.sh` (esteso) | i due test nuovi entrano nella suite |
| Suite esistente | `test_glb_rigged_artifacts`, `test_glb_pose_export`, `test_zip`, parità ops, chiavi i18n: nessuna deve regredire |

## Rischi noti

1. **Percorso incrementale.** La firma della palette è il difetto più probabile. Mitigato
   dall'estensione di `test_incremental.mjs`.
2. **`ui/index.html` è generato e non è usa-e-getta.** Verificato all'inizio del lavoro:
   `grep -c deformsAlike` dà 2/2 fra bundle e sorgenti e un rebuild produce diff zero, il
   bundle **non** è avanti. Il controllo va ripetuto prima di ogni build.
3. **Peso dei progetti.** Texture in base64 dentro il `.voxai`; mitigato dal tetto
   128×128. Se un progetto con molti materiali rallentasse l'autosave, il passo successivo
   è spostare le texture in un sidecar dello ZIP — ma non ora, e non prima di misurarlo.
4. **Ampiezza dello sweep i18n.** ~330 stringhe: il rischio è la traduzione sbagliata, non
   il codice rotto. Le 6 lingue non-italiane sono già presenti e complete, quindi il
   modello di stile esiste.

## Fuori perimetro

- Motore i18n per il backend Python (`main.py`, `src/`): scartato in questo giro.
- Set PBR completo (normal map, mappa di rugosità separata): scartato.
- Texture per-faccia diversa (stile Minecraft con lato/cima distinti): il requisito è
  esplicitamente "quella di tutte e 6 le facce".
- Rifattorizzazioni non richieste dai due lavori.
