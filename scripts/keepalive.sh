#!/bin/bash
# 新网关保活：端口在 listen = 活着；不在就强杀残留并拉起。
# cron: @reboot + 每分钟。端口从同目录 .env 读，避免脚本与配置漂移。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
NODE=node
PORT=$(sed -n 's/^PORT=//p' .env 2>/dev/null | head -1)
PORT=${PORT:-19900}

if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  exit 0
fi

PID=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$PID" ]; then
  kill -9 "$PID" 2>/dev/null
  echo "[$(date '+%F %T')] 端口 $PORT 被僵死进程 $PID 占用，已强杀" >> keepalive.log
  sleep 1
fi

setsid nohup "$NODE" --env-file=.env src/main.ts >> server.log 2>&1 < /dev/null &
echo "[$(date '+%F %T')] 已拉起 src/main.ts (pid $!)" >> keepalive.log
