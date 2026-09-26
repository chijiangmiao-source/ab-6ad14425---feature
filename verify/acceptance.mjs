// 验收检查：通过真实 HTTP 接口复核业务行为。
// 用法：node verify/acceptance.mjs <smoke|converge|insert-in-delete|reject>
// 环境：APP_URL 指向被测服务；RUN_ID 隔离多次运行的草案标识。
const APP = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');
const RUN_ID = process.env.RUN_ID || `r${Date.now().toString(36)}`;
const which = process.argv[2];

let failures = 0;
function ok(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ` :: ${detail}`}`);
}

async function api(method, path, body) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body: json };
}

async function getDoc(id) {
  return api('GET', `/api/documents/${encodeURIComponent(id)}`);
}

async function createDoc(id, text) {
  return api('POST', '/api/documents', { id, text });
}

async function submit(docId, patch) {
  return api('POST', `/api/documents/${encodeURIComponent(docId)}/patches`, patch);
}

// 接口冒烟：健康状态、建立草案、读取全文与修订号。
async function smoke() {
  const health = await api('GET', '/api/health');
  ok('健康检查返回 200 且 status=ok', health.status === 200 && health.body?.status === 'ok',
    `status=${health.status} body=${JSON.stringify(health.body)}`);

  const id = `smoke-${RUN_ID}`;
  const created = await createDoc(id, '低温联锁规程 v1');
  ok('建立草案返回 201 且修订为 0', created.status === 201 && created.body?.revision === 0,
    `status=${created.status} body=${JSON.stringify(created.body)}`);

  const fetched = await getDoc(id);
  ok('读取当前全文与修订号', fetched.status === 200 && fetched.body?.text === '低温联锁规程 v1'
    && fetched.body?.revision === 0, `body=${JSON.stringify(fetched.body)}`);

  const list = await api('GET', '/api/documents');
  ok('草案出现在列表中', list.status === 200
    && list.body?.documents?.some((d) => d.id === id), `body=${JSON.stringify(list.body)}`);
}

// 业务检查一：同位置并发插入，两种提交顺序收敛到同一文本；并复核幂等重放。
async function converge() {
  const docA = `conv-a-${RUN_ID}`;
  const docB = `conv-b-${RUN_ID}`;
  await createDoc(docA, 'abcdef');
  await createDoc(docB, 'abcdef');
  const pa = { id: `ins-a-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 3, text: 'XYZ' };
  const pb = { id: `ins-b-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 3, text: '123' };

  // 顺序一：ins-a 先，ins-b 后（ins-b 迟到，需转换越过 ins-a）
  const a1 = await submit(docA, pa);
  const a2 = await submit(docA, pb);
  // 顺序二：ins-b 先，ins-a 后
  const b1 = await submit(docB, pb);
  const b2 = await submit(docB, pa);

  ok('两种顺序均确认成功', a1.status === 200 && a2.status === 200
    && b1.status === 200 && b2.status === 200,
    `a2=${a1.status},${a2.status} b=${b1.status},${b2.status}`);
  ok('收敛文本一致（标识字典序：ins-a 在前）',
    a2.body?.text === 'abcXYZ123def' && b2.body?.text === 'abcXYZ123def',
    `A=${a2.body?.text} B=${b2.body?.text}`);
  ok('修订连续递增（两份草案均为修订 2）',
    a2.body?.revision === 2 && b2.body?.revision === 2,
    `A=${a2.body?.revision} B=${b2.body?.revision}`);
  ok('迟到补丁实际落点正确（后到者按定序落在 6 或 3）',
    a2.body?.landing === 6 && b2.body?.landing === 3,
    `A=${a2.body?.landing} B=${b2.body?.landing}`);

  // 幂等重放：同标识同载荷重传，复现首次文本、修订与落点，不新增修订
  const replay = await submit(docA, pa);
  ok('同标识同载荷重传复现首次结果', replay.status === 200
    && replay.body?.duplicate === true
    && replay.body?.revision === a1.body?.revision
    && replay.body?.text === a1.body?.text
    && replay.body?.landing === a1.body?.landing,
    `body=${JSON.stringify(replay.body)}`);
  const after = await getDoc(docA);
  ok('重传未新增修订', after.body?.revision === 2 && after.body?.text === 'abcXYZ123def',
    `body=${JSON.stringify(after.body)}`);
}

// 业务检查二：删除段内插入的保留结果，两种提交顺序收敛。
async function insertInDelete() {
  const docA = `di-a-${RUN_ID}`;
  const docB = `di-b-${RUN_ID}`;
  await createDoc(docA, '0123456789');
  await createDoc(docB, '0123456789');
  const del = { id: `del-${RUN_ID}`, baseRevision: 0, op: 'delete', pos: 2, len: 5 }; // 删除 [2,7)
  const ins = { id: `ins-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 4, text: 'AB' }; // 落在删除区间内

  const a1 = await submit(docA, del);
  const a2 = await submit(docA, ins); // 迟到插入：应保留并收敛到删除区间起点
  const b1 = await submit(docB, ins);
  const b2 = await submit(docB, del); // 迟到删除：应拆段绕过已插入文本

  ok('两种顺序均确认成功', a1.status === 200 && a2.status === 200
    && b1.status === 200 && b2.status === 200);
  ok('删除段内插入被保留，收敛文本一致（01AB789）',
    a2.body?.text === '01AB789' && b2.body?.text === '01AB789',
    `A=${a2.body?.text} B=${b2.body?.text}`);
  ok('迟到插入落点收敛到删除区间起点 2', a2.body?.landing === 2,
    `landing=${a2.body?.landing}`);
  ok('迟到删除规范化为两段（绕过保留的插入文本）',
    Array.isArray(b2.body?.normalizedOps) && b2.body?.normalizedOps.length === 2
    && b2.body.normalizedOps.every((o) => o.type === 'delete'),
    `ops=${JSON.stringify(b2.body?.normalizedOps)}`);
}

// 业务检查三：各类非法提交被拒绝，且文本与修订保持不变。
async function reject() {
  const doc = `rej-${RUN_ID}`;
  await createDoc(doc, 'hello');
  const good = { id: `ok-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: '>' };
  const confirmed = await submit(doc, good);
  ok('合法补丁确认成功', confirmed.status === 200 && confirmed.body?.revision === 1
    && confirmed.body?.text === '>hello', `body=${JSON.stringify(confirmed.body)}`);

  const future = await submit(doc, { id: `f1-${RUN_ID}`, baseRevision: 9, op: 'insert', pos: 0, text: 'x' });
  ok('未来修订被拒绝（409）', future.status === 409 && future.body?.error === 'future-revision',
    `status=${future.status} body=${JSON.stringify(future.body)}`);

  const oob = await submit(doc, { id: `f2-${RUN_ID}`, baseRevision: 0, op: 'delete', pos: 3, len: 10 });
  ok('越界删除被拒绝（422）', oob.status === 422 && oob.body?.error === 'out-of-bounds',
    `status=${oob.status}`);

  const badLen = await submit(doc, { id: `f3-${RUN_ID}`, baseRevision: 0, op: 'delete', pos: 1, len: 0 });
  ok('长度不符的删除被拒绝（422）', badLen.status === 422 && badLen.body?.error === 'bad-length',
    `status=${badLen.status}`);

  const reuse = await submit(doc, { id: `ok-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 2, text: '>' });
  ok('标识复用但载荷不同被拒绝（409）', reuse.status === 409
    && reuse.body?.error === 'patch-id-conflict', `status=${reuse.status}`);

  const after = await getDoc(doc);
  ok('拒绝提交后文本与修订未变', after.status === 200
    && after.body?.text === '>hello' && after.body?.revision === 1,
    `body=${JSON.stringify(after.body)}`);
}

const checks = { smoke, converge, 'insert-in-delete': insertInDelete, reject };

if (!checks[which]) {
  console.error(`未知检查：${which}（可选：${Object.keys(checks).join(', ')}）`);
  process.exit(2);
}

console.log(`-- ${which} (APP_URL=${APP}, RUN_ID=${RUN_ID})`);
try {
  await checks[which]();
} catch (err) {
  console.error(`  [FAIL] 检查执行异常：${err.message}`);
  failures += 1;
}
process.exit(failures === 0 ? 0 : 1);
