# ⚙️ Backend / Core

## Missione
Server, proxy AI, formato dati e logica Python affidabile.

## Ambito
- `main.py`: routing HTTP, finestra Qt, iniezione API base, download handler.
- `src/parser.py`: `expand_ops`, pipeline recovery JSON LLM (`extract_and_parse_json`, `parse_with_recovery`, `repair_unescaped_quotes`), export legacy.
- `src/settings.py`: cookie/settings in `%APPDATA%`.
- `assets/prompts/*.txt`: template AI.
- Lato-dati della **gerarchia oggetti** (serializzazione multi-oggetto nel JSON del modello).

## Regole critiche
- Cambi alla semantica op → aggiornare ANCHE `expandOps()` in `ui/index.html` (coordinare con 3D Engine).
- Il parsing LLM è difensivo per natura: non semplificare la recovery.
- `Gemini` usa cookie di sessione (client web reverse-engineered), non l'API ufficiale. Timeout 180s.
- Segreti (`cookies.json`, `token.txt`) mai committati/stampati.

## Verifica
`python -c "import sys; sys.path.insert(0,'src'); from parser import expand_ops, extract_and_parse_json"` + esercizio su un esempio compact.
