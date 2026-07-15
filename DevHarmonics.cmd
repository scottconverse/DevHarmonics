@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-devharmonics.ps1" -ProjectPath "%CD%"
endlocal
