"""Quali pagine web possono parlare con i server LOCALI di VoxelAI.

Il difetto (riprodotto nell'audit del 2026-10-26): l'app (main.py) e il server
MCP (mcp_server/streamable.py) rispondevano a tutto con
`Access-Control-Allow-Origin: *` e non guardavano mai l'`Origin`. Una pagina
qualunque aperta nel browser poteva quindi fare `fetch("http://127.0.0.1:8755/
api/project/save", ...)` e scrivere un file dove voleva, iniettare un provider
AI, cancellare i cookie, e leggere le risposte.

La regola, uguale per i due server (ed e' quella che l'SDK MCP applica al suo
/sse): una richiesta senza `Origin` (client MCP, curl, test) passa; una pagina
web passa solo se e' servita da loopback (127.0.0.1, localhost, [::1]: la UI
dell'app e' li'). `null` (iframe in sandbox, data: URL, file://) e' proprio
cio' che una pagina ostile sa fabbricare: rifiutato. Schemi non web
(vscode-webview://, app://) non sono raggiungibili da un attaccante: ammessi.
"""

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")


def origin_allowed(origin):
    """True se una richiesta con questo `Origin` puo' essere servita."""
    if origin is None or origin == "":
        return True
    o = str(origin).strip().lower()
    if o == "null":
        return False
    if not (o.startswith("http://") or o.startswith("https://")):
        return True
    host = o.split("://", 1)[1].split("/", 1)[0]
    if "@" in host:                       # http://utente@host: conta l'host
        host = host.rsplit("@", 1)[1]
    if host.startswith("["):
        name = host[:host.find("]") + 1] if "]" in host else host
    else:
        name = host.rsplit(":", 1)[0] if ":" in host else host
    return name in LOOPBACK_HOSTS
