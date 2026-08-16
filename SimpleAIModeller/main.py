"""SimpleAIModeller — asset 3D parametrici da prompt, con critica automatica.

Avvio autonomo: `python main.py` (oppure `run.bat`). Serve la UI da un server
HTTP locale su porta effimera e la apre nel browser di sistema.

RAPPORTO CON VoxelAIArtist / PixelAIEditor
-----------------------------------------
App sorella autonoma nello stesso repo. RIUSA `../src` (settings, providers,
aiclient, parser) e ha un proprio `src/` per la logica specifica (spec, vision).
NON importa `main.py` del padre: quel modulo a livello di modulo risolve la
modalita' d'avvio leggendo `sys.argv` — che qui sarebbe il NOSTRO —, importa
Gemini e il motore dei pack, e lega il proprio `BASE_DIR` alla cartella del
padre. Le funzioni condivise stanno in `src/`, importabili da entrambi.

I cookie Gemini e i provider a chiave sono CONDIVISI (stessa cartella fissa);
le impostazioni sono SEPARATE (`set_app_name("SimpleAIModeller")`).
"""

import sys
import os
import json
import time
import threading
import http.server
import subprocess
import webbrowser
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _src_dir():
    """Cartella `src/` del PADRE (condivisa), sia da sorgente sia congelata."""
    here = os.path.join(BASE_DIR, "src")
    # Il nostro src/ ha spec.py e vision.py; il padre ha settings/providers/...
    # Si cerca il padre PRIMA: e' li' che vivono i moduli condivisi.
    parent = os.path.join(os.path.dirname(BASE_DIR), "src")
    if os.path.isdir(parent) and os.path.isfile(os.path.join(parent, "settings.py")):
        return parent
    if os.path.isdir(here) and os.path.isfile(os.path.join(here, "settings.py")):
        return here
    return parent


def _own_src_dir():
    return os.path.join(BASE_DIR, "src")


def _prompts_dir():
    own = os.path.join(BASE_DIR, "assets", "prompts")
    if os.path.isdir(own):
        return own
    return os.path.join(os.path.dirname(BASE_DIR), "assets", "prompts")


# Padre PRIMA (settings, providers, aiclient, parser), poi il nostro src
# (spec, vision). L'ordine conta: se si invertisse, un `import settings` dal
# nostro src/ (che non ce l'ha) fallirebbe invece di trovare quello del padre.
sys.path.insert(0, _own_src_dir())
sys.path.insert(0, _src_dir())

import settings as app_settings  # noqa: E402
from aiclient import (  # noqa: E402
    AIAuthError,
    AIFormatError,
    AITransientError,
    _classify_ai_error,
    ai_answer_text_retrying,
)
from parser import extract_and_parse_json  # noqa: E402
import providers as ai_providers  # noqa: E402
import spec as sam_spec  # noqa: E402
import plan as sam_plan  # noqa: E402
import vision as sam_vision  # noqa: E402

app_settings.set_app_name("SimpleAIModeller")

APP_MODE = "web"
VALID_APP_MODES = ("web",)
_APP_MODE_ALIASES = {
    "browser": "web", "http": "web", "server": "web", "headless": "web",
    "py": "web", "qt": "web", "pyqt": "web", "pyqt6": "web", "desktop": "web",
}


def _resolve_app_mode(default_mode="web", argv=None, env=None):
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    env = os.environ if env is None else env
    raw, source = str(default_mode), "costante APP_MODE"
    env_val = (env.get("SAM_MODE") or env.get("VOXELAI_MODE") or "").strip()
    if env_val:
        raw, source = env_val, "variabile SAM_MODE"
    cli_val = None
    for i, arg in enumerate(argv):
        a = str(arg).strip().lower()
        if a in ("--web", "-web", "web"):
            cli_val = "web"
        elif a in ("--py", "-py", "py"):
            cli_val = "py"
        elif a.startswith("--mode="):
            cli_val = a.split("=", 1)[1]
        elif a == "--mode" and i + 1 < len(argv):
            cli_val = str(argv[i + 1])
    if cli_val:
        raw, source = cli_val, "argomento CLI"
    mode = _APP_MODE_ALIASES.get(str(raw).strip().lower(), str(raw).strip().lower())
    if mode not in VALID_APP_MODES:
        print("[avvio] modalita' '%s' non riconosciuta (%s): uso 'web'." % (raw, source))
        mode = "web"
    return mode


APP_MODE = _resolve_app_mode(APP_MODE)
PORT = 0

# --- Prompt ------------------------------------------------------------------

def _read_prompt_file(name, fallback=""):
    path = os.path.join(_prompts_dir(), name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return fallback


ASSET_PROMPT_FALLBACK = (
    "Sei un compilatore di asset 3D. Rispondi SOLO con un JSON che descrive "
    "l'asset come lista di nodi parametrici (box, cyl, sphere, ...).\n\n"
    "BRIEF:\n[INSERISCI QUI IL BRIEF]\n\n"
    "RICHIESTA:\n[INSERISCI QUI LA RICHIESTA]\n"
)

DETAIL_LABELS = ("bozza", "basso", "medio", "alto")
CAT_LABELS = {
    "char": "personaggio/creatura",
    "vehicle": "veicolo",
    "prop": "prop/oggetto di gioco",
    "struct": "struttura/architettura",
}
STYLE_LABELS = {
    "lowpoly": "low-poly stilizzato",
    "pbr": "PBR procedurale",
    "toon": "toon/cel-shaded",
}


def build_asset_prompt(request, cat="prop", style="lowpoly", detail=2,
                       size=None, ground=True, notes="", plan=None,
                       plan_obj=None):
    """Compone il prompt di generazione. La richiesta resta l'ULTIMA riga."""
    template = _read_prompt_file("prompt-asset.txt", ASSET_PROMPT_FALLBACK)
    detail = max(0, min(3, int(detail if detail is not None else 2)))
    level = sam_spec.DETAIL_LEVELS[detail]
    size = size or [1.0, 1.0, 1.0]
    if isinstance(size, (int, float)):
        size = [size, size, size]
    size = list(size) + [1.0, 1.0, 1.0]
    size = [max(0.01, float(size[i])) for i in range(3)]

    brief_lines = [
        "Categoria: %s (%s)" % (cat, CAT_LABELS.get(cat, cat)),
        "Stile: %s (%s)" % (style, STYLE_LABELS.get(style, style)),
        "Dettaglio: %d (%s) — budget nodi: %d, segmenti tondi: %d. USA il budget: "
        "servono almeno %d pezzi visibili, altrimenti l'audit rifiuta l'asset "
        "con `underDetailed`."
        % (detail, DETAIL_LABELS[detail], level["nodes"], level["seg"],
           int(level["nodes"] * (0.22 if detail == 3 else
                                 0.14 if detail == 2 else 0.0))),
        "Appoggiato a terra (y=0): %s" % ("si" if ground else "no (volante)"),
    ]
    if plan_obj:
        # Con un piano, l'ingombro NON e' un desiderio dell'utente: e' il totale
        # del piano, che e' stato verificato aritmeticamente. Ripetere qui il
        # valore del form darebbe due numeri in conflitto nello stesso prompt.
        brief_lines.append(
            "Ingombro: lo stabilisce il PIANO qui sotto (%s m). Non dichiararlo."
            % " x ".join("%.4g" % v for v in plan_obj["total"]))
    else:
        brief_lines.append(
            "Ingombro target (metri, X Y Z): %.3g x %.3g x %.3g"
            % (size[0], size[1], size[2]))
    if notes:
        brief_lines.append("Note: %s" % str(notes)[:400])
    if cat == "char":
        brief_lines.append(
            "REGOLE CATEGORIA: entrambe le braccia, abbassate a riposo; "
            "niente equipaggiamento fuso nella testa se non richiesto; "
            "simmetria L/R con mir:x.")
    elif cat == "vehicle":
        brief_lines.append(
            "REGOLE CATEGORIA: cabina MAGGIORATA; ruote/pattini a y=0 e "
            "allineati; simmetria L/R.")
    elif cat == "prop":
        brief_lines.append(
            "REGOLE CATEGORIA: se e' una piattaforma, faccia superiore piatta "
            "e centro libero; ogni elemento interattivo ha una voce in logic.")
    elif cat == "struct":
        brief_lines.append(
            "REGOLE CATEGORIA: interni cavi (sub), porte come fori veri, "
            "niente colonne in mezzo ai passaggi.")

    brief = "\n".join(brief_lines)
    text = template.replace("[INSERISCI QUI IL BRIEF]", brief)

    if plan_obj:
        plan_block = sam_plan.plan_text(plan_obj)
        params = sam_plan.plan_params(plan_obj)
        plan_block += "\n\nPARAMS GIA' PRONTI (copiali in `params` e usali nelle espressioni):\n"
        plan_block += json.dumps(params, separators=(",", ": "), ensure_ascii=False)
    elif plan:
        plan_block = str(plan)
    else:
        plan_block = ("(nessun piano: deduci tu le misure, ma tienile realistiche "
                      "e coerenti fra i pezzi)")
    text = text.replace("[INSERISCI QUI IL PIANO]", plan_block)

    # La richiesta DEVE restare ultima: un promemoria messo dopo la seppellisce.
    if "[INSERISCI QUI LA RICHIESTA]" in text:
        text = text.replace("[INSERISCI QUI LA RICHIESTA]", str(request).strip())
    else:
        text = text.rstrip() + "\n\n" + str(request).strip()
    return text


PLAN_PROMPT_FALLBACK = (
    "Sei un architetto. Rispondi SOLO con un JSON che descrive l'oggetto come "
    "catena contigua di segmenti lungo l'asse principale, con from/to in metri.\n\n"
    "BRIEF:\n[INSERISCI QUI IL BRIEF]\n\nRICHIESTA:\n[INSERISCI QUI LA RICHIESTA]\n"
)


def build_plan_prompt(request, cat="prop", style="lowpoly", detail=2,
                      size=None, ground=True, notes=""):
    """Prompt dell'architetto. La richiesta resta l'ULTIMA riga."""
    template = _read_prompt_file("prompt-plan.txt", PLAN_PROMPT_FALLBACK)
    detail = max(0, min(3, int(detail if detail is not None else 2)))
    brief = [
        "Categoria: %s (%s)" % (cat, CAT_LABELS.get(cat, cat)),
        "Dettaglio richiesto: %d (%s) — da %d a %d segmenti portanti, e da %d a %d "
        "extras (i sottodettagli: avvolgimenti, collari, scanalature, terminali)."
        % (detail, DETAIL_LABELS[detail],
           4 if detail < 2 else 5, 6 if detail < 2 else 9,
           0 if detail == 0 else (2 if detail == 1 else (4 if detail == 2 else 8)),
           3 if detail == 0 else (5 if detail == 1 else (8 if detail == 2 else 16))),
        "Appoggiato a terra: %s" % ("si" if ground else "no (volante)"),
    ]
    if size:
        try:
            sx, sy, sz = [float(x) for x in (list(size) + [0, 0, 0])[:3]]
            if max(sx, sy, sz) > 0:
                brief.append(
                    "Ingombro SUGGERITO dall'utente (X Y Z, metri): %.3g x %.3g x %.3g. "
                    "E' un'indicazione: se e' irrealistica per l'oggetto, usa le "
                    "misure vere e spiega la scelta nel campo asset."
                    % (sx, sy, sz))
        except (TypeError, ValueError):
            pass
    if notes:
        brief.append("Note: %s" % str(notes)[:400])
    if cat == "char":
        brief.append("Un umanoide si misura dai piedi alla testa: la catena su Y "
                     "e' gambe -> bacino -> torso -> collo -> testa. Le braccia "
                     "sono extras appesi al torso.")
    elif cat == "vehicle":
        brief.append("Un veicolo si misura sulla LUNGHEZZA (asse z): muso -> "
                     "cofano -> abitacolo -> coda. Le ruote sono extras.")
    text = template.replace("[INSERISCI QUI IL BRIEF]", "\n".join(brief))
    if "[INSERISCI QUI LA RICHIESTA]" in text:
        text = text.replace("[INSERISCI QUI LA RICHIESTA]", str(request).strip())
    else:
        text = text.rstrip() + "\n\n" + str(request).strip()
    return text


def build_patch_prompt(digest, defects, request="", plan_obj=None):
    template = _read_prompt_file(
        "prompt-patch.txt",
        "Correggi la spec con una patch JSON.\n"
        "SPEC:\n[INSERISCI QUI LA SPEC]\n"
        "DIFETTI:\n[INSERISCI QUI I DIFETTI]\n"
        "RICHIESTA:\n[INSERISCI QUI LA RICHIESTA]\n")
    if isinstance(defects, (list, tuple)):
        defects_txt = "\n".join(
            "- [%s] %s: %s%s" % (
                d.get("sev", "?"),
                d.get("code", "?"),
                d.get("what", d.get("message", "")),
                (" (fix: %s)" % d["fix"]) if d.get("fix") else "")
            for d in defects if isinstance(d, dict))
    else:
        defects_txt = str(defects)
    spec_block = str(digest)
    if plan_obj:
        # Il piano va DENTRO il prompt di patch, non solo in quello di build: i
        # difetti aritmetici si esprimono come "il piano dice X", e senza la
        # tabella il correttore non ha modo di sapere quale sia X.
        spec_block = (sam_plan.plan_text(plan_obj)
                      + "\n\nSPEC ATTUALE:\n" + str(digest))
    text = template.replace("[INSERISCI QUI LA SPEC]", spec_block)
    text = text.replace("[INSERISCI QUI I DIFETTI]", defects_txt or "(nessuno)")
    if "[INSERISCI QUI LA RICHIESTA]" in text:
        text = text.replace("[INSERISCI QUI LA RICHIESTA]",
                            str(request).strip() or "Correggi i difetti elencati.")
    return text


def build_critic_prompt(digest, metrics, request=""):
    template = _read_prompt_file(
        "prompt-critic.txt",
        "Giudica l'asset. Metriche:\n[INSERISCI QUI LE METRICHE]\n"
        "Digest:\n[INSERISCI QUI IL DIGEST]\n"
        "Richiesta:\n[INSERISCI QUI LA RICHIESTA]\n")
    if isinstance(metrics, dict):
        metrics_txt = json.dumps(metrics, ensure_ascii=False, indent=2)
    else:
        metrics_txt = str(metrics)
    text = template.replace("[INSERISCI QUI LE METRICHE]", metrics_txt)
    text = text.replace("[INSERISCI QUI IL DIGEST]", str(digest))
    if "[INSERISCI QUI LA RICHIESTA]" in text:
        text = text.replace("[INSERISCI QUI LA RICHIESTA]",
                            str(request).strip() or "Giudica l'asset.")
    return text


PART_PROMPT_FALLBACK = (
    "Costruisci UN SOLO pezzo dell'oggetto. Rispondi SOLO con un JSON "
    "{\"nodes\":[...]}.\n\nPIANO:\n[INSERISCI QUI IL PIANO]\n\n"
    "COMPITO:\n[INSERISCI QUI IL COMPITO]\n\n"
    "MATERIALI:\n[INSERISCI QUI I MATERIALI]\n\n"
    "PARAMS:\n[INSERISCI QUI I PARAMS]\n\n"
    "RICHIESTA:\n[INSERISCI QUI LA RICHIESTA]\n"
)


def build_part_prompt(request, plan_obj, task, detail=2, style="lowpoly",
                      notes=""):
    """Prompt per UN pezzo. La richiesta resta l'ULTIMA riga."""
    template = _read_prompt_file("prompt-part.txt", PART_PROMPT_FALLBACK)
    text = template.replace("[INSERISCI QUI IL PIANO]",
                            sam_plan.plan_text(plan_obj))
    text = text.replace("[INSERISCI QUI IL COMPITO]",
                        sam_plan.task_text(plan_obj, task))

    mats = plan_obj.get("materials") or []
    if mats:
        lines = []
        for m in mats:
            mark = "  <- per il tuo pezzo" if m["n"] in (task.get("suggestedMats") or []) else ""
            lines.append("  %-14s %-8s  su: %s%s"
                         % (m["n"], m["col"], ", ".join(m.get("on") or []), mark))
        mats_txt = "\n".join(lines)
    else:
        mats_txt = ("  (il piano non ne dichiara: inventane 2-3 coerenti e usa "
                    "gli stessi nomi in tutti i pezzi)")
    text = text.replace("[INSERISCI QUI I MATERIALI]", mats_txt)
    text = text.replace("[INSERISCI QUI I PARAMS]",
                        json.dumps(sam_plan.task_params(plan_obj, task),
                                   separators=(",", ": "), ensure_ascii=False))

    detail = max(0, min(3, int(detail if detail is not None else 2)))
    req = [
        "Oggetto: %s" % (plan_obj.get("asset") or request),
        "Richiesta originale dell'utente: %s" % str(request).strip(),
        "Stile: %s (%s)" % (style, STYLE_LABELS.get(style, style)),
        "Livello di dettaglio: %d (%s) — %s"
        % (detail, DETAIL_LABELS[detail],
           "solo il volume, nessun fronzolo" if detail == 0 else
           "volume e i dettagli principali" if detail == 1 else
           "volume, dettagli e giunzioni curate" if detail == 2 else
           "massima cura: giunzioni, collari, smussi, rilievi, tutto cio' che "
           "il pezzo ha nella realta'"),
    ]
    if notes:
        req.append("Note dell'utente: %s" % str(notes)[:300])
    text = text.replace("[INSERISCI QUI LA RICHIESTA]", "\n".join(req))
    return text


# --- HTTP handler ------------------------------------------------------------

class SAMRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def translate_path(self, path):
        if path.startswith("/locales/"):
            path = "/ui" + path
        translated = super().translate_path(path)
        rel = os.path.relpath(translated, os.getcwd())
        return os.path.join(BASE_DIR, rel)

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _log_ai_answer(self, label, answer, exc=None):
        print("\n=== ERRORE %s ===" % label)
        print((answer or "[Risposta non disponibile]")[:2000])
        print("=" * 20)
        if exc is not None:
            import traceback
            traceback.print_exception(type(exc), exc, exc.__traceback__)

    def _send_ai_error(self, exc, label):
        self._log_ai_answer(label, getattr(exc, "answer", None), exc)
        if isinstance(exc, AIAuthError):
            try:
                uses_cookies = ai_providers.public_summary().get("usesCookies", True)
            except Exception:                                   # noqa: BLE001
                uses_cookies = True
            self._send_json(401, {"error": str(exc), "needsCookies": uses_cookies,
                                  "needsProvider": (not uses_cookies)})
        elif isinstance(exc, AIFormatError):
            self._send_json(400, {"error": str(exc)})
        else:
            self._send_json(503, {"error": str(exc), "retryable": True})

    def _serve_html(self, fs_path):
        try:
            with open(fs_path, "r", encoding="utf-8") as f:
                content = f.read()
        except OSError:
            self.send_error(404)
            return
        body = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- GET -----------------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path

        if route in ("/", "/ui/", "/index.html", "/ui/index.html"):
            self._serve_html(os.path.join(BASE_DIR, "ui", "index.html"))
            return

        if route == "/api/settings":
            _has_cookies = app_settings.has_cookies()
            summary = ai_providers.public_summary()
            self._send_json(200, {
                "has_cookies": _has_cookies,
                "needsCookies": (not _has_cookies) and summary.get("usesCookies", True),
                "cookie_count": len(app_settings.load_cookies()),
                "cookies_path": app_settings.get_cookies_path(),
                "appdata_dir": app_settings.get_appdata_dir(),
                "app_mode": APP_MODE,
                "is_desktop": False,
                "app": "SimpleAIModeller",
                "provider": summary,
            })
            return

        if route == "/api/settings/open-folder":
            try:
                folder = app_settings.get_appdata_dir()
                if sys.platform.startswith("win"):
                    subprocess.Popen('explorer "%s"' % folder)
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", folder])
                else:
                    subprocess.Popen(["xdg-open", folder])
                self._send_json(200, {"ok": True})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == "/api/prefs":
            try:
                self._send_json(200, {"settings": app_settings.get_public_settings()})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == "/api/providers":
            try:
                self._send_json(200, ai_providers.list_providers())
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == "/api/providers/models":
            qs = parse_qs(parsed.query)
            pid = (qs.get("id") or qs.get("provider") or [""])[0]
            try:
                self._send_json(200, ai_providers.list_models(pid))
            except ai_providers.AIAuthError as e:
                self._send_json(401, {"error": str(e)})
            except ai_providers.AIFormatError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == "/api/schema":
            # Espone tabelle condivise alla UI e ai test: primitive, detail,
            # categorie, stili. Una sola fonte di verita'.
            self._send_json(200, {
                "version": sam_spec.SPEC_VERSION,
                "categories": list(sam_spec.CATEGORIES),
                "styles": list(sam_spec.STYLES),
                "primitives": sorted(sam_spec.PRIMITIVES.keys()),
                "detailLevels": list(sam_spec.DETAIL_LEVELS),
                "flags": list(sam_spec.FLAGS),
                "boolOps": list(sam_spec.BOOL_OPS),
                "noiseTypes": list(sam_spec.NOISE_TYPES),
            })
            return

        super().do_GET()

    # --- POST handlers -------------------------------------------------------

    def _handle_generate(self):
        """POST /api/asset/generate — prompt -> spec JSON normalizzata."""
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Atteso un oggetto JSON."})
            return

        request = str(payload.get("prompt") or payload.get("request") or "").strip()
        if not request:
            self._send_json(400, {"error": "Descrizione dell'asset mancante."})
            return

        cat = str(payload.get("cat") or payload.get("category") or "prop").strip().lower()
        cat = sam_spec.CATEGORY_ALIASES.get(cat, cat)
        if cat not in sam_spec.CATEGORIES:
            cat = "prop"
        style = str(payload.get("style") or "lowpoly").strip().lower()
        style = sam_spec.STYLE_ALIASES.get(style, style)
        if style not in sam_spec.STYLES:
            style = "lowpoly"
        detail = int(payload.get("detail") if payload.get("detail") is not None else 2)
        detail = max(0, min(3, detail))
        size = payload.get("size") or [1.0, 1.0, 1.0]
        ground = bool(payload.get("ground", True))
        notes = str(payload.get("notes") or "")
        model = payload.get("model")
        # Il piano e' il DEFAULT, non un'opzione: senza, il modello piazza i
        # pezzi indovinando i centri ed e' esattamente il difetto che questa
        # architettura esiste per eliminare. Si disattiva solo esplicitamente.
        want_plan = payload.get("planFirst")
        if want_plan is None:
            want_plan = payload.get("plan")
        want_plan = True if want_plan is None else bool(want_plan)

        plan_obj = None
        plan_warns = []
        plan_raw_text = None
        answer = None
        try:
            if want_plan:
                plan_prompt = build_plan_prompt(
                    request, cat=cat, style=style, detail=detail,
                    size=size, ground=ground, notes=notes)
                plan_raw_text = ai_answer_text_retrying(plan_prompt, model)
                try:
                    plan_raw = extract_and_parse_json(plan_raw_text)
                    plan_obj, plan_warns = sam_plan.normalize_plan(plan_raw, request)
                except (ValueError, TypeError, json.JSONDecodeError) as e:
                    # Un piano illeggibile NON blocca la generazione: si prosegue
                    # senza, che e' il comportamento di prima. Bloccare qui
                    # trasformerebbe un miglioramento in un nuovo modo di
                    # fallire.
                    print("[plan] piano non utilizzabile (%s): proseguo senza." % e)
                    plan_obj = None
            final_prompt = build_asset_prompt(
                request, cat=cat, style=style, detail=detail,
                size=size, ground=ground, notes=notes, plan_obj=plan_obj)
            answer = ai_answer_text_retrying(final_prompt, model)
        except (AIAuthError, AITransientError, AIFormatError) as e:
            self._send_ai_error(e, "ASSET GENERATE")
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "ASSET GENERATE")
            return

        try:
            raw = extract_and_parse_json(answer)
        except Exception as e:                                  # noqa: BLE001
            self._log_ai_answer("ASSET GENERATE", answer, e)
            self._send_json(400, {
                "error": "Il modello non ha restituito JSON. Riprova. Dettaglio: %s" % e,
                "rawPreview": (answer or "")[:400],
            })
            return

        try:
            normalized, warns = sam_spec.normalize_spec(raw, request={
                "cat": cat, "style": style, "detail": detail,
                "hasPlan": bool(plan_obj),
            })
        except ValueError as e:
            self._log_ai_answer("ASSET GENERATE", answer, e)
            self._send_json(400, {
                "error": str(e),
                "rawPreview": (answer or "")[:400],
            })
            return

        # Con un piano, l'ingombro dichiarato dalla spec non vale: vale il piano.
        # Il valore FINALE lo misura il motore sulla mesh, e l'audit confronta i
        # due. Tenere qui il numero inventato dal modello darebbe difetti di
        # ingombro contro un bersaglio che nessuno ha verificato.
        if plan_obj:
            normalized["size"] = list(plan_obj["total"])
            missing = [k for k in sam_plan.plan_params(plan_obj)
                       if k not in (normalized.get("params") or {})]
            if missing:
                normalized.setdefault("params", {}).update(
                    {k: v for k, v in sam_plan.plan_params(plan_obj).items()
                     if k in missing})
                warns.append({"code": "planParamsInjected", "v": str(len(missing))})

        stats = sam_spec.spec_stats(normalized)
        if warns:
            print("[asset] normalizzata con %d avvisi: %s"
                  % (len(warns), json.dumps(warns[:8], ensure_ascii=False)))
        self._send_json(200, {
            "spec": normalized,
            "warnings": warns,
            "stats": stats,
            "digest": sam_spec.spec_digest(normalized),
            "plan": plan_obj,
            "planWarnings": plan_warns,
            "planStats": sam_plan.plan_stats(plan_obj) if plan_obj else None,
        })

    def _handle_patch(self):
        """POST /api/asset/patch — spec + difetti -> patch applicata."""
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Atteso un oggetto JSON."})
            return

        current = payload.get("spec")
        if not isinstance(current, dict):
            self._send_json(400, {"error": "Campo 'spec' mancante o non valido."})
            return
        defects = payload.get("defects") or payload.get("feedback") or ""
        request = str(payload.get("request") or payload.get("prompt") or "").strip()
        model = payload.get("model")
        plan_obj = payload.get("plan") if isinstance(payload.get("plan"), dict) else None

        # Se arriva gia' una patch pronta (es. scritta a mano dall'utente),
        # si applica senza chiamare l'AI.
        ready = payload.get("patch")
        if ready is not None:
            try:
                out, warns, applied = sam_spec.apply_patch(current, ready)
            except Exception as e:                              # noqa: BLE001
                self._send_json(400, {"error": "Patch non applicabile: %s" % e})
                return
            self._send_json(200, {
                "spec": out, "warnings": warns, "applied": applied,
                "stats": sam_spec.spec_stats(out),
                "digest": sam_spec.spec_digest(out),
                "patch": ready,
            })
            return

        digest = sam_spec.spec_for_prompt(current)
        final_prompt = build_patch_prompt(digest, defects, request, plan_obj=plan_obj)
        answer = None
        try:
            answer = ai_answer_text_retrying(final_prompt, model)
        except (AIAuthError, AITransientError, AIFormatError) as e:
            self._send_ai_error(e, "ASSET PATCH")
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "ASSET PATCH")
            return

        try:
            raw = extract_and_parse_json(answer)
        except Exception as e:                                  # noqa: BLE001
            self._log_ai_answer("ASSET PATCH", answer, e)
            self._send_json(400, {
                "error": "Il modello non ha restituito una patch JSON. Dettaglio: %s" % e,
                "rawPreview": (answer or "")[:400],
            })
            return

        try:
            out, warns, applied = sam_spec.apply_patch(current, raw)
        except Exception as e:                                  # noqa: BLE001
            self._log_ai_answer("ASSET PATCH", answer, e)
            self._send_json(400, {"error": "Patch non applicabile: %s" % e,
                                  "rawPreview": (answer or "")[:400]})
            return

        if plan_obj:
            out["size"] = list(plan_obj["total"])

        self._send_json(200, {
            "spec": out, "warnings": warns, "applied": applied,
            "stats": sam_spec.spec_stats(out),
            "digest": sam_spec.spec_digest(out),
            "patch": raw if isinstance(raw, (list, dict)) else None,
        })

    def _handle_plan(self):
        """POST /api/asset/plan — solo il piano dell'architetto."""
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Atteso un oggetto JSON."})
            return
        request = str(payload.get("prompt") or payload.get("request") or "").strip()
        if not request:
            self._send_json(400, {"error": "Descrizione dell'asset mancante."})
            return
        cat = str(payload.get("cat") or "prop").strip().lower()
        cat = sam_spec.CATEGORY_ALIASES.get(cat, cat)
        if cat not in sam_spec.CATEGORIES:
            cat = "prop"
        answer = None
        try:
            prompt = build_plan_prompt(
                request, cat=cat, style=str(payload.get("style") or "lowpoly"),
                detail=int(payload.get("detail") or 2),
                size=payload.get("size"), ground=bool(payload.get("ground", True)),
                notes=str(payload.get("notes") or ""))
            answer = ai_answer_text_retrying(prompt, payload.get("model"))
        except (AIAuthError, AITransientError, AIFormatError) as e:
            self._send_ai_error(e, "ASSET PLAN")
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "ASSET PLAN")
            return
        try:
            raw = extract_and_parse_json(answer)
            plan_obj, warns = sam_plan.normalize_plan(raw, request)
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            self._log_ai_answer("ASSET PLAN", answer, e)
            self._send_json(400, {"error": "Piano non utilizzabile: %s" % e,
                                  "rawPreview": (answer or "")[:400]})
            return
        self._send_json(200, {
            "plan": plan_obj,
            "warnings": warns,
            "stats": sam_plan.plan_stats(plan_obj),
            "text": sam_plan.plan_text(plan_obj),
            "params": sam_plan.plan_params(plan_obj),
        })

    def _handle_audit(self):
        """POST /api/asset/audit — confronta le misure REALI col piano.

        Nessuna chiamata AI: e' aritmetica. Il client manda cio' che ha misurato
        sulla mesh (ingombro totale + bbox per pezzo) e riceve i difetti con i
        numeri dentro, pronti per la patch.
        """
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Atteso un oggetto JSON."})
            return
        plan_obj = payload.get("plan")
        measured = payload.get("measured") or payload.get("metrics") or {}
        if not isinstance(plan_obj, dict) or not plan_obj.get("chain"):
            self._send_json(400, {"error": "Piano mancante o senza catena."})
            return
        try:
            defects = sam_plan.audit_built(plan_obj, measured)
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Audit fallito: %s" % e})
            return
        self._send_json(200, {
            "defects": defects,
            "verdict": "pass" if not any(d["sev"] == "high" for d in defects) else "fail",
        })

    def _handle_critique(self):
        """POST /api/asset/critique — contact sheet + metriche -> verbale."""
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Atteso un oggetto JSON."})
            return

        current = payload.get("spec") or {}
        metrics = payload.get("metrics") or {}
        image = payload.get("image") or payload.get("contactSheet")
        request = str(payload.get("request") or "").strip()
        model = payload.get("model")

        digest = sam_spec.spec_digest(current) if isinstance(current, dict) else str(current)
        final_prompt = build_critic_prompt(digest, metrics, request)

        images = None
        if image:
            images = [image]

        answer = None
        try:
            answer = ai_answer_text_retrying(final_prompt, model, images=images)
        except (AIAuthError, AITransientError, AIFormatError) as e:
            self._send_ai_error(e, "ASSET CRITIQUE")
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "ASSET CRITIQUE")
            return

        try:
            raw = extract_and_parse_json(answer)
        except Exception as e:                                  # noqa: BLE001
            # Se non e' JSON, si restituisce comunque il testo come feedback
            # umano-compatibile: l'utente puo' usarlo come brief di patch.
            self._send_json(200, {
                "verdict": "unknown",
                "score": None,
                "defects": [{
                    "code": "freeText",
                    "sev": "medium",
                    "where": "",
                    "what": (answer or "")[:800],
                    "fix": "",
                }],
                "raw": (answer or "")[:1200],
                "parseError": str(e),
            })
            return

        if not isinstance(raw, dict):
            raw = {"defects": raw if isinstance(raw, list) else [],
                   "verdict": "unknown"}
        defects = raw.get("defects") or raw.get("issues") or raw.get("problems") or []
        if not isinstance(defects, list):
            defects = [defects]
        clean = []
        for d in defects[:16]:
            if isinstance(d, str):
                clean.append({"code": "note", "sev": "medium", "where": "",
                              "what": d, "fix": ""})
            elif isinstance(d, dict):
                clean.append({
                    "code": str(d.get("code") or "note")[:40],
                    "sev": str(d.get("sev") or d.get("severity") or "medium")[:10],
                    "where": str(d.get("where") or d.get("node") or "")[:40],
                    "what": str(d.get("what") or d.get("message") or d.get("desc") or "")[:400],
                    "fix": str(d.get("fix") or d.get("suggestion") or "")[:400],
                })
        verdict = str(raw.get("verdict") or ("fail" if clean else "pass")).lower()
        if verdict not in ("pass", "fail", "unknown"):
            verdict = "fail" if clean else "pass"
        score = raw.get("score")
        try:
            score = int(score) if score is not None else None
            if score is not None:
                score = max(0, min(100, score))
        except (TypeError, ValueError):
            score = None

        self._send_json(200, {
            "verdict": verdict,
            "score": score,
            "defects": clean,
            "raw": (answer or "")[:400],
        })

    def _handle_tasks(self):
        """POST /api/asset/tasks — il piano diventa una lista di compiti.

        Nessuna chiamata AI: la decomposizione e' contenuta nel piano (un
        compito per segmento, con i suoi dettagli). Chiederla a un modello
        sarebbe pagare per un'informazione che abbiamo gia'.
        """
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        plan_obj = payload.get("plan") if isinstance(payload, dict) else None
        if not isinstance(plan_obj, dict) or not plan_obj.get("chain"):
            self._send_json(400, {"error": "Piano mancante o senza catena."})
            return
        try:
            tasks = sam_plan.plan_tasks(plan_obj)
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Decomposizione fallita: %s" % e})
            return
        self._send_json(200, {
            "tasks": tasks,
            "count": len(tasks),
            "texts": [sam_plan.task_text(plan_obj, t) for t in tasks],
        })

    def _handle_part(self):
        """POST /api/asset/part — costruisce i nodi di UN pezzo.

        Il pezzo arriva con le sue quote e le sue interfacce: chi lo costruisce
        vede un compito piccolo e ben definito invece di un oggetto intero, ed e'
        questa la differenza fra sessanta nodi approssimativi e sei gruppi curati.
        """
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Atteso un oggetto JSON."})
            return
        plan_obj = payload.get("plan")
        if not isinstance(plan_obj, dict) or not plan_obj.get("chain"):
            self._send_json(400, {"error": "Piano mancante o senza catena."})
            return
        task = payload.get("task")
        if not isinstance(task, dict) or not task.get("seg"):
            # Con il solo indice si ricalcola: il client non deve rimandarci
            # una struttura che sappiamo derivare.
            try:
                idx = int(payload.get("index", -1))
            except (TypeError, ValueError):
                idx = -1
            tasks = sam_plan.plan_tasks(plan_obj)
            if idx < 0 or idx >= len(tasks):
                self._send_json(400, {"error": "Compito mancante o indice fuori range."})
                return
            task = tasks[idx]

        request = str(payload.get("prompt") or payload.get("request") or "").strip()
        detail = payload.get("detail")
        style = str(payload.get("style") or "lowpoly").strip().lower()
        style = sam_spec.STYLE_ALIASES.get(style, style)
        if style not in sam_spec.STYLES:
            style = "lowpoly"

        answer = None
        try:
            prompt = build_part_prompt(request, plan_obj, task,
                                       detail=detail, style=style,
                                       notes=str(payload.get("notes") or ""))
            answer = ai_answer_text_retrying(prompt, payload.get("model"))
        except (AIAuthError, AITransientError, AIFormatError) as e:
            self._send_ai_error(e, "ASSET PART %s" % task.get("name"))
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "ASSET PART")
            return

        try:
            raw = extract_and_parse_json(answer)
        except Exception as e:                                  # noqa: BLE001
            self._log_ai_answer("ASSET PART %s" % task.get("name"), answer, e)
            self._send_json(400, {
                "error": "Il pezzo \"%s\" non e' tornato in JSON. Dettaglio: %s"
                         % (task.get("name"), e),
                "rawPreview": (answer or "")[:400],
            })
            return

        # Si valida come mini-spec: si riusa `normalize_spec`, che sa gia'
        # ricondurre alias, primitive ignote e riferimenti rotti. Costruire un
        # secondo validatore per i pezzi vorrebbe dire due validatori che
        # divergono.
        if isinstance(raw, list):
            raw = {"nodes": raw}
        if not isinstance(raw, dict):
            self._send_json(400, {"error": "Risposta non utilizzabile per il pezzo."})
            return
        mini = {
            "id": task.get("name") or "parte",
            "cat": "prop",
            "style": style,
            "detail": detail if detail is not None else 2,
            "nodes": raw.get("nodes") or raw.get("parts") or [],
            "params": dict(sam_plan.task_params(plan_obj, task)),
            "mats": {m["n"]: {"col": m["col"]}
                     for m in (plan_obj.get("materials") or [])},
        }
        extra_params = raw.get("params")
        if isinstance(extra_params, dict):
            for k, v in extra_params.items():
                # I params del piano VINCONO: un pezzo che ridefinisce una quota
                # della catena la sposterebbe per tutti.
                if k not in mini["params"]:
                    mini["params"][k] = v
        try:
            normalized, warns = sam_spec.normalize_spec(mini, request={
                "cat": "prop", "style": style, "hasPlan": True,
            })
        except ValueError as e:
            self._log_ai_answer("ASSET PART %s" % task.get("name"), answer, e)
            self._send_json(400, {
                "error": "Il pezzo \"%s\" non contiene nodi utilizzabili: %s"
                         % (task.get("name"), e),
                "rawPreview": (answer or "")[:400],
            })
            return

        self._send_json(200, {
            "name": task.get("name"),
            "index": task.get("i"),
            "nodes": normalized.get("nodes") or [],
            "params": {k: v for k, v in (normalized.get("params") or {}).items()},
            "warnings": warns,
        })

    def _handle_vision_probe(self):
        """POST /api/vision/probe — misura se il provider vede le immagini."""
        try:
            payload = self._read_json_body() if int(self.headers.get("Content-Length") or 0) else {}
        except Exception:                                       # noqa: BLE001
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        result = sam_vision.run_probe(
            provider=payload.get("provider") or payload.get("id"),
            model=payload.get("model"),
            seed=payload.get("seed"),
        )
        self._send_json(200, result)

    def _handle_normalize(self):
        """POST /api/asset/normalize — normalizza una spec senza chiamare l'AI."""
        try:
            payload = self._read_json_body()
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        raw = payload.get("spec") if isinstance(payload, dict) else payload
        try:
            normalized, warns = sam_spec.normalize_spec(raw, request=payload.get("request") if isinstance(payload, dict) else None)
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            self._send_json(400, {"error": str(e)})
            return
        self._send_json(200, {
            "spec": normalized,
            "warnings": warns,
            "stats": sam_spec.spec_stats(normalized),
            "digest": sam_spec.spec_digest(normalized),
        })

    def do_POST(self):
        route = urlparse(self.path).path

        if route in ("/api/asset/generate", "/api/generate"):
            self._handle_generate()
            return
        if route in ("/api/asset/plan", "/api/plan"):
            self._handle_plan()
            return
        if route in ("/api/asset/tasks", "/api/tasks"):
            self._handle_tasks()
            return
        if route in ("/api/asset/part", "/api/part"):
            self._handle_part()
            return
        if route in ("/api/asset/audit", "/api/audit"):
            self._handle_audit()
            return
        if route in ("/api/asset/patch", "/api/patch"):
            self._handle_patch()
            return
        if route in ("/api/asset/critique", "/api/critique"):
            self._handle_critique()
            return
        if route in ("/api/asset/normalize", "/api/normalize"):
            self._handle_normalize()
            return
        if route == "/api/vision/probe":
            self._handle_vision_probe()
            return

        if route == "/api/prefs":
            try:
                body = self._read_json_body()
                patch = body.get("settings", body) if isinstance(body, dict) else {}
                updated = app_settings.merge_settings(patch)
                self._send_json(200, {"settings": {
                    k: v for k, v in updated.items()
                    if k not in ("cookies", "cookie", "token", "secret", "password", "auth")
                }})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == "/api/settings/cookies":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    self._send_json(400, {"error": "Corpo della richiesta mancante."})
                    return
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (TypeError, ValueError) as e:
                self._send_json(400, {"error": "Richiesta non valida: %s" % e})
                return
            try:
                app_settings.save_cookies(data)
                self._send_json(200, {"ok": True})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route in ("/api/providers", "/api/providers/test"):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    self._send_json(400, {"error": "Corpo della richiesta mancante."})
                    return
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (TypeError, ValueError) as e:
                self._send_json(400, {"error": "Richiesta non valida: %s" % e})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "Il corpo deve essere un oggetto JSON."})
                return
            try:
                if route == "/api/providers/test":
                    pid = payload.get("id") or ""
                    if not pid:
                        self._send_json(400, {"error": "parametro 'id' mancante"})
                        return
                    self._send_json(200, ai_providers.test_provider(pid))
                    return
                action = payload.get("action") or ""
                if action == "activate":
                    self._send_json(200, ai_providers.set_active_provider(payload.get("id")))
                    return
                if payload.get("id") and action != "add":
                    entry = ai_providers.update_provider(payload["id"], payload)
                else:
                    entry = ai_providers.add_provider(payload)
                self._send_json(200, {"provider": entry, **ai_providers.list_providers()})
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        self._send_json(404, {"error": "Endpoint non trovato: %s" % route})

    def do_DELETE(self):
        route = urlparse(self.path).path
        if route == "/api/settings/cookies":
            try:
                p = app_settings.get_cookies_path()
                if os.path.exists(p):
                    os.remove(p)
                self._send_json(200, {"ok": True})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return
        if route == "/api/providers":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                pid = body.get("id") if isinstance(body, dict) else None
                if not pid:
                    qs = parse_qs(urlparse(self.path).query)
                    pid = (qs.get("id") or [""])[0]
                self._send_json(200, ai_providers.delete_provider(pid))
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return
        self._send_json(404, {"error": "Endpoint non trovato: %s" % route})


# --- Avvio -------------------------------------------------------------------

def start_server():
    global PORT
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(("127.0.0.1", 0), SAMRequestHandler)
    PORT = server.server_address[1]
    print("[server] SimpleAIModeller in ascolto sulla porta %d" % PORT)
    server.serve_forever()


def _print_cookie_hint():
    try:
        if app_settings.has_cookies():
            return
        summary = ai_providers.public_summary()
        if not summary.get("usesCookies", True):
            return
    except Exception as e:                                      # noqa: BLE001
        print("[cookie] impossibile verificare i cookie: %s" % e)
        return
    print("-" * 78)
    print(" Nessun cookie salvato: la generazione AI non funzionera' finche' non")
    print(" li incolli in Impostazioni (dentro l'app), oppure configuri un")
    print(" provider a chiave API.")
    print(" I cookie e i provider sono CONDIVISI con VoxelAIArtist e PixelAIEditor.")
    try:
        print(" Cartella cookie: %s" % app_settings.get_cookies_dir())
    except Exception:
        pass
    print("-" * 78)


def run_web_mode():
    url = "http://127.0.0.1:%d/ui/index.html" % PORT
    print("")
    print("=" * 78)
    print(" SimpleAIModeller - asset 3D parametrici da prompt")
    print(" Interfaccia: %s" % url)
    print(" Server:      http://127.0.0.1:%d" % PORT)
    print(" Per chiudere: premi Ctrl+C in questa finestra.")
    print("=" * 78)
    print("")
    try:
        webbrowser.open(url)
    except Exception as e:                                      # noqa: BLE001
        print("[web] impossibile aprire il browser (%s): apri a mano %s" % (e, url))
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nServer arrestato. A presto.")
    return 0


if __name__ == "__main__":
    if not os.path.exists(os.path.join(BASE_DIR, "ui", "index.html")):
        print("[avvio] ui/index.html non trovato: generalo con "
              "`node ui/build.mjs` da questa cartella.")

    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    while PORT == 0:
        time.sleep(0.1)

    _print_cookie_hint()
    sys.exit(run_web_mode())
