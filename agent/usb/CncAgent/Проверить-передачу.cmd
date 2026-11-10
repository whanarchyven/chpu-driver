@echo off
rem Drag a .cnc file onto this button, or run it as is to send ERP-TEST.CNC (comment + M30 only).
set "EXE=%ProgramFiles(x86)%\CncAgent\CncAgent.exe"
if not exist "%EXE%" set "EXE=%ProgramFiles%\CncAgent\CncAgent.exe"
if not exist "%EXE%" (echo CncAgent is not installed. Run the installer first. & pause & exit /b 1)
set "FILE=%~1"
if "%FILE%"=="" set "FILE=%~dp0ERP-TEST.CNC"
"%EXE%" --upload "%FILE%"
pause
