import test from 'node:test';
import assert from 'node:assert/strict';
import { transformOps, applyOps } from '../src/transform.js';

const ins = (id, pos, text) => ({ type: 'insert', pos, text, patchId: id });
const del = (id, pos, len) => ({ type: 'delete', pos, len, patchId: id });

// 两种提交顺序均应收敛到同一文本。
function converge(text, opA, opB) {
  const aThenB = applyOps(applyOps(text, [opA]), transformOps([opB], [opA]));
  const bThenA = applyOps(applyOps(text, [opB]), transformOps([opA], [opB]));
  return { aThenB, bThenA };
}

test('同位置并发插入：按补丁标识字典序定序，两种顺序收敛', () => {
  const a = ins('patch-a', 3, 'XYZ');
  const b = ins('patch-b', 3, '123');
  const { aThenB, bThenA } = converge('abcdef', a, b);
  assert.equal(aThenB, 'abcXYZ123def');
  assert.equal(bThenA, 'abcXYZ123def');
});

test('三条同位置插入任意顺序收敛', () => {
  const ops = [ins('p1', 0, 'A'), ins('p2', 0, 'B'), ins('p3', 0, 'C')];
  const results = new Set();
  for (const perm of [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]) {
    let text = '';
    const confirmed = [];
    for (const i of perm) {
      const transformed = transformOps([ops[i]], confirmed);
      text = applyOps(text, transformed);
      confirmed.push(...transformed);
    }
    results.add(text);
  }
  assert.deepEqual([...results], ['ABC']);
});

test('插入落在删除区间内：插入保留并收敛到区间起点', () => {
  const d = del('d1', 2, 5); // 删除 [2,7)
  const i = ins('i1', 4, 'AB'); // 落在删除区间内部
  const { aThenB, bThenA } = converge('0123456789', d, i);
  assert.equal(aThenB, '01AB789');
  assert.equal(bThenA, '01AB789');
});

test('插入点与删除起点重合：插入保留在删除文本之前', () => {
  const d = del('d1', 2, 2);
  const i = ins('i1', 2, 'X');
  const { aThenB, bThenA } = converge('abcd', d, i);
  assert.equal(aThenB, 'abX');
  assert.equal(bThenA, 'abX');
});

test('插入跨越删除：删除拆为两段，插入文本保留', () => {
  const i = ins('i1', 3, 'X');
  const d = del('d1', 1, 4); // 删除 [1,5)，插入点 3 在内部
  const { aThenB, bThenA } = converge('abcdefg', i, d);
  assert.equal(aThenB, 'aXfg');
  assert.equal(bThenA, 'aXfg');
});

test('重叠删除：仅删除未被对方覆盖的部分，两种顺序收敛', () => {
  const a = del('a1', 1, 3); // [1,4)
  const b = del('b1', 3, 3); // [3,6)
  const { aThenB, bThenA } = converge('abcdefg', a, b);
  assert.equal(aThenB, 'ag');
  assert.equal(bThenA, 'ag');
});

test('完全重叠删除：后到补丁成为空操作', () => {
  const a = del('a1', 1, 3);
  const b = del('b1', 1, 3);
  const { aThenB, bThenA } = converge('abcdefg', a, b);
  assert.equal(aThenB, 'aefg');
  assert.equal(bThenA, 'aefg');
});

test('包含删除：被包含的迟到删除成为空操作', () => {
  const a = del('a1', 0, 6);
  const b = del('b1', 2, 2);
  const { aThenB, bThenA } = converge('abcdefg', a, b);
  assert.equal(aThenB, 'g');
  assert.equal(bThenA, 'g');
});

test('不同位置插入：按位置平移', () => {
  const a = ins('a1', 1, 'XX');
  const b = ins('b1', 4, 'YY');
  const { aThenB, bThenA } = converge('abcdef', a, b);
  assert.equal(aThenB, 'aXXbcdYYef');
  assert.equal(bThenA, 'aXXbcdYYef');
});

test('插入与删除交错：连续转换多条已确认补丁', () => {
  // 基准文本 abcdef；已确认：ins(0,'>>')、del(坐标 4,2)（删去 'cd'）
  const confirmed1 = [ins('h1', 0, '>>')];
  const confirmed2 = [del('h2', 4, 2)];
  // 迟到补丁基于修订 0：pos 3 插入 'X'，落点在删除区间内，收敛到区间起点
  const ops = transformOps(transformOps([ins('late', 3, 'X')], confirmed1), confirmed2);
  const text = applyOps(applyOps(applyOps('abcdef', confirmed1), confirmed2), ops);
  assert.equal(text, '>>abXef');
});
