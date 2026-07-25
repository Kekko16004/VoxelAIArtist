import os
import re
import json
import time

APP_NAME = "VoxelAIArtist"

# Chiavi che non devono MAI finire nel dict pubblico delle preferenze.
# I cookie vivono in cookies.json separato, ma restiamo difensivi nel caso
# in cui una chiave sensibile finisca per errore in settings.json.
_SENSITIVE_KEYS = {"cookies", "cookie", "token", "secret", "password", "auth"}

# Numero di autosave da conservare per singolo progetto (rotazione per conteggio).
AUTOSAVE_MAX_KEEP = 20
# Numero massimo di progetti recenti conservati.
RECENT_MAX_KEEP = 15
# Pattern nome file autosave: autosave_<projectId>_<epoch>.voxai.json
_AUTOSAVE_RE = re.compile(r"^autosave_[A-Za-z0-9._-]+_\d+\.voxai\.json$")

def get_appdata_dir():
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    path = os.path.join(appdata, APP_NAME)
    os.makedirs(path, exist_ok=True)
    return path

def get_cookies_path():
    return os.path.join(get_appdata_dir(), "cookies.json")

def get_settings_path():
    return os.path.join(get_appdata_dir(), "settings.json")

def has_cookies():
    p = get_cookies_path()
    if not os.path.exists(p):
        return False
    try:
        data = json.loads(open(p, "r", encoding="utf-8").read())
        return bool(data)
    except Exception:
        return False

def load_cookies():
    p = get_cookies_path()
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return {c["name"]: c["value"] for c in data if "name" in c and "value" in c}
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}

def save_cookies(cookies_data):
    with open(get_cookies_path(), "w", encoding="utf-8") as f:
        json.dump(cookies_data, f, indent=2)

def load_settings():
    p = get_settings_path()
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_settings(data):
    with open(get_settings_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# Preferenze generiche (tema, keymap, locale, ...) — merge senza perdere chiavi
# ---------------------------------------------------------------------------

def get_setting(key, default=None):
    """Ritorna il valore di una singola preferenza, o `default` se assente."""
    try:
        return load_settings().get(key, default)
    except Exception:
        return default


def set_setting(key, value):
    """Imposta una singola preferenza facendo merge sul settings.json esistente
    (non sovrascrive le altre chiavi). Ritorna il dict aggiornato."""
    data = load_settings()
    if not isinstance(data, dict):
        data = {}
    data[key] = value
    save_settings(data)
    return data


def merge_settings(patch):
    """Fonde un dict di preferenze nel settings.json esistente senza perdere le
    altre chiavi. Le chiavi sensibili vengono ignorate (i segreti stanno in
    cookies.json). Ritorna il dict aggiornato."""
    if not isinstance(patch, dict):
        raise ValueError("il body delle preferenze deve essere un oggetto JSON")
    data = load_settings()
    if not isinstance(data, dict):
        data = {}
    for k, v in patch.items():
        if str(k).lower() in _SENSITIVE_KEYS:
            continue
        data[k] = v
    save_settings(data)
    return data


def get_public_settings():
    """Ritorna il dict delle preferenze SENZA chiavi sensibili/segrete."""
    data = load_settings()
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if str(k).lower() not in _SENSITIVE_KEYS}


# ---------------------------------------------------------------------------
# Autosave + versioning in cartella temp (appdata/autosaves/)
# ---------------------------------------------------------------------------

def get_autosave_dir():
    """Cartella degli autosave dentro appdata; creata se assente."""
    path = os.path.join(get_appdata_dir(), "autosaves")
    os.makedirs(path, exist_ok=True)
    return path


def _sanitize_project_id(project_id):
    """Normalizza un projectId a un token filesystem-safe."""
    if not project_id:
        return "default"
    token = re.sub(r"[^A-Za-z0-9._-]", "_", str(project_id)).strip("._-")
    return token or "default"


def _is_within(base_dir, target_path):
    """True se target_path si risolve dentro base_dir (anti path-traversal)."""
    base = os.path.realpath(base_dir)
    target = os.path.realpath(target_path)
    try:
        return os.path.commonpath([base, target]) == base
    except ValueError:
        return False


def write_autosave(data, project_id=None):
    """Scrive uno snapshot autosave con timestamp e ruota i più vecchi
    mantenendo al più AUTOSAVE_MAX_KEEP file per progetto. Ritorna il path."""
    autosave_dir = get_autosave_dir()
    pid = _sanitize_project_id(project_id)
    epoch = int(time.time() * 1000)
    name = f"autosave_{pid}_{epoch}.voxai.json"
    path = os.path.join(autosave_dir, name)
    payload = {
        "format": "voxai",
        "version": 1,
        "projectId": pid,
        "savedAt": _now_iso(),
        "data": data,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    _rotate_autosaves(autosave_dir, pid)
    return path


def _rotate_autosaves(autosave_dir, project_id):
    """Mantiene solo gli ultimi AUTOSAVE_MAX_KEEP autosave del progetto dato."""
    prefix = f"autosave_{project_id}_"
    entries = []
    for name in os.listdir(autosave_dir):
        if name.startswith(prefix) and _AUTOSAVE_RE.match(name):
            full = os.path.join(autosave_dir, name)
            try:
                entries.append((os.path.getmtime(full), full))
            except OSError:
                pass
    entries.sort(reverse=True)  # più recenti prima
    for _, full in entries[AUTOSAVE_MAX_KEEP:]:
        try:
            os.remove(full)
        except OSError:
            pass


def list_autosaves():
    """Ritorna la lista degli autosave: {name, projectId, savedAt, epoch, size}."""
    autosave_dir = get_autosave_dir()
    out = []
    for name in os.listdir(autosave_dir):
        if not _AUTOSAVE_RE.match(name):
            continue
        full = os.path.join(autosave_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        # nome = autosave_<projectId>_<epoch>.voxai.json
        core = name[len("autosave_"):-len(".voxai.json")]
        epoch_str = core.rsplit("_", 1)[-1]
        pid = core.rsplit("_", 1)[0] if "_" in core else "default"
        try:
            epoch = int(epoch_str)
        except ValueError:
            epoch = int(st.st_mtime * 1000)
        out.append({
            "name": name,
            "projectId": pid,
            "epoch": epoch,
            "savedAt": _epoch_ms_to_iso(epoch),
            "size": st.st_size,
        })
    out.sort(key=lambda e: e["epoch"], reverse=True)
    return out


def read_autosave(name):
    """Legge il contenuto di un autosave per nome (solo basename, anti-traversal).
    Ritorna il dict JSON. Solleva se il nome non è valido o fuori cartella."""
    safe = os.path.basename(str(name))
    if not _AUTOSAVE_RE.match(safe):
        raise ValueError("nome autosave non valido")
    autosave_dir = get_autosave_dir()
    path = os.path.join(autosave_dir, safe)
    if not _is_within(autosave_dir, path) or not os.path.exists(path):
        raise FileNotFoundError("autosave non trovato")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Progetti recenti (chiave "recentProjects" in settings.json)
# ---------------------------------------------------------------------------

def get_recent_projects():
    """Lista dei progetti recenti (ordinata per lastOpened desc)."""
    data = load_settings()
    recent = data.get("recentProjects", []) if isinstance(data, dict) else []
    if not isinstance(recent, list):
        return []
    return recent


def add_recent_project(entry):
    """Aggiunge/aggiorna un progetto recente. Dedup per `path`, ordinati per
    lastOpened desc, troncati a RECENT_MAX_KEEP. `entry` = {path, name?, thumbnail?}.
    Ritorna la lista aggiornata."""
    if not isinstance(entry, dict) or not entry.get("path"):
        raise ValueError("entry recente deve avere almeno 'path'")
    data = load_settings()
    if not isinstance(data, dict):
        data = {}
    recent = data.get("recentProjects", [])
    if not isinstance(recent, list):
        recent = []
    path = entry["path"]
    recent = [r for r in recent if isinstance(r, dict) and r.get("path") != path]
    item = {
        "path": path,
        "name": entry.get("name") or os.path.basename(path),
        "lastOpened": entry.get("lastOpened") or _now_iso(),
    }
    if entry.get("thumbnail"):
        item["thumbnail"] = entry["thumbnail"]
    recent.insert(0, item)
    recent.sort(key=lambda r: r.get("lastOpened", ""), reverse=True)
    recent = recent[:RECENT_MAX_KEEP]
    data["recentProjects"] = recent
    save_settings(data)
    return recent


def remove_recent_project(path):
    """Rimuove un progetto recente per path. Ritorna la lista aggiornata."""
    data = load_settings()
    if not isinstance(data, dict):
        return []
    recent = data.get("recentProjects", [])
    if not isinstance(recent, list):
        return []
    recent = [r for r in recent if isinstance(r, dict) and r.get("path") != path]
    data["recentProjects"] = recent
    save_settings(data)
    return recent


# ---------------------------------------------------------------------------
# Utilità tempo
# ---------------------------------------------------------------------------

def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _epoch_ms_to_iso(epoch_ms):
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(epoch_ms / 1000.0))
    except (OverflowError, OSError, ValueError):
        return ""
