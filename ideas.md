# VoxelAIArtist — 10 idee per il salto di qualità

Documento prodotto il **2026-07-25**, dopo:

- un **audit del codice** con verifica sperimentale di ogni difetto (nessun bug è
  elencato "per sospetto": ognuno è stato riprodotto);
- un'**analisi dei competitor** (VoxAI, VoxelSprites, Meshy, Tripo3D, Hyper3D/Rodin,
  MagicaVoxel, Goxel, Avoyd, Blockbench).

Le idee sono ordinate **1 → 10 per importanza**, dove "importanza" =
`(danno se non fatto) × (utenti colpiti) ÷ (costo di implementazione)`.

> **Contesto competitivo, in una riga.** Nessuno dei servizi analizzati risolve la
> coerenza di stile in un batch: Meshy elenca "batch concepts lack consistency"
> tra i problemi noti nella propria documentazione, e Tripo3D genera fino a 30
> modelli in parallelo ma ognuno indipendente, senza ancora di stile. Il
> vantaggio strutturale di VoxelAIArtist è che, essendo locale, può sostituire il
> *prompting fragile* con **vincoli deterministici**. Le idee sotto puntano lì.

---

## 1. Ripristinare la parità Python ↔ JS del formato compatto — e proteggerla con un test

**Stato: ✅ FATTO in questa sessione** (resta il punto 1 perché è la lezione più importante).

Il CLAUDE.md impone che `expand_ops()` (Python) e `expandOps()` (JS) restino
identici. Non lo erano, e le conseguenze erano gravi:

| Caso | Prima | Dopo |
|---|---|---|
| `box` con coordinate frazionarie | **0 voxel: il modello spariva** | 98 voxel, identico a Python |
| `fill 0.9 … 3.9` | Python `x∈0..3`, JS `x∈1..4` (modello sfalsato di 1) | identici |
| `line` diagonale con passi pari | scalini sfalsati (`round()` Python = *banker's rounding*, `Math.round()` no) | identici |

La terza divergenza si manifestava **anche con coordinate intere in input** ed era
sfuggita all'analisi statica: l'ho trovata solo con un test differenziale.

**Perché conta**: l'AI produce spesso coordinate frazionarie. L'utente vedeva un
modello nel viewer e ne salvava un altro sul disco — il tipo di bug che fa perdere
fiducia nello strumento senza che si capisca perché.

**Da fare ancora**: mettere in CI il test differenziale (`tests/` di questa
sessione, 20 casi) così una futura modifica a una sola delle due implementazioni
fallisce subito invece di divergere in silenzio.

---

## 2. Igiene del repository e delle credenziali

**Stato: ✅ FATTO in questa sessione** (tranne la revoca del token, che spetta a te).

- `token.txt` (credenziale di sessione) era **tracciato in git**, in violazione
  esplicita del CLAUDE.md.
- Nessun `.gitignore`: erano versionati 4 `.pyc`, `build/…/base_library.zip`,
  23 `.bak` e 6 `.tar.gz` di backup.
- Peso del repo tracciato: **8,0 MB → 1,6 MB** (−80%).

> ⚠️ **Azione che devo chiedere a te**: rimuovere il file dall'index **non
> disinnesca la credenziale** — resta leggibile nella storia dei commit. Va
> **revocata/rigenerata** lato Google, e se il repo è pubblico va considerata
> compromessa da ora. Per cancellarla dalla storia serve un `git filter-repo` +
> force-push, operazione distruttiva che non eseguo senza il tuo assenso.

---

## 3. Tetto di sicurezza sull'espansione dei voxel

**Stato: ✅ FATTO in questa sessione.**

`expand_ops` non aveva alcun limite. Un singolo op malformato dell'AI —
`["fill",0,0,0,299,299,299]` — generava **27 milioni di celle**: nel mio test il
processo Python ha superato i **120 secondi senza completare**, e nel browser
avrebbe congelato il tab senza messaggi d'errore.

Ora entrambe le implementazioni si fermano a `MAX_VOXELS = 4.000.000` (una griglia
128³ piena ne usa 2,1M, quindi c'è ampio margine) e **troncano** il modello:
meglio un modello parziale visibile che un'app bloccata. Il caso patologico ora si
risolve in 4 secondi; i modelli normali sono bit-per-bit invariati.

---

## 4. Normalizzazione automatica di scala e ancoraggio del pack

**Stato: ✅ FATTO** (secondo round).

È il difetto n.1 dei competitor, documentato con numeri: uno sviluppatore che ha
prodotto 30 asset con Meshy per un game jam ha ottenuto una spada da
**19.416 cm³** e un arco da **1.395.337 cm³** — un rapporto di 70× fra oggetti
destinati alla stessa scena. Nessuno dei tool analizzati offre un "batch scale
tool".

Il contratto di stile che ho implementato *chiede* all'AI scala coerente e
appoggio a `y=0`. Ma come mostra il punto 1, chiedere non basta: va **imposto**
dopo la generazione, esattamente come faccio già per la palette.

**Cosa è stato fatto** (tutto locale, deterministico, senza AI):
1. **Ancoraggio** (`normalize_asset`): ogni asset viene centrato su XZ e appoggiato
   a `y=0` *dopo* la generazione. Verificato che sia una traslazione rigida: forma
   e conteggio voxel restano identici.
2. **Scala relativa dichiarata**: scrivi `Armadio :grande` nella lista oggetti e
   l'AI riceve l'ingombro atteso (le taglie sono `:minuscolo`, `:piccolo`,
   `:medio`, `:grande`, `:enorme`).
3. **Report di coerenza** (`pack_coherence_report` + `GET /api/pack/report`):
   calcola la mediana delle dimensioni e segnala gli outlier (oltre 2× o sotto
   0,5×). Compare nel pannello a fine pack e finisce dentro il manifest dello ZIP.

---

## 5. Export `.vox` e GLB a livello di pack

**Stato: ✅ FATTO** (secondo round).

Gli export esistevano già per il singolo modello (`20-formats.js` ha `encodeVox`,
OBJ, GLB, `.schem`), ma la modalità Pack esportava solo JSON, uno alla volta.

Dalla ricerca, i formati non negoziabili per chi sviluppa giochi sono:
**`.vox`** (l'intero ecosistema MagicaVoxel), **GLB animato** (Unity via glTFast,
Godot 4 nativo, Three.js) e **`.fbx`** (pipeline Unity/Unreal per personaggi).

**Cosa è stato fatto**: il bottone "Esporta pack (ZIP)" produce un unico archivio
con una cartella per asset (`.json` + `.vox` + `.obj` + `.mtl`) e un `pack.json`
di manifest che include il report di coerenza. Lo scrittore ZIP
(`ui/src/lib/29-zip.js`, modalità *store*) è scritto a mano in ~140 righe **senza
dipendenze esterne**: nessuno script da CDN, quindi funziona anche offline.
Validato in modo incrociato con `unzip` di sistema e con `zipfile` di Python,
inclusi contenuti binari e nomi file con accenti.

Resta da fare: GLB per-asset dentro lo ZIP (l'esportatore GLB è asincrono e
richiede un giro in più) e `.fbx`.

---

## 6. L'immagine di riferimento viene ignorata dal backend

Difetto verificato: `08-generate-ai.js` invia `image: selectedImageBase64` nel
POST, ma `main.py` **non legge mai quel campo** — passa a Gemini solo il testo.
Il bottone è attualmente nascosto (`display: none`), quindi oggi è latente; ma il
codice frontend c'è e chi lo riattivasse otterrebbe un fallimento silenzioso.

**Perché conta**: è la funzione più richiesta del settore. VoxelSprites permette
di allegare uno schizzo, e VoxAI ha un intero flusso image-to-3D. Per un pack,
un'immagine di riferimento è il modo più naturale di dire "questo è lo stile".

**Cosa implementare**: passare l'immagine al client Gemini (che supporta input
multimodale), oppure — se non fosse affidabile — rimuovere il codice morto e dirlo
chiaramente nell'interfaccia. **Un bottone che finge di funzionare è peggio di un
bottone assente.**

**Effort**: basso.

---

## 7. Restringere CORS e chiudere la superficie del server locale

Il server risponde `Access-Control-Allow-Origin: *` su **tutte** le route. Finché
l'app è aperta, qualsiasi sito web visitato nello stesso browser può chiamare
`POST /api/settings/cookies` o `DELETE /api/settings/cookies` — cioè leggere o
distruggere le credenziali salvate — o lanciare generazioni a tuo carico.

Il rischio è mitigato dal fatto che il server ascolta su `127.0.0.1` e su porta
casuale, ma una porta casuale è indovinabile in pochi secondi.

**Cosa implementare**: restringere l'origine a `http://127.0.0.1:{PORT}`, esigere
un token di sessione (generato all'avvio e iniettato come `window.__API_TOKEN__`,
già c'è il meccanismo di injection per `__API_BASE__`) sulle route che toccano
impostazioni e credenziali. Ho già corretto in questa sessione i due crash da
`Content-Length` mancante che azzeravano la connessione senza risposta.

**Effort**: basso.

---

## 8. Rendering incrementale: `buildModel()` ricostruiva tutto a ogni modifica

**Stato: ✅ FATTO** (secondo round). Era il prerequisito delle griglie grandi.

`buildModel()` distruggeva e ricreava **tutti** gli `InstancedMesh` (uno per colore) a
ogni singola modifica. Su un modello da 100k voxel ogni pennellata paga il costo
di una ricostruzione completa. È il motivo per cui i modelli grandi diventano
appiccicosi, e peggiora quanto più l'utente è bravo (i modelli belli sono densi).

**Cosa è stato fatto** (`ui/src/lib/28-incremental.js`):
- la visibilità si ricalcola **solo sulle celle toccate e sui loro vicini** (una
  cella nascosta può scoprirsi solo se le sparisce accanto un vicino): il costo
  non dipende più dalla dimensione del modello;
- l'array dei voxel si aggiorna in **O(1) per cella** grazie a un indice
  chiave → posizione, con rimozione *swap-with-last*;
- si ricreano **solo gli InstancedMesh dei colori toccati**, non tutti;
- la palette DOM si riscrive solo se l'insieme dei colori cambia davvero.

`buildModel()` completo resta il percorso autorevole per load/generate/import/undo,
e c'è un fallback automatico: se qualcosa non torna, si torna alla strada sicura.
**Verificato con 19 controlli**, inclusa una sequenza di 100 edit casuali in cui
lo stato incrementale è risultato identico, voxel per voxel, al rebuild completo.

---

## 9. Cronologia dei pack e riproducibilità

**Stato: ✅ FATTO** (secondo round).

Prima la coda viveva solo in memoria: chiudendo l'app, un pack da 40 minuti svanisce.
Sopravvive al reload della webview (l'ho verificato: `packResume()` si riaggancia),
ma non alla chiusura del processo.

**Cosa è stato fatto**: ogni pack completato viene salvato automaticamente in
`%APPDATA%/VoxelAIArtist/packs/{data}_{id}/` con un file per asset e un
`manifest.json` che conserva **palette, griglia, oggetti, varianti e modello AI**.
Nuovi endpoint `GET /api/pack/saved` (elenco) e `?folder=...` (ricarica).
Il `PackManager` accetta una `storage_dir`, così i test girano isolati senza
sporcare la cartella reale. La lettura è protetta da *path traversal*.

Da qui nascono due cose che nessun servizio hosted a crediti può offrire: riaprire
un pack di settimane prima riusandone la palette, e rigenerarlo dal manifest.

---

## 10. Onboarding: template di pack pronti

La modalità Pack è potente ma parte da un campo vuoto, e "cosa scrivo?" è
l'ostacolo maggiore per un utente nuovo. In `examples/` ci sono già 18 modelli non
sfruttati per l'apprendimento.

**Cosa implementare**: 4-5 preset a un clic che compilano oggetti e impostazioni —
*Props da taverna fantasy* (barile, boccale, sgabello, candela, forziere),
*Cucina moderna* (frigo, tostapane, microonde), *Kit sci-fi*, *Arredo urbano*.
Con i modelli in `examples/` come riferimenti di stile precaricati, il primo pack
di un utente nuovo esce coerente **senza che debba capire cos'è una palette**.

**Effort**: basso. È il miglior rapporto impatto/costo per la percezione del
prodotto.

---

## Riepilogo

| # | Idea | Stato | Note |
|---|---|---|---|
| 1 | Parità Python ↔ JS del formato compatto | ✅ fatto | + test differenziale a protezione |
| 2 | Igiene repo e credenziali | ✅ fatto | **revoca del token: spetta a te** |
| 3 | Tetto sull'espansione voxel | ✅ fatto | ora adattivo alla griglia |
| 4 | Normalizzazione scala del pack | ✅ fatto | ancoraggio + taglie + report outlier |
| 5 | Export pack in ZIP | ✅ fatto | `.vox`/OBJ/MTL + manifest, zero dipendenze |
| 6 | Immagine di riferimento | ⏸️ sospesa | su tua indicazione |
| 7 | CORS e superficie del server | ⬜ parziale | crash `Content-Length` risolti |
| 8 | Rendering incrementale | ✅ fatto | prerequisito delle griglie grandi |
| 9 | Cronologia e riproducibilità dei pack | ✅ fatto | salvataggio automatico + manifest |
| 10 | Template di pack | ⬜ da fare | basso costo, alto impatto percepito |

### Lavori aggiuntivi del secondo round (non erano fra le 10 idee)

| Tema | Cosa |
|---|---|
| **Griglie grandi** | Nuove opzioni fino a 512³ + spunta "Struttura grande / alto dettaglio" che istruisce l'AI su facciate, interni, tetti e scale. Tetto voxel adattivo alla griglia. |
| **Flash all'avvio** | Il bundle JS sta in fondo al `<body>`: la pagina nasceva coi default CSS e cambiava aspetto dopo. Ora uno script sincrono nell'`<head>` applica tema, accent e font **prima del primo paint**. |
| **Flicker** | Preferenze non più riapplicate dopo il fetch se identiche; pannello Pack aggiornato in modo differenziale invece di ricostruirlo ogni 2,5 s; palette ridisegnata solo se i colori cambiano; i18n che non riscrive il DOM quando i testi sono già corretti. |
| **Consumo** | Render **on-demand**: prima si disegnavano 60 fotogrammi al secondo anche a schermo fermo. Ora il frame parte solo se qualcosa cambia (la rotazione automatica resta fluida). |
| **Autosave** | Spostato in `requestIdleCallback`: non causa più un micro-blocco ogni 90 secondi su modelli grandi. |
| **Build** | Guardia contro i caratteri non-latin1 e i moduli vuoti: un carattere sbagliato non può più corrompere silenziosamente il bundle. |

### Suite di verifica

`bash tests/run_all.sh` — 9 gruppi, nessuna rete, nessun cookie, nessuna quota AI:
coda pack, API end-to-end, **parità ops Python↔JS (20 casi)**, UI pack (40
asserzioni), ancoraggio/persistenza, **rendering incrementale (19 controlli, con
100 edit casuali confrontati col rebuild completo)**, export ZIP (validato anche
da `zipfile` di Python), build + sintassi bundle, i18n su 6 lingue.

**I tre prossimi passi che consiglio**: **#10** (template di pack: costa poco e
cambia la prima impressione), **#7** (chiudere la superficie del server locale),
e il **GLB dentro lo ZIP** per completare il #5.
