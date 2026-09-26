// 验收检查：通过真实 HTTP 接口复核业务行为。
// 用法：node verify/acceptance.mjs <smoke|converge|insert-in-delete|reject|protected|restart>
// 环境：APP_URL 指向被测服务；RUN_ID 隔离多次运行的草案标识。
const APP = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');
const RUN_ID = process.env.RUN_ID || `r${Date.now().toString(36)}`;
const which = process.argv[2];

let failures = 0;
function ok(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ` :: ${detail}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 业务检查四：受保护补传 —— 并发改动后的接受与拒绝（锚点定位 + 标识序列）。
async function protectedFlow() {
  const doc = `prot-${RUN_ID}`;
  await createDoc(doc, 'ABCDEFGHIJ');
  let cur = await getDoc(doc);
  ok('读取批准文本携带稳定字符标识序列', cur.status === 200
    && Array.isArray(cur.body?.seq) && cur.body.seq.length === 10
    && cur.body.seq.every((c) => typeof c.id === 'string' && typeof c.ch === 'string'),
    `body=${JSON.stringify(cur.body)}`);
  let ids = cur.body.seq.map((c) => c.id);

  // —— 接受：并发改动落在锚点之外，锚点仍围住原选位置 ——
  const pins = {
    id: `pins-${RUN_ID}`, protected: true, op: 'insert',
    leftId: ids[3], rightId: ids[4], text: '$$', baseRevision: 0,
  };
  const leg1 = await submit(doc, { id: `plg1-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  ok('并发无锚补丁确认（修订 1）', leg1.status === 200 && leg1.body?.revision === 1);
  const acc = await submit(doc, pins);
  ok('锚点仍围住原选位置：受保护插入按当前标识序列定位并接受',
    acc.status === 200 && acc.body?.revision === 2
      && acc.body?.text === '>>ABCD$$EFGHIJ' && acc.body?.landing === 6
      && acc.body?.normalizedOps?.[0]?.pos === 6,
    `status=${acc.status} body=${JSON.stringify(acc.body)}`);

  // 幂等重传受保护补丁：复现首次结论，不新增修订
  const replay = await submit(doc, pins);
  ok('受保护补丁幂等重传复现首次结论', replay.status === 200
    && replay.body?.duplicate === true && replay.body?.revision === 2
    && replay.body?.text === '>>ABCD$$EFGHIJ' && replay.body?.landing === 6,
    `body=${JSON.stringify(replay.body)}`);
  cur = await getDoc(doc);
  ok('重传未新增修订', cur.body?.revision === 2);

  // —— 拒绝：锚点被插入隔开 ——
  ids = cur.body.seq.map((c) => c.id); // 文本 >>ABCD$$EFGHIJ
  const sep = await submit(doc, { id: `plg2-${RUN_ID}`, baseRevision: 2, op: 'insert', pos: 8, text: '#' });
  ok('并发插入落在两锚点之间（修订 3）', sep.status === 200 && sep.body?.text === '>>ABCD$$#EFGHIJ');
  const sepRej = await submit(doc, {
    id: `psep-${RUN_ID}`, protected: true, op: 'insert', leftId: ids[7], rightId: ids[8], text: 'X',
  });
  ok('锚点被插入隔开：明确拒绝（409 anchor-separated）',
    sepRej.status === 409 && sepRej.body?.error === 'anchor-separated',
    `status=${sepRej.status} body=${JSON.stringify(sepRej.body)}`);
  cur = await getDoc(doc);
  ok('拒绝后文本与修订未变', cur.body?.revision === 3 && cur.body?.text === '>>ABCD$$#EFGHIJ');

  // —— 拒绝：删除目标内容已变化 ——
  ids = cur.body.seq.map((c) => c.id); // 文本 >>ABCD$$#EFGHIJ，片段 EFG 位于索引 9..11
  const leg3 = await submit(doc, { id: `plg3-${RUN_ID}`, baseRevision: 3, op: 'insert', pos: 11, text: '!' });
  ok('并发插入落入删除目标内部（修订 4）', leg3.status === 200 && leg3.body?.text === '>>ABCD$$#EF!GHIJ');
  const changed = await submit(doc, {
    id: `pchg-${RUN_ID}`, protected: true, op: 'delete', leftId: ids[9], rightId: ids[11], text: 'EFG',
  });
  ok('删除目标内容已变化：明确拒绝（409 target-changed）',
    changed.status === 409 && changed.body?.error === 'target-changed',
    `status=${changed.status} body=${JSON.stringify(changed.body)}`);
  cur = await getDoc(doc);
  ok('拒绝后文本与修订未变（修订 4）', cur.body?.revision === 4 && cur.body?.text === '>>ABCD$$#EF!GHIJ');

  // —— 拒绝：锚点字符已被删除 ——
  ids = cur.body.seq.map((c) => c.id); // 文本 >>ABCD$$#EF!GHIJ，H 位于索引 13
  const leg4 = await submit(doc, { id: `plg4-${RUN_ID}`, baseRevision: 4, op: 'delete', pos: 13, len: 1 });
  ok('并发删除锚点字符（修订 5）', leg4.status === 200 && leg4.body?.text === '>>ABCD$$#EF!GIJ');
  const lost = await submit(doc, {
    id: `plost-${RUN_ID}`, protected: true, op: 'delete', leftId: ids[13], rightId: ids[14], text: 'HI',
  });
  ok('锚点字符已被删除：明确拒绝（409 anchor-lost）',
    lost.status === 409 && lost.body?.error === 'anchor-lost',
    `status=${lost.status} body=${JSON.stringify(lost.body)}`);

  // —— 拒绝：标识伪造 ——
  const forged = await submit(doc, {
    id: `pfrg-${RUN_ID}`, protected: true, op: 'insert',
    leftId: `never-issued-${RUN_ID}`, rightId: null, text: 'x',
  });
  ok('伪造标识：明确拒绝（409 anchor-forged）',
    forged.status === 409 && forged.body?.error === 'anchor-forged',
    `status=${forged.status} body=${JSON.stringify(forged.body)}`);
  cur = await getDoc(doc);
  ok('多次拒绝后文本与修订仍未变（修订 5）',
    cur.body?.revision === 5 && cur.body?.text === '>>ABCD$$#EF!GIJ');

  // —— 接受：受保护删除（并发改动在目标之外，目标连续且内容未变）——
  ids = cur.body.seq.map((c) => c.id); // 文本 >>ABCD$$#EF!GIJ（15 字符），IJ 在末尾
  const leg5 = await submit(doc, { id: `plg5-${RUN_ID}`, baseRevision: 5, op: 'insert', pos: 0, text: '<<' });
  ok('并发改动落在删除目标之外（修订 6）', leg5.status === 200 && leg5.body?.revision === 6);
  const pdel = await submit(doc, {
    id: `pdel-${RUN_ID}`, protected: true, op: 'delete',
    leftId: ids[13], rightId: ids[14], text: 'IJ',
  });
  ok('目标连续且内容未变：受保护删除按当前标识序列定位并接受',
    pdel.status === 200 && pdel.body?.revision === 7
      && pdel.body?.text === '<<>>ABCD$$#EF!G' && pdel.body?.landing === 15,
    `status=${pdel.status} body=${JSON.stringify(pdel.body)}`);
  cur = await getDoc(doc);
  ok('标识序列随确认补丁演进且拼接文本等于全文',
    cur.body?.revision === 7 && cur.body?.seq?.length === 15
      && cur.body.seq.map((c) => c.ch).join('') === cur.body.text,
    `seq=${JSON.stringify(cur.body?.seq)}`);
}

// 业务检查五：重启恢复 —— 进程重启后锚点、最近结论与历史变换保持兼容。
async function restart() {
  const doc = `rst-${RUN_ID}`;
  await createDoc(doc, '0123456789ABCDEF');
  const p1 = { id: `rleg1-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: '>>' };
  const r1 = await submit(doc, p1);
  ok('重启前无锚补丁确认（修订 1）', r1.status === 200 && r1.body?.text === '>>0123456789ABCDEF');

  let cur = await getDoc(doc);
  const ids1 = cur.body.seq.map((c) => c.id);
  // 删除片段：索引 5..7（内容 '345'）；插入点：索引 10 与 11 之间
  const delSel = { leftId: ids1[5], rightId: ids1[7], text: '345' };
  const insSel = { leftId: ids1[10], rightId: ids1[11] };
  const p2 = { id: `rpdel-${RUN_ID}`, protected: true, op: 'delete', ...delSel };
  const r2 = await submit(doc, p2);
  ok('重启前受保护删除确认（修订 2）', r2.status === 200 && r2.body?.text === '>>0126789ABCDEF');

  cur = await getDoc(doc);
  const preIds = cur.body.seq.map((c) => c.id);
  const preLast = cur.body.lastConfirmed;
  ok('重启前最近结论为修订 2', preLast?.revision === 2 && preLast?.text === '>>0126789ABCDEF',
    `lastConfirmed=${JSON.stringify(preLast)}`);
  const preBoot = (await api('GET', '/api/health')).body?.bootId;

  // 触发进程内重启，并等待一个“新进程”恢复健康（bootId 改变为重启的铁证）
  const kick = await api('POST', '/api/admin/restart');
  ok('重启请求被接受（202）', kick.status === 202, `status=${kick.status}`);
  const restarted = await waitRestarted(preBoot, 30000);
  ok('服务在进程重启后恢复健康（bootId 已改变）', restarted,
    `preBoot=${preBoot}`);
  if (!restarted) return;

  cur = await getDoc(doc);
  ok('重启后全文与修订不变', cur.status === 200 && cur.body?.revision === 2
    && cur.body?.text === '>>0126789ABCDEF', `body=${JSON.stringify(cur.body)}`);
  ok('重启后字符标识序列保持一致', JSON.stringify(cur.body?.seq?.map((c) => c.id)) === JSON.stringify(preIds));
  ok('重启后从接口恢复最近结论', cur.body?.lastConfirmed?.revision === 2
    && cur.body?.lastConfirmed?.text === '>>0126789ABCDEF'
    && cur.body?.lastConfirmed?.landing === preLast?.landing);

  // 重启前的插入点锚点仍可定位确认
  const r3 = await submit(doc, {
    id: `rpins-${RUN_ID}`, protected: true, op: 'insert', ...insSel, text: '@@',
  });
  ok('重启后按重启前锚点接受受保护插入', r3.status === 200 && r3.body?.revision === 3
    && r3.body?.text === '>>012678@@9ABCDEF' && r3.body?.landing === 8,
    `status=${r3.status} body=${JSON.stringify(r3.body)}`);

  // 旧式迟到补丁：重启后仍按历史变换结果确认
  const late = await submit(doc, { id: `rlate-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 16, text: 'ZZ' });
  ok('重启后旧式迟到补丁按历史转换确认', late.status === 200 && late.body?.revision === 4
    && late.body?.text === '>>012678@@9ABCDEFZZ',
    `status=${late.status} body=${JSON.stringify(late.body)}`);

  // 幂等重传：重启前的无锚补丁与受保护补丁均复现首次结论
  const d1 = await submit(doc, p1);
  ok('重启前无锚补丁重传幂等复现', d1.status === 200 && d1.body?.duplicate === true
    && d1.body?.revision === 1, `body=${JSON.stringify(d1.body)}`);
  const d2 = await submit(doc, p2);
  ok('重启前受保护补丁重传幂等复现', d2.status === 200 && d2.body?.duplicate === true
    && d2.body?.revision === 2, `body=${JSON.stringify(d2.body)}`);
  cur = await getDoc(doc);
  ok('重传未新增修订（仍为 4）', cur.body?.revision === 4);

  // 重启后拒绝语义仍然生效
  const forged = await submit(doc, {
    id: `rfrg-${RUN_ID}`, protected: true, op: 'insert',
    leftId: `never-issued-${RUN_ID}`, rightId: null, text: 'x',
  });
  ok('重启后伪造标识仍被拒绝（409 anchor-forged）',
    forged.status === 409 && forged.body?.error === 'anchor-forged');
  const lost = await submit(doc, {
    id: `rlost-${RUN_ID}`, protected: true, op: 'delete', ...delSel,
  });
  ok('重启后已删除锚点仍被拒绝（409 anchor-lost）',
    lost.status === 409 && lost.body?.error === 'anchor-lost');
  cur = await getDoc(doc);
  ok('拒绝后文本与修订未变', cur.body?.revision === 4
    && cur.body?.text === '>>012678@@9ABCDEFZZ');
}

// 等待服务以“新进程”恢复健康：bootId 与重启前不同才算完成重启。
async function waitRestarted(prevBootId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  await sleep(800); // 留出旧进程退出时间，避免把旧进程误判为已重启
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP}/api/health`);
      if (res.status === 200) {
        const body = await res.json();
        if (body?.bootId && body.bootId !== prevBootId) return true;
      }
    } catch {
      /* 重启进行中 */
    }
    await sleep(300);
  }
  return false;
}

const checks = {
  smoke,
  converge,
  'insert-in-delete': insertInDelete,
  reject,
  protected: protectedFlow,
  restart,
};

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
