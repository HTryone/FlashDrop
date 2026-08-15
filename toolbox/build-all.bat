@echo off
cd /d "%~dp0.."
REM Add node to PATH (system node first, then workbuddy-managed node)
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2" set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2;%PATH%"
node "%~dp0build-all.mjs" %*
