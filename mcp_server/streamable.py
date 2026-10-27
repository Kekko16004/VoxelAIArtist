"""Trasporto Streamable HTTP (`/mcp`) accanto a SSE (`/sse`).

mcp 1.7.1 (pinnato) parla HTTP solo come SSE: GET /sse + POST /messages/.
I client nuovi (Zcode, type=http / streamable-http) POSTANO su un unico
endpoint `/mcp` e si aspettano JSON (o un SSE per-risposta), con la sessione
nell'header `Mcp-Session-Id`. Senza questa rotta il bat parte, /sse funziona
su Kilo/Claude, e Zcode dice che il server non esiste.

Non si aggiorna l'SDK: FastMCP 2 cambia i nomi e romperebbe gli strumenti.
Ogni POST e' una richiesta/risposta JSON: gli strumenti si chiamano sullo
stesso FastMCP dello stdio, senza un `Server.run` in background (quello
muore a fine richiesta HTTP e la sessione sparisce).
"""

from __future__ import annotations

import contextvars
import json
import os
import sys
from uuid import uuid4

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import compat
import mcp.types as types

_mounted = False
_sessions = {}


def _log(line):
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


# Origini ammesse: la regola sta in src/localorigin.py, condivisa con main.py.
# Prima ogni risposta aveva `Access-Control-Allow-Origin: *` e una pagina web
# qualunque poteva chiamare gli strumenti (`voxel_open` legge qualunque file,
# `voxel_save` scrive) e leggere le risposte, o cancellare i cookie da /cookies.
origin_allowed = compat.origin_allowed
# L'origine della richiesta in corso, per `_cors` (chiamata in molti punti senza
# la richiesta a portata di mano). Un ContextVar e' per-task: due richieste
# concorrenti non si vedono.
_ORIGIN = contextvars.ContextVar("voxelai_origin", default=None)


def _forbidden_origin(request):
    """Una risposta 403 se l'origine non e' ammessa, altrimenti None."""
    origin = request.headers.get("origin")
    _ORIGIN.set(origin)
    if origin_allowed(origin):
        return None
    _log("[mcp] richiesta rifiutata dall'origine %s" % origin)
    return Response("origine non ammessa: %s" % origin, status_code=403)


def _cors(resp, request=None):
    # Si rimanda l'origine SOLO se e' ammessa (e solo se c'e'): `*` permetteva
    # a qualunque pagina di leggere le risposte.
    origin = (request.headers.get("origin") if request is not None
              else _ORIGIN.get())
    if origin and origin_allowed(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = (
        "Authorization, Content-Type, Accept, Mcp-Session-Id, "
        "MCP-Protocol-Version, Last-Event-ID, *"
    )
    resp.headers["Access-Control-Expose-Headers"] = "Mcp-Session-Id"
    return resp


def _session_id_of(request):
    return (
        request.headers.get("mcp-session-id")
        or request.headers.get("Mcp-Session-Id")
        or request.query_params.get("session_id")
        or ""
    ).strip()


def _wants_json(request):
    accept = (request.headers.get("accept") or "").lower()
    if not accept or "*/*" in accept:
        return True
    return "application/json" in accept


def _dump_model(obj):
    if hasattr(obj, "model_dump"):
        return obj.model_dump(by_alias=True, mode="json", exclude_none=True)
    return obj


def _resolve_session(sid):
    if sid and sid in _sessions:
        return _sessions[sid]
    live = list(_sessions.values())
    if len(live) == 1:
        return live[0]
    return None


def _rpc(req_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result if result is not None else {}
    return out


def _reply(request, payload, status=200, sid=None):
    if payload is None:
        resp = Response(status_code=status)
    elif _wants_json(request):
        resp = JSONResponse(payload, status_code=status)
    else:
        from sse_starlette import EventSourceResponse

        async def one():
            yield {"event": "message", "data": json.dumps(payload)}

        resp = EventSourceResponse(one())
        resp.status_code = status
    if sid:
        resp.headers["Mcp-Session-Id"] = sid
    return _cors(resp)


async def _dispatch(mcp, method, params):
    params = params or {}
    if method == "ping":
        return {}
    if method == "tools/list":
        tools = await mcp.list_tools()
        return {"tools": [_dump_model(t) for t in tools]}
    if method == "tools/call":
        name = params.get("name") or ""
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            raise ValueError("arguments deve essere un oggetto")
        try:
            res = await mcp.call_tool(name, args)
            # Dalle versioni recenti dell'SDK (misurato su mcp 1.26)
            # `FastMCP.call_tool` ritorna la COPPIA (contenuti, strutturato) e
            # non piu' la sola lista: iterarla dava una lista e un dizionario,
            # e `json.dumps` cadeva su `TextContent` — ogni tools/call su /mcp
            # finiva in un 500. Si accettano tutte e due le forme.
            structured = None
            if isinstance(res, tuple):
                content = res[0] if res else []
                structured = res[1] if len(res) > 1 else None
            else:
                content = res
            out = {
                "content": [_dump_model(c) for c in (content or [])],
                "isError": False,
            }
            if isinstance(structured, dict) and structured:
                out["structuredContent"] = structured
            return out
        except Exception as e:
            return {
                "content": [{"type": "text", "text": str(e)}],
                "isError": True,
            }
    if method == "resources/list":
        items = await mcp.list_resources()
        return {"resources": [_dump_model(r) for r in items]}
    if method == "resources/templates/list":
        items = await mcp.list_resource_templates()
        return {"resourceTemplates": [_dump_model(r) for r in items]}
    if method == "resources/read":
        uri = params.get("uri")
        chunks = await mcp.read_resource(uri)
        contents = []
        for item in chunks:
            data = getattr(item, "content", item)
            mime = getattr(item, "mime_type", None)
            if isinstance(data, bytes):
                import base64
                contents.append({
                    "uri": str(uri),
                    "mimeType": mime or "application/octet-stream",
                    "blob": base64.b64encode(data).decode("ascii"),
                })
            else:
                contents.append({
                    "uri": str(uri),
                    "mimeType": mime or "text/plain",
                    "text": data,
                })
        return {"contents": contents}
    if method == "prompts/list":
        items = await mcp.list_prompts()
        return {"prompts": [_dump_model(p) for p in items]}
    if method == "prompts/get":
        prompt = await mcp.get_prompt(params.get("name"), params.get("arguments"))
        return _dump_model(prompt)
    raise KeyError(method)


async def handle(request: Request, mcp) -> Response:
    denied = _forbidden_origin(request)
    if denied is not None:
        return denied
    if request.method == "OPTIONS":
        return _cors(Response(status_code=204), request)

    if request.method == "GET":
        accept = (request.headers.get("accept") or "").lower()
        if "text/event-stream" in accept:
            sid = _session_id_of(request)
            sess = _resolve_session(sid)
            if sess is None:
                return _cors(Response(
                    "Mcp-Session-Id assente o sconosciuto", status_code=400))
            from sse_starlette import EventSourceResponse

            async def empty():
                while sess["id"] in _sessions:
                    yield {"comment": "keepalive"}
                    await asyncio_sleep()

            resp = EventSourceResponse(empty())
            resp.headers["Mcp-Session-Id"] = sess["id"]
            return _cors(resp)
        return _cors(JSONResponse({
            "name": "voxelai",
            "transport": "streamable-http",
            "endpoint": "/mcp",
            "sse": "/sse",
        }))

    if request.method == "DELETE":
        sid = _session_id_of(request)
        if not sid or sid not in _sessions:
            return _cors(Response("sessione sconosciuta", status_code=404))
        _sessions.pop(sid, None)
        return _cors(Response(status_code=200))

    if request.method != "POST":
        return _cors(Response("Method Not Allowed", status_code=405))

    body = await request.body()
    try:
        raw = json.loads(body.decode("utf-8") or "null")
    except Exception as e:
        return _reply(request, _rpc(None, error={
            "code": -32700, "message": "Parse error: %s" % e}), 400)

    if not isinstance(raw, dict):
        return _reply(request, _rpc(None, error={
            "code": -32600, "message": "il corpo non e' un oggetto JSON"}), 400)

    req_id = raw.get("id")
    method = raw.get("method")
    params = raw.get("params") if isinstance(raw.get("params"), dict) else {}
    sid = _session_id_of(request)

    if raw.get("jsonrpc") != "2.0" or not method:
        return _reply(request, _rpc(req_id, error={
            "code": -32600, "message": "richiesta JSON-RPC non valida"}), 400,
                      sid=sid or None)

    if method == "initialize":
        client_version = params.get("protocolVersion") or types.LATEST_PROTOCOL_VERSION
        opts = mcp._mcp_server.create_initialization_options()
        sess = {
            "id": uuid4().hex,
            "protocolVersion": str(client_version),
        }
        if sid and sid in _sessions:
            _sessions.pop(sid, None)
        _sessions[sess["id"]] = sess
        sid = sess["id"]
        result = {
            "protocolVersion": sess["protocolVersion"],
            "capabilities": _dump_model(opts.capabilities),
            "serverInfo": {
                "name": opts.server_name,
                "version": opts.server_version,
            },
        }
        if opts.instructions:
            result["instructions"] = opts.instructions
        return _reply(request, _rpc(req_id, result), sid=sid)

    if method.startswith("notifications/"):
        if method != "notifications/initialized":
            sess = _resolve_session(sid)
            if sess is None and req_id is not None:
                return _reply(request, _rpc(req_id, error={
                    "code": -32000,
                    "message": "Sessione assente o scaduta. "
                               "POST initialize su /mcp e riprova.",
                }), 404)
        return _reply(request, None, status=202, sid=sid or None)

    sess = _resolve_session(sid)
    if sess is None:
        return _reply(request, _rpc(req_id, error={
            "code": -32000,
            "message": "Sessione assente o scaduta. "
                       "POST initialize su /mcp e riprova.",
        }), 404)

    try:
        result = await _dispatch(mcp, method, params)
    except KeyError:
        return _reply(request, _rpc(req_id, error={
            "code": -32601, "message": "Method not found: %s" % method}),
                      sid=sess["id"])
    except Exception as e:
        _log("[mcp] %s: %s" % (method, e))
        return _reply(request, _rpc(req_id, error={
            "code": -32603, "message": str(e)}), 500, sid=sess["id"])
    return _reply(request, _rpc(req_id, result), sid=sess["id"])


async def asyncio_sleep():
    import asyncio
    await asyncio.sleep(15)


def mount(mcp):
    """Registra /mcp (e /mcp/) sull'app Starlette di FastMCP. Idempotente."""
    global _mounted
    if _mounted:
        return

    async def on_mcp(request: Request) -> Response:
        return await handle(request, mcp)

    async def on_root(request: Request) -> Response:
        denied = _forbidden_origin(request)
        if denied is not None:
            return denied
        return _cors(JSONResponse({
            "name": "voxelai",
            "transports": {
                "streamable-http": "/mcp",
                "sse": "/sse",
            },
        }))

    async def on_cookies(request: Request) -> Response:
        denied = _forbidden_origin(request)
        if denied is not None:
            return denied
        if request.method == "OPTIONS":
            return _cors(Response())
        if request.method == "DELETE":
            try:
                p = compat.settings_module().get_cookies_path()
                if os.path.exists(p):
                    os.remove(p)
                return _cors(JSONResponse({"ok": True}))
            except Exception as e:
                return _cors(JSONResponse({"error": str(e)}, status_code=500))
        if request.method == "GET":
            try:
                has = compat.settings_module().has_cookies()
                return _cors(JSONResponse({"ok": True, "has_cookies": has}))
            except Exception as e:
                return _cors(JSONResponse({"error": str(e)}, status_code=500))
        if request.method == "POST":
            try:
                data = await request.json()
                compat.settings_module().save_cookies(data)
                return _cors(JSONResponse({"ok": True}))
            except Exception as e:
                return _cors(JSONResponse({"error": str(e)}, status_code=500))
        return _cors(Response(status_code=405))

    for path, name in (("/mcp", "voxelai_mcp"), ("/mcp/", "voxelai_mcp_slash")):
        mcp._custom_starlette_routes.append(Route(
            path,
            endpoint=on_mcp,
            methods=["GET", "POST", "DELETE", "OPTIONS"],
            name=name,
        ))
    for path, name in (
        ("/cookies", "voxelai_cookies"),
        ("/cookies/", "voxelai_cookies_slash"),
        ("/api/settings/cookies", "voxelai_api_cookies"),
        ("/api/settings/cookies/", "voxelai_api_cookies_slash"),
    ):
        mcp._custom_starlette_routes.append(Route(
            path,
            endpoint=on_cookies,
            methods=["GET", "POST", "DELETE", "OPTIONS"],
            name=name,
        ))
    mcp._custom_starlette_routes.append(Route(
        "/",
        endpoint=on_root,
        methods=["GET"],
        name="voxelai_root",
    ))
    _mounted = True


async def close_all():
    """Svuota le sessioni vive (prove)."""
    _sessions.clear()
