@echo off
rem RuninqVic launcher: opens the app in Edge (or Chrome) app-window mode. No install needed.
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "URL=file:///%HERE:\=/%index.html"
set "PROFILE=%LOCALAPPDATA%\RuninqVic\browser-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --app="%URL%" --user-data-dir="%PROFILE%" --window-size=1600,980 --no-first-run --no-default-browser-check --allow-file-access-from-files
  goto :eof
)
if exist "%CHROME%" (
  start "" "%CHROME%" --app="%URL%" --user-data-dir="%PROFILE%" --window-size=1600,980 --no-first-run --no-default-browser-check --allow-file-access-from-files
  goto :eof
)
echo Microsoft Edge 또는 Google Chrome 이 필요합니다. index.html 을 브라우저로 열어 주세요.
start "" "%URL%"
