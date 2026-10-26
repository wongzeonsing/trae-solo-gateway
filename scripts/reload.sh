#!/bin/bash
# 重新加载网关：按 .env 里的 PORT 反查监听进程并停掉，再交给 keepalive 拉起。
# 注意：不能用 pkill -f <路径>，进程命令行是相对路径 "src/main.ts"，匹配不到。
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
PORT=$(sed -n 's/^PORT=//p' .env 2>/dev/null | head -1)
PORT=${PORT:-19900}

PID=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$PID" 2>/dev/null || true
  echo "[$(date '+%F %T')] 停掉旧进程 $PID，重新拉起" >> keepalive.log
fi
sleep 1
exec "$DIR/scripts/keepalive.sh"
