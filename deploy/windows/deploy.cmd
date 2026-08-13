@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
set "FORGEX_EXIT_CODE=%errorlevel%"
pause
exit /b %FORGEX_EXIT_CODE%
