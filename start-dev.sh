#!/bin/bash
# KnowClip 一键启动脚本
# 首次运行会自动：创建 Python 虚拟环境 → 安装后端依赖 → 安装前端依赖
# 之后每次运行直接启动。Ctrl+C 同时退出前后端。
set -e
cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

echo "=============================================="
echo "  KnowClip 智能剪辑（开源版）"
echo "=============================================="

# ---------- 1. Python 环境 ----------
if [ ! -x ".venv/bin/python" ]; then
    echo "[1/4] 首次运行：创建 Python 虚拟环境..."
    python3 -m venv .venv
else
    echo "[1/4] Python 虚拟环境已存在"
fi

# 检查后端依赖是否已安装（以 fastapi 为标记）
if ! .venv/bin/pip show fastapi >/dev/null 2>&1; then
    echo "[2/4] 安装后端依赖（首次约几分钟）..."
    .venv/bin/pip install -q --upgrade pip
    .venv/bin/pip install -q -r backend/requirements.txt
else
    echo "[2/4] 后端依赖已安装"
fi

# ---------- 2. 前端依赖 ----------
cd desktop-app
if [ ! -d node_modules ]; then
    echo "[3/4] 首次运行：安装前端依赖（npm install）..."
    npm install
else
    echo "[3/4] 前端依赖已安装"
fi

# ---------- 3. 启动 ----------
echo "[4/4] 启动后端（127.0.0.1:8000）与前端（Tauri 窗口）..."
echo "      首次识别会自动下载 Paraformer 模型（约 1GB），请耐心等待一次"
echo "      退出：在本窗口按 Ctrl+C 同时关闭前后端"
echo "=============================================="

cleanup() {
    echo ""
    echo "正在关闭..."
    [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
    exit 0
}
trap cleanup INT TERM

# 清理上次可能残留的后端进程（端口占用会导致新后端静默启动失败）
if [ -n "$(lsof -ti:8000)" ]; then
    echo "清理残留的旧后端进程..."
    lsof -ti:8000 | xargs kill 2>/dev/null
    sleep 1
fi

(cd "$ROOT_DIR/backend" && exec "$ROOT_DIR/.venv/bin/python" api_server.py) &
BACKEND_PID=$!

# 等后端就绪再拉前端（避免前端首屏请求落空）
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://127.0.0.1:8000/check; then
        break
    fi
    sleep 1
done

npm run tauri dev
