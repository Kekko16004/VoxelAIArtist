@echo off
REM ============================================================
REM  VoxelAI Artist - Avvia l'app (main.py) nel venv
REM  Richiede setup.bat eseguito almeno una volta.
REM ============================================================
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo  Venv non trovato. Esegui prima setup.bat .
    pause
    exit /b 1
)

".venv\Scripts\python.exe" main.py --web %*
if errorlevel 1 pause
