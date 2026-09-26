#!/bin/sh
# 服务守护脚本：以退出码 42 退出视为“维护重启”约定，立即重新拉起；
# 其他退出码透传并停止；收到 TERM/INT 时转发给子进程后退出，不留孤儿进程。
set -u
cd "$(dirname "$0")/.."

term=0
child=''
trap 'term=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT

rc=0
while [ "$term" -eq 0 ]; do
  node src/server.js &
  child=$!
  wait "$child"
  rc=$?
  if [ "$rc" -ne 42 ]; then
    exit "$rc"
  fi
  echo "检测到维护重启（退出码 42），正在重新拉起服务…"
done
