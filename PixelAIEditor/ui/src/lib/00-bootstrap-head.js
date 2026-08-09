/* ===========================================================================
 *  PixelAIEditor - bundle JS
 *
 *  I file in ui/src/lib/ sono FRAMMENTI DI UNA SOLA closure, non moduli ES:
 *  niente import/export, tutto condivide lo stesso scope. `ui/build.mjs` li
 *  concatena nell'ordine di `ui/src/manifest.json` e li infila nell'unico
 *  <script> del template. Questo file apre la closure, l'ultimo la chiude:
 *  aggiungere un modulo significa aggiungere una riga al manifest, non un
 *  <script> in piu'.
 *
 *  Perche' una closure e non lo scope globale: la pagina non deve esporre
 *  `doc`, `zoom`, `sel`... su `window`, dove collidono con l'API del browser
 *  (`window.doc`? `window.name`?) e con la pagina che ci embedda quando
 *  l'editor gira dentro VoxelAIArtist. Le sole cose deliberatamente pubbliche
 *  stanno in `PixelAI` (vedi 24-boot.js).
 *
 *  Ordine di dichiarazione: ogni modulo dichiara SOLO funzioni e costanti. Le
 *  chiamate vere partono da `init()` in fondo, quindi l'ordine del manifest
 *  conta per le costanti (`const` ha la temporal dead zone) ma non per le
 *  funzioni fra loro.
 * ======================================================================== */

window.addEventListener('load', () => {

    'use strict';

    // --- Limiti della tela ---------------------------------------------------
    // Il minimo e' 1 perche' una tela 1x1 e' legittima (una tavolozza, un
    // singolo texel). Il massimo e' 4096: oltre, uno snapshot di annullamento
    // di un singolo livello supera i 64 MB e la pila di annullamenti diventa
    // il vero limite di memoria dell'app, non la tela.
    const DOC_MIN_SIDE = 1;
    const DOC_MAX_SIDE = 4096;
    const DOC_DEFAULT_W = 64;
    const DOC_DEFAULT_H = 64;

    // Dimensioni offerte all'AI. Sono le stesse del prompt condiviso
    // (`PIXEL_MIN_SIDE`..`PIXEL_MAX_SIDE` in src/pixelprompt.py): chiedere a un
    // LLM una tela 512x512 in comandi compatti produce risposte troncate a
    // meta' disegno, quindi si genera piccolo e si ingrandisce senza
    // interpolazione.
    const AI_SIDES = [8, 16, 24, 32, 48, 64, 96, 128];
    const AI_DEFAULT_SIDE = 32;

    // Fattori di zoom INTERI. Un fattore frazionario spalmerebbe un pixel della
    // tela su un numero non intero di pixel di schermo e, con
    // `image-rendering: pixelated`, le colonne uscirebbero di larghezza diversa:
    // un reticolo irregolare che si legge come un difetto del disegno. Per lo
    // stesso motivo la griglia in gradiente CSS resta esatta a ogni zoom.
    const PIX_ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

    // Sotto questo zoom la griglia si spegne da sola: a 2 px di passo le linee
    // occupano meta' della cella e si vede solo la griglia.
    const GRID_MIN_ZOOM = 6;
