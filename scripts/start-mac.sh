#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "首次运行，安装依赖…"
  npm install --no-audit --no-fund
fi

if [ ! -f web/dist/index.html ]; then
  echo "构建前端…"
  npm run build
fi

export PAPER_AI_OPEN="${PAPER_AI_OPEN:-1}"
exec npm start
