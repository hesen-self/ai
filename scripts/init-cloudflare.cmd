@echo off
rem Windows launcher: bypasses the local PowerShell execution policy for this one process.
rem All arguments are forwarded, e.g. init-cloudflare.cmd -DatabaseUrl "postgres://..." -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0init-cloudflare.ps1" %*
exit /b %ERRORLEVEL%
