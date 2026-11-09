@echo off
set "EXE=%ProgramFiles(x86)%\CncAgent\CncAgent.exe"
if not exist "%EXE%" set "EXE=%ProgramFiles%\CncAgent\CncAgent.exe"
if not exist "%EXE%" (echo CncAgent is not installed. Run the installer first. & pause & exit /b 1)
"%EXE%" --check
pause
