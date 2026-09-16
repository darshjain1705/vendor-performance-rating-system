@echo off
cd /d "%~dp0"
echo ============================================
echo  VPR Backend - one-time setup
echo ============================================
echo.

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo A file named .env was just created in this folder.
    echo Notepad will now open it - change DB_PASSWORD to your real
    echo MySQL password, then SAVE the file and CLOSE Notepad to continue.
    echo.
    pause
    notepad ".env"
    echo.
    echo Continuing setup now that .env is saved...
    echo.
)

echo Installing dependencies (this can take a minute)...
call npm install
if errorlevel 1 goto :error

echo.
echo Importing purchase orders from data\PO_Report.xlsx ...
echo (If this fails with a connection error, make sure you already
echo  created the "vpr" database and ran schema.sql in MySQL Workbench.)
call npm run seed
if errorlevel 1 goto :error

echo.
echo Creating starter login accounts (admin + one per team)...
call npm run seed:users
if errorlevel 1 goto :error

echo.
echo ============================================
echo  Setup complete!
echo  Double-click START-SERVER.bat next.
echo ============================================
pause
exit /b 0

:error
echo.
echo ============================================
echo  Something went wrong - read the error above.
echo  Common causes: MySQL isn't running, or the
echo  password in .env is wrong.
echo ============================================
pause
exit /b 1
