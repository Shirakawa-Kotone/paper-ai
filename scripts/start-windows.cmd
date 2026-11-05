@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

echo.
echo   化学 AI 改卷台 - Windows 启动器
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js。请先安装 Node.js 24 或更高版本：
  echo          https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo   首次运行，正在安装依赖（约 1-2 分钟）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [错误] 依赖安装失败，请检查网络或代理。
    pause
    exit /b 1
  )
)

if not exist web\dist\index.html (
  echo   正在构建前端...
  call npm run build
  if errorlevel 1 (
    echo   [错误] 前端构建失败。
    pause
    exit /b 1
  )
)

set PAPER_AI_OPEN=1
if "%PORT%"=="" set PORT=8787

echo.
echo   启动后浏览器会自动打开 http://127.0.0.1:%PORT%
echo   关闭此窗口即停止服务。
echo.

node server/main.ts

echo.
echo   服务已退出。
pause
