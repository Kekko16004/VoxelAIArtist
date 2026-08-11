@echo off
REM --debug stampa ogni richiesta in arrivo e il motivo di un eventuale rifiuto.
REM Toglilo quando tutto funziona: costa una lettura del corpo per richiesta.
python -m mcp_server --sse --host 127.0.0.1 --port 8000 --unrestricted --debug
pause

