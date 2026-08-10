"""`python -m mcp_server` avvia il server sul canale stdio.

Regge anche `python percorso/a/mcp_server` (la CARTELLA come argomento), che e'
la forma comoda per i client che non sanno impostare una directory di lavoro —
Claude Desktop fra questi. In quel caso Python esegue questo file senza pacchetto
genitore, quindi `from .server import ...` solleverebbe
`ImportError: attempted relative import with no known parent package`: si
aggiunge la radice del repo a `sys.path` e si importa per nome assoluto, come fa
gia' `server.py` per il caso simmetrico (`python mcp_server/server.py`).
"""

import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from mcp_server.server import main
else:
    from .server import main

main()
