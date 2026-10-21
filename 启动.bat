@echo off
setlocal
title ZSEARCH - Search
cd /d "%~dp0"

echo.
echo   ==========================================
echo     ZSEARCH  -  Netdisk Resource Search
echo   ==========================================
echo.
echo   Security guard: ON
echo     - domain allowlist (netdisk hosts only)
echo     - pre-redirect risk screen
echo     - lookalike / phishing domain block
echo     - dangerous file-type warnings
echo   Note: no real virus scan in the browser.
echo         Always scan downloads with your own AV.
echo.

rem ---- locate node (prefer the WorkBuddy managed build) ----
set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

if not defined NODE_EXE call :scan_managed
if not defined NODE_EXE call :scan_path
if not defined NODE_EXE call :scan_programfiles

if not defined NODE_EXE goto :no_node

echo   Node:  %NODE_EXE%

rem ---- install deps on first run ----
if not exist "node_modules\express" call :install_deps
if errorlevel 1 goto :dep_failed

rem ---- refresh static-asset cache-busting hashes ----
rem  Every time this script runs, re-stamp css/js URLs with their content hash.
rem  Without this, the browser may keep serving a cached old stylesheet and the
rem  UI will look unchanged no matter how many times the code is edited.
call :stamp_assets

rem ---- free port 5178 if a previous instance is still listening ----
call :free_port

echo.
echo   Starting server...
echo.

rem ---- open the browser after a short warm-up ----
rem  The random ?t= suffix defeats any cached copy of the HTML itself, so a
rem  stale page can never be shown even if something was cached earlier.
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:5178/?t=%RANDOM%%RANDOM%"

rem ---- run in foreground with auto-restart ----
rem  The upstreams are flaky by nature (PanSou throttling, zreso 429).
rem  If the server ever dies, bring it back instead of leaving a dead window.
rem  Backoff grows 3s -> 6s -> 12s -> 30s (capped) so a hard crash loop
rem  cannot spin the CPU. Closing this window still stops everything.
set "RETRY=3"
set "RUNS=0"

:run_loop
set /a RUNS+=1
if %RUNS% GTR 1 echo.
if %RUNS% GTR 1 echo   Restarting server (attempt %RUNS%)...

"%NODE_EXE%" server.js
set "CODE=%errorlevel%"

rem  Exit code 0 = clean shutdown (user pressed Ctrl+C) -> do not restart.
rem  Exit code 2 = config problem (port already in use) -> restarting cannot
rem  help, so stop instead of looping forever.
if "%CODE%"=="0" goto :stopped
if "%CODE%"=="2" goto :stopped

echo.
echo   Server exited with code %CODE%. Restarting in %RETRY%s...
echo   (Close this window to stop.)
timeout /t %RETRY% /nobreak >nul

rem  exponential backoff, capped at 30s
if %RETRY% LSS 30 set /a RETRY*=2
if %RETRY% GTR 30 set "RETRY=30"

rem  make sure the port is free before the next attempt
call :free_port
goto :run_loop

:stopped
echo.
echo   Server stopped.
echo.
pause
exit /b 0


rem ===========================================================================
rem  subroutines
rem ===========================================================================

:scan_managed
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
)
exit /b 0

:scan_path
for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE_EXE=%%~$PATH:N"
exit /b 0

:scan_programfiles
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
exit /b 0

:install_deps
echo.
echo   First run - installing dependencies (needs network, about 10s)...
echo.
call npm install --omit=dev --no-audit --no-fund
exit /b %errorlevel%

:free_port
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5178" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>&1
)
exit /b 0

:stamp_assets
rem  Re-hash css/js URLs so browsers pick up edited files.
rem  Failing here is non-fatal - a stale hash only means a cached stylesheet,
rem  it should not stop the server from starting.
if exist "_stamp.js" (
  "%NODE_EXE%" _stamp.js >nul 2>&1
)
exit /b 0

:no_node
echo   [ERROR] Node.js not found.
echo   Please install Node.js 18 or newer : https://nodejs.org/
echo.
pause
exit /b 1

:dep_failed
echo.
echo   [ERROR] npm install failed. Check your network and run this file again.
echo.
pause
exit /b 1
