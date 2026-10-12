@echo off
setlocal
cd /d "%~dp0"
echo Trifolia Management System - Build Check
echo.
if not exist "index.html" (
  echo ERROR: index.html is missing from this folder.
  echo Run this file from the extracted Trifolia project root.
  pause
  exit /b 1
)
if not exist "package.json" (
  echo ERROR: package.json is missing from this folder.
  pause
  exit /b 1
)
echo [1/3] Installing dependencies...
npm install
if errorlevel 1 exit /b 1
echo [2/3] Building application...
npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED. Make sure you are in the folder containing index.html and package.json.
  pause
  exit /b 1
)
echo [3/3] BUILD SUCCESSFUL.
echo.
echo Run npm run dev to start the application.
pause
