@echo off
cd /d "%~dp0.."
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2" set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2;%PATH%"
npm run dev -- --host --port 3001
