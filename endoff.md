# ENDOFF - punto di ripresa (2026-07-30)

## Contesto
Richieste utente (5 punti). **1, 2, 4, 5 sono COMPLETI.** Resta da chiudere
la coda del punto **3 (AI animations)**. Tutto il resto e' gia' buildato.

1. Weight painting stile Blender (ramp verde->rosso, influenze blend non 0/1,
   preview pennello) -> FATTO (`ui/src/lib/32-rig-tools.js`, test
   `tests/test_rig_weights.mjs`).
2. i18n: stringhe hardcoded -> `t()` + 6 locali a **629 chiavi** ciascuno
   (`ui/locales/{it,en,es,fr,de,pt}.json`) -> FATTO tranne il blocco animazioni
   descritto sotto.
3. AI animations + timeline stile Blender in basso solo in sezione rigging ->
   timeline FATTA (`ui/src/lib/33-timeline.js`, 1003 righe; markup in
   `ui/src/index.template.html` righe ~2867-2931; gate `timelineSync()` mostra
   il dock solo se `rigPreviewActive && rig.bones.length > 0`;
   `18-bootstrap-tail.js` chiama `tlTick(dt)` e include `tlIsPlaying()` nella
   condizione di `animate()`). **MANCA solo il punto A qui sotto.**
4. Ctrl+Z su azione scheletro mentre sei in altra tab -> annulla in silenzio
   (gate `rigTabActive()`) -> FATTO.
5. Gizmo rig ridotto a `0.65` (globale resta `1.2`, `01-scene-setup.js`) -> FATTO.

## COSA MANCA - Punto A: handler animazione AI
File: `ui/src/lib/15-rig.js`, righe **2256-2301**.
ATTENZIONE: quel blocco usa **indentazione a 20 spazi** - leggi il testo
verbatim prima di ogni Edit, altrimenti "String to replace not found".

### A1 - chiave i18n inesistente (bug attivo)
Riga 2284: `const ex = new Error(e.error || t('rig.anim.errGeneric'));`
`rig.anim.errGeneric` **NON esiste in nessun locale**. La chiave giusta e'
`rig.animError` = `"Errore animazione: {error}"` (it) / `"Animation error: {error}"` (en).
Nota: e' un template con `{error}`, quindi serve `t('rig.animError', {error: ...})`
oppure una nuova chiave secca. Scegli una via e resta coerente.

### A2 - `.catch` butta via la diagnostica del backend
Riga 2300: `.catch(err => alert('Errore animazione: ' + err.message))`
Il backend `POST /api/animate` (`main.py` righe 1545-1587) restituisce
`{error, unknownBones, availableBones, warnings, rawPreview}`, e il branch di
rejection (righe 2280-2289) **le mette gia'** su `ex.unknownBones`,
`ex.availableBones`, `ex.warnings`. Il `.catch` deve mostrarle: aggiungi righe
tipo "Ossa non trovate: ..." / "Ossa disponibili: ..." quando gli array non
sono vuoti. Servono 2 nuove chiavi in **tutti i 6 locali** (es.
`rig.animUnknownBones`, `rig.animAvailableBones`).

### A3 - stringhe hardcoded italiane rimaste
Righe e chiave locale gia' esistente da usare:
- 2257 `"Prima crea uno scheletro (Rig) per l'oggetto."` -> `rig.needRigForObject` (valore identico, esiste)
- 2268 `"Scheletro non pronto."` -> `rig.skeletonNotReady`
- 2270 `"Descrivi l'animazione da generare."` -> `rig.describeAnim`
- 2274 `'<span class="spinner"></span> Genero...'` -> **nessuna chiave**: crea
  `rig.animGenerating` in tutti i 6 locali (oppure riusa `generate.processing`
  = "Elaborazione..." se preferisci non aggiungere chiavi)
- 2291 `"L'AI non ha restituito track validi."` -> `rig.aiNoTracks`
- 2294 `"Nessun osso valido nei track generati."` -> `rig.aiNoValidBones`
- 2298 `` `Animazione "${finalName}" creata e in riproduzione.` `` ->
  `rig.animCreated` (ha placeholder `{name}`) -> `t('rig.animCreated', {name: finalName})`

## Punto B - AG_TODO.md
`AG_TODO.md` si fermava a item 65 e **non contiene** le voci di questo lavoro.
Appendi le 5 richieste completate con lo stesso formato delle altre righe:
`- [x] descrizione (100%)`.

## Vincoli da NON violare
- `ui/index.html` e' **GENERATO**: modifica solo `ui/src/index.template.html` +
  `ui/src/lib/*.js` + `ui/src/manifest.json`, poi `node ui/build.mjs`.
- `ui/src/**` e' letto/scritto in **latin1**: nessuna emoji, freccia unicode
  (usa `->`), virgoletta tipografica, bullet. Apostrofi ASCII.
- `ui/locales/*.json` sono **UTF-8** (la regola latin1 NON vale qui) e usano
  **chiavi piatte con punti** (`"rig.wp.mode"`), non oggetti annidati.
- Helper i18n: `t(key, vars)` - **due argomenti**, non esiste un terzo argomento
  di fallback. L'interpolazione `{x}` la fa `interpolate(s, vars)`.
- I file in `ui/src/lib/` sono frammenti di **un unico scope**: nessun
  `import`/`export`; chiamate cross-modulo guardate con
  `typeof x === 'function'`.
- Three.js pinnato a r128: `skinIndex`/`skinWeight` sono vec4 -> max 4 ossa per
  vertice (`MAX_BONE_INFLUENCES = 4`).
- Rendering on-demand: dopo ogni cambio scena chiama `requestRender()`.
- Script di supporto: scrivili con il tool Write, **mai heredoc** (un heredoc
  aveva trasformato `\b` in un vero carattere backspace).
- File temporanei in `C:/Users/FRANCY/.claude/jobs/e0b24b6d/tmp`.
- `token.txt` e `cookies.json` contengono credenziali: mai committare ne'
  stampare il contenuto.

## Verifica finale (obbligatoria, in quest'ordine)
```bash
node ui/build.mjs                  # atteso: 35 moduli, build OK
node tests/test_rig_tools.mjs      # atteso pass=72
node tests/test_rig_weights.mjs    # atteso pass=17
bash tests/run_all.sh              # atteso: "TUTTI I CONTROLLI SUPERATI"
```
`run_all.sh` include il test di completezza i18n: se aggiungi chiavi devi
aggiungerle a **tutti e 6** i locali o il test fallisce (conteggio atteso
629 + n).

## Stato build al momento dello stop
`node ui/build.mjs` eseguito con successo: 35 moduli, bundle 752572 byte,
`ui/index.html` 919002 byte / 16477 righe. Le suite di test **non** sono state
rilanciate dopo l'ultima modifica al branch di rejection -> vanno rilanciate.
