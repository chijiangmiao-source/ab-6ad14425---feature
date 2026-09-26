#!/bin/sh
# 验收编排：业务检查之间穿插接口冒烟、代码测试与构建检查。
# 全部步骤执行完毕后退出，退出状态如实表示验收成败。
set -u
cd "$(dirname "$0")/.."

APP_URL="${APP_URL:-http://localhost:8080}"
export APP_URL
export RUN_ID="${RUN_ID:-r$(date +%s)$$}"

healthy() {
  node -e "fetch('$APP_URL/api/health').then((r)=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null
}

# 本地验收且服务未启动时：以守护方式启动（支持“重启恢复”检查的进程内重启），
# 数据目录与进程在退出时清理。
SERVER_PID=''
if ! healthy; then
  echo "未检测到运行中的服务，本地以守护方式启动（DATA_DIR=verify/.tmp-data）"
  rm -rf verify/.tmp-data
  DATA_DIR="$PWD/verify/.tmp-data" PORT=8080 sh scripts/serve.sh &
  SERVER_PID=$!
  trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf verify/.tmp-data' EXIT
  i=0
  while [ "$i" -lt 50 ]; do
    if healthy; then break; fi
    i=$((i + 1))
    sleep 0.2
  done
  if ! healthy; then
    echo "服务启动失败，验收中止"
    exit 1
  fi
fi

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

step "接口冒烟（健康状态 / 建立草案 / 读取全文与修订号）"
run node verify/acceptance.mjs smoke

step "旧接口回归：同位并发插入的收敛文本（含幂等重放复核）"
run node verify/acceptance.mjs converge

step "代码测试（node --test）"
run node --test test/

step "旧接口回归：删除段内插入的保留结果"
run node verify/acceptance.mjs insert-in-delete

step "受保护补传：并发改动后的接受与拒绝（锚点定位 + 标识序列）"
run node verify/acceptance.mjs protected

step "构建检查（全部源码语法校验）"
build_ok=1
for f in src/*.js public/app.js test/*.js verify/acceptance.mjs; do
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

step "重启恢复：进程重启后锚点、最近结论与历史变换保持兼容"
run node verify/acceptance.mjs restart

echo
if [ "$fail" -eq 0 ]; then
  echo "验收通过：全部检查成功"
else
  echo "验收失败：存在未通过项"
fi
exit "$fail"
