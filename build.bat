@echo off
echo ========================================
echo  VoxelAI Artist - Build Script
echo ========================================
echo.

echo [1/3] Installazione dipendenze...
REM Nota: il modulo `gemini` viene da python-gemini-api (NON da gemini-api).
pip install -r requirements.txt -r requirements-build.txt

echo.
echo [2/3] Build exe in corso (onefile)...
pyinstaller --clean VoxelAI.spec

echo.
if exist "dist\VoxelAIArtist.exe" (
    echo ========================================
    echo  BUILD COMPLETATO!
    echo  File: dist\VoxelAIArtist.exe
    echo ========================================
    explorer dist
) else (
    echo  ERRORE: Build fallito. Controlla i log sopra.
)
pause
