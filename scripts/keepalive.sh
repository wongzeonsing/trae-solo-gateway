#!/bin/bash
# 网关保活：端口在 listen = 活着；不在就拉起。cron: @reboot + 每分钟。
# 端口从 .env 读，避免脚本与配置漂移。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
NODE=node
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

if [ -n "$(port_pids)" ]; then
  exit 0
fi

# setsid 不是每个平台都有：有就用（彻底脱离 cron 的进程组），没有时 nohup 也够
SETSID=$(command -v setsid 2>/dev/null || true)
$SETSID nohup "$NODE" --env-file=.env src/main.ts >> server.log 2>&1 < /dev/null &
echo "[$(date '+%F %T')] 已拉起 src/main.ts (pid $!)" >> keepalive.log
