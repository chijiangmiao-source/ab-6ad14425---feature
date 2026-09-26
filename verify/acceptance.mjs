// 验收检查：通过真实 HTTP 接口复核业务行为。
// 用法：node verify/acceptance.mjs <smoke|converge|insert-in-delete|reject|
//       protected-accept|protected-reject|restart-pre|restart-post>
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

async function registerSel(docId, payload) {
  return api('POST', `/api/documents/${encodeURIComponent(docId)}/protected`, payload);
}

async function listSel(docId) {
  return api('GET', `/api/documents/${encodeURIComponent(docId)}/protected`);
}

async function getSel(docId, selId) {
  return api('GET', `/api/documents/${encodeURIComponent(docId)}/protected/${encodeURIComponent(selId)}`);
}

async function confirmSel(docId, selId, payload) {
  return api(
    'POST',
    `/api/documents/${encodeURIComponent(docId)}/protected/${encodeURIComponent(selId)}/confirm`,
    payload,
  );
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
  ok('全文携带逐字符稳定标识（charIds 与文本等长）',
    Array.isArray(fetched.body?.charIds)
    && fetched.body.charIds.length === fetched.body.text.length,
    `charIds=${JSON.stringify(fetched.body?.charIds)}`);

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

// 业务检查四：受保护补传在并发改动后的接受（锚点平移、目标定位、幂等重传）。
async function protectedAccept() {
  const doc = `pa-${RUN_ID}`;
  await createDoc(doc, '低温联锁规程');
  const d0 = await getDoc(doc);
  const ids0 = d0.body?.charIds;
  ok('批准稿携带逐字符标识', Array.isArray(ids0) && ids0.length === 6,
    `body=${JSON.stringify(d0.body)}`);

  // 从已批准全文选定插入点：位置 3（“联”与“锁”之间），保存所见修订与两端锚点
  const selIns = `sel-ins-${RUN_ID}`;
  const reg = await registerSel(doc, {
    id: selIns, baseRevision: 0, kind: 'insert', pos: 3, leftId: ids0[2], rightId: ids0[3],
  });
  ok('插入点选择已注册（201，待确认，锚点签发）', reg.status === 201
    && reg.body?.status === 'pending'
    && reg.body?.leftId === ids0[2] && reg.body?.rightId === ids0[3]
    && reg.body?.baseRevision === 0,
    `status=${reg.status} body=${JSON.stringify(reg.body)}`);

  // 并发改动：他处在锚点之外插入（旧式无锚补丁）
  const pre = await submit(doc, { id: `pa-pre-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: '【批注】' });
  ok('并发旧式补丁确认成功', pre.status === 200 && pre.body?.revision === 1,
    `body=${JSON.stringify(pre.body)}`);

  // 受保护补传：锚点仍围住原选位置 → 按当前标识序列定位并原子确认
  const ins = await confirmSel(doc, selIns, {
    patchId: `prot-${selIns}`, text: '（复核）', leftId: ids0[2], rightId: ids0[3],
  });
  ok('受保护插入被接受（锚点平移后落点 7）', ins.status === 200
    && ins.body?.revision === 2 && ins.body?.landing === 7
    && ins.body?.text === '【批注】低温联（复核）锁规程',
    `status=${ins.status} body=${JSON.stringify(ins.body)}`);

  // 从新的批准全文选定删除片段：“（复核）”
  const d2 = await getDoc(doc);
  const ids2 = d2.body?.charIds;
  const selDel = `sel-del-${RUN_ID}`;
  const reg2 = await registerSel(doc, {
    id: selDel, baseRevision: 2, kind: 'delete', start: 7, end: 11,
    expectedText: '（复核）', targetIds: ids2.slice(7, 11),
    leftId: ids2[6], rightId: ids2[11],
  });
  ok('删除片段选择已注册（201）', reg2.status === 201 && reg2.body?.status === 'pending'
    && reg2.body?.expectedText === '（复核）' && reg2.body?.targetIds?.length === 4,
    `status=${reg2.status} body=${JSON.stringify(reg2.body)}`);

  // 并发改动：在目标之前删除（不触及目标与锚点）
  const pre2 = await submit(doc, { id: `pa-pre2-${RUN_ID}`, baseRevision: 2, op: 'delete', pos: 0, len: 2 });
  ok('并发旧式删除确认成功', pre2.status === 200 && pre2.body?.revision === 3,
    `body=${JSON.stringify(pre2.body)}`);

  // 受保护删除：目标仍连续且内容未变 → 按当前标识序列定位确认
  const del = await confirmSel(doc, selDel, {
    patchId: `prot-${selDel}`, targetIds: ids2.slice(7, 11),
  });
  ok('受保护删除被接受（目标定位到 5，文本收敛）', del.status === 200
    && del.body?.revision === 4 && del.body?.landing === 5
    && del.body?.text === '注】低温联锁规程',
    `status=${del.status} body=${JSON.stringify(del.body)}`);

  // 幂等重传：复现首次确认结果，不新增修订
  const replay = await confirmSel(doc, selDel, {
    patchId: `prot-${selDel}`, targetIds: ids2.slice(7, 11),
  });
  ok('受保护确认重传复现首次结果', replay.status === 200 && replay.body?.duplicate === true
    && replay.body?.revision === 4 && replay.body?.text === '注】低温联锁规程',
    `body=${JSON.stringify(replay.body)}`);
  const after = await getDoc(doc);
  ok('重传未新增修订，标识序列与全文等长', after.body?.revision === 4
    && after.body?.text === '注】低温联锁规程'
    && after.body?.charIds?.length === 8,
    `body=${JSON.stringify(after.body)}`);
}

// 业务检查五：受保护补传在并发改动后的拒绝（锚点隔开、目标删改、标识伪造）。
async function protectedReject() {
  const doc = `pr-${RUN_ID}`;
  await createDoc(doc, '0123456789');
  const d0 = await getDoc(doc);
  const ids0 = d0.body?.charIds;

  // 选定插入点 5，随后并发插入恰好落在两锚点之间
  const selIns = `sel-i-${RUN_ID}`;
  await registerSel(doc, {
    id: selIns, baseRevision: 0, kind: 'insert', pos: 5, leftId: ids0[4], rightId: ids0[5],
  });
  await submit(doc, { id: `pr-x1-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 5, text: 'ZZ' });
  const separated = await confirmSel(doc, selIns, {
    patchId: `prot-${selIns}`, text: 'Q', leftId: ids0[4], rightId: ids0[5],
  });
  ok('锚点被插入隔开：明确拒绝（409 anchors-separated）', separated.status === 409
    && separated.body?.error === 'anchors-separated',
    `status=${separated.status} body=${JSON.stringify(separated.body)}`);
  let cur = await getDoc(doc);
  ok('拒绝后文本与修订未变', cur.body?.revision === 1 && cur.body?.text === '01234ZZ56789',
    `body=${JSON.stringify(cur.body)}`);
  const rec1 = await getSel(doc, selIns);
  ok('拒绝结论已落库（rejected / anchors-separated）', rec1.body?.status === 'rejected'
    && rec1.body?.conclusion?.code === 'anchors-separated'
    && rec1.body?.conclusion?.revision === 1,
    `body=${JSON.stringify(rec1.body)}`);

  // 选定删除片段“ZZ”，随后并发删除改动目标内容
  const ids1 = cur.body?.charIds;
  const selDel = `sel-d-${RUN_ID}`;
  await registerSel(doc, {
    id: selDel, baseRevision: 1, kind: 'delete', start: 5, end: 7,
    expectedText: 'ZZ', targetIds: ids1.slice(5, 7), leftId: ids1[4], rightId: ids1[7],
  });
  await submit(doc, { id: `pr-x2-${RUN_ID}`, baseRevision: 1, op: 'delete', pos: 6, len: 1 });
  const changed = await confirmSel(doc, selDel, {
    patchId: `prot-${selDel}`, targetIds: ids1.slice(5, 7),
  });
  ok('删除目标被删改：明确拒绝（409 target-changed）', changed.status === 409
    && changed.body?.error === 'target-changed',
    `status=${changed.status} body=${JSON.stringify(changed.body)}`);
  cur = await getDoc(doc);
  ok('拒绝后文本与修订未变', cur.body?.revision === 2 && cur.body?.text === '01234Z56789',
    `body=${JSON.stringify(cur.body)}`);
  const rec2 = await getSel(doc, selDel);
  ok('拒绝结论已落库（rejected / target-changed）', rec2.body?.status === 'rejected'
    && rec2.body?.conclusion?.code === 'target-changed',
    `body=${JSON.stringify(rec2.body)}`);

  // 标识伪造：注册时携带序列中从未签发的锚点
  const forged = await registerSel(doc, {
    id: `sel-f-${RUN_ID}`, baseRevision: 2, kind: 'insert', pos: 0,
    leftId: null, rightId: 'c999999',
  });
  ok('锚点标识伪造：注册即拒绝（409 anchor-forged）', forged.status === 409
    && forged.body?.error === 'anchor-forged',
    `status=${forged.status} body=${JSON.stringify(forged.body)}`);

  // 标识伪造：确认时回传被篡改的锚点
  const ids2 = cur.body?.charIds;
  const selOk = `sel-ok-${RUN_ID}`;
  await registerSel(doc, {
    id: selOk, baseRevision: 2, kind: 'insert', pos: 0, leftId: null, rightId: ids2[0],
  });
  const tampered = await confirmSel(doc, selOk, {
    patchId: `prot-${selOk}`, text: 'Q', leftId: 'c888888', rightId: ids2[0],
  });
  ok('确认时锚点被篡改：明确拒绝（409 anchor-forged）', tampered.status === 409
    && tampered.body?.error === 'anchor-forged',
    `status=${tampered.status} body=${JSON.stringify(tampered.body)}`);
  const rec3 = await getSel(doc, selOk);
  ok('篡改尝试不形成结论（选择仍待确认）', rec3.body?.status === 'pending'
    && rec3.body?.conclusion === null,
    `body=${JSON.stringify(rec3.body)}`);

  const after = await getDoc(doc);
  ok('全部拒绝后文本与修订仍未变', after.body?.revision === 2
    && after.body?.text === '01234Z56789',
    `body=${JSON.stringify(after.body)}`);
}

// 业务检查六（前半）：重启前写入——历史变换、锚点选择、已确认结论。
// 场景确定性构造，restart-post 依据同一 RUN_ID 复核。
async function restartPre() {
  const doc = `rs-${RUN_ID}`;
  await createDoc(doc, '规程ABC甲乙丙');
  const p1 = await submit(doc, { id: `rs-p1-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  const p2 = await submit(doc, { id: `rs-p2-${RUN_ID}`, baseRevision: 1, op: 'delete', pos: 2, len: 2 });
  const p3 = await submit(doc, { id: `rs-p3-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 1, text: 'L' });
  ok('重启前旧式补丁（含迟到补丁）确认到修订 3', p1.status === 200 && p2.status === 200
    && p3.status === 200 && p3.body?.text === '>>LABC甲乙丙' && p3.body?.revision === 3,
    `p3=${JSON.stringify(p3.body)}`);

  const d3 = await getDoc(doc);
  const ids = d3.body?.charIds;
  ok('重启前标识序列与全文等长', Array.isArray(ids) && ids.length === 9,
    `charIds=${JSON.stringify(ids)}`);

  // 待确认选择：插入点 4（“A”与“B”之间）
  const regPend = await registerSel(doc, {
    id: `rs-sel-pend-${RUN_ID}`, baseRevision: 3, kind: 'insert', pos: 4,
    leftId: ids[3], rightId: ids[4],
  });
  ok('待确认选择已注册（锚点 c2/c3）', regPend.status === 201
    && regPend.body?.leftId === 'c2' && regPend.body?.rightId === 'c3',
    `status=${regPend.status} body=${JSON.stringify(regPend.body)}`);

  // 已确认选择：删除片段“甲乙”
  const regDone = await registerSel(doc, {
    id: `rs-sel-done-${RUN_ID}`, baseRevision: 3, kind: 'delete', start: 6, end: 8,
    expectedText: '甲乙', targetIds: ids.slice(6, 8), leftId: ids[5], rightId: ids[8],
  });
  ok('删除选择已注册', regDone.status === 201 && regDone.body?.status === 'pending',
    `body=${JSON.stringify(regDone.body)}`);
  const done = await confirmSel(doc, `rs-sel-done-${RUN_ID}`, {
    patchId: `prot-rs-sel-done-${RUN_ID}`, targetIds: ids.slice(6, 8),
  });
  ok('重启前受保护删除确认到修订 4', done.status === 200 && done.body?.revision === 4
    && done.body?.text === '>>LABC丙' && done.body?.landing === 6,
    `body=${JSON.stringify(done.body)}`);
}

// 业务检查六（后半）：服务重启后——仅从接口恢复锚点与最近结论，旧接口保持兼容。
async function restartPost() {
  const doc = `rs-${RUN_ID}`;
  const cur = await getDoc(doc);
  ok('重启后全文与修订原样恢复', cur.status === 200 && cur.body?.revision === 4
    && cur.body?.text === '>>LABC丙' && cur.body?.charIds?.length === 7,
    `body=${JSON.stringify(cur.body)}`);

  const list = await listSel(doc);
  ok('选择列表从接口恢复（两条记录）', list.status === 200
    && list.body?.selections?.some((s) => s.id === `rs-sel-pend-${RUN_ID}` && s.status === 'pending')
    && list.body?.selections?.some((s) => s.id === `rs-sel-done-${RUN_ID}` && s.status === 'accepted'),
    `body=${JSON.stringify(list.body)}`);

  const pend = await getSel(doc, `rs-sel-pend-${RUN_ID}`);
  ok('待确认选择的锚点从接口恢复（c2/c3，仍待确认）', pend.status === 200
    && pend.body?.status === 'pending' && pend.body?.leftId === 'c2' && pend.body?.rightId === 'c3'
    && pend.body?.conclusion === null,
    `body=${JSON.stringify(pend.body)}`);

  const doneRec = await getSel(doc, `rs-sel-done-${RUN_ID}`);
  ok('最近结论从接口恢复（accepted，修订 4，落点 6）', doneRec.status === 200
    && doneRec.body?.status === 'accepted'
    && doneRec.body?.conclusion?.revision === 4
    && doneRec.body?.conclusion?.landing === 6
    && doneRec.body?.conclusion?.patchId === `prot-rs-sel-done-${RUN_ID}`,
    `body=${JSON.stringify(doneRec.body)}`);

  // 旧接口回归：幂等重传复现，不新增修订
  const replay = await submit(doc, { id: `rs-p1-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  ok('重启后旧式补丁重传幂等复现', replay.status === 200 && replay.body?.duplicate === true
    && replay.body?.revision === 1,
    `body=${JSON.stringify(replay.body)}`);

  // 旧接口回归：迟到补丁仍按历史变换确认
  const late = await submit(doc, { id: `rs-p4-${RUN_ID}`, baseRevision: 0, op: 'insert', pos: 0, text: 'T' });
  ok('重启后迟到补丁按历史变换确认（修订 5）', late.status === 200
    && late.body?.revision === 5 && late.body?.text === '>>LTABC丙' && late.body?.landing === 3,
    `body=${JSON.stringify(late.body)}`);

  // 受保护确认重传：幂等复现
  const protReplay = await confirmSel(doc, `rs-sel-done-${RUN_ID}`, {
    patchId: `prot-rs-sel-done-${RUN_ID}`,
  });
  ok('重启后受保护确认重传幂等复现', protReplay.status === 200
    && protReplay.body?.duplicate === true && protReplay.body?.revision === 4,
    `body=${JSON.stringify(protReplay.body)}`);

  // 重启后待确认选择仍可确认（锚点未被并发改动隔开）
  const landed = await confirmSel(doc, `rs-sel-pend-${RUN_ID}`, {
    patchId: `prot-rs-sel-pend-${RUN_ID}`, text: '§',
  });
  ok('重启后待确认选择按当前标识序列确认（修订 6，落点 5）', landed.status === 200
    && landed.body?.revision === 6 && landed.body?.landing === 5
    && landed.body?.text === '>>LTA§BC丙',
    `body=${JSON.stringify(landed.body)}`);

  const after = await getDoc(doc);
  ok('最终全文与标识序列一致', after.body?.revision === 6
    && after.body?.text === '>>LTA§BC丙' && after.body?.charIds?.length === 9,
    `body=${JSON.stringify(after.body)}`);
}

const checks = {
  smoke,
  converge,
  'insert-in-delete': insertInDelete,
  reject,
  'protected-accept': protectedAccept,
  'protected-reject': protectedReject,
  'restart-pre': restartPre,
  'restart-post': restartPost,
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
