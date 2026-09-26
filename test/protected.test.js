import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document, PatchError } from '../src/document.js';
import { Store } from '../src/store.js';

const seqText = (doc) => doc.seq.map((s) => s.ch).join('');
const seqIds = (doc) => doc.seq.map((s) => s.id);

// 确认一条补丁并断言不变量：标识序列拼接文本恒等于当前全文。
function confirm(doc, payload) {
  const result = doc.confirm(payload);
  assert.equal(seqText(doc), doc.text, `标识序列拼接文本必须等于当前全文（补丁 ${payload.id}）`);
  assert.equal(doc.seq.length, doc.text.length);
  return result;
}

function assertPatchError(fn, status, code) {
  assert.throws(fn, (err) => err instanceof PatchError && err.status === status && err.code === code);
}

test('标识序列随旧式补丁演进：插入、删除与迟到补丁同步更新，字符标识保持稳定', () => {
  const doc = new Document('main', 'abcdef');
  const ids0 = seqIds(doc);

  confirm(doc, { id: 'p1', baseRevision: 0, op: 'insert', pos: 3, text: 'XY' }); // abcXYdef
  confirm(doc, { id: 'p2', baseRevision: 1, op: 'delete', pos: 0, len: 2 }); // cXYdef
  // 迟到补丁（基准 0）依次转换越过 p1、p2
  const late = confirm(doc, { id: 'p3', baseRevision: 0, op: 'insert', pos: 6, text: '!' });
  assert.equal(late.text, 'cXYdef!');

  // 存留字符的标识保持签发时的值
  assert.equal(doc.seq[0].id, ids0[2]); // 'c'
  assert.equal(doc.seq[3].id, ids0[3]); // 'd'
  // 被删除字符的标识进入已退役集合
  assert.ok(doc.retired.has(ids0[0]));
  assert.ok(doc.retired.has(ids0[1]));
  // 新签发标识不与历史冲突
  assert.ok(!ids0.includes(doc.seq[1].id));
});

test('受保护插入：并发改动落在锚点之外时按当前标识序列定位并接受', () => {
  const doc = new Document('main', 'ABCDEFGHIJ');
  const leftId = doc.seq[3].id; // D
  const rightId = doc.seq[4].id; // E
  confirm(doc, { id: 'leg', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  const r = confirm(doc, {
    id: 'p1', protected: true, op: 'insert', leftId, rightId, text: '$$', baseRevision: 0,
  });
  assert.equal(r.revision, 2);
  assert.equal(r.text, '>>ABCD$$EFGHIJ');
  assert.equal(r.landing, 6);
  assert.deepEqual(r.normalizedOps, [{ type: 'insert', pos: 6, text: '$$', patchId: 'p1' }]);
});

test('受保护插入：文首与文末的 null 锚点', () => {
  const doc = new Document('main', 'ab');
  const r1 = confirm(doc, { id: 'p1', protected: true, op: 'insert', leftId: null, rightId: doc.seq[0].id, text: '>' });
  assert.equal(r1.text, '>ab');
  const r2 = confirm(doc, { id: 'p2', protected: true, op: 'insert', leftId: doc.seq[2].id, rightId: null, text: '<' });
  assert.equal(r2.text, '>ab<');
  // 双 null 锚点仅在空文档上成立
  const empty = new Document('e', '');
  confirm(empty, { id: 'p1', protected: true, op: 'insert', leftId: null, rightId: null, text: 'x' });
  assert.equal(empty.text, 'x');
  assertPatchError(
    () => doc.confirm({ id: 'p3', protected: true, op: 'insert', leftId: null, rightId: null, text: 'y' }),
    409, 'anchor-separated',
  );
});

test('受保护插入：锚点被插入隔开时明确拒绝，文本与修订不变', () => {
  const doc = new Document('main', 'ABCDEFGHIJ');
  const leftId = doc.seq[3].id;
  const rightId = doc.seq[4].id;
  confirm(doc, { id: 'leg', baseRevision: 0, op: 'insert', pos: 4, text: '#' }); // 落在两锚点之间
  const before = doc.text;
  assertPatchError(
    () => doc.confirm({ id: 'p1', protected: true, op: 'insert', leftId, rightId, text: '$$' }),
    409, 'anchor-separated',
  );
  assert.equal(doc.text, before);
  assert.equal(doc.revision, 1);
});

test('受保护删除：目标连续且内容未变时接受', () => {
  const doc = new Document('main', '0123456789');
  confirm(doc, { id: 'leg', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  const leftId = doc.seq[5].id; // '3'
  const rightId = doc.seq[7].id; // '5'
  const r = confirm(doc, { id: 'p1', protected: true, op: 'delete', leftId, rightId, text: '345' });
  assert.equal(r.text, '>>0126789');
  assert.equal(r.landing, 5);
  assert.deepEqual(r.normalizedOps, [{ type: 'delete', pos: 5, len: 3, patchId: 'p1' }]);
  // 被删字符标识退役
  assert.ok(doc.retired.has(leftId));
});

test('受保护删除：目标被删改（内容变化 / 锚点丢失）时明确拒绝', () => {
  const doc = new Document('main', '0123456789');
  const leftId = doc.seq[3].id;
  const rightId = doc.seq[5].id;
  // 内容被插入改变
  confirm(doc, { id: 'leg1', baseRevision: 0, op: 'insert', pos: 4, text: 'X' });
  assertPatchError(
    () => doc.confirm({ id: 'p1', protected: true, op: 'delete', leftId, rightId, text: '345' }),
    409, 'target-changed',
  );
  // 锚点字符被删除
  const doc2 = new Document('m2', '0123456789');
  const l2 = doc2.seq[3].id;
  const r2 = doc2.seq[5].id;
  confirm(doc2, { id: 'leg2', baseRevision: 0, op: 'delete', pos: 3, len: 1 });
  assertPatchError(
    () => doc2.confirm({ id: 'p1', protected: true, op: 'delete', leftId: l2, rightId: r2, text: '345' }),
    409, 'anchor-lost',
  );
  assert.equal(doc2.text, '012456789');
  assert.equal(doc2.revision, 1);
});

test('受保护补丁：伪造标识与锚点顺序颠倒时明确拒绝', () => {
  const doc = new Document('main', 'abcdef');
  assertPatchError(
    () => doc.confirm({ id: 'p1', protected: true, op: 'insert', leftId: 'c999', rightId: null, text: 'x' }),
    409, 'anchor-forged',
  );
  assertPatchError(
    () => doc.confirm({ id: 'p2', protected: true, op: 'delete', leftId: doc.seq[4].id, rightId: doc.seq[1].id, text: 'bcd' }),
    409, 'anchor-mismatch',
  );
  assert.equal(doc.text, 'abcdef');
  assert.equal(doc.revision, 0);
});

test('受保护补丁：幂等重传复现首次结果，标识复用不同载荷被拒绝', () => {
  const doc = new Document('main', 'ABCDEFGHIJ');
  const leftId = doc.seq[3].id;
  const rightId = doc.seq[4].id;
  const payload = { id: 'p1', protected: true, op: 'insert', leftId, rightId, text: '$$', baseRevision: 0 };
  const first = confirm(doc, payload);
  // 即使锚点之后被隔开，重传仍复现首次结论（幂等优先）
  confirm(doc, { id: 'leg', baseRevision: 1, op: 'insert', pos: 6, text: '#' });
  const replay = confirm(doc, payload);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.text, first.text);
  assert.equal(doc.revision, 2);
  // 同标识不同载荷
  assertPatchError(
    () => doc.confirm({ ...payload, text: '%%' }),
    409, 'patch-id-conflict',
  );
});

test('受保护补丁载荷校验：缺锚点、缺内容、坏基准修订', () => {
  const doc = new Document('main', 'abcdef');
  assertPatchError(
    () => doc.confirm({ id: 'p1', protected: true, op: 'delete', leftId: null, rightId: doc.seq[1].id, text: 'ab' }),
    400, 'bad-anchor',
  );
  assertPatchError(
    () => doc.confirm({ id: 'p2', protected: true, op: 'insert', leftId: null, rightId: null, text: '' }),
    400, 'bad-insert',
  );
  assertPatchError(
    () => doc.confirm({ id: 'p3', protected: true, op: 'insert', leftId: null, rightId: null, text: 'x', baseRevision: -1 }),
    400, 'bad-revision',
  );
  assert.equal(doc.revision, 0);
});

test('持久化：标识序列、已退役标识与最近结论随状态文件恢复，重启前锚点仍可用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-prot-'));
  const file = path.join(dir, 'state.json');

  const s1 = new Store(file);
  s1.load();
  s1.createDocument('main', '0123456789');
  s1.confirm('main', { id: 'l1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  const doc1 = s1.get('main');
  const delSel = { leftId: doc1.seq[5].id, rightId: doc1.seq[7].id, text: '345' };
  const insSel = { leftId: doc1.seq[10].id, rightId: doc1.seq[11].id };
  s1.confirm('main', { id: 'pd', protected: true, op: 'delete', ...delSel });
  const idsBefore = seqIds(doc1);
  const textBefore = doc1.text;

  // 模拟服务重启：从状态文件恢复
  const s2 = new Store(file);
  s2.load();
  const doc2 = s2.get('main');
  assert.deepEqual(seqIds(doc2), idsBefore);
  assert.equal(seqText(doc2), textBefore);
  assert.equal(doc2.lastConfirmed().revision, 2);
  assert.equal(doc2.lastConfirmed().text, textBefore);

  // 重启前的插入点锚点仍可定位确认
  const r = s2.confirm('main', { id: 'pi', protected: true, op: 'insert', ...insSel, text: '@@' });
  assert.equal(r.revision, 3);
  assert.equal(seqText(doc2), doc2.text);

  // 重启前的受保护删除重传：幂等复现
  const replay = s2.confirm('main', { id: 'pd', protected: true, op: 'delete', ...delSel });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 2);

  // 已删除锚点仍识别为“目标被删改”而非“标识伪造”
  assertPatchError(
    () => s2.confirm('main', { id: 'x1', protected: true, op: 'delete', ...delSel }),
    409, 'anchor-lost',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧版状态文件（无标识序列）加载后：无锚补丁、幂等重传与历史变换保持兼容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-legacy-'));
  const file = path.join(dir, 'state.json');
  const h1Ops = [{ type: 'insert', pos: 0, text: '>>', patchId: 'h1' }];
  const h2Ops = [{ type: 'delete', pos: 4, len: 2, patchId: 'h2' }];
  const legacy = {
    documents: {
      main: {
        id: 'main',
        initialText: 'abcdef',
        text: '>>abef',
        revision: 2,
        history: [
          { revision: 1, patchId: 'h1', normalizedOps: h1Ops, text: '>>abcdef', landing: 0 },
          { revision: 2, patchId: 'h2', normalizedOps: h2Ops, text: '>>abef', landing: 4 },
        ],
        patches: {
          h1: {
            payload: { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' },
            result: { revision: 1, text: '>>abcdef', landing: 0, normalizedOps: h1Ops, duplicate: false },
          },
        },
      },
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(legacy));

  const store = new Store(file);
  store.load();
  const doc = store.get('main');
  // 标识序列按当前全文重建，不变量成立
  assert.equal(seqText(doc), doc.text);
  assert.equal(doc.lastConfirmed().revision, 2);

  // 旧式迟到补丁仍按历史变换
  const late = store.confirm('main', { id: 'late', baseRevision: 0, op: 'insert', pos: 3, text: 'X' });
  assert.equal(late.text, '>>abXef');
  assert.equal(seqText(doc), doc.text);

  // 旧式补丁重传仍幂等复现
  const replay = store.confirm('main', { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 1);

  // 重建序列上的受保护补丁可用
  const leftId = doc.seq[0].id;
  const rightId = doc.seq[1].id;
  const prot = store.confirm('main', { id: 'pp', protected: true, op: 'delete', leftId, rightId, text: '>>' });
  assert.equal(prot.text, 'abXef');
  assert.equal(seqText(doc), doc.text);

  fs.rmSync(dir, { recursive: true, force: true });
});
