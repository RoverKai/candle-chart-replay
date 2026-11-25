@echo off
cd /d "%~dp0"
set "PS=powershell"
where powershell >nul 2>nul || set "PS=pwsh"
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause