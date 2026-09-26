import { transformOps, applyOps } from './transform.js';

export class PatchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_PATCH_TEXT = 10000;

function normalizeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new PatchError(400, 'bad-patch-id', '补丁标识必须是 1..128 字符的字符串');
  }
  return id;
}

function normalizeAnchor(value, name, { nullable }) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new PatchError(
      400,
      'bad-anchor',
      `锚点 ${name} 必须是${nullable ? '字符标识字符串或 null（表示文首/文末）' : '字符标识字符串'}`,
    );
  }
  return value;
}

// 规范化并校验补丁载荷的结构（不依赖文档状态）。
// 旧式无锚补丁：{ id, baseRevision, op, pos, text? | len? }
// 受保护补丁：  { id, protected: true, op, leftId, rightId, text, baseRevision? }
//   - 插入：leftId/rightId 为插入点两侧相邻字符的标识（文首/文末用 null），text 为插入内容；
//   - 删除：leftId/rightId 为目标片段首、尾字符的标识，text 为选择时所见的片段内容。
export function normalizePayload(req) {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new PatchError(400, 'bad-request', '补丁载荷必须是 JSON 对象');
  }
  return req.protected === true ? normalizeProtectedPayload(req) : normalizeLegacyPayload(req);
}

function normalizeLegacyPayload(req) {
  const { id, baseRevision, op, pos } = req;
  normalizeId(id);
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

function normalizeProtectedPayload(req) {
  const { id, op } = req;
  normalizeId(id);
  if (req.baseRevision !== undefined && (!Number.isInteger(req.baseRevision) || req.baseRevision < 0)) {
    throw new PatchError(400, 'bad-revision', 'baseRevision 必须是非负整数（选择所见修订）');
  }
  if (op !== 'insert' && op !== 'delete') {
    throw new PatchError(400, 'bad-op', "op 必须是 'insert' 或 'delete'");
  }
  const { text } = req;
  if (typeof text !== 'string' || text.length === 0) {
    throw new PatchError(
      400,
      op === 'insert' ? 'bad-insert' : 'bad-delete',
      op === 'insert' ? '受保护插入必须携带非空 text' : '受保护删除必须携带选择所见片段内容 text',
    );
  }
  if (text.length > MAX_PATCH_TEXT) {
    throw new PatchError(400, op === 'insert' ? 'bad-insert' : 'bad-delete', `文本长度超过 ${MAX_PATCH_TEXT}`);
  }
  // 插入点允许 null 锚点（文首/文末）；删除目标非空，首、尾字符标识都必须给出。
  const nullable = op === 'insert';
  const leftId = normalizeAnchor(req.leftId, 'leftId', { nullable });
  const rightId = normalizeAnchor(req.rightId, 'rightId', { nullable });
  const out = { id, protected: true, op, leftId, rightId, text };
  if (req.baseRevision !== undefined) out.baseRevision = req.baseRevision;
  return out;
}

// 规范化后的载荷键序固定，可直接序列化比较（幂等重放判定）。
function payloadEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

export class Document {
  constructor(id, initialText) {
    this.id = id;
    this.initialText = initialText;
    this.text = initialText;
    this.revision = 0;
    this.history = []; // history[i] 为产生修订 i+1 的确认记录
    this.patches = new Map(); // patchId -> { payload, result }
    // 稳定字符标识序列：每个字符持有签发后不再改变的标识，随确认补丁演进；
    // 任何时刻 seq 拼接文本都必须等于当前全文（由 applyOpsToSeq 与 applyOps 同坐标保证）。
    this.seq = initialText.split('').map((ch, i) => ({ id: `c${i}`, ch }));
    this.nextCharId = this.seq.length;
    this.retired = new Set(); // 已被删除的字符标识：用于区分“目标被删改”与“标识伪造”
  }

  static fromJSON(data) {
    const doc = new Document(data.id, data.initialText);
    doc.text = data.text;
    doc.revision = data.revision;
    doc.history = data.history;
    doc.patches = new Map(Object.entries(data.patches));
    if (Array.isArray(data.seq)) {
      doc.seq = data.seq;
      doc.nextCharId = data.nextCharId;
      doc.retired = new Set(data.retired || []);
    } else {
      // 旧版状态文件（无标识序列）：按当前全文重建，历史无锚补丁与幂等记录不受影响。
      doc.seq = data.text.split('').map((ch, i) => ({ id: `c${i}`, ch }));
      doc.nextCharId = doc.seq.length;
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
      seq: this.seq,
      nextCharId: this.nextCharId,
      retired: [...this.retired],
    };
  }

  textAt(revision) {
    if (revision === 0) return this.initialText;
    return this.history[revision - 1].text;
  }

  // 最近一条新确认的结论（幂等重放不刷新），供终端刷新/重启后从接口恢复。
  lastConfirmed() {
    if (this.history.length === 0) return null;
    const h = this.history[this.history.length - 1];
    return {
      revision: h.revision,
      text: h.text,
      landing: h.landing,
      normalizedOps: h.normalizedOps,
      duplicate: false,
    };
  }

  seqText() {
    return this.seq.map((s) => s.ch).join('');
  }

  // 与 applyOps 相同的坐标语义（按位置降序），让规范化插入、删除同步更新标识序列。
  applyOpsToSeq(ops) {
    const ordered = [...ops].sort((a, b) => b.pos - a.pos);
    for (const op of ordered) {
      if (op.type === 'insert') {
        const fresh = op.text.split('').map((ch) => {
          const id = `c${this.nextCharId}`;
          this.nextCharId += 1;
          return { id, ch };
        });
        this.seq.splice(op.pos, 0, ...fresh);
      } else {
        const removed = this.seq.splice(op.pos, op.len);
        for (const r of removed) this.retired.add(r.id);
      }
    }
  }

  // 确认一条补丁：幂等重放、校验、定位/转换、应用，返回确认结果。
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

    const ops = payload.protected ? this.resolveProtected(payload) : this.resolveLegacy(payload);

    const newText = applyOps(this.text, ops);
    const landing = ops.length === 0 ? null : Math.min(...ops.map((o) => o.pos));
    const result = {
      revision: this.revision + 1,
      text: newText,
      landing,
      normalizedOps: ops,
      duplicate: false,
    };

    // 原子确认：历史、幂等记录、标识序列、全文与修订一次性推进。
    this.history.push({
      revision: result.revision,
      patchId: payload.id,
      normalizedOps: ops,
      text: newText,
      landing,
    });
    this.patches.set(payload.id, { payload, result });
    this.applyOpsToSeq(ops);
    this.text = newText;
    this.revision += 1;
    return result;
  }

  // 旧式无锚补丁：校验基准修订，迟到补丁依次转换越过其后的已确认补丁。
  resolveLegacy(payload) {
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

    let ops = [payloadToOp(payload)];
    for (let r = payload.baseRevision; r < this.revision; r += 1) {
      ops = transformOps(ops, this.history[r].normalizedOps);
    }
    return ops;
  }

  // 受保护补丁：仅当锚点仍围住原选位置、删除目标仍连续且内容未变时，
  // 才按当前标识序列定位；否则明确拒绝（文本与修订不变）。
  resolveProtected(payload) {
    if (payload.op === 'insert') {
      const leftIdx = payload.leftId === null ? -1 : this.anchorIndex(payload.leftId);
      const rightIdx = payload.rightId === null ? this.seq.length : this.anchorIndex(payload.rightId);
      if (rightIdx !== leftIdx + 1) {
        throw new PatchError(409, 'anchor-separated', '两端锚点已被插入隔开或相对位置改变，受保护插入被拒绝');
      }
      return [{ type: 'insert', pos: leftIdx + 1, text: payload.text, patchId: payload.id }];
    }
    const start = this.anchorIndex(payload.leftId);
    const end = this.anchorIndex(payload.rightId);
    if (end < start) {
      throw new PatchError(409, 'anchor-mismatch', '两端锚点顺序颠倒，无法围住原选删除目标');
    }
    const current = this.seq.slice(start, end + 1).map((s) => s.ch).join('');
    if (current !== payload.text) {
      throw new PatchError(409, 'target-changed', '删除目标已不连续或内容已变化，受保护删除被拒绝');
    }
    return [{ type: 'delete', pos: start, len: end - start + 1, patchId: payload.id }];
  }

  // 在当前标识序列中定位锚点；已删除与从未签发的标识分别拒绝。
  anchorIndex(id) {
    const idx = this.seq.findIndex((s) => s.id === id);
    if (idx !== -1) return idx;
    if (this.retired.has(id)) {
      throw new PatchError(409, 'anchor-lost', `锚点字符 ${id} 已被删除（目标被删改）`);
    }
    throw new PatchError(409, 'anchor-forged', `锚点标识 ${id} 从未签发（标识伪造）`);
  }
}
