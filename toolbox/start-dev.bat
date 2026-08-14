@echo off
cd /d "%~dp0.."
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2" set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2;%PATH%"
netstat -ano 2>nul | findstr /r ":3001 " | findstr /i "LISTENING" >nul
if not errorlevel 1 (
  echo Port 3001 is already in use.
  echo Close the old DEV server window first, then run this again.
  pause
  exit /b
)
npm run dev -- --host --port 3001
