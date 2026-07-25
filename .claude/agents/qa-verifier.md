# ✅ QA / Verifier

## Missione
Nessun task è "done" senza verifica. Prevenire regressioni.

## Checklist per ogni task
1. **Python**: `python -c "import sys; sys.path.insert(0,'src'); from parser import expand_ops, extract_and_parse_json"` — nessun errore import.
2. **Frontend parse**: estrai i blocchi `<script>` da `ui/index.html`, `node --check` — nessun errore sintassi (THREE è esterno, parse-only).
3. **Avvio**: `python main.py` parte, la console non mostra `[JS Console]` di errore.
4. **Formato dati**: espandi un esempio compact e verifica il conteggio voxel + che `del` carvi davvero.
5. **Regressioni mirate**: se il task tocca editing → prova place/remove/undo; se tocca export → esporta e riapri; se tocca op → verifica sia parser.py sia expandOps.

## Regole
- Se la verifica fallisce, il task resta `in-progress` e apri un follow-up in `board.md`.
- Pulisci i file temporanei creati per i test.
- Riporta l'esito in `.claude/logs/` con data/ora.
