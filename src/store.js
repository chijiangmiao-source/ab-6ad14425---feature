import fs from 'node:fs';
import path from 'node:path';
import { Document } from './document.js';

// 文档集合 + 原子持久化：每次确认后整体写入临时文件再 rename，
// 保证补丁的规范化结果与新修订原子落盘；重启后从状态文件恢复全部历史。
export class Store {
  constructor(file) {
    this.file = file;
    this.documents = new Map();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return; // 首次启动，无状态
      throw err;
    }
    const data = JSON.parse(raw);
    for (const [id, doc] of Object.entries(data.documents)) {
      this.documents.set(id, Document.fromJSON(doc));
    }
  }

  save() {
    const data = {
      documents: Object.fromEntries(
        [...this.documents.entries()].map(([id, doc]) => [id, doc.toJSON()]),
      ),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file); // 同目录 rename，原子替换
  }

  list() {
    return [...this.documents.values()].map((doc) => ({ id: doc.id, revision: doc.revision }));
  }

  get(id) {
    return this.documents.get(id);
  }

  createDocument(id, text) {
    if (this.documents.has(id)) return null;
    const doc = new Document(id, text);
    this.documents.set(id, doc);
    this.save();
    return doc;
  }

  // 返回确认结果；文档不存在返回 undefined；校验/冲突抛出 PatchError。
  confirm(id, payload) {
    const doc = this.documents.get(id);
    if (!doc) return undefined;
    const result = doc.confirm(payload);
    if (!result.duplicate) this.save(); // 幂等重放不改变状态，无需落盘
    return result;
  }
}
