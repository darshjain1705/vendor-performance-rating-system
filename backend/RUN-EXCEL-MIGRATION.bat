@echo off
cd /d "%~dp0"
echo ============================================
echo  VPR - Full Excel migration (ratings, PO
echo  details, evaluator/approver names)
echo ============================================
echo.
echo This is a ONE-TIME step. Run schema.sql and
echo migration-full-fidelity.sql in MySQL Workbench
echo BEFORE running this, if you haven't already.
echo.
pause

if exist "migration-accounts.csv" goto :havecsv

copy "migration-accounts.csv.example" "migration-accounts.csv" >nul
echo A file named migration-accounts.csv was just created.
echo Notepad will now open it - fill in a password for EVERY
echo row (the "password" column is currently empty), then SAVE
echo the file and CLOSE Notepad to continue.
echo.
pause
notepad "migration-accounts.csv"
echo.
echo Continuing now that migration-accounts.csv is saved...
echo.

:havecsv
set WORKBOOK=
set /p WORKBOOK="Full path to New Rating Excel.xlsx (or press Enter for the default): "
if "%WORKBOOK%"=="" set WORKBOOK=..\frontend\VPR_updated_fixed\New Rating Excel.xlsx

echo.
echo Running migration against: %WORKBOOK%
echo.
call node migrate-excel.js "%WORKBOOK%" migration-accounts.csv
if errorlevel 1 goto :error

echo.
echo ============================================
echo  Migration complete!
echo  Delete migration-accounts.csv now (it has
echo  plaintext temporary passwords) once you have
echo  shared each password with its owner.
echo  Then double-click START-SERVER.bat.
echo ============================================
pause
exit /b 0

:error
echo.
echo ============================================
echo  Something went wrong - read the error above.
echo  Common causes:
echo   - A name in the Excel has no matching row in
echo     migration-accounts.csv (fix the CSV, rerun)
echo   - migration-full-fidelity.sql was not run yet
echo   - MySQL isn't running, or .env has the wrong
echo     password
echo  Nothing was changed in the database - the
echo  migration rolled back automatically.
echo ============================================
pause
exit /b 1
