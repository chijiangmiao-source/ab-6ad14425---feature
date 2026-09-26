import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document, PatchError } from '../src/document.js';
import { Store } from '../src/store.js';

test('确认补丁：修订连续递增，返回全文与落点', () => {
  const doc = new Document('main', 'abcdef');
  const r1 = doc.confirm({ id: 'p1', baseRevision: 0, op: 'insert', pos: 3, text: 'XY' });
  assert.equal(r1.revision, 1);
  assert.equal(r1.text, 'abcXYdef');
  assert.equal(r1.landing, 3);
  const r2 = doc.confirm({ id: 'p2', baseRevision: 1, op: 'delete', pos: 0, len: 2 });
  assert.equal(r2.revision, 2);
  assert.equal(r2.text, 'cXYdef');
  assert.equal(doc.revision, 2);
  assert.equal(doc.text, 'cXYdef');
});

test('迟到补丁：依次转换越过基准后的已确认补丁', () => {
  const doc = new Document('main', 'abcdef');
  doc.confirm({ id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  doc.confirm({ id: 'h2', baseRevision: 1, op: 'delete', pos: 4, len: 2 }); // 删去 'cd'
  const late = doc.confirm({ id: 'late', baseRevision: 0, op: 'insert', pos: 3, text: 'X' });
  assert.equal(late.revision, 3);
  assert.equal(late.text, '>>abXef');
  assert.equal(late.landing, 4);
});

test('同位置并发插入：按标识字典序定序，与提交先后无关', () => {
  const d1 = new Document('a', 'abcdef');
  d1.confirm({ id: 'patch-a', baseRevision: 0, op: 'insert', pos: 3, text: 'XYZ' });
  const r1 = d1.confirm({ id: 'patch-b', baseRevision: 0, op: 'insert', pos: 3, text: '123' });
  assert.equal(r1.text, 'abcXYZ123def');
  assert.equal(r1.landing, 6);

  const d2 = new Document('b', 'abcdef');
  d2.confirm({ id: 'patch-b', baseRevision: 0, op: 'insert', pos: 3, text: '123' });
  const r2 = d2.confirm({ id: 'patch-a', baseRevision: 0, op: 'insert', pos: 3, text: 'XYZ' });
  assert.equal(r2.text, 'abcXYZ123def');
  assert.equal(r2.landing, 3);
});

test('删除区间内插入：插入保留，两种顺序收敛', () => {
  const d1 = new Document('a', '0123456789');
  d1.confirm({ id: 'd1', baseRevision: 0, op: 'delete', pos: 2, len: 5 });
  const r1 = d1.confirm({ id: 'i1', baseRevision: 0, op: 'insert', pos: 4, text: 'AB' });
  assert.equal(r1.text, '01AB789');

  const d2 = new Document('b', '0123456789');
  d2.confirm({ id: 'i1', baseRevision: 0, op: 'insert', pos: 4, text: 'AB' });
  const r2 = d2.confirm({ id: 'd1', baseRevision: 0, op: 'delete', pos: 2, len: 5 });
  assert.equal(r2.text, '01AB789');
});

test('幂等重放：同标识同载荷复现首次结果，不新增修订', () => {
  const doc = new Document('main', 'hello');
  const first = doc.confirm({ id: 'p1', baseRevision: 0, op: 'insert', pos: 0, text: '>' });
  const replay = doc.confirm({ id: 'p1', baseRevision: 0, op: 'insert', pos: 0, text: '>' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.text, first.text);
  assert.equal(replay.landing, first.landing);
  assert.equal(doc.revision, 1);
  assert.equal(doc.text, '>hello');
});

test('标识复用但载荷不同：拒绝且规程不变', () => {
  const doc = new Document('main', 'hello');
  doc.confirm({ id: 'p1', baseRevision: 0, op: 'insert', pos: 0, text: '>' });
  assert.throws(
    () => doc.confirm({ id: 'p1', baseRevision: 0, op: 'insert', pos: 1, text: '>' }),
    (err) => err instanceof PatchError && err.status === 409 && err.code === 'patch-id-conflict',
  );
  assert.equal(doc.revision, 1);
  assert.equal(doc.text, '>hello');
});

test('未来修订：拒绝且规程不变', () => {
  const doc = new Document('main', 'hello');
  assert.throws(
    () => doc.confirm({ id: 'p1', baseRevision: 5, op: 'insert', pos: 0, text: 'x' }),
    (err) => err.status === 409 && err.code === 'future-revision',
  );
  assert.equal(doc.revision, 0);
  assert.equal(doc.text, 'hello');
});

test('越界与长度不符的删除：拒绝且规程不变', () => {
  const doc = new Document('main', 'hello');
  assert.throws(
    () => doc.confirm({ id: 'p1', baseRevision: 0, op: 'delete', pos: 3, len: 10 }),
    (err) => err.status === 422 && err.code === 'out-of-bounds',
  );
  assert.throws(
    () => doc.confirm({ id: 'p2', baseRevision: 0, op: 'delete', pos: 2, len: 0 }),
    (err) => err.status === 422 && err.code === 'bad-length',
  );
  assert.throws(
    () => doc.confirm({ id: 'p3', baseRevision: 0, op: 'delete', pos: -1, len: 2 }),
    (err) => err.status === 422,
  );
  assert.equal(doc.revision, 0);
  assert.equal(doc.text, 'hello');
});

test('持久化：重启后仍可按历史转换旧修订上的合法补丁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-store-'));
  const file = path.join(dir, 'state.json');

  const s1 = new Store(file);
  s1.load();
  s1.createDocument('main', 'abcdef');
  s1.confirm('main', { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  s1.confirm('main', { id: 'h2', baseRevision: 1, op: 'delete', pos: 4, len: 2 });

  // 模拟服务重启：从状态文件恢复
  const s2 = new Store(file);
  s2.load();
  const doc = s2.get('main');
  assert.equal(doc.revision, 2);
  assert.equal(doc.text, '>>abef');

  // 旧修订（基准 0）上的迟到补丁仍按历史转换
  const late = s2.confirm('main', { id: 'late', baseRevision: 0, op: 'insert', pos: 3, text: 'X' });
  assert.equal(late.revision, 3);
  assert.equal(late.text, '>>abXef');

  // 重启前的补丁重传：幂等复现
  const replay = s2.confirm('main', { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 1);
  assert.equal(s2.get('main').revision, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});
