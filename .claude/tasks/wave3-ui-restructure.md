# WAVE 3 — Ristrutturazione UI stile Blender (richiesta utente 2026-07-20)

## Obiettivo
Layout professionale a 3 colonne (come Blender):
- **SINISTRA** = solo strumenti operativi: tab **Genera / Disegna / Rig**.
- **DESTRA** (nuovo pannello, sempre visibile) = **Outliner oggetti** (in alto) + **Proprietà oggetto attivo** (transform, nome, visibilità) + **Palette colori**, come sezioni accordion sempre disponibili.
- **BARRA SUPERIORE** (nuova) = menu **Import / Export** (con scelta formato) + **File progetto** (salva/apri/cronologia) + pulsante **Impostazioni**.
- **IMPOSTAZIONI** = **finestra modale** centrale con tutta la customizzazione: **Lingua**, Tema, Font e dimensione font, Scorciatoie, Avvio, Salvataggio, cartella Plugin.

Vincoli chiave rilevati nel codice:
- Il tab "Vista" oggi contiene outliner+palette+opzioni-vista+scorciatoie → questi vengono spostati e il tab "Vista" **sparisce** dalla sidebar.
- L'oggetto **attivo** è sempre a transform identità (editing/raycast/gizmo/rig lo richiedono); i transform reali stanno solo sugli oggetti **non attivi** e vengono "cotti" (`bakeTransform`) quando l'oggetto diventa attivo. → Il pannello Proprietà deve gestire questo con onestà (vedi sotto).
- Build: monolite generato da `ui/src/index.template.html` + moduli `ui/src/lib/*.js` via `ui/build.mjs` (manifest.json). Desktop = `setHtml` file-baseUrl. i18n: `data-i18n*` + engine `t()`.

---

## Fase 1 — Layout a 3 colonne (CSS + HTML template)
- `body` resta flex-row. Nuova struttura: `.sidebar` (sx) · `#sidebarResizer` · `.canvas-container` (centro, flex-grow) · `#rightResizer` · `.rightpanel` (dx, nuova).
- Nuova top-bar: `.topbar` in cima al canvas-container (position sticky/flex sopra il canvas) OPPURE riga full-width sopra tutto. **Scelta**: barra full-width sopra le 3 colonne → `body` diventa `flex-direction:column`; una riga `.topbar` + una riga `.workspace` (flex-row con le 3 colonne). Più pulita e "seria".
- Variabili: `--rightpanel-width: 340px` (resizable, persistita in prefs come già fatto per sidebar).
- Tema/responsività preservati (le var CSS restano).

## Fase 2 — Sidebar sinistra: rimuovere tab "Vista"
- Tab-bar passa da 4 a 3 pulsanti (Genera/Disegna/Rig). Rimuovo il bottone `data-tab="view"` e il pannello `data-panel="view"` viene SVUOTATO dei contenuti (spostati altrove), non cancellato del tutto finché non riaggancio i renderer.
- Il footer sidebar (export/save) viene **svuotato**: i suoi pulsanti migrano nella top-bar (Fase 4). Gli **ID e i listener restano identici** — sposto solo i nodi nel DOM, così `21-project.js`/`20-formats.js`/`02-io-files.js` continuano a funzionare senza modifiche JS.

## Fase 3 — Pannello destro (`.rightpanel`)
Contiene 3 sezioni accordion (`<details open>` o header cliccabile), sempre visibili:
1. **Outliner** — sposto qui il blocco `#objectsPanel` + `#objectsList` (renderer `renderObjectsList()` in 04-objects.js NON cambia: cerca per id).
2. **Proprietà oggetto attivo** — NUOVO. Campi: Nome (input → `obj.name`), Visibilità (toggle → `obj.visible`), Transform: Posizione X/Y/Z, Rotazione Y (step 90°), Scala. 
   - Onestà tecnica: l'attivo è a identità. Due opzioni presentate all'utente in UI:
     - I campi transform mostrano/modificano il transform dell'oggetto **selezionato nell'outliner** (che può essere non-attivo).
     - Su "Applica" si bake-a il transform (riuso `bakeTransform`) e si ricostruisce (`renderInactiveObjects`/`buildModel`). Documentato che rotazione = step 90° e coord intere (limite già noto nel codice).
   - Nuovo modulo `ui/src/lib/25-properties.js` con `renderProperties()` agganciato a select/attivazione oggetto.
3. **Palette colori** — sposto qui `#palette` (renderer in 02-io-files.js per id, invariato).
- Opzioni vista (griglia/rotazione/wireframe/gap): le sposto in fondo al pannello destro come 4ª sezione accordion "Vista" (restano utili e sempre accessibili). ID invariati (`toggleGrid`, `rotationModes`, `toggleWireframe`, `voxelGap`).

## Fase 4 — Barra superiore (top-bar)
Gruppi con menu a discesa (dropdown "seri", no emoji-spam):
- **File**: Nuovo · Apri progetto (`openProjectBtn`) · Salva `.voxai` (`saveProjectBtn`) · Salva con nome (`saveProjectAsBtn`) · Cronologia (`autosaveHistoryBtn`).
- **Import**: apre file-picker (riusa `handleFile` esistente per .vox/.schem/.voxai/.json).
- **Export** (dropdown con scelta formato): OBJ (`exportObjBtn`), GLB (`exportGlbBtn`), .vox (`exportVoxBtn`), .schem (`exportSchemBtn`), VoxelAI (`saveJsonBtn`), JSON (`savePlainJsonBtn`) + opzioni (autoscale GLB checkbox, help Blender details).
- **Impostazioni**: apre la modale (Fase 5).
- Sposto qui anche il toggle tema? No: il tema va nelle Impostazioni (richiesta utente), ma lascio anche l'icona tema in top-bar per comodità (opzionale, decidibile). → Metto SOLO nelle impostazioni per rispettare "spostare tutto".
- Riuso il pattern dropdown con un piccolo componente CSS/JS (nuovo, minimale). Tutti i pulsanti mantengono ID/listener esistenti: sposto i nodi dentro i dropdown.

## Fase 5 — Modale Impostazioni (nuovo modulo `ui/src/lib/26-settings-modal.js`)
Overlay centrale (riuso pattern `autosaveHistoryOverlay`). Sezioni:
- **Lingua**: sposto qui `#languageSelect` (i18n engine lo popola per id — nessun cambio JS; aggiorno solo il fallback host in 23-i18n per puntare alla modale).
- **Aspetto**: Tema chiaro/scuro (riuso `themeToggleBtn`/`applyTheme`); **Font** (select tra 2-3 famiglie sicure già caricate o system-ui) → nuova var `--font-family` + `savePref('font',...)`; **Dimensione font** (range 12–16px) → nuova var `--ui-font-size` su `:root`/`body` + `savePref('fontSize',...)`.
- **Scorciatoie**: sposto qui `#shortcutsPanel` (renderer T6 in 19-prefs.js per id, invariato).
- **Avvio / Salvataggio**: sposto qui la sezione `#startupSettingsSection` creata da 22-screens (o la ricablo per costruirla nella modale invece che nel tab Vista).
- **Plugin**: cartella plugin — opzione per aprire/impostare (desktop: route backend se esiste; web: nota). Se non c'è backend per cartella plugin, mostro solo la nota "disponibile in desktop" (onestà). Verifico prima se esiste una route.
- Persistenza: estendo `initPrefs()` in 19-prefs.js per applicare font/fontSize salvati all'avvio (come già fa per tema/keymap).

## Fase 6 — Adattamenti JS
- `22-screens.js`: la funzione `buildSettingsSections()` oggi appende al tab Vista → la ricablo per costruire dentro la modale impostazioni (o lascio che la modale contenga già gli id e 22-screens li popoli). Evito duplicazioni di id.
- `23-i18n.js`: `buildLanguageSelector()` fallback host → punta alla modale invece che a `[data-panel="view"]`.
- Nuove chiavi i18n (`topbar.*`, `settings.*`, `properties.*`) in tutti i 6 locali + annotazione DOM.
- `13-history.js` riga 177: usa `[data-panel="draw"]` per le hotkey tool → invariato (il tab draw resta).

## Fase 7 — Verifica
- `node ui/build.mjs` → deterministico (doppio build + diff).
- `node --check` sul bundle JS estratto.
- Coverage i18n: tutte le chiavi DOM presenti nei 6 locali.
- Controllo che TUTTI gli id spostati esistano ancora 1× nel bundle (nessun listener orfano): objectsList, palette, toggleGrid, rotationModes, toggleWireframe, voxelGap, tutti gli export/save btn, languageSelect, shortcutsPanel, startupSettingsSection.
- Backup `index.html` prima e dopo.
- **Limite dichiarato**: non posso testare il rendering reale nel browser/QtWebEngine desktop da qui (solo parse/verifica statica), come per le wave precedenti. Il layout va provato dall'utente.

## Rischi / decisioni aperte
- Spostare nodi DOM con ID preserva i listener SOLO se i listener sono attaccati agli elementi (non delegati per posizione). Verificato: sono `getElementById(...).addEventListener` → sicuro.
- Il pannello Proprietà transform sull'oggetto attivo è intrinsecamente limitato (identità + bake distruttivo). Propongo di applicarlo all'oggetto **selezionato** e fare bake esplicito su richiesta, spiegando il limite in UI.
- "Cartella plugin": dipende dall'esistenza di una route backend; se assente, resta nota informativa.

## Ordine esecuzione
1 → 2 → 3 → 4 → 5 → 6, poi 7 (verifica). Un backup per milestone.
