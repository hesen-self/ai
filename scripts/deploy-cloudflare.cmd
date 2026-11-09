@echo off
rem Windows launcher: bypasses the local PowerShell execution policy for this one process.
rem All arguments are forwarded, e.g. deploy-cloudflare.cmd -WithIngest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-cloudflare.ps1" %*
exit /b %ERRORLEVEL%
