@echo off
setlocal
REM === Wealth Atlas release script (double-click to run) ===
REM Switch to this script's folder (project root)
cd /d "%~dp0"

REM ---------- 1. Resolve GitHub token ----------
REM Priority: env GH_TOKEN > local .gh-token file > type it now
if defined GH_TOKEN goto :got_token
if exist ".gh-token" (
  set /p GH_TOKEN=<.gh-token
)
if defined GH_TOKEN goto :got_token

echo.
echo Type your GitHub token (github_pat_... or ghp_...). It will be saved to the
echo local, git-ignored file .gh-token so you only enter it once.
set /p GH_TOKEN=
if not defined GH_TOKEN (
  echo.
  echo [ERROR] No token entered. Publish cancelled.
  exit /b 1
)
REM Save to git-ignored .gh-token so next time you don't have to retype it
> .gh-token echo %GH_TOKEN%

:got_token

REM ---------- 2. Publish ----------
set WEALTH_ATLAS_PUBLISH=1
echo.
echo Publishing Wealth Atlas...
call npm run release:publish
if errorlevel 1 (
  echo.
  echo [FAILED] Publish errored. See output above.
  exit /b 1
)
echo.
echo [DONE] Published to GitHub Releases.
endlocal
