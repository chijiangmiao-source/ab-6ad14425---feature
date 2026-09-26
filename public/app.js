/* 低温联锁规程补传确认终端。
 * 本机仅保存：草案标识、本终端基准修订、离线草案文本、最近确认结果。
 * 已批准内容一律以服务端真实接口为准，本地旧草案绝不当作批准稿展示。 */
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
  lastConfirmed: store.get('lastConfirmed', null),
  approved: null,
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
  if (state.lastConfirmed) {
    renderConfirmed(state.lastConfirmed);
  }
}

function renderConfirmed(result) {
  $('confirmed-rev').textContent = String(result.revision);
  $('confirmed-landing').textContent =
    result.landing === null ? '（空操作）' : String(result.landing);
  $('confirmed-ops').textContent = JSON.stringify(result.normalizedOps);
  $('confirmed-text').textContent = result.text;
  $('confirmed-dup').hidden = !result.duplicate;
}

async function refreshApproved() {
  const { status, body } = await api(
    `/api/documents/${encodeURIComponent(state.docId)}`,
  );
  state.approved = status === 200 ? body : null;
  renderApproved();
}

async function refreshHealth() {
  const el = $('health');
  try {
    const { status } = await api('/api/health');
    if (status === 200) {
      el.textContent = '服务正常';
      el.className = 'pill pill-ok';
      return;
    }
    throw new Error();
  } catch {
    el.textContent = '服务不可达';
    el.className = 'pill pill-bad';
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
    state.lastConfirmed = body;
    store.set('lastConfirmed', body);
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
  $('btn-new-id').addEventListener('click', () => {
    $('patch-id').value = newPatchId();
  });
  $('doc-id').addEventListener('change', () => {
    state.docId = $('doc-id').value.trim() || 'main';
    $('doc-id').value = state.docId;
    store.set('docId', state.docId);
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
  refreshApproved();
  refreshHealth();
  setInterval(refreshHealth, 10000);
}

init();
