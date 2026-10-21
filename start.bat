@echo off
rem ---------------------------------------------------------------------------
rem  Legacy alias kept for convenience (English filename).
rem
rem  The canonical launcher is the Chinese-named .bat next to this file.
rem  Because .bat content should stay pure ASCII, this file does not hard-code
rem  that Chinese filename; it locates the first *.bat in this folder whose name
rem  is not itself, then forwards to it. Edit that file, never this one.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

set "TARGET="
for %%F in ("*.bat") do (
  if /i not "%%~nxF"=="start.bat" if not defined TARGET set "TARGET=%%~fF"
)

if not defined TARGET (
  echo   [ERROR] No launcher .bat found in this folder.
  echo.
  pause
  exit /b 1
)

call "%TARGET%"
exit /b %errorlevel%
