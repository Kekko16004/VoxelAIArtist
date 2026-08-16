@echo off
REM ============================================================
REM  VoxelAI Artist - Setup venv (PRIMA ESECUZIONE)
REM  Crea il venv ".venv" e installa tutte le dipendenze.
REM  Da rilanciare solo se requirements.txt cambia.
REM ============================================================
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creazione venv in .venv ...
    python -m venv .venv
    if errorlevel 1 (
        echo  ERRORE: creazione venv fallita. Verifica che Python sia installato e nel PATH.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Venv .venv gia' esistente, lo riutilizzo.
)

echo.
echo [2/3] Aggiornamento pip ...
".venv\Scripts\python.exe" -m pip install --upgrade pip

echo.
echo [3/3] Installazione dipendenze runtime ...
".venv\Scripts\python.exe" -m pip install -r requirements.txt

echo.
echo ============================================
echo  SETUP COMPLETATO
echo  Venv: %cd%\.venv
echo  Usa:  start_app.bat        (avvia main.py)
echo        start_mcp_sse.bat     (avvia MCP: /mcp + /sse)
echo  Per l'exe: setup.bat poi build.bat
echo ============================================
pause
