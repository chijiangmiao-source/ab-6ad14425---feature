#!/bin/sh
# 验收编排：业务检查之间穿插接口冒烟、代码测试与构建检查。
# 全部步骤执行完毕后退出，退出状态如实表示验收成败。
set -u
cd "$(dirname "$0")/.."

APP_URL="${APP_URL:-http://localhost:8080}"
export APP_URL
export RUN_ID="${RUN_ID:-r$(date +%s)$$}"

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

step "业务检查：同位并发插入的收敛文本（含幂等重放复核）"
run node verify/acceptance.mjs converge

step "代码测试（node --test）"
run node --test test/

step "业务检查：删除段内插入的保留结果"
run node verify/acceptance.mjs insert-in-delete

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

step "业务检查：拒绝提交后文本和修订未变"
run node verify/acceptance.mjs reject

echo
if [ "$fail" -eq 0 ]; then
  echo "验收通过：全部检查成功"
else
  echo "验收失败：存在未通过项"
fi
exit "$fail"
