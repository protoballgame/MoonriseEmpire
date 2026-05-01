@echo off
setlocal

REM Always run from this script's directory (project root).
pushd "%~dp0"

echo [1/5] Removing previous build output...
if exist "dist" (
  rmdir /s /q "dist"
)

echo [2/5] Clearing Vite caches...
if exist ".vite" (
  rmdir /s /q ".vite"
)
if exist "node_modules\.vite" (
  rmdir /s /q "node_modules\.vite"
)

echo [3/5] Installing dependencies from lockfile...
call npm ci
if errorlevel 1 goto :fail

echo [4/5] Building project from source...
call npm run build
if errorlevel 1 goto :fail

echo [5/5] Rebuild complete.
echo Output: dist\
popd
exit /b 0

:fail
echo.
echo Rebuild failed. See errors above.
popd
exit /b 1
