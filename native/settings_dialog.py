"""Pannello Impostazioni NATIVO (PyQt6) - primo mattone della migrazione (FASE 3a).

Sostituisce, per la parte "cartella di salvataggio", la schermata HTML
`ui/settings.html`: si apre come QDialog SOPRA il viewport 3D (non fa piu'
navigare via la webview) e usa un QFileDialog NATIVO per lo "Sfoglia" (che dentro
la webview finiva coperto dalla surface GPU). Le impostazioni avanzate (cookie,
tema) restano per ora nella pagina HTML, raggiungibile da un pulsante.

Import Qt difensivo (PyQt6 -> PySide6 -> PyQt5) come in main.py, cosi' il modulo
funziona con qualunque binding attivo. Importato in modo LAZY da main.py.
"""
import os

_BIND = None
try:
    from PyQt6.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                                 QLineEdit, QPushButton, QFrame, QFileDialog)
    from PyQt6.QtCore import Qt
    _BIND = "PyQt6"
except ImportError:
    try:
        from PySide6.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                                       QLineEdit, QPushButton, QFrame, QFileDialog)
        from PySide6.QtCore import Qt
        _BIND = "PySide6"
    except ImportError:
        from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                                     QLineEdit, QPushButton, QFrame, QFileDialog)
        from PyQt5.QtCore import Qt
        _BIND = "PyQt5"

from .theme import dark_qss


def _hsep():
    f = QFrame()
    f.setObjectName("sep")
    return f


class SettingsDialog(QDialog):
    """Dialog impostazioni nativo. `settings` = modulo app_settings (get_setting/
    set_setting/get_autosave_dir); `open_web_settings` = callable per aprire le
    impostazioni avanzate HTML."""

    def __init__(self, parent, settings, open_web_settings=None):
        super().__init__(parent)
        self._settings = settings
        self._open_web_settings = open_web_settings
        self.setWindowTitle("Impostazioni")
        self.setMinimumWidth(460)
        self.setStyleSheet(dark_qss())
        self._build_ui()

    # PLACEHOLDER_BODY
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(22, 20, 22, 20)
        root.setSpacing(14)

        title = QLabel("Impostazioni")
        title.setObjectName("title")
        root.addWidget(title)

        sec = QLabel("SALVATAGGIO")
        sec.setObjectName("sectionTitle")
        root.addWidget(sec)

        lbl = QLabel("Cartella di default (salvataggio / esportazione)")
        lbl.setObjectName("muted")
        root.addWidget(lbl)

        row = QHBoxLayout()
        row.setSpacing(8)
        self._dir_field = QLineEdit()
        self._dir_field.setReadOnly(True)
        self._dir_field.setPlaceholderText("Predefinita (AppData)")
        self._dir_field.setText(self._settings.get_setting("default_save_dir", "") or "")
        row.addWidget(self._dir_field, 1)
        browse = QPushButton("Sfoglia...")
        browse.setObjectName("primary")
        browse.clicked.connect(self._on_browse)
        row.addWidget(browse)
        root.addLayout(row)

        open_autosave = QPushButton("Apri cartella autosave")
        open_autosave.clicked.connect(self._on_open_autosave)
        root.addWidget(open_autosave)

        hist_lbl = QLabel("Cartella modelli JSON (history)")
        hist_lbl.setObjectName("muted")
        root.addWidget(hist_lbl)
        hist_row = QHBoxLayout()
        hist_row.setSpacing(8)
        self._hist_field = QLineEdit()
        self._hist_field.setReadOnly(True)
        self._hist_field.setPlaceholderText("Predefinita: <cartella export>/history")
        self._hist_field.setText(self._settings.get_setting("json_models_dir", "") or "")
        hist_row.addWidget(self._hist_field, 1)
        hist_browse = QPushButton("Sfoglia...")
        hist_browse.setObjectName("primary")
        hist_browse.clicked.connect(self._on_browse_history)
        hist_row.addWidget(hist_browse)
        root.addLayout(hist_row)
        open_hist = QPushButton("Apri cartella history")
        open_hist.clicked.connect(self._on_open_history)
        root.addWidget(open_hist)

        root.addWidget(_hsep())

        if self._open_web_settings is not None:
            adv = QPushButton("Impostazioni avanzate (cookie, tema)...")
            adv.clicked.connect(self._on_open_web)
            root.addWidget(adv)

        foot = QHBoxLayout()
        foot.addStretch(1)
        close_btn = QPushButton("Chiudi")
        close_btn.clicked.connect(self.accept)
        foot.addWidget(close_btn)
        root.addLayout(foot)

    def _on_browse(self):
        start = self._settings.get_setting("default_save_dir", "") or ""
        if start and not os.path.exists(start):
            start = ""
        # QFileDialog nativo: e' una finestra a livello di OS, appare SOPRA tutto
        # (dentro la webview lo stesso dialog finiva coperto dalla surface GPU).
        path = QFileDialog.getExistingDirectory(self, "Seleziona cartella", start)
        if path:
            self._settings.set_setting("default_save_dir", path)
            self._dir_field.setText(path)

    def _on_open_autosave(self):
        try:
            folder = self._settings.get_autosave_dir()
        except Exception:
            folder = None
        if folder and os.path.isdir(folder):
            try:
                os.startfile(folder)  # Windows
            except AttributeError:
                pass  # non-Windows: no-op

    def _on_browse_history(self):
        start = self._settings.get_setting("json_models_dir", "") or ""
        if start and not os.path.exists(start):
            start = self._settings.get_setting("default_save_dir", "") or ""
        path = QFileDialog.getExistingDirectory(self, "Seleziona cartella history", start)
        if path:
            self._settings.set_setting("json_models_dir", path)
            self._hist_field.setText(path)

    def _on_open_history(self):
        try:
            folder = self._settings.get_json_models_dir()
        except Exception:
            folder = None
        if folder and os.path.isdir(folder):
            try:
                os.startfile(folder)
            except AttributeError:
                pass

    def _on_open_web(self):
        if callable(self._open_web_settings):
            self.accept()
            self._open_web_settings()

