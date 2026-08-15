@echo off
REM --debug stampa ogni richiesta in arrivo e il motivo di un eventuale rifiuto.
REM Toglilo quando tutto funziona: costa una lettura del corpo per richiesta.
REM Richiede setup.bat eseguito almeno una volta.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo  Venv non trovato. Esegui prima setup.bat .
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -m mcp_server --sse --host 127.0.0.1 --port 8750 --unrestricted --debug
pause

