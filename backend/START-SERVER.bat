@echo off
cd /d "%~dp0"
echo ============================================
echo  Starting VPR backend on http://localhost:5000
echo  Keep this window open while you use the dashboard.
echo  Close this window to stop the server.
echo ============================================
echo.
call npm start
pause
