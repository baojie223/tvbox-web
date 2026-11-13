@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or later, then open this file again.
  pause
  exit /b 1
)
if not exist "node_modules\hls.js\dist\hls.min.js" (
  call npm.cmd ci --no-fund --no-audit
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set "TVBOX_OPEN=1"
node server.mjs
pause
