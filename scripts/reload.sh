#!/bin/bash
# 重新加载网关：按 .env 里的 PORT 反查监听进程并停掉，再交给 keepalive 拉起。
# 注意：不能用 pkill -f <路径>，进程命令行是相对路径 "src/main.ts"，匹配不到。
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
PORT=$(sed -n 's/^PORT=//p' .env 2>/dev/null | head -1)
PORT=${PORT:-19900}

# ss 是 Linux 的，lsof 是 macOS/BSD 的 —— 两种都认，脚本才能跨平台跑。
port_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null
  fi
}

PIDS=$(port_pids)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null || true
  sleep 5
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  echo "[$(date '+%F %T')] 停掉旧进程 $(echo $PIDS | tr '\n' ' ')，重新拉起" >> keepalive.log
fi
sleep 1
exec "$DIR/scripts/keepalive.sh"
