#!/bin/sh
# 验收编排：业务检查之间穿插接口冒烟、代码测试与构建检查。
# 重启恢复覆盖方式：
#   - Compose（RESTART_MODE=docker）：经 docker.sock 实际重启 app 容器；
#   - 本地默认（未设 APP_URL）：自管被测服务进程，实际 kill 后以同一数据目录重启；
#   - 对接已有服务（仅设 APP_URL）：无法重启对方进程，跳过重启恢复并明示。
# 全部步骤执行完毕后退出，退出状态如实表示验收成败。
set -u
cd "$(dirname "$0")/.."

EXTERNAL=0
if [ -n "${APP_URL:-}" ]; then
  EXTERNAL=1
else
  APP_URL="http://127.0.0.1:${VERIFY_PORT:-18080}"
fi
export APP_URL
export RUN_ID="${RUN_ID:-r$(date +%s)$$}"

SRV_PID=""
DATA_DIR=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "$DATA_DIR" ] && rm -rf "$DATA_DIR"
  return 0
}
trap cleanup EXIT

wait_health() {
  i=0
  while [ "$i" -lt 60 ]; do
    if node -e "fetch('$APP_URL/api/health').then((r)=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "等待服务健康超时"
  return 1
}

start_server() {
  DATA_DIR="${DATA_DIR:-$(mktemp -d)}"
  PORT="${VERIFY_PORT:-18080}" DATA_DIR="$DATA_DIR" node src/server.js &
  SRV_PID=$!
  wait_health
}

stop_server() {
  kill "$SRV_PID" 2>/dev/null
  wait "$SRV_PID" 2>/dev/null
  SRV_PID=""
  return 0
}

fail=0
step() { echo; echo "== $1 =="; }
run() {
  if "$@"; then
    echo "-> 通过"
  else
    echo "-> 失败"
    fail=1
  fi
}

if [ "$EXTERNAL" -eq 0 ]; then
  step "启动本地被测服务（端口 ${VERIFY_PORT:-18080}，独立数据目录）"
  run start_server
fi

step "接口冒烟（健康状态 / 建立草案 / 读取全文与修订号 / 字符标识）"
run node verify/acceptance.mjs smoke

step "旧接口回归：同位并发插入的收敛文本（含幂等重放复核）"
run node verify/acceptance.mjs converge

step "代码测试（node --test）"
run node --test test/

step "旧接口回归：删除段内插入的保留结果"
run node verify/acceptance.mjs insert-in-delete

step "构建检查（全部源码语法校验）"
build_ok=1
for f in src/*.js public/app.js test/*.js verify/*.mjs; do
  if node --check "$f"; then
    echo "  [PASS] $f"
  else
    echo "  [FAIL] $f"
    build_ok=0
  fi
done
if [ "$build_ok" -eq 1 ]; then
  echo "-> 通过"
else
  echo "-> 失败"
  fail=1
fi

step "旧接口回归：拒绝提交后文本和修订未变"
run node verify/acceptance.mjs reject

step "受保护补传：并发改动后的接受（锚点平移 / 目标定位 / 幂等重传）"
run node verify/acceptance.mjs protected-accept

step "受保护补传：并发改动后的拒绝（锚点隔开 / 目标删改 / 标识伪造）"
run node verify/acceptance.mjs protected-reject

step "重启恢复：重启前写入（历史变换 / 锚点选择 / 已确认结论）"
run node verify/acceptance.mjs restart-pre

RESTARTED=0
if [ "${RESTART_MODE:-}" = "docker" ]; then
  step "经 docker.sock 实际重启 app 容器"
  run node verify/docker-restart.mjs
  RESTARTED=1
elif [ "$EXTERNAL" -eq 0 ]; then
  step "实际重启本地被测服务进程（同一数据目录恢复）"
  if stop_server && start_server; then
    echo "-> 通过"
  else
    echo "-> 失败"
    fail=1
  fi
  RESTARTED=1
else
  echo
  echo "== 跳过重启恢复：被测服务为外部进程且未设 RESTART_MODE=docker =="
fi

if [ "$RESTARTED" -eq 1 ]; then
  step "重启恢复：重启后复核（锚点与最近结论恢复 / 旧接口与历史变换兼容）"
  run node verify/acceptance.mjs restart-post
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "验收通过：全部检查成功"
else
  echo "验收失败：存在未通过项"
fi
exit "$fail"
