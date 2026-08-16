@echo off
REM Un solo processo, due endpoint:
REM   http://127.0.0.1:8750/mcp   Streamable HTTP (Zcode, type=http)
REM   http://127.0.0.1:8750/sse   SSE legacy     (Kilo/Claude, type=sse)
REM --debug stampa ogni richiesta SSE in arrivo e il motivo di un rifiuto.
REM Richiede setup.bat eseguito almeno una volta.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo  Venv non trovato. Esegui prima setup.bat .
    pause
    exit /b 1
)

echo.
echo  VoxelAI MCP
echo    Streamable HTTP : http://127.0.0.1:8750/mcp
echo    SSE legacy      : http://127.0.0.1:8750/sse
echo.

".venv\Scripts\python.exe" -m mcp_server --sse --host 127.0.0.1 --port 8750 --unrestricted --debug
pause

