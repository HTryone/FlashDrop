
@echo off
chcp 65001 >nul
cd /d "%~dp0.."

REM 自动探测 node 安装位置（PATH 里有就优先用；没有就塞常见目录）
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2" set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2;%PATH%"

echo ===================================================
echo   ArkPulse 一键打包（Windows 桌面 + Android 双端）
echo ===================================================
echo.

set "EXTRA="

REM 检测命令行是否已带 --version
set HASVER=0
:checkargs
if "%~1"=="" goto :checkargsdone
if /I "%~1"=="--version" set HASVER=1
shift
goto :checkargs
:checkargsdone
if %HASVER%==1 (
  echo 检测到命令行已指定 --version，跳过版本选择。
  goto :run
)

:askver
echo.
echo 是否修改版本号？
set /p CHOICE=输入 Y 修改 / N 沿用当前版本： 
if /I "%CHOICE%"=="Y" goto :setver
if /I "%CHOICE%"=="N" goto :nobuild
echo 输入无效，请重新输入。
goto :askver

:setver
set /p VER=请输入新版本号（格式 X.Y.Z，如 1.2.3）：
for /f "delims=0123456789." %%a in ("%VER%") do (
  if not "%%a"=="" (
    echo 版本号格式不正确，应为 X.Y.Z（如 1.2.3）。
    goto :setver
  )
)
set "EXTRA=--version %VER%"
echo 已选择版本号：%VER%
goto :run

:nobuild
echo 沿用 tauri.conf.json 当前版本号。

:run
echo.
echo(构建时间较长，请耐心等待，勿关闭此窗口。
echo.
echo ===================================================
node "%~dp0build-all.mjs" %EXTRA% %*
echo ===================================================
if errorlevel 1 (
  echo 构建异常退出（退出码 %errorlevel%），详见上方日志。
) else (
  echo 构建流程已结束。
)
pause
