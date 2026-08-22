@echo off
cd /d "%~dp0.."
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2" set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2;%PATH%"

set "ARKPULE_DEV_PORT=3003"

rem Android SDK
if not defined ANDROID_HOME (
  if exist "D:\Apps\SDKS" set "ANDROID_HOME=D:\Apps\SDKS"
)
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%ANDROID_HOME%\platform-tools;%PATH%"

rem NDK
if not defined NDK_HOME (
  if exist "D:\Apps\SDKS\ndk\30.0.15729638" set "NDK_HOME=D:\Apps\SDKS\ndk\30.0.15729638"
)

rem JDK
if not defined JAVA_HOME (
  if exist "D:\Apps\SDKS\jdk17\jdk-17.0.20+8" set "JAVA_HOME=D:\Apps\SDKS\jdk17\jdk-17.0.20+8"
)
if exist "%JAVA_HOME%\bin\java.exe" set "PATH=%JAVA_HOME%\bin;%PATH%"

echo Starting Android dev on port 3003...
echo ANDROID_HOME = %ANDROID_HOME%
echo NDK_HOME     = %NDK_HOME%
echo JAVA_HOME    = %JAVA_HOME%
echo ARKPULE_DEV_PORT = %ARKPULE_DEV_PORT%
npm run tauri android dev 2> D:\arkpulse\tmp\android-dev-err.log
echo.
echo Exit code: %errorlevel%
if %errorlevel% neq 0 (
    echo --- ERRORS ---
    type D:\arkpulse\tmp\android-dev-err.log
)
pause
