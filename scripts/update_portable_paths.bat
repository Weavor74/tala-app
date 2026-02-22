@echo off
:: This script updates all references to use the portable Python

set "PORTABLE_PYTHON=bin\python-portable\python.exe"

:: Update start_local_inference.bat
echo Updating start_local_inference.bat...
powershell -Command "(Get-Content start_local_inference.bat) -replace 'local-inference\\venv\\Scripts\\python.exe', '%PORTABLE_PYTHON%' | Set-Content start_local_inference.bat"

echo Portable paths updated.
