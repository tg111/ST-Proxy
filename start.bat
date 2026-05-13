@echo off
setlocal

echo Starting ST Proxy...

set "NODE_VERSION=v20.11.1"
set "LOCAL_NODE_ROOT=.local-node"
set "NODE_EXE="
set "NPM_CMD="

where node >nul 2>&1
if not errorlevel 1 (
  set "NODE_EXE=node"
  where npm >nul 2>&1
  if not errorlevel 1 set "NPM_CMD=npm"
)

if defined NODE_EXE (
  for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node" 2^>nul') do set "NODE_MAJOR=%%v"
)
if not defined NODE_MAJOR set "NODE_MAJOR=0"

if %NODE_MAJOR% LSS 20 (
  if defined NODE_EXE (
    echo System Node.js is older than 20:
    node --version
  ) else (
    echo Node.js was not found in PATH.
  )
  call :install_local_node
  if errorlevel 1 exit /b 1
)
if not defined NPM_CMD (
  call :install_local_node
  if errorlevel 1 exit /b 1
)

echo Using Node.js:
"%NODE_EXE%" --version

if not exist data mkdir data

if not exist config.json (
  echo.
  echo config.json was not found. The service will create one automatically.
  echo.
)

echo.
echo ST Proxy is starting.
echo Config file: .\config.json
echo.
echo Press Ctrl+C to stop.
echo.
"%NPM_CMD%" start
goto :eof

:install_local_node
set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
set "DIST_NAME=node-%NODE_VERSION%-win-%NODE_ARCH%"
set "DIST_DIR=%LOCAL_NODE_ROOT%\%DIST_NAME%"
set "ARCHIVE=%LOCAL_NODE_ROOT%\%DIST_NAME%.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VERSION%/%DIST_NAME%.zip"

if not exist "%DIST_DIR%\node.exe" (
  if not exist "%LOCAL_NODE_ROOT%" mkdir "%LOCAL_NODE_ROOT%"
  echo Installing local Node.js %NODE_VERSION% into .\%LOCAL_NODE_ROOT% ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%ARCHIVE%'"
  if errorlevel 1 (
    echo Failed to download Node.js from %NODE_URL%
    pause
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%ARCHIVE%' -DestinationPath '%LOCAL_NODE_ROOT%' -Force"
  if errorlevel 1 (
    echo Failed to extract %ARCHIVE%
    pause
    exit /b 1
  )
  del "%ARCHIVE%" >nul 2>&1
)

set "NODE_EXE=%DIST_DIR%\node.exe"
set "NPM_CMD=%DIST_DIR%\npm.cmd"
exit /b 0
