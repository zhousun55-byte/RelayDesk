@echo off
rem RelayDesk (jie li tai) for Windows: double-click to install. Run "install-windows.cmd --remove" to remove it.
rem The real work is in scripts\windows\install.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1" %*
