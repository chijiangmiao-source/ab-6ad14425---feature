import { transformOps, applyOps } from './transform.js';

export class PatchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_PATCH_TEXT = 10000;

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

export class Document {
  constructor(id, initialText) {
    this.id = id;
    this.initialText = initialText;
    this.text = initialText;
    this.revision = 0;
    this.history = []; // history[i] 为产生修订 i+1 的确认记录
    this.patches = new Map(); // patchId -> { payload, result }
  }

  static fromJSON(data) {
    const doc = new Document(data.id, data.initialText);
    doc.text = data.text;
    doc.revision = data.revision;
    doc.history = data.history;
    doc.patches = new Map(Object.entries(data.patches));
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
    };
  }

  textAt(revision) {
    if (revision === 0) return this.initialText;
    return this.history[revision - 1].text;
  }

  // 确认一条补丁：幂等重放、校验、转换、应用，返回确认结果。
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
    return result;
  }
}
