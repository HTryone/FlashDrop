@echo off
cd /d "%~dp0.."
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2" set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2;%PATH%"
set "ARKPULE_DEV_PORT=3002"
echo Starting Windows dev on port 3002...
npm run tauri:dev 2> D:\arkpulse\tmp\win-dev-err.log
echo.
echo Exit code: %errorlevel%
if %errorlevel% neq 0 (
    echo --- ERRORS ---
    type D:\arkpulse\tmp\win-dev-err.log
)
pause
