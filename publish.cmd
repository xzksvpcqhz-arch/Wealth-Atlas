@echo off
setlocal
REM === Wealth Atlas 发布脚本（双击运行即可）===
REM 自动切到脚本所在目录（项目根），避免"找不到 package.json"
cd /d "%~dp0"

REM ---------- 1. 获取 GitHub token ----------
REM 优先级：环境变量 GH_TOKEN > 本机文件 .gh-token > 手动输入
if defined GH_TOKEN goto :got_token
if exist ".gh-token" (
  set /p GH_TOKEN=<.gh-token
)
if defined GH_TOKEN goto :got_token

echo 请输入你的 GitHub 新 token（github_pat_...），仅首次需要，会存到本机 .gh-token：
set /p GH_TOKEN=
if not defined GH_TOKEN (
  echo [错误] 未输入 token，取消发布。
  exit /b 1
)
REM 存到 gitignored 的 .gh-token，下次免输入
> .gh-token echo %GH_TOKEN%

:got_token

REM ---------- 2. 发布 ----------
set WEALTH_ATLAS_PUBLISH=1
echo.
echo 开始发布 Wealth Atlas（使用 GH_TOKEN）...
call npm run release:publish
if errorlevel 1 (
  echo.
  echo [发布失败] 请查看上方报错。
  exit /b 1
)
echo.
echo [完成] 已发布到 GitHub Releases。
endlocal
