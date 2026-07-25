# Localizzazione (i18n) — VoxelAIArtist

Questa cartella contiene i file di traduzione dell'interfaccia utente. Sono file **disgiunti** dal resto dell'app: un agente frontend li collegherà a `ui/index.html` (integrazione UI + selettore lingua) in un task successivo (WAVE 2, W2-C punto 2).

## Lingue supportate

| Codice | Nome nativo |
|--------|-------------|
| `it`   | Italiano    |
| `en`   | English     |
| `es`   | Español     |
| `de`   | Deutsch     |
| `fr`   | Français    |
| `pt`   | Português   |

`it` è la **lingua sorgente** (i testi italiani reali estratti dall'app) e allo stesso tempo la **lingua di fallback**: se una chiave manca o una lingua non è disponibile, si usa il valore italiano.

## File

- `it.json`, `en.json`, `es.json`, `de.json`, `fr.json`, `pt.json` — i dizionari, uno per lingua.
- `index.json` — manifest per popolare il selettore lingua senza hardcode (vedi sotto).
- `README.md` — questo file.

## Schema delle chiavi

Ogni file è un **oggetto JSON piatto** (nessun annidamento) con **chiavi a namespace puntato**: `sezione.elemento` oppure `sezione.elemento.variante`. Esempi reali:

```json
{
  "tools.place": "Aggiungi",
  "panel...": "...",
  "mode.object": "Modalità Oggetto",
  "objects.confirmDelete": "Eliminare l'oggetto \"{name}\"? L'operazione non è annullabile."
}
```

Regole:

- Le **chiavi sono identiche in tutti i file** e nello **stesso ordine** (facilita i diff). Cambiano solo i valori.
- I suffissi `.title` indicano il testo del `title=`/tooltip dell'elemento (es. `tools.placeTitle` è il tooltip del bottone `tools.place`).
- Namespace usati attualmente:
  - `app.*` — titolo finestra, logo, toggle tema
  - `tabs.*` — le 4 schede (Genera / Vista / Disegna / Rig)
  - `generate.*` — pannello generazione AI (prompt, modalità, modello, griglia, bottoni, stati)
  - `dropzone.*`, `paste.*` — caricamento file / incolla JSON
  - `newProject.*` — dialog nuovo progetto
  - `info.*` — pannello Informazioni Modello
  - `view.*` — Opzioni di Visualizzazione (griglia, rotazione, wireframe, gap)
  - `objects.*` — outliner Oggetti della Scena + dialog (nuovo/duplica/rinomina/unisci/elimina) e relativi confirm/prompt/alert
  - `mode.*` — badge Modalità Oggetto / Modifica
  - `palette.*` — palette colori
  - `tools.*` — strumenti di modifica (vista/aggiungi/disegna/contagocce/svuota/riempi/pennello)
  - `symmetry.*` — controllo simmetria
  - `dragPlane.*` — controllo piano di drag
  - `hint.*` — testo suggerimento per ogni strumento
  - `hud.*` — HUD a schermo (asse drag, estrusione)
  - `rig.*` — scheletro, rigging, ossa, pose, animazioni + hint dinamici
  - `gizmo.*` — barra gizmo ruota/sposta + hint
  - `export.*` — footer export/salvataggio (VoxelAI, JSON, MTL, OBJ, GLB)
  - `help.*` — accordion aiuto animazioni Blender
  - `loader.*` — overlay di caricamento
  - `confirm.*`, `alert.*` — messaggi di `confirm()` / `alert()`

## Convenzione dei placeholder `{var}`

Dove il testo contiene un valore dinamico (numero, nome, asse), c'è un **placeholder tra parentesi graffe** con nome descrittivo. I placeholder sono **identici in tutte le lingue** — traduci il testo attorno, non il nome della variabile.

Placeholder attualmente in uso:

- `{name}` — nome oggetto (es. `objects.confirmDelete`)
- `{color}` — codice colore esadecimale (es. `palette.swatchTitle`)
- `{type}` — tipo di rig (es. `rig.ready`)
- `{count}` — conteggio (ossa, ecc.)
- `{axis}` — asse in maiuscolo, es. `X` (es. `hud.extrudeAxis`)
- `{dir}` — verso estrusione: `+`, `−` o vuoto
- `{faces}`, `{steps}` — conteggi HUD estrusione
- `{error}` — messaggio d'errore concatenato (es. `alert.fileLoadError`)

Esempio (stessa chiave, 3 lingue):

```
it: "objects.confirmDelete": "Eliminare l'oggetto \"{name}\"? L'operazione non è annullabile."
en: "objects.confirmDelete": "Delete the object \"{name}\"? This action cannot be undone."
de: "objects.confirmDelete": "Objekt \"{name}\" löschen? Dieser Vorgang kann nicht rückgängig gemacht werden."
```

Il motore i18n (lato frontend, ancora da implementare) dovrà sostituire `{var}` con il valore effettivo a runtime.

## Come aggiungere una lingua

1. Copia `it.json` in `xx.json` (dove `xx` è il codice ISO 639-1 della lingua).
2. Traduci **solo i valori**, lasciando invariate chiavi, ordine e placeholder `{var}`.
3. Aggiungi la voce al manifest `index.json`:
   ```json
   { "code": "xx", "name": "Nome Nativo" }
   ```
4. Verifica con gli script nella sezione seguente che il JSON sia valido e che l'insieme di chiavi combaci con quello di `it.json`.

## Manifest `index.json`

```json
{
  "source": "it",
  "fallback": "it",
  "locales": [
    { "code": "it", "name": "Italiano" },
    { "code": "en", "name": "English" }
  ]
}
```

- `source` — lingua sorgente (i testi originali).
- `fallback` — lingua usata quando una chiave/lingua manca.
- `locales` — elenco ordinato `{ code, name }` per popolare il selettore lingua (il `name` è il nome nativo mostrato all'utente).

## Verifica

JSON valido:

```bash
node -e "['it','en','es','de','fr','pt'].forEach(l=>{JSON.parse(require('fs').readFileSync('ui/locales/'+l+'.json','utf8'))}); JSON.parse(require('fs').readFileSync('ui/locales/index.json','utf8')); console.log('JSON_OK')"
```

Stesso insieme di chiavi in tutti i file:

```bash
node -e "const fs=require('fs');const langs=['it','en','es','de','fr','pt'];const keys=langs.map(l=>Object.keys(JSON.parse(fs.readFileSync('ui/locales/'+l+'.json','utf8'))).sort());const base=JSON.stringify(keys[0]);langs.forEach((l,i)=>{if(JSON.stringify(keys[i])!==base)throw new Error('MISMATCH keys in '+l)});console.log('KEYS_MATCH '+keys[0].length+' chiavi')"
```

## Note

- I file sono UTF-8, accenti scritti direttamente (non-escaped). Nessuna virgola finale.
- Alcune emoji/icone (💾, 🦴, ⟳, ✥, ＋, ⧉, ✎, ⛓, 🗑, 🔧, 🧱) fanno parte dei valori perché sono nel testo dei bottoni originali. Mantienile.
- Copertura ~80-150 chiavi delle stringhe UI visibili principali; alcune stringhe minori o generate dinamicamente in `ui/index.html` potrebbero non essere ancora estratte — vanno aggiunte qui con nuove chiavi mantenendo l'allineamento tra tutte le lingue.
