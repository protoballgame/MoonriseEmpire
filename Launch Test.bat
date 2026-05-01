@echo off
setlocal
cd /d "%~dp0"

echo [WebRTS] Launching test servers (Vite dev + secure serve + match:dev for PvP).
echo [WebRTS] This window stays open while tests run.
echo [WebRTS] Press Enter in this window to stop all test servers.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = (Get-Location).Path;" ^
  "Write-Host '[WebRTS] Building latest dist before secure server start...';" ^
  "Set-Location $root; npm run build;" ^
  "$devJob = Start-Job -Name 'webrts-dev' -ScriptBlock { param($wd) Set-Location $wd; npm run dev } -ArgumentList $root;" ^
  "$serveJob = Start-Job -Name 'webrts-serve' -ScriptBlock { param($wd) Set-Location $wd; npm run serve } -ArgumentList $root;" ^
  "$matchJob = Start-Job -Name 'webrts-match' -ScriptBlock { param($wd) Set-Location $wd; npm run match:dev } -ArgumentList $root;" ^
  "Write-Host '[WebRTS] Jobs started: dev + serve + match:dev (ws port 8788)';" ^
  "Write-Host '[WebRTS] Open http://localhost:5173 (dev) and http://localhost:4173 (secure serve)';" ^
  "try {" ^
  "  Start-Sleep -Milliseconds 700;" ^
  "  Receive-Job -Name 'webrts-dev' -Keep -ErrorAction SilentlyContinue | Out-Host;" ^
  "  Receive-Job -Name 'webrts-serve' -Keep -ErrorAction SilentlyContinue | Out-Host;" ^
  "  Receive-Job -Name 'webrts-match' -Keep -ErrorAction SilentlyContinue | Out-Host;" ^
  "  Read-Host '[WebRTS] Press Enter to stop all test servers' | Out-Null;" ^
  "} finally {" ^
  "  Write-Host '[WebRTS] Stopping test servers...';" ^
  "  Get-Job -Name 'webrts-dev','webrts-serve','webrts-match' -ErrorAction SilentlyContinue | Stop-Job -ErrorAction SilentlyContinue;" ^
  "  Get-Job -Name 'webrts-dev','webrts-serve','webrts-match' -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue;" ^
  "  Write-Host '[WebRTS] All test servers stopped.';" ^
  "}"

echo.
echo [WebRTS] Launcher exited.
endlocal

