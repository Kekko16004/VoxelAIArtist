# SimpleAIModeller

Asset 3D parametrici da un prompt. App sorella di VoxelAIArtist: stesso server
HTTP locale, stessi cookie Gemini / provider a chiave, UI nel browser.

L'AI **non scrive codice WebGL**. Produce una spec JSON compatta; il motore
locale la interpreta estrudendo primitive, applicando booleane e materiali
procedurali. Le correzioni viaggiano come patch di poche righe.

## Avvio

```bat
SimpleAIModeller\run.bat
```

oppure `python SimpleAIModeller/main.py`. Serve `node` una volta per costruire
la UI (`node ui/build.mjs` da questa cartella) se `ui/index.html` non c'e'.

I cookie e i provider AI sono **condivisi** con VoxelAIArtist: se li hai gia'
configurati li', funzionano anche qui. Altrimenti Impostazioni (in-app).

## Cosa c'e'

**Generazione in due tempi.** Prima un *architetto* produce una distinta di
misure verificata (catena di segmenti contigui `da → a` in metri), poi il
costruttore la traduce in nodi. Un audit aritmetico confronta la mesh col piano
pezzo per pezzo e corregge da solo fino a quando i numeri tornano.

**Geometria vera, non mattoni.** 16 primitive + CSG, e soprattutto i
deformatori: bevel raccordato, rastremature per-asse (il filo di una lama),
schiacciamento di un solo lato, inclinazione, torsione, piega, irregolarita'
superficiale, e `loft` con sezione a lente/rettangolo/esagono.

**Editor.** Selezione con clic o dall'outliner, gizmo sposta/ruota/scala che
scrive nella spec, undo/redo, duplica, elimina, wireframe. Scorciatoie:
`G`/`R`/`S` strumenti, `W` wireframe, `F` inquadra, `1-6` viste, `Del`,
`Ctrl+Z` / `Ctrl+Y` / `Ctrl+D`.

**Materiali.** Tre stili (low-poly, PBR con clearcoat, toon), rumore procedurale
che varia tinta e ruvidita', ambiente generato, tone mapping ACES, ombre morbide.

**Validatori locali** (gratis, deterministici): braccia, piattaforme piatte,
cabine, simmetria, pezzi staccati, appoggio a terra, collider, budget triangoli.

**Critica AI opzionale** su contact sheet a 6 viste con silhouette umana di
1,70 m. Una sonda misura se il provider legge davvero le immagini; se no, il
critico sei tu (scrivi cosa non va e diventa il brief di correzione).

**Import/export.** Riapre `.sam.json`; carica GLB/OBJ come riferimento
semitrasparente; esporta bundle ZIP (GLB + spec + piano + collider + istruzioni),
oppure GLB, OBJ+MTL, JSON e collider separati. Trascina un file sulla finestra.

**Demo senza AI** (cassa di legno) per giudicare il motore da subito.

## Cosa non c'e' ancora

Gauntlet Loop multi-agente, skinning vero (deformazione a pesi), set coerenti di
asset, timeline di animazione.

## Test

```bash
bash SimpleAIModeller/tests/run_all.sh
```

Offline, niente cookie, niente quota.
