@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title Trifolia 1 Management System - Safe Launcher

set "SOURCE=%~dp0"
set "RUNTIME=%USERPROFILE%\Trifolia-Management-System"
set "PORT=3001"

echo ================================================================
echo   TRIFOLIA 1 MANAGEMENT SYSTEM - SAFE WINDOWS LAUNCHER
echo ================================================================
echo.
echo This launcher avoids npm/esbuild problems caused by OneDrive file locks.
echo Runtime folder: %RUNTIME%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js 20.19+ and run this file again.
  pause
  exit /b 1
)

for /f "tokens=1" %%v in ('node -p "process.versions.node"') do set "NODEVER=%%v"
echo Node.js: !NODEVER!

if not exist "%RUNTIME%" mkdir "%RUNTIME%"

echo [1/5] Copying application outside OneDrive...
robocopy "%SOURCE%" "%RUNTIME%" /E /R:2 /W:1 /XD node_modules dist .git >nul
if errorlevel 8 (
  echo ERROR: Could not copy the application to %RUNTIME%.
  pause
  exit /b 1
)

cd /d "%RUNTIME%"

if not exist package.json (
  echo ERROR: package.json was not copied.
  pause
  exit /b 1
)

echo [2/5] Checking npm installation...
if not exist node_modules\express (
  echo Installing packages in the local runtime folder...
  echo This may take a few minutes.
  call npm cache verify
  call npm install --include=optional --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo First npm install failed. Cleaning the local runtime and retrying...
    if exist node_modules rmdir /s /q node_modules
    call npm cache verify
    call npm install --include=optional --force --no-audit --no-fund
    if errorlevel 1 (
      echo.
      echo ERROR: npm install failed again.
      echo IMPORTANT: Do NOT run npm install inside the OneDrive source folder.
      echo Runtime folder is: %RUNTIME%
      pause
      exit /b 1
    )
  )
)

if not exist node_modules\vite\bin\vite.js (
  echo ERROR: Vite was not installed correctly.
  echo Reinstalling dependencies...
  rmdir /s /q node_modules
  call npm install --include=optional --force --no-audit --no-fund
  if errorlevel 1 (
    echo ERROR: dependency installation failed.
    pause
    exit /b 1
  )
)

echo [3/5] Building production website...
if not exist dist\index.html call npm run build
if errorlevel 1 (
  echo ERROR: npm run build failed.
  echo Try deleting %RUNTIME%\node_modules and run this launcher again.
  pause
  exit /b 1
)

echo [4/5] Starting Trifolia server on 0.0.0.0:%PORT%...
start "TRIFOLIA SERVER" cmd /k "cd /d "%RUNTIME%" && set PORT=%PORT% && npm run server"
timeout /t 3 /nobreak >nul

echo [5/5] Opening Trifolia...
start "" "http://localhost:%PORT%"

echo.
echo ================================================================
echo   TRIFOLIA IS RUNNING
echo ================================================================
echo.
echo PC:     http://localhost:%PORT%
echo.
echo Phone / other PC on the same Wi-Fi:
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address" /C:"IPv4"') do (
  set "IP=%%A"
  set "IP=!IP: =!"
  if not "!IP!"=="" echo          http://!IP!:%PORT%
)
echo.
echo Keep the TRIFOLIA SERVER window open while using the system.
echo Your source files remain in OneDrive, but Node/npm runs safely outside it.
echo ================================================================
pause
