#!/usr/bin/env bash
# Esegue tutta la suite di verifica di PixelAIEditor.
# Uso:  bash PixelAIEditor/tests/run_all.sh
#
# Non serve rete, ne' cookie, ne' quota AI. I primi tre test leggono solo file
# locali; il quarto avvia il server dell'app su una porta scelta dal sistema e la
# interroga da 127.0.0.1, senza uscire dalla macchina e senza chiamare l'AI.
# Nessuno di essi modifica il repository: test_build.mjs rigenera il bundle per
# confrontarlo, ma rimette i file com'erano.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

fails=0
run() {
  local label="$1"; shift
  echo ""
  echo "=============================================="
  echo " $label"
  echo "=============================================="
  if "$@"; then
    echo "--> OK: $label"
  else
    echo "--> FALLITO: $label"
    fails=$((fails + 1))
  fi
}

# 1. Chiavi i18n. La guardia di maggior valore della suite: una chiave citata dal
#    codice e assente dal dizionario non solleva niente, `t()` ripiega sul NOME
#    della chiave e quel nome arriva fino allo schermo. La prima scansione con
#    questo criterio ha trovato 26 chiavi fantasma, fra cui `pix.sc.groupTools`,
#    che compariva come titolo di gruppo nella finestra delle scorciatoie.
#    Copre anche la parita' fra le 6 lingue e i segnaposto {nome}: una traduzione
#    che perde {count} mostra una frase senza numero, una che lo storpia lo
#    stampa a schermo con le graffe.
run "Chiavi i18n (fantasma, parita', segnaposto)" node tests/test_i18n_keys.mjs

# 2. L'altra meta': nessun testo per l'utente scritto in chiaro. Il test 1 non
#    puo' vederlo -- una stringa italiana mai diventata chiave non MANCA da
#    nessun dizionario, semplicemente non esiste -- e il sintomo e' un'app che
#    resta parzialmente in italiano in tutte e sei le lingue.
run "Guardia i18n (niente testi hardcoded)" node tests/test_i18n_hardcoded.mjs

# 3. Build: moduli senza collisioni (i moduli sono fette di UNA closure, un
#    `const` doppio e' un SyntaxError e la pagina resta disegnata ma morta), ogni
#    <script> del bundle che compila, e soprattutto ui/index.html AGGIORNATO -
#    un bundle committato senza rilanciare la build fa servire all'app codice
#    vecchio mentre le sorgenti mostrano la correzione.
run "Build, moduli e bundle aggiornato" node tests/test_build.mjs

# 4. L'avvio autonomo: il prompt chiedeva "un file bat/py per avviare solo
#    quello", e nessuno degli altri tre passa da `main.py`. La verifica GUI
#    nemmeno: serve la pagina da un server di comodo suo. Quindi `BASE_DIR`,
#    `translate_path` e le rotte `/api/*` sarebbero provati solo dall'utente.
#    Copre anche i cookie condivisi col padre e le impostazioni separate: se la
#    condivisione si rompesse, l'app chiederebbe di rifare il login soltanto
#    quando e' avviata da sola, cioe' mai durante una prova del ponte.
run "Avvio autonomo: il server serve l'app" python tests/test_standalone_server.py

echo ""
echo "=============================================="
if [ "$fails" -eq 0 ]; then
  echo " TUTTI I CONTROLLI SUPERATI"
else
  echo " CONTROLLI FALLITI: $fails"
fi
echo "=============================================="
exit "$fails"
