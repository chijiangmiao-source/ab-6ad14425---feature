/* 低温联锁规程补传确认终端。
 * 本机仅保存：草案标识、本终端基准修订、离线草案文本、受保护选择（所见修订与两端锚点）。
 * 已批准内容、锚点的当前位置与最近确认结论一律以服务端真实接口为准：
 * 刷新或服务重启后，本终端只从接口恢复锚点（字符标识序列）和最近结论，
 * 本地旧草案仅标注为“未批准”，绝不当作已批准内容。 */
'use strict';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`lti.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(`lti.${key}`, JSON.stringify(value));
  },
};

const state = {
  docId: store.get('docId', 'main'),
  baseRevision: store.get('baseRevision', null),
  // 受保护选择：{ kind: 'insert'|'delete', revision, leftId, rightId, text }
  // 只保存选择所见修订与两端锚点；锚点的当前位置一律从接口的标识序列恢复。
  selection: store.get('selection', null),
  approved: null, // { id, revision, text, seq, lastConfirmed }
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = `msg ${kind || ''}`;
}

function newPatchId() {
  const rand =
    globalThis.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `patch-${rand}`;
}

function renderApproved() {
  if (state.approved) {
    $('approved-rev').textContent = String(state.approved.revision);
    $('approved-text').textContent = state.approved.text;
  } else {
    $('approved-rev').textContent = '—';
    $('approved-text').textContent = '（服务端尚无该草案，请先建立草案）';
  }
}

function renderLocal() {
  $('base-rev-view').textContent =
    state.baseRevision === null ? '—' : String(state.baseRevision);
}

function renderConfirmed(result) {
  $('confirmed-rev').textContent = String(result.revision);
  $('confirmed-landing').textContent =
    result.landing === null ? '（空操作）' : String(result.landing);
  $('confirmed-ops').textContent = JSON.stringify(result.normalizedOps);
  $('confirmed-text').textContent = result.text;
  $('confirmed-dup').hidden = !result.duplicate;
}

// 从接口恢复最近结论：服务端返回的 lastConfirmed 是唯一来源。
function renderLastConfirmed() {
  const last = state.approved && state.approved.lastConfirmed;
  if (last) {
    renderConfirmed(last);
  } else {
    $('confirmed-rev').textContent = '—';
    $('confirmed-landing').textContent = '—';
    $('confirmed-ops').textContent = '—';
    $('confirmed-text').textContent = '（尚无确认结果，刷新后仅从接口恢复最近结论）';
    $('confirmed-dup').hidden = true;
  }
}

// 在最新标识序列中恢复锚点位置；返回 { leftIdx, rightIdx } 或 null（锚点已不存在）。
function resolveAnchors() {
  const sel = state.selection;
  const seq = state.approved && state.approved.seq;
  if (!sel || !seq) return null;
  const find = (id) => (id === null ? null : seq.findIndex((c) => c.id === id));
  const leftIdx = sel.leftId === null ? -1 : find(sel.leftId);
  const rightIdx = sel.rightId === null ? seq.length : find(sel.rightId);
  if (sel.leftId !== null && leftIdx === -1) return null;
  if (sel.rightId !== null && rightIdx === -1) return null;
  return { leftIdx, rightIdx };
}

function renderSelection() {
  const sel = state.selection;
  const has = Boolean(sel);
  for (const id of ['sel-rev', 'sel-kind', 'sel-left', 'sel-right', 'sel-pos', 'sel-text', 'sel-pid']) {
    if (!has) $(id).textContent = '—';
  }
  $('wrap-protected-text').hidden = !has || sel.kind !== 'insert';
  if (!has) return;

  $('sel-rev').textContent = String(sel.revision);
  $('sel-pid').textContent = sel.patchId || '—';
  $('sel-kind').textContent = sel.kind === 'insert' ? '插入点' : '删除片段';
  $('sel-left').textContent = sel.leftId === null ? '（文首）' : sel.leftId;
  $('sel-right').textContent = sel.rightId === null ? '（文末）' : sel.rightId;
  $('sel-text').textContent =
    sel.kind === 'delete' ? sel.text : '（插入点，无片段内容）';

  const resolved = resolveAnchors();
  if (!state.approved) {
    $('sel-pos').textContent = '待接口恢复';
  } else if (!resolved) {
    $('sel-pos').textContent = '锚点已不存在';
  } else if (sel.kind === 'insert') {
    $('sel-pos').textContent =
      resolved.rightIdx === resolved.leftIdx + 1
        ? `插入位置 ${resolved.leftIdx + 1}（锚点仍相邻）`
        : '锚点已被插入隔开（提交将被拒绝）';
  } else {
    const { leftIdx, rightIdx } = resolved;
    const current = state.approved.text.slice(leftIdx, rightIdx + 1);
    $('sel-pos').textContent =
      current === sel.text
        ? `删除区间 [${leftIdx}, ${rightIdx}]（内容未变）`
        : '目标已不连续或内容已变（提交将被拒绝）';
  }
}

async function refreshApproved() {
  const { status, body } = await api(
    `/api/documents/${encodeURIComponent(state.docId)}`,
  );
  state.approved = status === 200 ? body : null;
  renderApproved();
  renderSelection();
  renderLastConfirmed();
}

async function refreshHealth() {
  const el = $('health');
  try {
    const { status, body } = await api('/api/health');
    if (status === 200 && body && body.status === 'ok') {
      el.textContent = '服务正常';
      el.className = 'pill pill-ok';
      $('boot-id').textContent = body.bootId || '—';
      return;
    }
    throw new Error();
  } catch {
    el.textContent = '服务不可达';
    el.className = 'pill pill-bad';
    $('boot-id').textContent = '—';
  }
}

// 批准稿 <pre> 内选区的字符区间 [start, end)；选区不在批准稿内时返回 null。
function selectionRangeInApproved() {
  const pre = $('approved-text');
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !state.approved) return null;
  const range = sel.getRangeAt(0);
  if (!pre.contains(range.startContainer) || !pre.contains(range.endContainer)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(pre);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = probe.toString().length;
  const end = start + range.toString().length;
  if (end > state.approved.text.length) return null;
  return { start, end };
}

function pickInsertPoint() {
  const msg = $('pick-msg');
  const r = selectionRangeInApproved();
  if (!r) {
    setMsg(msg, '请先在批准稿全文中放置光标', 'err');
    return;
  }
  const seq = state.approved.seq;
  state.selection = {
    kind: 'insert',
    patchId: newPatchId(),
    revision: state.approved.revision,
    leftId: r.start === 0 ? null : seq[r.start - 1].id,
    rightId: r.start === seq.length ? null : seq[r.start].id,
    text: '',
  };
  store.set('selection', state.selection);
  renderSelection();
  setMsg(msg, `已记录插入点（所见修订 ${state.approved.revision}，两端锚点已保存）`, 'ok');
}

function pickDeleteFragment() {
  const msg = $('pick-msg');
  const r = selectionRangeInApproved();
  if (!r || r.start === r.end) {
    setMsg(msg, '请先在批准稿全文中拖选一段连续文字', 'err');
    return;
  }
  const seq = state.approved.seq;
  state.selection = {
    kind: 'delete',
    patchId: newPatchId(),
    revision: state.approved.revision,
    leftId: seq[r.start].id,
    rightId: seq[r.end - 1].id,
    text: state.approved.text.slice(r.start, r.end),
  };
  store.set('selection', state.selection);
  renderSelection();
  setMsg(msg, `已记录删除片段（所见修订 ${state.approved.revision}，${r.end - r.start} 字符）`, 'ok');
}

async function submitProtected() {
  const msg = $('protected-msg');
  const sel = state.selection;
  if (!sel) {
    setMsg(msg, '请先在批准稿中记录插入点或删除片段', 'err');
    return;
  }
  const payload = {
    id: sel.patchId,
    protected: true,
    op: sel.kind,
    leftId: sel.leftId,
    rightId: sel.rightId,
    baseRevision: sel.revision,
  };
  if (sel.kind === 'insert') {
    payload.text = $('protected-text').value;
    if (payload.text.length === 0) {
      setMsg(msg, '受保护插入必须填写插入文本', 'err');
      return;
    }
  } else {
    payload.text = sel.text;
  }

  const { status, body } = await api(
    `/api/documents/${encodeURIComponent(state.docId)}/patches`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  if (status === 200) {
    // 补传成功：只显示服务端确认的全文、修订和实际落点。
    renderConfirmed(body);
    setMsg(
      msg,
      body.duplicate
        ? `补丁 ${payload.id} 为重复提交，已复现首次确认结果`
        : `受保护补丁已确认为修订 ${body.revision}（实际落点 ${body.landing}）`,
      'ok',
    );
    state.selection = null;
    store.set('selection', null);
    $('protected-text').value = '';
    await refreshApproved();
  } else {
    setMsg(
      msg,
      `已拒绝（${status}）：${body && body.message ? body.message : '未知错误'}；规程文本与修订未变`,
      'err',
    );
    await refreshApproved();
  }
}

async function createDraft() {
  const msg = $('create-msg');
  const { status, body } = await api('/api/documents', {
    method: 'POST',
    body: JSON.stringify({ id: state.docId, text: $('initial-text').value }),
  });
  if (status === 201) {
    setMsg(msg, `草案 ${body.id} 已建立（修订 ${body.revision}）`, 'ok');
    await refreshApproved();
  } else {
    setMsg(msg, body && body.message ? body.message : '建立失败', 'err');
  }
}

function loadApprovedAsDraft() {
  const msg = $('draft-msg');
  if (!state.approved) {
    setMsg(msg, '服务端尚无批准稿可载入', 'err');
    return;
  }
  $('draft-text').value = state.approved.text;
  state.baseRevision = state.approved.revision;
  store.set('baseRevision', state.baseRevision);
  store.set('draftText', $('draft-text').value);
  $('patch-base').value = String(state.baseRevision);
  renderLocal();
  setMsg(msg, `已载入批准稿（基准修订 ${state.baseRevision}），仍为未批准草案`, 'ok');
}

function saveLocalDraft() {
  store.set('draftText', $('draft-text').value);
  setMsg($('draft-msg'), '草案已保存到本机（未批准）', 'ok');
}

async function submitPatch() {
  const msg = $('submit-msg');
  const op = $('patch-op').value;
  const payload = {
    id: $('patch-id').value.trim(),
    baseRevision: Number($('patch-base').value),
    op,
    pos: Number($('patch-pos').value),
  };
  if (op === 'insert') payload.text = $('patch-text').value;
  else payload.len = Number($('patch-len').value);

  const { status, body } = await api(
    `/api/documents/${encodeURIComponent(state.docId)}/patches`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  if (status === 200) {
    renderConfirmed(body);
    setMsg(
      msg,
      body.duplicate
        ? `补丁 ${payload.id} 为重复提交，已复现首次确认结果`
        : `补丁已确认为修订 ${body.revision}`,
      'ok',
    );
    await refreshApproved();
  } else {
    setMsg(
      msg,
      `已拒绝（${status}）：${body && body.message ? body.message : '未知错误'}；规程文本与修订未变`,
      'err',
    );
  }
}

function bindEvents() {
  $('btn-refresh').addEventListener('click', refreshApproved);
  $('btn-create').addEventListener('click', createDraft);
  $('btn-load-approved').addEventListener('click', loadApprovedAsDraft);
  $('btn-save-local').addEventListener('click', saveLocalDraft);
  $('btn-submit').addEventListener('click', submitPatch);
  $('btn-pick-insert').addEventListener('click', pickInsertPoint);
  $('btn-pick-delete').addEventListener('click', pickDeleteFragment);
  $('btn-protected-submit').addEventListener('click', submitProtected);
  $('btn-new-id').addEventListener('click', () => {
    $('patch-id').value = newPatchId();
  });
  $('btn-new-pid').addEventListener('click', () => {
    if (state.selection) {
      state.selection.patchId = newPatchId();
      store.set('selection', state.selection);
      renderSelection();
    }
  });
  $('doc-id').addEventListener('change', () => {
    state.docId = $('doc-id').value.trim() || 'main';
    $('doc-id').value = state.docId;
    store.set('docId', state.docId);
    // 锚点标识按文档签发，切换草案后原选择不再适用
    state.selection = null;
    store.set('selection', null);
    renderSelection();
    refreshApproved();
  });
  $('patch-op').addEventListener('change', () => {
    const isInsert = $('patch-op').value === 'insert';
    $('wrap-patch-text').hidden = !isInsert;
    $('wrap-patch-len').hidden = isInsert;
  });
  $('draft-text').addEventListener('input', () => {
    store.set('draftText', $('draft-text').value);
  });
}

function init() {
  $('doc-id').value = state.docId;
  $('draft-text').value = store.get('draftText', '');
  $('patch-id').value = newPatchId();
  $('patch-base').value =
    state.baseRevision === null ? '0' : String(state.baseRevision);
  bindEvents();
  renderLocal();
  renderSelection();
  refreshApproved();
  refreshHealth();
  setInterval(refreshHealth, 10000);
}

init();
