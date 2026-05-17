@echo off
:: One-click uninstaller. Double-click this file to:
::   1. Trigger a UAC prompt (so the PowerShell step gets admin)
::   2. Run audimo-purge.ps1 with ExecutionPolicy bypassed
::   3. Hold the console open at the end so you can read the output
::
:: This .bat lives next to audimo-purge.ps1 — %~dp0 is the folder
:: this batch file lives in (with trailing backslash), so the two
:: files can be moved around together without breaking the link.

set "PURGE_PS1=%~dp0audimo-purge.ps1"

if not exist "%PURGE_PS1%" (
    echo [error] audimo-purge.ps1 not found next to this batch file.
    echo Expected at: %PURGE_PS1%
    pause
    exit /b 1
)

:: Self-elevate via UAC. -Verb RunAs is the documented PowerShell way
:: to prompt for admin. The inner script keeps its console open with
:: a Read-Host at the bottom so the user sees the result.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','\"%PURGE_PS1%\"' -Verb RunAs"
