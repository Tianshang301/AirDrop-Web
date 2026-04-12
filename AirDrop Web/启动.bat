@echo off
setlocal

REM Switch to UTF-8
chcp 65001 >nul 2>&1

echo ========================================
echo   AirDrop Web - File Transfer Server
echo ========================================
echo.

REM Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    echo Please install Node.js: https://nodejs.org/
    pause
    exit /b 1
)

REM Check port 3000
netstat -ano | findstr ":3000 " | findstr LISTENING >nul
if errorlevel 1 (
    echo Port 3000 is free, starting server...
    cd /d "%~dp0"
    start "AirDrop" cmd /k "node server.js"
    timeout /t 3 >nul
) else (
    echo Port 3000 is in use, using existing service
)

echo.
echo ========================================
echo   Server Started
echo ========================================
echo.
echo Local:    http://localhost:3000

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        if not "%%b"=="127.0.0.1" (
            echo Network: http://%%b:3000
        )
    )
)

echo.
echo Open this URL on other devices in the same network
echo ========================================
echo.
pause

start http://localhost:3000

echo.
echo Server is running in background
echo Press any key to exit...
pause >nul