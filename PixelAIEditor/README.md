# PixelAIEditor

Editor di **pixel art 2D** e ritocco immagini, con generazione AI. Fa da compagno
a VoxelAIArtist: quello lavora a voxel, questo fa **solo texture 2D** — ed e' qui
che ha senso rendere trasparente lo sfondo di un'immagine, ritagliarla, o farsi
generare un motivo da riusare come materiale.

## Avvio

```
run.bat                 # Windows, doppio clic
python main.py          # da riga di comando (solo modalita' web)
```

Parte un server locale su una porta scelta dal sistema e si apre il browser.
Non c'e' una finestra Qt: l'app e' solo web.

**I cookie sono gli stessi di VoxelAIArtist** (`%APPDATA%\VoxelAIArtist\cookies.json`):
una sessione Google non e' una preferenza, quindi configurarla in una delle due
app la configura per entrambe. Le impostazioni invece sono separate
(`%APPDATA%\PixelAIEditor\`). Senza cookie l'app si apre lo stesso e la finestra
delle impostazioni lo segnala: si genera solo dopo averli messi.

## Dentro VoxelAIArtist

Nel creatore di materiali, il bottone **"Editor completo"** apre questo editor in
una finestra sopra la scena (c'e' anche nell'intestazione della finestra grande
della tela). Li' l'app ragiona **a cubo**: si scelgono quali facce mandare come
contesto all'AI, si lavora, e "Applica" le rimanda indietro — solo quelle
toccate, le altre restano come stavano. E' la stessa applicazione, non una
copia: la differenza e' solo che il ponte e' acceso. "Apri in una scheda" la
apre invece da sola, senza ponte.

## Cosa c'e'

- **Strumenti**: matita, gomma, secchiello, contagocce, linea, rettangolo,
  ellisse, selezione rettangolare, lazo, bacchetta magica, sposta.
- **Livelli** con opacita', visibilita', duplica, unisci, appiattisci.
- **Immagine**: ridimensiona immagine, ridimensiona tela (con ancoraggio),
  ritaglia, rifila, specchia, ruota, **rimuovi sfondo**.
- **Appunti di sistema**: si incolla un'immagine copiata da un altro programma
  con Ctrl+V.
- **Filtri e regolazioni** colore, e generazione AI su tutta la tela o su un
  livello nuovo.
- **Scorciatoie** complete: `F1` apre l'elenco.
- Sei lingue, tema chiaro/scuro.

## Verifica

```
bash tests/run_all.sh
```

Quattro sezioni, nessuna rete e nessuna quota AI: chiavi i18n, testi non
tradotti, build e bundle aggiornato, e l'avvio autonomo che serve davvero l'app.

## Struttura

```
main.py                 server locale + endpoint /api/texture2d
assets/prompts/         il prompt della generazione 2D
ui/src/lib/NN-*.js      i moduli, FETTE DI UNA SOLA closure (niente import/export)
ui/src/manifest.json    l'ordine in cui vengono concatenati
ui/build.mjs            genera ui/index.html; NON modificare ui/index.html a mano
tests/                  la suite
```

Dopo aver toccato `ui/src/`, ricostruire con `node ui/build.mjs`. Due `const` con
lo stesso nome in moduli diversi sono un errore di sintassi che lascia la pagina
disegnata ma **morta**, senza messaggi: `node .check_modules.mjs` lo trova.
