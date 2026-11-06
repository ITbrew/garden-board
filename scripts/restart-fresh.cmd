@echo off
REM Double-click wrapper for restart-fresh.ps1.
REM
REM The owner's answer to being handed a PowerShell line was "im not doing that, too much work",
REM which is the correct answer: opening a terminal and pasting a command is not a thing an owner
REM should have to do to get onto a current build. This is the same action as an icon.
REM
REM The confirm is not ceremony. The shortcut for this sits beside the ordinary Garden shortcut on
REM his desktop, one of them keeps his sessions and the other ends all of them, and a misclick
REM between two adjacent icons should cost a keypress rather than a board.
title Garden fresh start
echo.
echo   This stops Garden completely, rewrites the database, and starts it
echo   again on current code.
echo.
echo   It ENDS EVERY SESSION on the board. The ordinary Garden shortcut is
echo   the one that keeps them.
echo.
choice /c YN /n /m "   Go ahead? [Y/N] "
if errorlevel 2 exit /b 0
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-fresh.ps1"
set RESULT=%ERRORLEVEL%
echo.
echo   ============================================================
if "%RESULT%"=="0" (
  echo     FINISHED. Garden is opening. You can close this window.
) else (
  echo     STOPPED EARLY. Garden may be down: open the normal Garden
  echo     shortcut to bring it back, and tell Claude what it said.
)
echo   ============================================================
echo.
REM A visible prompt, deliberately. This was `pause ^>nul`, which hides the
REM "Press any key" line, so the owner's first run of it ended in a window that
REM had finished successfully and looked identical to one that had hung: "couldnt
REM tell if it was done or not". A long job's last line has to say it is the last
REM line.
pause
