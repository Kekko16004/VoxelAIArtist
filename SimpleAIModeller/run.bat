@echo off
rem SimpleAIModeller - avvio autonomo.
rem
rem `cd /d "%~dp0"` NON e' cosmetico: translate_path fa
rem os.path.relpath(translated, os.getcwd()) e poi rijoina su BASE_DIR. Con una
rem working directory arbitraria il relpath produce un percorso pieno di ".." e
rem i file statici non si trovano piu'.
cd /d "%~dp0"
python main.py --web %*
if errorlevel 1 pause
