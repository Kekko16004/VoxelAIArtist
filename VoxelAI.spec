# -*- mode: python ; coding: utf-8 -*-
import os

block_cipher = None

# ---------------------------------------------------------------------------
# EXCLUDES — snellimento build (T3)
#
# Regola d'oro: NON escludere nulla che serva a QtWebEngine (il WebView e' il
# cuore dell'app). Verificato con dump dei simboli di Qt6WebEngineCore.dll:
# QtWebEngine dipende da Qt6Quick / Qt6Qml / Qt6Positioning / Qt6WebChannel,
# quindi questi NON vanno esclusi.
#
# Qui sotto sono ATTIVATI solo esclusioni sicure:
#   - stdlib non usata dall'app (tkinter, unittest, test, pydoc, ecc.)
#   - binding Qt alternativi mai importati con successo (PySide6/PyQt5:
#     main.py li prova ma su questa macchina vince PyQt6; includerli
#     gonfierebbe inutilmente il bundle).
# ---------------------------------------------------------------------------
excludes = [
    # --- stdlib / tool non usati a runtime ---
    'tkinter',
    'unittest',
    'test',
    'pydoc',
    'pdb',
    'doctest',
    'lib2to3',
    'ensurepip',
    'venv',
    'distutils',

    # --- binding Qt alternativi (fallback mai usati se PyQt6 e' presente) ---
    # main.py tenta PyQt6 -> PySide6 -> PyQt5. Con PyQt6 installato i due
    # fallback non vengono mai importati: escluderli evita di impacchettare
    # un secondo (o terzo) intero toolkit Qt.
    'PySide6',
    'PyQt5',
]

# ---------------------------------------------------------------------------
# CANDIDATI DA TESTARE (NON attivati: rischio di rompere il WebEngine)
#
# I moduli Qt sotto NON sono usati direttamente dal codice Python, ma alcuni
# sono trascinati come DLL di QtWebEngine. Attivarli come 'excludes' richiede
# una build reale + avvio dell'exe per confermare che il WebView regga.
# Se testati e OK, spostarli nella lista `excludes` sopra:
#
#   'PyQt6.QtQuick3D'      # Quick3D: WebEngine usa Quick (2D) non Quick3D -> probabilmente ok
#   'PyQt6.QtCharts'       # grafici: non usati
#   'PyQt6.QtDataVisualization'
#   'PyQt6.QtMultimedia'   # ATTENZIONE: HTML5 <video>/<audio> nel WebView ne dipende
#   'PyQt6.QtPdf'          # visualizzatore PDF integrato in Chromium
#   'PyQt6.QtSql'
#   'PyQt6.QtBluetooth'
#   'PyQt6.QtNfc'
#   'PyQt6.QtSensors'      # RISCHIO: alcune API web (DeviceOrientation) lo usano
#   'PyQt6.QtSerialPort'
#   'PyQt6.QtDesigner'
#   'PyQt6.QtTest'
#
# NON toccare (dipendenze DIRETTE di QtWebEngine, verificate): QtQuick, QtQml,
# QtWebChannel, QtPositioning, QtNetwork, QtCore, QtGui, QtWidgets, QtOpenGL.
# ---------------------------------------------------------------------------

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('ui/*.html',       'ui'),
        ('assets/prompts/*', 'assets/prompts'),
        ('src/*.py',        'src'),
    ],
    hiddenimports=[
        'gemini',
        'PyQt6',
        'PyQt6.QtWebEngineWidgets',
        'PyQt6.QtWebEngineCore',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='VoxelAIArtist',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
