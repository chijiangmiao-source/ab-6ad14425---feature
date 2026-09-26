import { transformOps, applyOps } from './transform.js';
import {
  initialAtoms,
  applyOpsToAtoms,
  rebuildAtoms,
  atomsText,
  aliveCount,
  aliveIndexOfId,
  aliveIdAtPos,
  aliveCharAt,
} from './atoms.js';

export class PatchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_PATCH_TEXT = 10000;
// 字符标识形如 cN：N 为签发序号，单调递增、永不复用（删除仅标记不存活）。
const CHAR_ID_RE = /^c(\d+)$/;
// 受保护确认中属于“状态结论”的拒绝码：记入选择记录并随状态原子落盘。
const RECORDED_REJECTIONS = new Set(['anchors-separated', 'anchor-deleted', 'target-changed']);

// 规范化并校验补丁载荷的结构（不依赖文档状态）。
export function normalizePayload(req) {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new PatchError(400, 'bad-request', '补丁载荷必须是 JSON 对象');
  }
  const { id, baseRevision, op, pos } = req;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new PatchError(400, 'bad-patch-id', '补丁标识必须是 1..128 字符的字符串');
  }
  if (!Number.isInteger(baseRevision)) {
    throw new PatchError(400, 'bad-revision', 'baseRevision 必须是整数');
  }
  if (!Number.isInteger(pos)) {
    throw new PatchError(400, 'bad-position', 'pos 必须是整数');
  }
  if (op === 'insert') {
    const { text } = req;
    if (typeof text !== 'string' || text.length === 0) {
      throw new PatchError(400, 'bad-insert', '插入补丁必须携带非空 text');
    }
    if (text.length > MAX_PATCH_TEXT) {
      throw new PatchError(400, 'bad-insert', `插入文本长度超过 ${MAX_PATCH_TEXT}`);
    }
    return { id, baseRevision, op, pos, text };
  }
  if (op === 'delete') {
    const { len } = req;
    if (!Number.isInteger(len)) {
      throw new PatchError(400, 'bad-delete', '删除补丁必须携带整数 len');
    }
    return { id, baseRevision, op, pos, len };
  }
  throw new PatchError(400, 'bad-op', "op 必须是 'insert' 或 'delete'");
}

function payloadEquals(a, b) {
  if (a.id !== b.id || a.baseRevision !== b.baseRevision || a.op !== b.op || a.pos !== b.pos) {
    return false;
  }
  return a.op === 'insert' ? a.text === b.text : a.len === b.len;
}

function payloadToOp(payload) {
  return payload.op === 'insert'
    ? { type: 'insert', pos: payload.pos, text: payload.text, patchId: payload.id }
    : { type: 'delete', pos: payload.pos, len: payload.len, patchId: payload.id };
}

// 针对基准修订上的文本校验落点与长度。
function validateAgainstBase(payload, baseText) {
  if (payload.op === 'insert') {
    if (payload.pos < 0 || payload.pos > baseText.length) {
      throw new PatchError(
        422,
        'out-of-bounds',
        `插入位置 ${payload.pos} 越界（基准修订文本长度 ${baseText.length}）`,
      );
    }
    return;
  }
  if (payload.len < 1) {
    throw new PatchError(422, 'bad-length', '删除长度必须为正整数');
  }
  if (payload.pos < 0 || payload.pos + payload.len > baseText.length) {
    throw new PatchError(
      422,
      'out-of-bounds',
      `删除区间 [${payload.pos}, ${payload.pos + payload.len}) 越界或长度不符（基准修订文本长度 ${baseText.length}）`,
    );
  }
}

// 规范化并校验受保护选择（注册）载荷的结构。
export function normalizeProtectionPayload(req) {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new PatchError(400, 'bad-request', '选择载荷必须是 JSON 对象');
  }
  const { id, baseRevision, kind } = req;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new PatchError(400, 'bad-selection-id', '选择标识必须是 1..128 字符的字符串');
  }
  if (!Number.isInteger(baseRevision)) {
    throw new PatchError(400, 'bad-revision', 'baseRevision 必须是整数');
  }
  if (!('leftId' in req) || !('rightId' in req)) {
    throw new PatchError(400, 'bad-anchor', '必须显式携带左右锚点（文首/文末以 null 表示）');
  }
  const { leftId, rightId } = req;
  if ((leftId !== null && typeof leftId !== 'string') || (rightId !== null && typeof rightId !== 'string')) {
    throw new PatchError(400, 'bad-anchor', '锚点必须是字符串或 null');
  }
  if (kind === 'insert') {
    const { pos } = req;
    if (!Number.isInteger(pos)) {
      throw new PatchError(400, 'bad-position', 'pos 必须是整数');
    }
    return { id, baseRevision, kind, pos, leftId, rightId };
  }
  if (kind === 'delete') {
    const { start, end, expectedText, targetIds } = req;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new PatchError(400, 'bad-range', 'start/end 必须是整数');
    }
    if (typeof expectedText !== 'string') {
      throw new PatchError(400, 'bad-expect', '删除选择必须携带所见内容 expectedText');
    }
    if (!Array.isArray(targetIds) || targetIds.some((t) => typeof t !== 'string')) {
      throw new PatchError(400, 'bad-targets', '删除选择必须携带字符串数组 targetIds');
    }
    if (start >= 0 && end > start) {
      if (targetIds.length !== end - start) {
        throw new PatchError(400, 'bad-targets', '目标标识数量与片段长度不符');
      }
      if (expectedText.length !== end - start) {
        throw new PatchError(400, 'bad-expect', '所见内容长度与片段长度不符');
      }
    }
    return { id, baseRevision, kind, start, end, expectedText, targetIds: [...targetIds], leftId, rightId };
  }
  throw new PatchError(400, 'bad-kind', "kind 必须是 'insert' 或 'delete'");
}

function protectionPayloadEquals(a, b) {
  if (
    a.id !== b.id || a.baseRevision !== b.baseRevision || a.kind !== b.kind
    || a.leftId !== b.leftId || a.rightId !== b.rightId
  ) {
    return false;
  }
  if (a.kind === 'insert') return a.pos === b.pos;
  return (
    a.start === b.start && a.end === b.end && a.expectedText === b.expectedText
    && a.targetIds.length === b.targetIds.length
    && a.targetIds.every((t, i) => t === b.targetIds[i])
  );
}

// 规范化并校验受保护确认载荷的结构。
export function normalizeProtectionConfirm(req) {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new PatchError(400, 'bad-request', '确认载荷必须是 JSON 对象');
  }
  const { patchId } = req;
  if (typeof patchId !== 'string' || patchId.length === 0 || patchId.length > 128) {
    throw new PatchError(400, 'bad-patch-id', '补丁标识必须是 1..128 字符的字符串');
  }
  const out = { patchId };
  if ('text' in req) {
    if (typeof req.text !== 'string' || req.text.length === 0) {
      throw new PatchError(400, 'bad-insert', '插入补传必须携带非空 text');
    }
    if (req.text.length > MAX_PATCH_TEXT) {
      throw new PatchError(400, 'bad-insert', `插入文本长度超过 ${MAX_PATCH_TEXT}`);
    }
    out.text = req.text;
  }
  for (const k of ['leftId', 'rightId']) {
    if (k in req) {
      if (req[k] !== null && typeof req[k] !== 'string') {
        throw new PatchError(400, 'bad-anchor', '锚点必须是字符串或 null');
      }
      out[k] = req[k];
    }
  }
  if ('targetIds' in req) {
    if (!Array.isArray(req.targetIds) || req.targetIds.some((t) => typeof t !== 'string')) {
      throw new PatchError(400, 'bad-targets', 'targetIds 必须是字符串数组');
    }
    out.targetIds = req.targetIds;
  }
  return out;
}

// 由已确认的选择记录构造确认结果（首次确认与幂等重放共用）。
function protectionResult(record, duplicate) {
  const c = record.conclusion;
  return {
    protectionId: record.id,
    patchId: record.patchId,
    revision: c.revision,
    text: c.text,
    landing: c.landing,
    normalizedOps: c.normalizedOps,
    duplicate,
  };
}

export class Document {
  constructor(id, initialText) {
    this.id = id;
    this.initialText = initialText;
    this.text = initialText;
    this.revision = 0;
    this.history = []; // history[i] 为产生修订 i+1 的确认记录
    this.patches = new Map(); // patchId -> { payload, result }
    this.protections = new Map(); // selectionId -> { payload, record }
    this.atoms = initialAtoms(initialText); // 稳定字符标识序列
    this.nextId = initialText.length; // 下一个签发序号
  }

  static fromJSON(data) {
    const doc = new Document(data.id, data.initialText);
    doc.text = data.text;
    doc.revision = data.revision;
    doc.history = data.history;
    doc.patches = new Map(Object.entries(data.patches));
    doc.protections = new Map(Object.entries(data.protections || {})); // 旧格式无此字段
    // 重放全部已确认补丁，重建稳定字符标识序列（新旧格式一致，确定性结果）。
    const { atoms, nextId } = rebuildAtoms(data.initialText, data.history);
    doc.atoms = atoms;
    doc.nextId = nextId;
    if (atomsText(atoms) !== data.text) {
      throw new Error(`草案 ${data.id} 状态损坏：标识序列拼接文本与全文不一致`);
    }
    return doc;
  }

  toJSON() {
    return {
      id: this.id,
      initialText: this.initialText,
      text: this.text,
      revision: this.revision,
      history: this.history,
      patches: Object.fromEntries(this.patches),
      protections: Object.fromEntries(this.protections),
    };
  }

  textAt(revision) {
    if (revision === 0) return this.initialText;
    return this.history[revision - 1].text;
  }

  // 指定修订上的标识序列：当前修订直接复用，历史修订由初始文本重放重建。
  atomsAt(revision) {
    if (revision === this.revision) return this.atoms;
    return rebuildAtoms(this.initialText, this.history.slice(0, revision)).atoms;
  }

  // 当前存活标识序列（与全文逐字符对齐，供终端选定插入点/片段）。
  aliveCharIds() {
    const ids = [];
    for (const a of this.atoms) if (a.alive) ids.push(a.id);
    return ids;
  }

  // 标识是否为本规程签发过（含已删除）；否则视为伪造。
  isKnownCharId(id) {
    const m = CHAR_ID_RE.exec(id);
    return m !== null && Number(m[1]) < this.nextId;
  }

  // 应用规范化操作序列：同步推进全文、修订、历史与标识序列，并校验不变量。
  commitOps(payload, ops) {
    if (this.patches.has(payload.id)) {
      // 旧式补丁与受保护补传共享同一补丁标识命名空间。
      throw new PatchError(409, 'patch-id-conflict', `补丁标识 ${payload.id} 已存在，不能重复用于不同操作`);
    }
    const newText = applyOps(this.text, ops);
    const landing = ops.length === 0 ? null : Math.min(...ops.map((o) => o.pos));
    const result = {
      revision: this.revision + 1,
      text: newText,
      landing,
      normalizedOps: ops,
      duplicate: false,
    };
    this.history.push({
      revision: result.revision,
      patchId: payload.id,
      normalizedOps: ops,
      text: newText,
      landing,
    });
    this.patches.set(payload.id, { payload, result });
    this.text = newText;
    this.revision += 1;
    this.nextId = applyOpsToAtoms(this.atoms, ops, result.revision, this.nextId);
    if (atomsText(this.atoms) !== this.text) {
      // 不变量：任一时刻标识序列拼接文本必须等于当前全文。
      throw new Error('标识序列拼接文本与全文不一致');
    }
    return result;
  }

  // 确认一条旧式补丁：幂等重放、校验、转换、应用，返回确认结果。
  confirm(request) {
    const payload = normalizePayload(request);

    const existing = this.patches.get(payload.id);
    if (existing) {
      if (payloadEquals(existing.payload, payload)) {
        // 同一标识携相同载荷重传：复现首次确认结果，不新增修订。
        return { ...existing.result, duplicate: true };
      }
      throw new PatchError(409, 'patch-id-conflict', `补丁标识 ${payload.id} 已携不同载荷确认过`);
    }

    if (payload.baseRevision < 0) {
      throw new PatchError(400, 'bad-revision', 'baseRevision 不能为负');
    }
    if (payload.baseRevision > this.revision) {
      throw new PatchError(
        409,
        'future-revision',
        `基准修订 ${payload.baseRevision} 是未来修订（当前修订 ${this.revision}）`,
      );
    }
    validateAgainstBase(payload, this.textAt(payload.baseRevision));

    // 迟到补丁：依次转换越过基准修订之后的每条已确认补丁。
    let ops = [payloadToOp(payload)];
    for (let r = payload.baseRevision; r < this.revision; r += 1) {
      ops = transformOps(ops, this.history[r].normalizedOps);
    }
    return this.commitOps(payload, ops);
  }

  // 注册受保护选择：校验所见修订上的位置、内容与锚点，保存记录（含两端锚点）。
  registerProtection(request) {
    const payload = normalizeProtectionPayload(request);

    const existing = this.protections.get(payload.id);
    if (existing) {
      if (protectionPayloadEquals(existing.payload, payload)) {
        // 同一标识携相同载荷重传：复现已保存记录，不新增记录。
        return { ...existing.record, duplicate: true };
      }
      throw new PatchError(409, 'protection-id-conflict', `选择标识 ${payload.id} 已携不同载荷注册过`);
    }

    if (payload.baseRevision < 0) {
      throw new PatchError(400, 'bad-revision', 'baseRevision 不能为负');
    }
    if (payload.baseRevision > this.revision) {
      throw new PatchError(
        409,
        'future-revision',
        `所见修订 ${payload.baseRevision} 是未来修订（当前修订 ${this.revision}）`,
      );
    }

    const baseAtoms = this.atomsAt(payload.baseRevision);
    const baseText = this.textAt(payload.baseRevision);
    const idAt = (pos) => aliveIdAtPos(baseAtoms, pos);
    // 锚点须为本规程已签发标识（否则系伪造），且与所见修订上的所选位置一致。
    const checkAnchor = (given, expected, side) => {
      if (given !== null && !this.isKnownCharId(given)) {
        throw new PatchError(409, 'anchor-forged', `${side}锚点标识 ${given} 不是本规程签发的字符标识`);
      }
      if (given !== expected) {
        throw new PatchError(
          422,
          'anchor-mismatch',
          `${side}锚点与所见修订 ${payload.baseRevision} 上的所选位置不符`,
        );
      }
    };

    const record = {
      id: payload.id,
      kind: payload.kind,
      baseRevision: payload.baseRevision,
      leftId: payload.leftId,
      rightId: payload.rightId,
      targetIds: [],
      expectedText: null,
      status: 'pending',
      patchId: null,
      conclusion: null,
      createdAtRevision: this.revision,
      updatedAtRevision: this.revision,
    };

    if (payload.kind === 'insert') {
      const { pos } = payload;
      if (pos < 0 || pos > baseText.length) {
        throw new PatchError(
          422,
          'out-of-bounds',
          `插入位置 ${pos} 越界（所见修订文本长度 ${baseText.length}）`,
        );
      }
      checkAnchor(payload.leftId, pos > 0 ? idAt(pos - 1) : null, '左');
      checkAnchor(payload.rightId, pos < baseText.length ? idAt(pos) : null, '右');
      record.pos = pos;
    } else {
      const { start, end } = payload;
      if (start < 0 || start >= end || end > baseText.length) {
        throw new PatchError(
          422,
          'out-of-bounds',
          `删除区间 [${start}, ${end}) 越界或长度不符（所见修订文本长度 ${baseText.length}）`,
        );
      }
      if (payload.expectedText !== baseText.slice(start, end)) {
        throw new PatchError(422, 'content-mismatch', '所见内容与服务端该修订文本不符');
      }
      for (const t of payload.targetIds) {
        if (!this.isKnownCharId(t)) {
          throw new PatchError(409, 'target-forged', `目标标识 ${t} 不是本规程签发的字符标识`);
        }
      }
      const expectedIds = [];
      for (let p = start; p < end; p += 1) expectedIds.push(idAt(p));
      if (!payload.targetIds.every((t, i) => t === expectedIds[i])) {
        throw new PatchError(422, 'target-mismatch', '目标标识序列与所见修订上的所选片段不符');
      }
      checkAnchor(payload.leftId, start > 0 ? idAt(start - 1) : null, '左');
      checkAnchor(payload.rightId, end < baseText.length ? idAt(end) : null, '右');
      record.start = start;
      record.end = end;
      record.targetIds = [...payload.targetIds];
      record.expectedText = payload.expectedText;
    }

    this.protections.set(payload.id, { payload, record });
    return { ...record, duplicate: false };
  }

  getProtection(id) {
    const entry = this.protections.get(id);
    return entry ? entry.record : undefined;
  }

  listProtections() {
    return [...this.protections.values()].map(({ record }) => ({
      id: record.id,
      kind: record.kind,
      baseRevision: record.baseRevision,
      status: record.status,
      createdAtRevision: record.createdAtRevision,
      updatedAtRevision: record.updatedAtRevision,
    }));
  }

  // 确认受保护补传：仅当锚点仍围住原选位置、删除目标仍连续且内容未变时，
  // 才按当前标识序列定位并原子确认；否则明确拒绝，文本与修订不变。
  confirmProtection(selId, request) {
    const entry = this.protections.get(selId);
    if (!entry) return undefined;
    const { record } = entry;
    const req = normalizeProtectionConfirm(request);

    if (record.status === 'accepted') {
      // 幂等重传：复现首次确认结果，不新增修订。
      if (req.patchId !== record.patchId) {
        throw new PatchError(
          409,
          'patch-id-conflict',
          `选择 ${selId} 已携补丁标识 ${record.patchId} 确认过`,
        );
      }
      return protectionResult(record, true);
    }

    // 回传的锚点/目标（可选）须为已签发标识且与注册记录一致：防伪造、防篡改。
    const echoAnchor = (given, expected, side) => {
      if (given === undefined) return;
      if (given !== null && !this.isKnownCharId(given)) {
        throw new PatchError(409, 'anchor-forged', `回传的${side}锚点标识 ${given} 不是本规程签发的字符标识`);
      }
      if (given !== expected) {
        throw new PatchError(409, 'anchor-mismatch', `回传的${side}锚点与注册选择不符`);
      }
    };
    echoAnchor(req.leftId, record.leftId, '左');
    echoAnchor(req.rightId, record.rightId, '右');
    if (req.targetIds !== undefined) {
      for (const t of req.targetIds) {
        if (!this.isKnownCharId(t)) {
          throw new PatchError(409, 'target-forged', `回传的目标标识 ${t} 不是本规程签发的字符标识`);
        }
      }
      const same = req.targetIds.length === record.targetIds.length
        && req.targetIds.every((t, i) => t === record.targetIds[i]);
      if (!same) {
        throw new PatchError(409, 'target-mismatch', '回传的目标标识与注册选择不符');
      }
    }

    if (record.kind === 'insert' && req.text === undefined) {
      throw new PatchError(400, 'bad-insert', '插入补传必须携带非空 text');
    }

    try {
      const ops = this.locateProtection(record, req);
      const payload = record.kind === 'insert'
        ? { id: req.patchId, baseRevision: record.baseRevision, op: 'insert', pos: record.pos, text: req.text }
        : { id: req.patchId, baseRevision: record.baseRevision, op: 'delete', pos: record.start, len: record.targetIds.length };
      const result = this.commitOps(payload, ops);
      record.status = 'accepted';
      record.patchId = req.patchId;
      record.updatedAtRevision = this.revision;
      record.conclusion = {
        status: 'accepted',
        revision: result.revision,
        landing: result.landing,
        text: result.text,
        normalizedOps: result.normalizedOps,
        patchId: req.patchId,
      };
      return protectionResult(record, false);
    } catch (err) {
      // 状态性拒绝：记录结论并随状态落盘；文本与修订保持不变。
      if (err instanceof PatchError && RECORDED_REJECTIONS.has(err.code)) {
        record.status = 'rejected';
        record.updatedAtRevision = this.revision;
        record.conclusion = {
          status: 'rejected',
          code: err.code,
          message: err.message,
          revision: this.revision,
        };
        err.recorded = true;
      }
      throw err;
    }
  }

  // 按当前标识序列定位受保护操作；前提不满足时抛出对应 PatchError。
  locateProtection(record, req) {
    const atoms = this.atoms;
    const total = aliveCount(atoms);
    const anchorIndex = (id, side) => {
      if (id === null) return null;
      const idx = aliveIndexOfId(atoms, id);
      if (idx === -1) {
        throw new PatchError(409, 'anchor-deleted', `${side}锚点 ${id} 已被删除，原选位置不再成立`);
      }
      return idx;
    };
    const idxL = anchorIndex(record.leftId, '左');
    const idxR = anchorIndex(record.rightId, '右');
    const left = idxL === null ? -1 : idxL;
    const right = idxR === null ? total : idxR;

    if (record.kind === 'insert') {
      // 锚点仍相邻（未被插入隔开）时，原选插入点才成立。
      if (right !== left + 1) {
        throw new PatchError(409, 'anchors-separated', '左右锚点之间已被插入内容隔开，原选插入点不再成立');
      }
      return [{ type: 'insert', pos: left + 1, text: req.text, patchId: req.patchId }];
    }

    // 删除：目标标识须全部存活、连续，且拼接内容与所见一致。
    const n = record.targetIds.length;
    const indices = record.targetIds.map((t) => aliveIndexOfId(atoms, t));
    if (indices.some((i) => i === -1)) {
      throw new PatchError(409, 'target-changed', '删除目标已有字符被删除，目标不再完整');
    }
    for (let i = 1; i < n; i += 1) {
      if (indices[i] !== indices[0] + i) {
        throw new PatchError(409, 'target-changed', '删除目标已被插入或删改隔开，不再连续');
      }
    }
    let content = '';
    for (const i of indices) content += aliveCharAt(atoms, i);
    if (content !== record.expectedText) {
      throw new PatchError(409, 'target-changed', '删除目标内容已改变');
    }
    // 两端锚点仍须紧邻围住原选片段。
    if (left !== indices[0] - 1 || right !== indices[n - 1] + 1) {
      throw new PatchError(409, 'anchors-separated', '两端锚点不再围住原选片段');
    }
    return [{ type: 'delete', pos: indices[0], len: n, patchId: req.patchId }];
  }
}
