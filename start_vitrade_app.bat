@echo off
rem VITrade (own project): server + engine on http://127.0.0.1:4180
cd /d "%~dp0"
if not exist web\dist\index.html call npm run build
node server\main.js >> data\server.log 2>&1
