@echo off
rem ai-flow Web 看板启动器 —— 双击运行,浏览器自动打开
rem 端口 8792;已在本跑则先关掉旧的(按端口精确清理,不误伤其他 node 进程)

chcp 65001 >nul
cd /d "%~dp0"

rem 找到占用 8792 的 PID 并结束(只动自己的端口)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8792 .*LISTENING"') do (
    echo 关闭旧进程 PID %%p
    taskkill /F /PID %%p >nul 2>&1
)

echo 启动 ai-flow 看板...
start "ai-flow-web" /min cmd /c "node server.js > data\web.log 2>&1"

rem 等服务起来
timeout /t 6 /nobreak >nul

start http://127.0.0.1:8792
echo 已打开 http://127.0.0.1:8792 (最小化窗口里是服务进程,关掉它=停止看板)
echo 日志: data\web.log
timeout /t 4 /nobreak >nul
