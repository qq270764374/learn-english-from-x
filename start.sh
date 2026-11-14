#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
WEB_DIR="$ROOT_DIR/web"

if [[ ! -f "$BACKEND_DIR/.env" && -f "$BACKEND_DIR/.env.example" ]]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  echo "[LearnEnglishFromX] 已生成默认 backend/.env（可按需填入 DeepSeek 或 Gemini API Key）"
fi

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  echo "[LearnEnglishFromX] 正在安装前端依赖..."
  (cd "$WEB_DIR" && npm install)
fi

cleanup() {
  echo ""
  echo "[LearnEnglishFromX] 正在关闭本地服务..."
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! command -v uv >/dev/null 2>&1 && [[ ! -x "$BACKEND_DIR/.venv/bin/uvicorn" ]]; then
  echo "[LearnEnglishFromX] 未检测到 uv，正在使用 python3 -m venv 初始化后端依赖..."
  python3 -m venv "$BACKEND_DIR/.venv"
  "$BACKEND_DIR/.venv/bin/pip" install -q fastapi "uvicorn[standard]" pydantic pydantic-settings simplemma lemminflect wordfreq genanki httpx
fi

echo "[LearnEnglishFromX] 启动本地 NLP 与 Anki 导出后端 (http://127.0.0.1:8765)..."
if command -v uv >/dev/null 2>&1; then
  (cd "$BACKEND_DIR" && uv run uvicorn app.main:app --host 127.0.0.1 --port 8765) &
else
  (cd "$BACKEND_DIR" && "$BACKEND_DIR/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8765) &
fi
BACKEND_PID=$!

echo "[LearnEnglishFromX] 启动 Web 学习界面 (http://localhost:5173)..."
(cd "$WEB_DIR" && npm run dev -- --host 127.0.0.1 --port 5173) &
WEB_PID=$!

echo ""
echo "=========================================================="
echo "  LearnEnglishFromX 已就绪!"
echo "  学习界面: http://localhost:5173"
echo "  后端接口: http://127.0.0.1:8765/docs"
echo "  Chrome 扩展目录: $ROOT_DIR/chrome-extension"
echo "=========================================================="
echo ""

wait "$BACKEND_PID" "$WEB_PID"
