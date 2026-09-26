// 操作变换（OT）核心：迟到补丁依次转换越过基准修订之后的已确认补丁。
//
// 操作形如：
//   { type: 'insert', pos, text, patchId }
//   { type: 'delete', pos, len,  patchId }
// patchId 用于同位置插入的确定性定序：按补丁标识字典序，标识小者在前。

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// 将单个操作 op 转换越过“已应用”的操作 other，返回 0..2 个结果操作。
export function transformOp(op, other) {
  return op.type === 'insert' ? [transformInsert(op, other)] : transformDelete(op, other);
}

function transformInsert(ins, other) {
  if (other.type === 'insert') {
    // 同位置插入：标识字典序小者留在原位（靠前），大者右移。
    const before =
      other.pos < ins.pos ||
      (other.pos === ins.pos && other.patchId < ins.patchId);
    return before ? { ...ins, pos: ins.pos + other.text.length } : { ...ins };
  }
  // other 为删除区间 [pos, pos+len)
  const dStart = other.pos;
  const dEnd = other.pos + other.len;
  if (ins.pos <= dStart) return { ...ins };
  if (ins.pos >= dEnd) return { ...ins, pos: ins.pos - other.len };
  // 插入落在删除区间内：保留插入文本，落点收敛到区间起点。
  return { ...ins, pos: dStart };
}

function transformDelete(del, other) {
  const start = del.pos;
  const end = del.pos + del.len;
  if (other.type === 'insert') {
    const ip = other.pos;
    const il = other.text.length;
    if (ip >= end) return [{ ...del }];
    if (ip <= start) return [{ ...del, pos: start + il }];
    // 插入点落在删除区间内部：删除拆为两段，插入文本得以保留。
    const left = { ...del, pos: start, len: ip - start };
    const right = { ...del, pos: ip + il, len: end - ip };
    return [left, right].filter((o) => o.len > 0);
  }
  // 删除越过删除：仅保留未被 other 覆盖的区间段（可能为 0/1/2 段）。
  const os = other.pos;
  const oe = other.pos + other.len;
  const segments = [];
  if (start < Math.min(os, end)) segments.push([start, Math.min(os, end)]);
  if (Math.max(start, oe) < end) segments.push([Math.max(start, oe), end]);
  return segments.map(([a, b]) => ({
    type: 'delete',
    pos: a - clamp(a - os, 0, other.len),
    len: b - a,
    patchId: del.patchId,
  }));
}

// 将操作序列依次转换越过另一已确认补丁的规范化操作序列。
export function transformOps(ops, otherOps) {
  let current = ops;
  for (const other of otherOps) {
    current = current.flatMap((op) => transformOp(op, other));
  }
  return current;
}

// 将规范化操作序列应用到文本上（按位置降序，保证坐标有效）。
export function applyOps(text, ops) {
  const ordered = [...ops].sort((a, b) => b.pos - a.pos);
  let out = text;
  for (const op of ordered) {
    if (op.type === 'insert') {
      out = out.slice(0, op.pos) + op.text + out.slice(op.pos);
    } else {
      out = out.slice(0, op.pos) + out.slice(op.pos + op.len);
    }
  }
  return out;
}
