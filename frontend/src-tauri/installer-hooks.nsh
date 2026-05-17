; NSIS installer hooks for Audimo.
;
; Wired in via tauri.conf.json -> bundle.windows.nsis.installerHooks.
;
; Why this exists:
;   Running an upgrade install while Audimo is still running (e.g. the
;   user double-clicks setup.exe to "update" without closing the app)
;   leaves audimo-backend.exe / audimo-streaming.exe / Audimo.exe alive
;   holding their own image files open. Windows refuses to overwrite a
;   running .exe, so NSIS errors out with:
;     "error opening file for writing: audimo-backend.exe"
;
;   The PREINSTALL hook fires before any File copies happen, so killing
;   the process tree here releases the locks just in time.
;
; Why /T:
;   PyInstaller-bundled sidecars spawn a child Python interpreter under
;   the bootstrapper. /T (tree) makes sure both die together; without it
;   the grandchild keeps the _MEI* tempdir + .exe locked.

!macro NSIS_HOOK_PREINSTALL
    DetailPrint "Stopping any running Audimo processes..."
    nsExec::ExecToLog 'taskkill /F /T /IM Audimo.exe'
    nsExec::ExecToLog 'taskkill /F /T /IM audimo-backend.exe'
    nsExec::ExecToLog 'taskkill /F /T /IM audimo-streaming.exe'
    ; Give Windows ~500ms to release file handles after the kill, so
    ; the upcoming File overwrites don't hit a stale-lock race.
    Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
    DetailPrint "Stopping any running Audimo processes..."
    nsExec::ExecToLog 'taskkill /F /T /IM Audimo.exe'
    nsExec::ExecToLog 'taskkill /F /T /IM audimo-backend.exe'
    nsExec::ExecToLog 'taskkill /F /T /IM audimo-streaming.exe'
    Sleep 500
!macroend
