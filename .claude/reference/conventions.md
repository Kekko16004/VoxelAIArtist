# Convenzioni & regole del progetto

## Regole tassative (rompono l'app se ignorate)
1. **Op paritari**: ogni modifica alla semantica degli op va fatta in `src/parser.py` (`expand_ops`) **E** in `ui/index.html` (`expandOps`). Sono due implementazioni gemelle.
2. **Three.js r128**: le API sono pinnate a r128 via CDN. NON usare API di versioni moderne (es. moduli ES, `BatchedMesh`, ecc.).
3. **Lingua UI = Italiano**: ogni stringa visibile all'utente in italiano.
4. **Segreti**: `token.txt`, `cookies.json`, `settings.json` contengono credenziali di sessione. Mai committare, mai stamparne il contenuto.
5. **Un solo file frontend**: tutto il frontend è inline in `ui/index.html` (HTML+CSS+JS). Nessun bundler.

## Formato dati (contratto centrale)
Modelli in formato compact `palette` + `ops`, espansi in flat `{voxels:[{x,y,z,color}]}`.
Ops (in ordine, i successivi sovrascrivono): `fill`, `box` (guscio), `line`, `rect axis level`, `set color x y z...`, `del`. Colore = chiave palette o `#RRGGBB`, fallback `#CCCCCC`.

## Stile codice
- Python: stdlib-first, niente dipendenze extra se evitabile. Gestione errori difensiva sul parsing LLM (output inaffidabile).
- JS: stile del file esistente (funzioni nominate, `const`/`let`, niente framework). `voxelMap` è la source of truth per l'editing.
- CSS: usare le CSS custom properties in `:root`; il tema è glassmorphism scuro.

## Sicurezza / azioni rischiose
- Il server HTTP è locale (`127.0.0.1`, porta random) e senza auth: è per uso desktop locale. Segnalare se si espone in rete.
- Nessun git repo: fare backup manuali prima di refactor ampi su `ui/index.html` (file grande e monolitico).

## Verifica obbligatoria prima di dire "fatto"
- Python import ok + funzione esercitata su un esempio.
- `node --check` sui blocchi script del frontend.
- Se possibile, avvio `python main.py` e controllo console JS (`[JS Console]` in stdout).
