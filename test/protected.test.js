import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document, PatchError } from '../src/document.js';
import { Store } from '../src/store.js';
import { atomsText } from '../src/atoms.js';

function expectPatchError(fn, status, code) {
  assert.throws(
    fn,
    (err) => err instanceof PatchError && err.status === status && err.code === code,
  );
}

function registerInsert(doc, id, pos) {
  const ids = doc.aliveCharIds();
  return doc.registerProtection({
    id,
    baseRevision: doc.revision,
    kind: 'insert',
    pos,
    leftId: pos > 0 ? ids[pos - 1] : null,
    rightId: pos < ids.length ? ids[pos] : null,
  });
}

function registerDelete(doc, id, start, end) {
  const ids = doc.aliveCharIds();
  return doc.registerProtection({
    id,
    baseRevision: doc.revision,
    kind: 'delete',
    start,
    end,
    expectedText: doc.text.slice(start, end),
    targetIds: ids.slice(start, end),
    leftId: start > 0 ? ids[start - 1] : null,
    rightId: end < ids.length ? ids[end] : null,
  });
}

test('标识序列随旧式与迟到补丁演进，拼接文本恒等于当前全文', () => {
  const doc = new Document('main', '规程ABC');
  assert.equal(atomsText(doc.atoms), doc.text);
  const before = doc.aliveCharIds();

  doc.confirm({ id: 'p1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  doc.confirm({ id: 'p2', baseRevision: 1, op: 'delete', pos: 2, len: 2 });
  // 迟到补丁：基于修订 0，需转换越过 p1、p2，规范化结果同步更新标识序列
  const late = doc.confirm({ id: 'p3', baseRevision: 0, op: 'insert', pos: 1, text: 'L' });
  assert.equal(late.text, '>>LABC');
  assert.equal(atomsText(doc.atoms), doc.text);
  // 未被触及的字符标识保持稳定
  for (const id of before.slice(2)) {
    assert.ok(doc.aliveCharIds().includes(id), `标识 ${id} 应保持稳定`);
  }
  // 被删除字符的标识不再存活，但仍为“已签发”（区别于伪造）
  assert.ok(!doc.aliveCharIds().includes(before[0]));
  assert.ok(doc.isKnownCharId(before[0]));
  assert.ok(!doc.isKnownCharId('c9999'));
});

test('受保护插入：注册与确认（无并发改动）', () => {
  const doc = new Document('main', '甲乙丙丁');
  const rec = registerInsert(doc, 's1', 2);
  assert.equal(rec.status, 'pending');
  assert.equal(rec.baseRevision, 0);
  assert.equal(rec.leftId, 'c1');
  assert.equal(rec.rightId, 'c2');

  const result = doc.confirmProtection('s1', { patchId: 'prot-s1', text: '新' });
  assert.equal(result.revision, 1);
  assert.equal(result.text, '甲乙新丙丁');
  assert.equal(result.landing, 2);
  assert.equal(atomsText(doc.atoms), doc.text);

  // 幂等重传：复现首次确认结果，不新增修订
  const replay = doc.confirmProtection('s1', { patchId: 'prot-s1', text: '新' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 1);
  assert.equal(doc.revision, 1);
  // 换补丁标识重传已被确认的选择：冲突
  expectPatchError(
    () => doc.confirmProtection('s1', { patchId: 'prot-other', text: '新' }),
    409,
    'patch-id-conflict',
  );
});

test('锚点被插入隔开：拒绝且文本与修订不变，结论落库', () => {
  const doc = new Document('main', '甲乙丙丁');
  registerInsert(doc, 's1', 2);
  // 并发改动：旧式补丁恰好落在原选插入点（两锚点之间）
  doc.confirm({ id: 'x1', baseRevision: 0, op: 'insert', pos: 2, text: '插' });
  expectPatchError(
    () => doc.confirmProtection('s1', { patchId: 'prot-s1', text: '新' }),
    409,
    'anchors-separated',
  );
  assert.equal(doc.text, '甲乙插丙丁');
  assert.equal(doc.revision, 1);
  const rec = doc.getProtection('s1');
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.conclusion.code, 'anchors-separated');
  assert.equal(rec.conclusion.revision, 1);
});

test('锚点外的并发插入：接受且落点随标识序列平移', () => {
  const doc = new Document('main', '甲乙丙丁');
  registerInsert(doc, 's1', 2);
  doc.confirm({ id: 'x1', baseRevision: 0, op: 'insert', pos: 0, text: '【注】' });
  const result = doc.confirmProtection('s1', { patchId: 'prot-s1', text: '新' });
  assert.equal(result.landing, 5); // 2 + 3（锚点整体右移）
  assert.equal(result.text, '【注】甲乙新丙丁');
  assert.equal(atomsText(doc.atoms), doc.text);
});

test('锚点被删除：拒绝且文本与修订不变', () => {
  const doc = new Document('main', '甲乙丙丁');
  registerInsert(doc, 's1', 2);
  doc.confirm({ id: 'x1', baseRevision: 0, op: 'delete', pos: 0, len: 2 }); // 删去左锚点
  expectPatchError(
    () => doc.confirmProtection('s1', { patchId: 'prot-s1', text: '新' }),
    409,
    'anchor-deleted',
  );
  assert.equal(doc.text, '丙丁');
  assert.equal(doc.revision, 1);
});

test('受保护删除：目标连续且内容未变时按当前标识序列定位确认', () => {
  const doc = new Document('main', '甲乙丙丁戊');
  const rec = registerDelete(doc, 's1', 1, 3);
  assert.deepEqual(rec.targetIds, ['c1', 'c2']);
  assert.equal(rec.expectedText, '乙丙');
  // 并发改动在目标之前（不触及目标与锚点）
  doc.confirm({ id: 'x1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  const result = doc.confirmProtection('s1', { patchId: 'prot-s1' });
  assert.equal(result.text, '>>甲丁戊');
  assert.equal(result.landing, 3);
  assert.equal(atomsText(doc.atoms), doc.text);
});

test('删除目标被删改：拒绝且文本与修订不变', () => {
  const doc = new Document('main', '甲乙丙丁');
  registerDelete(doc, 's1', 1, 3);
  doc.confirm({ id: 'x1', baseRevision: 0, op: 'delete', pos: 2, len: 1 }); // 删去目标中的 丙
  expectPatchError(
    () => doc.confirmProtection('s1', { patchId: 'prot-s1' }),
    409,
    'target-changed',
  );
  assert.equal(doc.text, '甲乙丁');
  assert.equal(doc.revision, 1);
  assert.equal(doc.getProtection('s1').conclusion.code, 'target-changed');
});

test('删除目标被插入隔开：拒绝且文本与修订不变', () => {
  const doc = new Document('main', '甲乙丙丁');
  registerDelete(doc, 's1', 1, 3);
  doc.confirm({ id: 'x1', baseRevision: 0, op: 'insert', pos: 2, text: '隔' }); // 插入目标内部
  expectPatchError(
    () => doc.confirmProtection('s1', { patchId: 'prot-s1' }),
    409,
    'target-changed',
  );
  assert.equal(doc.text, '甲乙隔丙丁');
  assert.equal(doc.revision, 1);
});

test('标识伪造：注册与确认均明确拒绝', () => {
  const doc = new Document('main', '甲乙丙丁');
  // 注册时锚点伪造
  expectPatchError(
    () => doc.registerProtection({
      id: 's1', baseRevision: 0, kind: 'insert', pos: 2, leftId: 'c9999', rightId: 'c2',
    }),
    409,
    'anchor-forged',
  );
  expectPatchError(
    () => doc.registerProtection({
      id: 's2', baseRevision: 0, kind: 'insert', pos: 2, leftId: '伪造', rightId: 'c2',
    }),
    409,
    'anchor-forged',
  );
  // 注册时目标标识伪造
  expectPatchError(
    () => doc.registerProtection({
      id: 's3', baseRevision: 0, kind: 'delete', start: 1, end: 3,
      expectedText: '乙丙', targetIds: ['c1', 'c9999'], leftId: 'c0', rightId: 'c3',
    }),
    409,
    'target-forged',
  );
  assert.equal(doc.protections.size, 0); // 伪造注册不留下记录

  // 确认时回传锚点被篡改
  registerInsert(doc, 's4', 2);
  expectPatchError(
    () => doc.confirmProtection('s4', { patchId: 'prot-s4', text: '新', leftId: 'c8888' }),
    409,
    'anchor-forged',
  );
  expectPatchError(
    () => doc.confirmProtection('s4', { patchId: 'prot-s4', text: '新', leftId: 'c0' }),
    409,
    'anchor-mismatch',
  );
  assert.equal(doc.getProtection('s4').status, 'pending'); // 篡改尝试不形成结论
  assert.equal(doc.revision, 0);
});

test('注册校验：锚点与所见位置不符、内容不符、未来修订', () => {
  const doc = new Document('main', '甲乙丙丁');
  expectPatchError(
    () => doc.registerProtection({
      id: 's1', baseRevision: 0, kind: 'insert', pos: 2, leftId: 'c0', rightId: 'c2',
    }),
    422,
    'anchor-mismatch',
  );
  expectPatchError(
    () => doc.registerProtection({
      id: 's2', baseRevision: 0, kind: 'delete', start: 1, end: 3,
      expectedText: '丙丁', targetIds: ['c1', 'c2'], leftId: 'c0', rightId: 'c3',
    }),
    422,
    'content-mismatch',
  );
  expectPatchError(
    () => doc.registerProtection({
      id: 's3', baseRevision: 9, kind: 'insert', pos: 0, leftId: null, rightId: 'c0',
    }),
    409,
    'future-revision',
  );
  // 幂等注册：同标识同载荷复现记录
  const ids = doc.aliveCharIds();
  const payload = {
    id: 's4', baseRevision: 0, kind: 'insert', pos: 1, leftId: ids[0], rightId: ids[1],
  };
  const first = doc.registerProtection(payload);
  const again = doc.registerProtection(payload);
  assert.equal(again.duplicate, true);
  assert.equal(again.leftId, first.leftId);
  // 同标识不同载荷：冲突
  expectPatchError(
    () => doc.registerProtection({ ...payload, pos: 2, leftId: ids[1], rightId: ids[2] }),
    409,
    'protection-id-conflict',
  );
});

test('持久化：重启后锚点与最近结论可恢复，旧接口行为兼容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-prot-'));
  const file = path.join(dir, 'state.json');

  const s1 = new Store(file);
  s1.load();
  s1.createDocument('main', '甲乙丙丁');
  s1.confirm('main', { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  s1.createProtection('main', {
    id: 'pend', baseRevision: 1, kind: 'insert', pos: 2, leftId: 'c5', rightId: 'c0',
  });
  s1.createProtection('main', {
    id: 'done', baseRevision: 1, kind: 'delete', start: 3, end: 5,
    expectedText: '乙丙', targetIds: ['c1', 'c2'], leftId: 'c0', rightId: 'c3',
  });
  const accepted = s1.confirmProtection('main', 'done', { patchId: 'prot-done' });
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.text, '>>甲丁');

  // 模拟服务重启：从状态文件恢复
  const s2 = new Store(file);
  s2.load();
  const doc = s2.get('main');
  assert.equal(doc.revision, 2);
  assert.equal(doc.text, '>>甲丁');
  assert.equal(atomsText(doc.atoms), doc.text); // 标识序列重建不变量

  // 待确认选择的锚点原样恢复
  const pend = doc.getProtection('pend');
  assert.equal(pend.status, 'pending');
  assert.equal(pend.leftId, 'c5');
  assert.equal(pend.rightId, 'c0');
  // 已确认选择的最近结论原样恢复
  const done = doc.getProtection('done');
  assert.equal(done.status, 'accepted');
  assert.equal(done.conclusion.revision, 2);
  assert.equal(done.conclusion.patchId, 'prot-done');

  // 重启后受保护确认重传：幂等复现
  const replay = s2.confirmProtection('main', 'done', { patchId: 'prot-done' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 2);
  // 重启后旧式补丁重传：幂等复现
  const legacyReplay = s2.confirm('main', { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  assert.equal(legacyReplay.duplicate, true);
  // 重启后旧式迟到补丁仍按历史转换
  const late = s2.confirm('main', { id: 'late', baseRevision: 0, op: 'insert', pos: 4, text: 'L' });
  assert.equal(late.text, '>>甲丁L');
  // 重启后待确认选择仍可确认（锚点未被动过）
  const landed = s2.confirmProtection('main', 'pend', { patchId: 'prot-pend', text: '新' });
  assert.equal(landed.text, '>>新甲丁L');
  assert.equal(atomsText(doc.atoms), doc.text);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧格式状态文件（无 protections 字段）加载后保持兼容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-v1-'));
  const file = path.join(dir, 'state.json');
  const v1 = {
    documents: {
      main: {
        id: 'main',
        initialText: 'abcdef',
        text: '>>abef',
        revision: 2,
        history: [
          {
            revision: 1, patchId: 'h1',
            normalizedOps: [{ type: 'insert', pos: 0, text: '>>', patchId: 'h1' }],
            text: '>>abcdef', landing: 0,
          },
          {
            revision: 2, patchId: 'h2',
            normalizedOps: [{ type: 'delete', pos: 4, len: 2, patchId: 'h2' }],
            text: '>>abef', landing: 4,
          },
        ],
        patches: {
          h1: {
            payload: { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' },
            result: {
              revision: 1, text: '>>abcdef', landing: 0,
              normalizedOps: [{ type: 'insert', pos: 0, text: '>>', patchId: 'h1' }],
              duplicate: false,
            },
          },
          h2: {
            payload: { id: 'h2', baseRevision: 1, op: 'delete', pos: 4, len: 2 },
            result: {
              revision: 2, text: '>>abef', landing: 4,
              normalizedOps: [{ type: 'delete', pos: 4, len: 2, patchId: 'h2' }],
              duplicate: false,
            },
          },
        },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(v1));

  const store = new Store(file);
  store.load();
  const doc = store.get('main');
  assert.equal(doc.text, '>>abef');
  assert.equal(atomsText(doc.atoms), '>>abef'); // 由历史重放重建标识序列
  assert.equal(doc.aliveCharIds().length, 6);

  // 旧式迟到补丁仍按历史转换
  const late = store.confirm('main', { id: 'late', baseRevision: 0, op: 'insert', pos: 3, text: 'X' });
  assert.equal(late.text, '>>abXef');
  // 旧式幂等重传复现
  const replay = store.confirm('main', { id: 'h1', baseRevision: 0, op: 'insert', pos: 0, text: '>>' });
  assert.equal(replay.duplicate, true);
  // 迁移后的文档可正常使用受保护选择
  const ids = doc.aliveCharIds();
  const rec = store.createProtection('main', {
    id: 's1', baseRevision: doc.revision, kind: 'insert', pos: 1, leftId: ids[0], rightId: ids[1],
  });
  assert.equal(rec.status, 'pending');

  fs.rmSync(dir, { recursive: true, force: true });
});
