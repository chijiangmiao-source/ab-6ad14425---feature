// 稳定字符标识序列：为批准文本的每个字符位置维护一个服务端签发的稳定标识。
//
// 标识形如 cN（N 为签发序号，单调递增、永不复用），随确认补丁演进：
//   插入（含旧式补丁与迟到补丁的规范化插入）→ 为每个新字符签发新标识；
//   删除（同上）→ 对应标识标记为不再存活，但保留记录，
//   以便受保护校验区分“锚点/目标被删”与“标识伪造”。
//
// 不变量：任一时刻，存活标识按序拼接的文本必须等于当前全文。
// 序列由初始文本与确认历史确定性重放而来，重启后重建结果与崩溃前一致。

import { orderedOps } from './transform.js';

export function initialAtoms(text) {
  return text.split('').map((ch, i) => ({ id: `c${i}`, ch, rev: 0, alive: true }));
}

// 以与 applyOps 相同的次序（位置降序）把规范化操作序列应用到标识序列上，
// 为插入字符签发新标识；atoms 原地修改，返回新的签发序号。
// 注意：操作坐标是“存活文本”坐标，而 atoms 数组中已删除元素仍占位，
// 须先把存活坐标换算成数组下标。
export function applyOpsToAtoms(atoms, ops, rev, nextId) {
  let next = nextId;
  const arrayIndexOfAlivePos = (pos) => {
    let idx = 0;
    for (let i = 0; i < atoms.length; i += 1) {
      if (!atoms[i].alive) continue;
      if (idx === pos) return i;
      idx += 1;
    }
    return atoms.length; // pos === 存活数 → 末尾
  };
  for (const op of orderedOps(ops)) {
    if (op.type === 'insert') {
      const at = arrayIndexOfAlivePos(op.pos);
      const fresh = op.text.split('').map((ch) => {
        const atom = { id: `c${next}`, ch, rev, alive: true };
        next += 1;
        return atom;
      });
      atoms.splice(at, 0, ...fresh);
    } else {
      let marked = 0;
      for (let i = arrayIndexOfAlivePos(op.pos); i < atoms.length && marked < op.len; i += 1) {
        if (atoms[i].alive) {
          atoms[i].alive = false;
          marked += 1;
        }
      }
    }
  }
  return next;
}

// 由初始文本与确认历史重放，重建标识序列（用于状态恢复与历史修订回看）。
export function rebuildAtoms(initialText, history) {
  const atoms = initialAtoms(initialText);
  let nextId = initialText.length;
  for (const h of history) nextId = applyOpsToAtoms(atoms, h.normalizedOps, h.revision, nextId);
  return { atoms, nextId };
}

// 存活标识按序拼接的文本（任何时刻必须等于当前全文）。
export function atomsText(atoms) {
  let out = '';
  for (const a of atoms) if (a.alive) out += a.ch;
  return out;
}

export function aliveCount(atoms) {
  let n = 0;
  for (const a of atoms) if (a.alive) n += 1;
  return n;
}

// 标识在存活序列中的位置；未签发或已删除返回 -1。
export function aliveIndexOfId(atoms, id) {
  let idx = 0;
  for (const a of atoms) {
    if (!a.alive) continue;
    if (a.id === id) return idx;
    idx += 1;
  }
  return -1;
}

// 存活序列 pos 处的标识；pos 越界（含 pos === 存活数）返回 null。
export function aliveIdAtPos(atoms, pos) {
  let idx = 0;
  for (const a of atoms) {
    if (!a.alive) continue;
    if (idx === pos) return a.id;
    idx += 1;
  }
  return null;
}

// 存活序列 pos 处的字符；越界返回 null。
export function aliveCharAt(atoms, pos) {
  let idx = 0;
  for (const a of atoms) {
    if (!a.alive) continue;
    if (idx === pos) return a.ch;
    idx += 1;
  }
  return null;
}
