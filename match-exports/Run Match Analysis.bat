@echo off
setlocal

cd /d "%~dp0\.."
set "EXPORT_DIR=%~dp0"
if "%EXPORT_DIR:~-1%"=="\" set "EXPORT_DIR=%EXPORT_DIR:~0,-1%"

echo [WebRTS] Analyzing JSON exports in "%EXPORT_DIR%"
call npm run analyze-match:open -- "%EXPORT_DIR%"

if errorlevel 1 (
  echo.
  echo [WebRTS] Analysis failed. Make sure this folder contains one or more .json exports.
)

echo.
pause
endlocal