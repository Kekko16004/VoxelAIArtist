import sys
import os
import json
import time
import base64
import threading
import socketserver
import http.server
import subprocess
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE_DIR, "src"))
import settings as app_settings

os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = "--no-sandbox"

GUI_AVAILABLE = False
GUI_LIBRARY = None

try:
    from PyQt6.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QFileDialog, QMenuBar, QMenu
    from PyQt6.QtWebEngineWidgets import QWebEngineView
    from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
    from PyQt6.QtCore import QUrl, QTimer, Qt
    from PyQt6.QtGui import QKeySequence, QAction, QColor, QPalette
    GUI_AVAILABLE = True
    GUI_LIBRARY = 'PyQt6'
except ImportError:
    try:
        from PySide6.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QFileDialog, QMenuBar, QMenu
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
        from PySide6.QtCore import QUrl, QTimer, Qt
        from PySide6.QtGui import QKeySequence, QAction, QColor, QPalette
        GUI_AVAILABLE = True
        GUI_LIBRARY = 'PySide6'
    except ImportError:
        try:
            from PyQt5.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QFileDialog, QAction, QMenuBar, QMenu
            from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEnginePage, QWebEngineSettings
            from PyQt5.QtCore import QUrl, QTimer, Qt
            from PyQt5.QtGui import QKeySequence, QColor, QPalette
            GUI_AVAILABLE = True
            GUI_LIBRARY = 'PyQt5'
        except ImportError:
            pass

if GUI_AVAILABLE:
    class WebEnginePage(QWebEnginePage):
        def javaScriptConsoleMessage(self, level, message, lineNumber, sourceID):
            print(f"[JS Console] Riga {lineNumber}: {message}")

from gemini import Gemini

PORT = 0

# Riferimento globale alla finestra principale (impostato in MainWindow.__init__).
# Serve per marshalare le operazioni con QFileDialog dal thread HTTP al thread GUI.
MAIN_WINDOW = None


def _run_on_gui(fn, timeout=300):
    """Esegue `fn(main_window)` sul thread GUI Qt e ne ritorna il risultato.

    Il server HTTP gira su un thread separato; toccare widget Qt (es. QFileDialog)
    da lì è vietato. Usiamo QTimer.singleShot(0, ...) per accodare la callable
    sull'event loop del thread GUI e un threading.Event per bloccare il thread
    HTTP finché il dialog non si chiude. Il valore/eccezione vengono riportati
    indietro tramite un box condiviso. Solleva RuntimeError se la GUI non è
    disponibile (es. modalità browser fallback senza Qt).
    """
    if not GUI_AVAILABLE or MAIN_WINDOW is None:
        raise RuntimeError("GUI non disponibile: dialog file non supportati in questa modalita")
    box = {}
    done = threading.Event()

    def _invoke():
        try:
            box["result"] = fn(MAIN_WINDOW)
        except Exception as e:  # noqa: BLE001 - riportiamo qualunque errore al chiamante
            box["error"] = e
        finally:
            done.set()

    QTimer.singleShot(0, _invoke)
    if not done.wait(timeout):
        raise RuntimeError("timeout in attesa del dialog GUI")
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _write_voxai(path, data):
    """Scrive un progetto nel formato nativo .voxai (JSON wrappato). Ritorna il path.

    Se il path non ha estensione .voxai la aggiunge. Il wrapper e':
    { format:"voxai", version:1, savedAt:iso, data:{...} }.
    """
    if not path.lower().endswith(".voxai"):
        path = path + ".voxai"
    payload = {
        "format": "voxai",
        "version": 1,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "data": data,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def _apply_dark_palette(app):
    """Applica una palette scura COMPLETA a QApplication + stile Fusion.

    Perche': i dialog NATIVI di Qt (QColorDialog aperto da <input type="color">,
    QMessageBox di confirm()/alert(), QFileDialog) NON sono HTML: non leggono il
    CSS della pagina, ma la palette di QApplication. Sul tema scuro di Windows
    ereditano un fondo scuro ma tengono testo/campi con i colori chiari di
    default -> testo nero su fondo nero, illeggibile (vedi screenshot "Select
    Color"). Definendo TUTTI i ruoli colore (non solo Window, come nel tentativo
    precedente che aveva rotto i dialog) i popup nativi diventano coerenti e
    leggibili. Lo stile "Fusion" rispetta la palette meglio dello stile nativo.
    Best-effort: se QPalette non e' disponibile si prosegue senza.
    """
    if not GUI_AVAILABLE:
        return
    try:
        try:
            app.setStyle("Fusion")
        except Exception:
            pass
        Role = getattr(QPalette, "ColorRole", QPalette)
        Group = getattr(QPalette, "ColorGroup", QPalette)
        pal = QPalette()

        def _set(role_name, color):
            role = getattr(Role, role_name, None)
            if role is not None:
                pal.setColor(role, QColor(color))

        # Superfici e testo
        _set("Window", "#141220")
        _set("WindowText", "#f3f4f6")
        _set("Base", "#1c1930")
        _set("AlternateBase", "#242038")
        _set("Text", "#f3f4f6")
        _set("Button", "#242038")
        _set("ButtonText", "#f3f4f6")
        _set("ToolTipBase", "#1c1930")
        _set("ToolTipText", "#f3f4f6")
        _set("PlaceholderText", "#9ca3af")
        _set("BrightText", "#ffffff")
        # Selezione (accent grafite, in tinta con la UI)
        _set("Highlight", "#475569")
        _set("HighlightedText", "#ffffff")
        _set("Link", "#64748b")

        # Testo disabilitato leggibile su fondo scuro.
        disabled = getattr(Group, "Disabled", None)
        if disabled is not None:
            for rn in ("WindowText", "Text", "ButtonText"):
                role = getattr(Role, rn, None)
                if role is not None:
                    pal.setColor(disabled, role, QColor("#6b7280"))

        app.setPalette(pal)
    except Exception as e:  # noqa: BLE001 - la palette e' un miglioramento, non critica
        print(f"[palette] impossibile applicare la palette scura: {e}")


class VoxelAIRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def translate_path(self, path):
        translated = super().translate_path(path)
        rel = os.path.relpath(translated, os.getcwd())
        return os.path.join(BASE_DIR, rel)

    def _send_json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/settings':
            self._send_json(200, {
                "has_cookies": app_settings.has_cookies(),
                "cookie_count": len(app_settings.load_cookies()),
                "cookies_path": app_settings.get_cookies_path(),
                "appdata_dir": app_settings.get_appdata_dir(),
            })
            return
        if self.path == '/api/settings/open-folder':
            folder = app_settings.get_appdata_dir()
            subprocess.Popen(f'explorer "{folder}"')
            self._send_json(200, {"ok": True})
            return

        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)

        # --- Preferenze generiche (tema/keymap/locale/...) ---
        if route == '/api/prefs':
            try:
                self._send_json(200, {"settings": app_settings.get_public_settings()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Apertura progetto via QFileDialog (marshal sul thread GUI) ---
        if route == '/api/project/open':
            try:
                result = _run_on_gui(lambda w: w.open_project_dialog())
                if result is None:
                    self._send_json(200, {"cancelled": True})
                else:
                    self._send_json(200, result)
            except RuntimeError as e:
                self._send_json(501, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: lista ---
        if route == '/api/autosave/list':
            try:
                self._send_json(200, {"autosaves": app_settings.list_autosaves()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: contenuto singolo ---
        if route == '/api/autosave/get':
            try:
                name = (query.get('name') or [''])[0]
                if not name:
                    self._send_json(400, {"error": "parametro 'name' mancante"})
                    return
                content = app_settings.read_autosave(name)
                self._send_json(200, {"name": os.path.basename(name), "content": content})
            except (ValueError, FileNotFoundError) as e:
                self._send_json(404, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: apri cartella ---
        if route == '/api/autosave/open-folder':
            try:
                folder = app_settings.get_autosave_dir()
                subprocess.Popen(f'explorer "{folder}"')
                self._send_json(200, {"ok": True, "folder": folder})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Progetti recenti: lista ---
        if route == '/api/recent':
            try:
                self._send_json(200, {"recent": app_settings.get_recent_projects()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        super().do_GET()

    def do_DELETE(self):
        if self.path == '/api/settings/cookies':
            p = app_settings.get_cookies_path()
            if os.path.exists(p):
                os.remove(p)
            self._send_json(200, {"ok": True})
            return

        parsed = urlparse(self.path)
        if parsed.path == '/api/recent':
            try:
                query = parse_qs(parsed.query)
                path = (query.get('path') or [''])[0]
                if not path:
                    self._send_json(400, {"error": "parametro 'path' mancante"})
                    return
                recent = app_settings.remove_recent_project(path)
                self._send_json(200, {"recent": recent})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        super().do_DELETE()

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    def do_POST(self):
        # --- Preferenze generiche: merge senza perdere le altre chiavi ---
        if self.path == '/api/prefs':
            try:
                body = self._read_json_body()
                patch = body.get("settings", body) if isinstance(body, dict) else {}
                updated = app_settings.merge_settings(patch)
                self._send_json(200, {"settings": {
                    k: v for k, v in updated.items()
                    if k not in ("cookies", "cookie", "token", "secret", "password", "auth")
                }})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Salvataggio progetto nativo .voxai ---
        if self.path == '/api/project/save':
            try:
                body = self._read_json_body()
                path = body.get("path")
                data = body.get("data", {})
                if not path:
                    # nessun path → apri dialog "Salva con nome" sul thread GUI
                    try:
                        path = _run_on_gui(lambda w: w.save_project_dialog())
                    except RuntimeError as e:
                        self._send_json(501, {"error": str(e)})
                        return
                    if not path:
                        self._send_json(200, {"cancelled": True})
                        return
                saved_path = _write_voxai(path, data)
                self._send_json(200, {"path": saved_path})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: scrittura snapshot con rotazione ---
        if self.path == '/api/autosave':
            try:
                body = self._read_json_body()
                data = body.get("data", {})
                project_id = body.get("projectId")
                path = app_settings.write_autosave(data, project_id)
                self._send_json(200, {"path": path, "name": os.path.basename(path)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Progetti recenti: aggiungi/aggiorna ---
        if self.path == '/api/recent':
            try:
                body = self._read_json_body()
                entry = body.get("entry", body) if isinstance(body, dict) else {}
                recent = app_settings.add_recent_project(entry)
                self._send_json(200, {"recent": recent})
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if self.path == '/api/settings/cookies':
            length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            try:
                app_settings.save_cookies(data)
                self._send_json(200, {"ok": True})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if self.path == "/api/generate":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8'))
                prompt = payload.get("prompt", "")
                grid_size = payload.get("gridSize", "auto")
                mode = payload.get("mode", "generate")

                prompts_dir = os.path.join(BASE_DIR, "assets", "prompts")

                if mode == "modify":
                    current_model = payload.get("currentModel", {})
                    current_model_str = json.dumps(current_model, separators=(',', ':'))

                    prompt_edit_path = os.path.join(prompts_dir, "prompt-edit.txt")
                    if os.path.exists(prompt_edit_path):
                        with open(prompt_edit_path, 'r', encoding='utf-8') as pef:
                            prompt_edit_template = pef.read()
                    else:
                        prompt_edit_template = (
                            "Sei un Voxel Artist AI esperto. Devi MODIFICARE il modello voxel esistente.\n\n"
                            "Modello attuale:\n[INSERISCI QUI IL MODELLO ATTUALE]\n\n"
                            "Richiesta:\n[INSERISCI QUI LA RICHIESTA DI MODIFICA]"
                        )
                    final_prompt = prompt_edit_template.replace("[INSERISCI QUI IL MODELLO ATTUALE]", current_model_str)
                    final_prompt = final_prompt.replace("[INSERISCI QUI LA RICHIESTA DI MODIFICA]", prompt)
                else:
                    prompt_template_path = os.path.join(prompts_dir, "prompt.txt")
                    if os.path.exists(prompt_template_path):
                        with open(prompt_template_path, 'r', encoding='utf-8') as pf:
                            prompt_template = pf.read()
                    else:
                        prompt_template = "Generate voxel model: [INSERISCI QUI IL MODELLO DESIDERATO]"

                    if "[INSERISCI QUI IL MODELLO DESIDERATO]" in prompt_template:
                        final_prompt = prompt_template.replace("[INSERISCI QUI IL MODELLO DESIDERATO]", prompt)
                    else:
                        final_prompt = prompt_template.strip() + " " + prompt

                    final_prompt = (
                        f"SOGGETTO DA GENERARE: {prompt}\n\n"
                        "IMPORTANTE: Progetta da zero le coordinate per rappresentare fedelmente questo soggetto. "
                        "Non copiare le coordinate o la topologia della torre dell'esempio.\n\n"
                        + final_prompt
                    )

                if grid_size != "auto":
                    dims = grid_size.split('x')
                    if len(dims) == 3:
                        final_prompt += (
                            f"\n\n[REGOLA TASSATIVA: L'utente ha richiesto esplicitamente la griglia {grid_size}. "
                            f"Nel metadata JSON imposta ASSOLUTAMENTE 'grid_size': [{dims[0]}, {dims[1]}, {dims[2]}]. "
                            "Sfrutta tutta la griglia per aggiungere dettagli!]"
                        )

                cookies_dict = app_settings.load_cookies()
                if cookies_dict:
                    client = Gemini(cookies=cookies_dict, timeout=180)
                else:
                    client = Gemini(auto_cookies=True, timeout=180)

                response = client.generate_content(final_prompt)
                answer = response.text if hasattr(response, 'text') else str(response)

                sys.path.insert(0, os.path.join(BASE_DIR, "src"))
                from parser import extract_and_parse_json
                model_data = extract_and_parse_json(answer)

                self._send_json(200, model_data)

            except Exception as e:
                import traceback
                print("\n=== ERRORE GENERAZIONE ===")
                try:
                    print(answer)
                except NameError:
                    print("[Risposta non disponibile]")
                print("===========================")
                traceback.print_exc()
                self._send_json(500, {"error": str(e)})
        else:
            super().do_POST()


def start_server():
    global PORT
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(("127.0.0.1", 0), VoxelAIRequestHandler)
    PORT = server.server_address[1]
    print(f"Server started on port {PORT}")
    server.serve_forever()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        global MAIN_WINDOW
        MAIN_WINDOW = self
        self.setWindowTitle("VoxelAI Artist - KFDev")
        self.resize(1280, 720)

        self.browser = QWebEngineView()
        self.browser.setPage(WebEnginePage(self.browser))

        # Anti-flicker: di default QWebEngineView dipinge la pagina su BIANCO.
        # Con WebGL (alpha:true) + i backdrop-filter blur, durante repaint/resize
        # il compositor di Qt mostra per un frame quel bianco -> lampeggio. Forzando
        # lo sfondo pagina su un colore scuro (in tinta col gradiente della UI) il
        # frame intermedio combacia e il flicker sparisce. Coloriamo solo la PAGINA
        # web e il widget del browser: NON la palette della finestra, altrimenti i
        # dialog nativi (confirm()/alert() di QtWebEngine) ereditano il fondo scuro
        # ma tengono il testo scuro -> nero-su-nero illeggibile.
        _bg = QColor("#09070f")
        self.browser.page().setBackgroundColor(_bg)
        self.browser.setStyleSheet("background:#09070f;")

        settings = self.browser.settings()
        try:
            settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        except AttributeError:
            try:
                settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
            except Exception:
                pass

        self.browser.page().profile().downloadRequested.connect(self.on_downloadRequested)

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.browser)

        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

        self._build_menu()
        self.reload_page()

        reload_action = QAction(self)
        reload_action.setShortcuts([QKeySequence("F5"), QKeySequence("Ctrl+R")])
        reload_action.triggered.connect(self.reload_page)
        self.addAction(reload_action)

    def _build_menu(self):
        menubar = self.menuBar()
        file_menu = menubar.addMenu("File")

        new_action = QAction("Nuovo Progetto", self)
        new_action.triggered.connect(lambda: self.browser.page().runJavaScript("if(window.clearAll) clearAll();"))
        file_menu.addAction(new_action)

        file_menu.addSeparator()

        settings_action = QAction("⚙ Impostazioni...", self)
        settings_action.triggered.connect(self.open_settings)
        file_menu.addAction(settings_action)

    def _inject_api_base(self, html_content):
        inject = f"<script>window.__API_BASE__ = 'http://127.0.0.1:{PORT}'; window.__IS_DESKTOP__ = true;</script>"
        return html_content.replace("</head>", inject + "\n</head>", 1)

    def _load_html(self, html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            content = f.read()
        content = content.replace("fetch('/api/generate'", f"fetch('http://127.0.0.1:{PORT}/api/generate'")
        content = self._inject_api_base(content)
        self.browser.setHtml(content, QUrl.fromLocalFile(html_path))

    def reload_page(self):
        html_path = os.path.join(BASE_DIR, "ui", "index.html")
        if os.path.exists(html_path):
            self._load_html(html_path)
        else:
            self.browser.setHtml("<h1>ui/index.html non trovato!</h1>")

    def open_settings(self):
        html_path = os.path.join(BASE_DIR, "ui", "settings.html")
        if os.path.exists(html_path):
            self._load_html(html_path)

    def save_project_dialog(self):
        """Apre 'Salva con nome' (filtro .voxai) sul thread GUI. Ritorna il path
        scelto oppure None se annullato. Chiamare SOLO via _run_on_gui."""
        default_dir = app_settings.get_appdata_dir()
        default_name = os.path.join(default_dir, "progetto.voxai")
        path, _ = QFileDialog.getSaveFileName(
            self, "Salva progetto", default_name, "Progetto VoxelAI (*.voxai)"
        )
        return path or None

    def open_project_dialog(self):
        """Apre 'Apri file' (voxai/json/vox/schem) sul thread GUI e ritorna il
        contenuto. Per .voxai/.json → JSON come oggetto; per binari .vox/.schem
        → base64 + estensione (il parsing binario lo fa il frontend/endpoint
        dedicato). Ritorna None se annullato. Chiamare SOLO via _run_on_gui."""
        filt = (
            "Tutti i formati supportati (*.voxai *.json *.vox *.schem);;"
            "Progetto VoxelAI (*.voxai);;JSON (*.json);;"
            "MagicaVoxel (*.vox);;Minecraft schematic (*.schem);;Tutti i file (*)"
        )
        path, _ = QFileDialog.getOpenFileName(self, "Apri progetto", "", filt)
        if not path:
            return None
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        if ext in ("voxai", "json"):
            with open(path, "r", encoding="utf-8") as f:
                content = json.load(f)
            return {"path": path, "ext": ext, "encoding": "json", "content": content}
        # binari (.vox/.schem o sconosciuti): ritorna i byte in base64
        with open(path, "rb") as f:
            raw = f.read()
        return {
            "path": path,
            "ext": ext,
            "encoding": "base64",
            "content": base64.b64encode(raw).decode("ascii"),
        }

    def on_downloadRequested(self, downloadItem):
        default_name = downloadItem.suggestedFileName()
        path, _ = QFileDialog.getSaveFileName(self, "Salva File", default_name)
        if path:
            if hasattr(downloadItem, 'setDownloadDirectory'):
                downloadItem.setDownloadDirectory(os.path.dirname(path))
                downloadItem.setDownloadFileName(os.path.basename(path))
            elif hasattr(downloadItem, 'setPath'):
                downloadItem.setPath(path)
            downloadItem.accept()


if __name__ == '__main__':
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    import time
    while PORT == 0:
        time.sleep(0.1)

    if GUI_AVAILABLE:
        app = QApplication(sys.argv)
        _apply_dark_palette(app)
        window = MainWindow()
        if not app_settings.has_cookies():
            window.open_settings()
        if not app_settings.has_cookies():
            window.open_settings()
        window.show()
        sys.exit(app.exec())
    else:
        import webbrowser
        url = f"http://localhost:{PORT}/ui/index.html"
        print("\n" + "="*80)
        print(" ATTENZIONE: GUI non disponibile.")
        print(f" Apertura nel browser: {url}")
        print(" Installa PySide6: pip install PySide6")
        print("="*80 + "\n")
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nServer arrestato.")
