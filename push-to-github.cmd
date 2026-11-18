@echo off
rem ASCII only: cmd.exe mis-parses UTF-8 Chinese lines without a BOM.
start "" "https://github.com/settings/tokens/new?scopes=repo&description=dsh-memory-list"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-to-github.ps1"
echo.
pause
