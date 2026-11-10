@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo 请先安装 Node.js: https://nodejs.org & pause & exit /b)
if not exist local.env copy local.env.example local.env >nul
start "" http://localhost:3000
node dev.js
pause
