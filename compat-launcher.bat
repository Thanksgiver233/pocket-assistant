@echo off
rem Pocket Assistant compatibility launcher.
rem Adds the two switches that fix silent startup failures on some
rem Windows setups (GPU/sandbox init crashes), and captures stderr so a
rem "nothing happens" report comes with evidence.
setlocal
set "EXE=%~dp0随身.exe"
if not exist "%EXE%" set "EXE=%~dp0electron.exe"
set "LOGDIR=%APPDATA%\随身"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
echo [%date% %time%] compat launch: %EXE% >> "%LOGDIR%\compat.log"
"%EXE%" --no-sandbox --disable-gpu %* 2>>"%LOGDIR%\compat.log"
if errorlevel 1 (
  echo.
  echo 启动失败。日志: %LOGDIR%\compat.log
  pause
)
