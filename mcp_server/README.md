# VoxelAI MCP — VoxelAIArtist come strumenti

Server [MCP](https://modelcontextprotocol.io) che espone **tutto** VoxelAIArtist a
un assistente: costruire voxel, generarli con l'AI, creare blocchi con texture di
pixel art, applicarli, riggare, animare, importare ed esportare per altri
programmi. 48 strumenti, `python -m mcp_server`, canale stdio.

Non avvia la GUI e non parla col server HTTP dell'app: riusa i moduli di `src/`
(l'espansore delle ops, il client AI multi-provider, le impostazioni) e tiene il
documento in memoria. Quindi funziona a finestra chiusa, e i file che produce
sono gli stessi che la GUI apre — un `.voxai` salvato da qui si riapre nell'app e
viceversa.

## Installazione

Serve **Python 3.10+** e il pacchetto del protocollo:

```bash
pip install "mcp>=1.2"
```

Il resto delle dipendenze dipende da cosa vuoi fare:

| Cosa | Cosa serve |
| --- | --- |
| Costruire, importare, esportare, riggare, animare | **niente**, solo la libreria standard |
| Generare con l'AI integrata (Gemini via cookie) | `pip install python-gemini-api==2.4.12` |
| Generare con Anthropic / OpenAI-compatibili / custom | **niente**: si parla in `urllib` |

PyQt6 **non serve**: il server importa `main.py` in modalita' `web`, che non
carica Qt. Nemmeno `pip install -r requirements.txt` e' necessario, se ti bastano
gli strumenti che non chiamano l'AI.

Prova che parta, senza client:

```bash
python -c "import sys,asyncio; sys.path.insert(0,'.'); from mcp_server import server; print(len(asyncio.run(server.mcp.list_tools())), 'strumenti')"
```

## Come Avviare il Server MCP

Hai **due modalità** per avviare e collegare il server MCP:

---

### 🌐 Modalità 1: Server HTTP / SSE con IP & Porta (Consigliata se vuoi un file `.bat` da avviare)

Con questa modalità avvii il server con un doppio click, e il server rimane attivo in ascolto su un indirizzo IP e una porta (es. `http://127.0.0.1:8000/sse`).

#### Come avviarlo:
- Fai doppio click sul file `start_mcp_sse.bat` presente nella root del progetto.
- Oppure lancia da terminale:
  ```bash
  python -m mcp_server --sse --host 127.0.0.1 --port 8000
  ```

#### Come collegarlo nei client via URL/IP:

* **Kilo Code / Roo Code / Cline**:
  *(ATTENZIONE: Devi mettere OBBLIGATORIAMENTE `"type": "sse"`, altrimenti Kilo rimane bloccato su `stdio`!)*
  ```json
  {
    "mcpServers": {
      "voxelai": {
        "type": "sse",
        "url": "http://127.0.0.1:8000/sse",
        "disabled": false
      }
    }
  }
  ```

* **Antigravity / VS Code MCP Config**:
  ```json
  {
    "mcpServers": {
      "voxelai": {
        "url": "http://127.0.0.1:8000/sse"
      }
    }
  }
  ```

* **Cursor / Windsurf**:
  In **Settings** -> **Features** -> **MCP** -> **Add new MCP server**:
  - **Name**: `voxelai`
  - **Type**: `sse`
  - **URL**: `http://127.0.0.1:8000/sse`

---

### ⚡ Modalità 2: Stdio (Avvio Automatico gestito dal Client)

In modalità `stdio` non serve avviare manualmente nessun file `.bat`: il client AI (Claude, Kilo Code, Antigravity) lancia `python` come sotto-processo ogni volta che serve.

#### Configurazione Stdio:
```json
{
  "mcpServers": {
    "voxelai": {
      "command": "python",
      "args": [
        "C:\\Users\\FRANCY\\Desktop\\Dev Things\\VoxelAIArtist\\mcp_server",
        "--workdir",
        "C:\\Users\\FRANCY\\Documents\\VoxelAI"
      ]
    }
  }
}
```

---

### 1. Testare l'MCP prima di collegarlo (MCP Inspector)
Puoi testare i 48 strumenti direttamente dal browser usando lo strumento ufficiale di test MCP:

```bash
npx @modelcontextprotocol/inspector python "C:\Users\FRANCY\Desktop\Dev Things\VoxelAIArtist\mcp_server"
```

### 2. Claude Code (CLI)

Dalla cartella del repo:

```bash
claude mcp add voxelai -- python -m mcp_server --workdir ~/VoxelAI
```

Oppure da qualunque posizione specificando il percorso completo:

```bash
claude mcp add voxelai -- python "C:\Users\FRANCY\Desktop\Dev Things\VoxelAIArtist\mcp_server"
```

### 3. Kilo Code / Roo Code / Cline (VS Code Extension)

Apri le impostazioni MCP dall'estensione oppure modifica il file di configurazione (`cline_mcp_settings.json` o `kilo_mcp_settings.json`):

```json
{
  "mcpServers": {
    "voxelai": {
      "command": "python",
      "args": [
        "C:\\Users\\FRANCY\\Desktop\\Dev Things\\VoxelAIArtist\\mcp_server",
        "--workdir",
        "C:\\Users\\FRANCY\\Documents\\VoxelAI"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### 4. Antigravity

Aggiungi il server nella configurazione MCP globale (`C:\Users\FRANCY\.gemini\config\mcp_config.json` o nella sezione mcp_servers):

```json
{
  "mcpServers": {
    "voxelai": {
      "command": "python",
      "args": [
        "C:\\Users\\FRANCY\\Desktop\\Dev Things\\VoxelAIArtist\\mcp_server",
        "--workdir",
        "C:\\Users\\FRANCY\\Documents\\VoxelAI"
      ]
    }
  }
}
```

### 5. Cursor / Windsurf

In Cursor vai su **Settings** -> **Features** -> **MCP** -> **Add new MCP server**:
- **Name**: `voxelai`
- **Type**: `command`
- **Command**: `python "C:\Users\FRANCY\Desktop\Dev Things\VoxelAIArtist\mcp_server" --workdir "C:\Users\FRANCY\Documents\VoxelAI"`

### 6. Claude Desktop

In `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "voxelai": {
      "command": "python",
      "args": [
        "C:\\Users\\FRANCY\\Desktop\\Dev Things\\VoxelAIArtist\\mcp_server",
        "--workdir",
        "C:\\Users\\FRANCY\\Documents\\VoxelAI"
      ]
    }
  }
}
```

Su macOS/Linux:

```json
{
  "mcpServers": {
    "voxelai": {
      "command": "python3",
      "args": ["/percorso/a/VoxelAIArtist/mcp_server",
               "--workdir", "/percorso/a/VoxelAI"]
    }
  }
}
```

Si passa la **cartella del pacchetto**, non `-m`: così non serve impostare la
directory di lavoro del client, che Claude Desktop non espone. Su Windows le
barre rovesciate vanno raddoppiate nelle stringhe JSON (`\\`).

### Un client qualunque

Comando `python -m mcp_server` (dal repo) o `python /percorso/a/mcp_server` (da
ovunque), trasporto **stdio**. Il saluto d'avvio esce su **stderr**: stdout è il canale del
protocollo, e una riga di troppo lì dentro corrompe il primo messaggio e chiude
il client senza spiegazioni. Per lo stesso motivo ogni `print` del processo viene
dirottato su stderr prima di partire.

## La cartella di lavoro

`--workdir CARTELLA` (per difetto la cartella corrente) e' **l'unico posto dove
il server puo' scrivere**. Un percorso fuori — anche raggiunto con `..` o con un
collegamento simbolico, perche' il confronto e' fra percorsi reali — viene
rifiutato con un errore invece di sovrascrivere un file da un'altra parte.

**Leggere non ha questo limite**, ed e' voluto: `voxel_open` e `voxel_import` su
un file che l'utente ha nominato sono esattamente cio' che gli e' stato chiesto.

La cartella viene creata se non c'e', si stabilisce all'avvio e non cambia:
nessuno strumento la puo' riscrivere, o il vincolo sarebbe aggirabile
dall'interno.

## Generare: con l'AI o senza

Gli strumenti che chiamano un modello esterno sono **sette** su 48:
`voxel_generate`, `voxel_modify`, `voxel_texture_generate`, `voxel_rig_animate`,
`voxel_pack_start` e i due che ne leggono l'esito. Tutti gli altri — costruire,
scavare, colorare, materiali, rig, pose, import, export — girano **in locale e
senza credenziali**.

Vale la pena dirlo perche' cambia il modo di lavorare: un assistente collegato
qui non ha bisogno di `voxel_generate` per fare un modello. `voxel_ops` prende le
stesse ops compatte che l'AI integrata produce, e le scrive lui — nessun cookie,
nessuna attesa, e si corregge una op alla volta invece di rigenerare tutto.

### Chi genera

`voxel_ai_status` dice chi e' attivo e se e' autenticato, **senza mai mostrare
una chiave o un cookie**. Guardalo prima di generare, se non sei sicuro.

- **Gemini via cookie** e' il default a configurazione zero: se l'app ha gia' i
  cookie, funziona senza toccare niente. E' un client *web* reverse-engineered,
  non l'API ufficiale.
- **Anthropic** (chiave + modello), **compatibili OpenAI** (base_url + chiave +
  modello: OpenAI, OpenRouter, Groq, Together, LM Studio, Ollama, vLLM) e
  **custom** (percorsi puntati, header propri) si configurano nella finestra
  Impostazioni dell'app, e il server MCP li vede subito: registro e chiavi
  stanno nella stessa cartella condivisa (`%APPDATA%/VoxelAIArtist/` su Windows,
  `~/.config/VoxelAIArtist/` altrove).

Le chiavi vivono in `provider_keys.json`, separato dal registro `providers.json`,
e non escono mai da un payload: quello che si vede e' `hasKey` e un `****WXYZ`.

## I 48 strumenti

### Progetti e oggetti
`voxel_new` · `voxel_open` · `voxel_save` · `voxel_close` · `voxel_list` ·
`voxel_use` · `voxel_info` · `voxel_preview` · `voxel_history` · `voxel_undo` ·
`voxel_redo` · `voxel_object_add` · `voxel_object_remove` · `voxel_object_rename`

Piu' progetti aperti insieme; ognuno ha piu' oggetti. Ogni strumento accetta
`document` e `obj` per dire su cosa lavorare, e senza usa quello corrente.
`voxel_preview` disegna il modello in ASCII da tre viste: serve a **guardare cosa
si sta facendo** senza esportare e aprire un altro programma.

### Costruire
`voxel_ops` · `voxel_fill` · `voxel_erase` · `voxel_set` · `voxel_recolor` ·
`voxel_shade` · `voxel_transform`

`voxel_fill` ha le forme (box, sphere, cylinder, cone, line, plane) con guscio e
spessore, e `symmetry` per specchiare il tratto. `voxel_transform` sposta, ruota
di 90 gradi, scala, poggia a terra e svuota l'interno.

Y e' **l'altezza** e il modello poggia su y=0.

Gli strumenti sono a grana grossa di proposito: "riempi una sfera" e' una
chiamata e una voce di cronologia, mille voxel singoli sarebbero mille di
entrambe.

### Materiali (i "blocchi")
`voxel_material_create` · `voxel_material_update` · `voxel_material_delete` ·
`voxel_material_list` · `voxel_material_apply` · `voxel_material_library`

Un materiale e' un blocco con una texture di pixel art — una sola, o **sei facce
diverse** — piu' l'aspetto (roughness, metalness, emissive, opacity) e la
mappatura UV. Si applica ai voxel per colore, per parte o per regione.

`voxel_material_library` e' la libreria personale, per riusare un blocco fra
progetti diversi.

### Texture
`voxel_texture_draw` · `voxel_texture_generate` · `voxel_texture_show` ·
`voxel_texture_import` · `voxel_texture_export`

La texture si scrive in **ops 2D** (`fill`, `rect`, `line`, `set`, `del`,
`mirror`, `noise`), non come PNG: origine in alto a sinistra come un'immagine, e
`-` come colore significa trasparente.

`voxel_texture_show` la ristampa **come testo**, che e' il punto: un assistente
puo' rileggere quello che ha disegnato e correggere il pixel sbagliato, invece di
rigenerare alla cieca. `voxel_texture_import` / `_export` sono il ponte coi PNG e
con gli altri editor.

### Rig e animazione
`voxel_rig_auto` · `voxel_rig_info` · `voxel_rig_bind` · `voxel_rig_pose` ·
`voxel_rig_clip` · `voxel_rig_animate` · `voxel_rig_export`

`voxel_rig_auto` costruisce lo scheletro sull'ingombro del modello: `humanoid`
(24 ossa) o `generic` (una catena lungo l'asse piu' lungo). Le pose e le clip si
scrivono in **gradi**; `voxel_rig_animate` fa scrivere una clip all'AI a parole.
`voxel_rig_export` scrive il GLB con ossa, pesi, posa e animazioni.

**Il modello umanoide va costruito in T-pose**, braccia orizzontali. Le stazioni
delle braccia si misurano dal bordo del torso, e con le braccia lungo i fianchi
il bordo del torso *e'* il braccio: la spalla finisce sulla punta del dito e a
`upperArm_*` non si lega nessun voxel — si posa e non si muove niente. Le braccia
si abbassano dopo, con `voxel_rig_pose` (Z −78 a destra, +78 a sinistra).
`voxel_rig_auto` avvisa se qualche osso e' rimasto senza voxel.

### Import / export
`voxel_import` · `voxel_export` · `voxel_rig_export`

| Formato | Import | Export |
| --- | --- | --- |
| `.voxai` / `.json` | si' (`voxel_open`) | si' |
| `.vox` (MagicaVoxel) | si', esatto | si', max 256 per lato |
| `.obj` + `.mtl` | si', voxelizzato | si', col `.mtl` e i PNG accanto |
| `.gltf` / `.glb` | si', voxelizzato | si', texture incorporate |
| `.png` | si' (piatto o sprite stack) | si', rendering ortografico |
| GLB riggato | — | `voxel_rig_export` |

Le mesh di triangoli (`.obj`, `.gltf`, `.glb`) si **voxelizzano**: `resolution`
e' il lato piu' lungo del risultato, `fill` riempie l'interno dei gusci chiusi.

Esportando in `.obj` vengono scritti anche `.mtl` e i PNG **accanto**: senza il
`.mtl` al suo fianco, con lo stesso nome, Blender mostra il modello bianco.

### AI
`voxel_ai_status` · `voxel_generate` · `voxel_modify` · `voxel_texture_generate` ·
`voxel_rig_animate` · `voxel_pack_start` · `voxel_pack_status` ·
`voxel_pack_result` · `voxel_pack_cancel`

`voxel_generate` usa gli stessi prompt del pulsante "Crea" dell'app, quindi da'
gli stessi risultati. I flag che contano: `humanoid` nomina le parti per il rig
(e' cio' che rende il modello animabile senza ritagliarlo a mano dopo),
`big_structure` per edifici che devono riempire la griglia con interni e scale,
`modular` per un pezzo che deve incastrarsi con altri.

Un **pack** genera N oggetti con lo stesso stile: la palette del primo asset
riuscito viene *applicata* agli altri, non solo chiesta nel prompt. Gira in
thread di questo processo e non blocca: `voxel_pack_start` mette in coda,
`voxel_pack_status` controlla, `voxel_pack_result` porta i modelli nel progetto.
La coda muore col server (thread daemon), ma i pack **arrivati in fondo** sono
salvati su disco nella cartella dell'app e si rivedono anche dalla GUI.

## Come si lavora, in pratica

Costruire un personaggio animato, senza mai chiamare un modello esterno:

```
voxel_new              griglia 32
voxel_ops              il corpo, in T-pose
voxel_material_create  un blocco con la texture del vestito
voxel_material_apply   applicalo per colore
voxel_rig_auto         kind=humanoid
voxel_rig_pose         braccia lungo il corpo: Z −78 / +78
voxel_rig_clip         una camminata, o voxel_rig_animate a parole
voxel_rig_export       personaggio.glb
```

Con l'AI cambia solo la seconda riga (`voxel_generate humanoid=true`). Il resto
e' identico — ed e' voluto: gli strumenti non sanno da dove viene il modello.

Ritoccare qualcosa fatto altrove:

```
voxel_import  scena.glb  resolution=64  fill=true
voxel_preview            guarda com'e' venuta
voxel_erase / voxel_fill correggi
voxel_export  scena.vox  per MagicaVoxel
```

## Tre scelte di fondo

1. **Gli strumenti ritornano testo, non oggetti.** Un JSON di quattromila voxel
   non dice a un modello quanto una frase come "42 voxel, 3 colori, ingombro
   7x7x5". L'elenco dei voxel non gli arriva **mai**: e' grande, illeggibile, e
   lo si otterrebbe solo per riscriverlo. Dove il dato strutturato serve davvero
   (elenchi, statistiche) si ritorna un JSON breve.

2. **Ogni modifica passa dalla cronologia.** Un assistente sbaglia, e la
   riparazione dev'essere `voxel_undo`, non "rifai il modello da capo".

3. **Scrivere su disco e' l'unica cosa irreversibile**, quindi e' l'unica con un
   vincolo (la cartella di lavoro). Leggere no.

## Prove

```bash
python3 tests/test_mcp_server.py     # i 48 strumenti, via il registro FastMCP
python3 tests/test_mcp_rig.py        # i sei invarianti del GLB + la skinning
python3 tests/test_mcp_export.py     # i formati in uscita
python3 tests/test_mcp_import.py     # i formati in entrata
bash tests/run_all.sh                # tutto, compreso il resto dell'app
```

Nessuna prova tocca la rete: il client AI e' sostituito da un generatore finto,
quindi non servono cookie ne' chiavi ne' quota.

