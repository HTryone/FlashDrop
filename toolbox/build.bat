@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0.."

echo ===========================================================
echo   ArkPulse Build Launcher
echo ===========================================================
echo.
echo Use the previous/existing version? (Y/N)
echo   Y = build with current version in tauri.conf.json
echo   N = enter a new version number
echo.
set /p "CHOICE=Your choice [Y/N]: "

if /I "%CHOICE%"=="N" goto :newver
echo.
echo Building with existing version ...
node toolbox/buildjs/build-all.mjs
goto :end

:newver
echo.
set /p "VER=Enter new version (X.Y.Z, e.g. 1.2.3): "
if not defined VER (
  echo No version entered. Aborted.
  goto :end
)
echo Building with version !VER! ...
node toolbox/buildjs/build-all.mjs --version !VER!

:end
echo.
echo ===========================================================
echo   Build finished. Press any key to close this window.
echo ===========================================================
pause >nul
endlocal
