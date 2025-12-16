@echo off
call npm install
call npm run compile
call vsce package --allow-missing-repository
pause
