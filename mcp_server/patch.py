"""Tracciamento diagnostico: si attiva SOLO con --debug, e sta al CONFINE.

Perche' non su `FastMCP.call_tool`: un `-32602 Invalid request parameters` nasce
in `mcp/shared/session.py`, quando il SDK valida la busta JSON-RPC contro
l'unione `ClientRequest`. Quel rifiuto avviene PRIMA che esista un nome di
strumento da chiamare, quindi un aggancio su `call_tool` non stampa niente: e'
esattamente il caso in cui il pannello del client mostra un errore e il terminale
resta muto, che e' il sintomo peggiore da inseguire perche' sembra che il server
non abbia nemmeno ricevuto la richiesta.

Qui si aggancia il POST del trasporto SSE, cioe' il punto in cui i byte del
client entrano nel processo. Da li' si vede tutto: le richieste valide, quelle
storte, e quelle che il SDK scarta senza arrivare a nessuno strumento.

Costa una lettura del corpo, quindi e' spento per difetto: `install()` la chiama
`main()` solo con --debug.
"""

import json
import sys

_installed = False


def _short(v, n=300):
    s = v if isinstance(v, str) else repr(v)
    return s if len(s) <= n else s[:n] + "... (%d byte)" % len(s)


def _log(line):
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def _describe(raw):
    """Riassume una busta JSON-RPC, dicendo SUBITO se e' malformata."""
    try:
        msg = json.loads(raw)
    except Exception as e:
        return "CORPO NON-JSON (%s): %s" % (type(e).__name__, _short(raw))
    if isinstance(msg, list):
        return "batch di %d messaggi" % len(msg)
    if not isinstance(msg, dict):
        return "il corpo non e' un oggetto JSON: %s" % _short(raw)

    method = msg.get("method")
    mid = msg.get("id")
    params = msg.get("params")
    head = "%s (id=%s)" % (method or "<senza method>", mid)

    problemi = []
    if msg.get("jsonrpc") != "2.0":
        problemi.append("jsonrpc=%r invece di '2.0'" % msg.get("jsonrpc"))
    if method is None:
        problemi.append("manca 'method'")
    if method == "tools/call":
        if not isinstance(params, dict):
            problemi.append("'params' e' %s, deve essere un oggetto"
                            % type(params).__name__)
        else:
            args = params.get("arguments")
            head += " -> %s" % params.get("name")
            # E' QUESTO il caso che produce -32602: lo schema del SDK vuole
            # `arguments` come oggetto, e una stringa (anche se contiene JSON
            # valido) fa fallire la validazione dell'intera unione ClientRequest.
            if args is not None and not isinstance(args, dict):
                problemi.append(
                    "'arguments' e' %s e deve essere un oggetto: %s"
                    % (type(args).__name__, _short(args, 160)))
            elif isinstance(args, dict):
                head += " %s" % _short(json.dumps(args, ensure_ascii=False), 200)
    if problemi:
        return "%s\n    BUSTA MALFORMATA: %s" % (head, "; ".join(problemi))
    return head


def install():
    """Aggancia il POST del trasporto SSE. Idempotente."""
    global _installed
    if _installed:
        return
    try:
        from mcp.server.sse import SseServerTransport
    except Exception as e:
        _log("[diag] trasporto SSE non agganciabile: %r" % (e,))
        return

    original = SseServerTransport.handle_post_message

    async def traced(self, scope, receive, send):
        chunks = []

        async def spy():
            ev = await receive()
            if ev.get("type") == "http.request":
                chunks.append(ev.get("body", b""))
                if not ev.get("more_body"):
                    raw = b"".join(chunks).decode("utf-8", "replace")
                    _log("[diag] <- %s" % _describe(raw))
            return ev

        return await original(self, scope, spy, send)

    SseServerTransport.handle_post_message = traced
    _installed = True
    _log("[diag] tracciamento delle richieste attivo (--debug)")
