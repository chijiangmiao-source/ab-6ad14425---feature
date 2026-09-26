import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { PatchError } from './document.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 1024 * 1024;

const store = new Store(path.join(DATA_DIR, 'state.json'));
store.load();

const DOC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new PatchError(413, 'too-large', '请求体超过 1MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw === '' ? {} : JSON.parse(raw);
  } catch {
    throw new PatchError(400, 'bad-json', '请求体不是合法 JSON');
  }
}

async function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'forbidden', '禁止访问');
    return;
  }
  try {
    const content = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    sendError(res, 404, 'not-found', '资源不存在');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    // 健康状态
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
      return;
    }

    // 文档列表
    if (req.method === 'GET' && url.pathname === '/api/documents') {
      sendJson(res, 200, { documents: store.list() });
      return;
    }

    // 建立草案
    if (req.method === 'POST' && url.pathname === '/api/documents') {
      const body = await readJson(req);
      const id = body.id ?? 'main';
      if (typeof id !== 'string' || !DOC_ID_RE.test(id)) {
        sendError(res, 400, 'bad-doc-id', '草案标识须为 1..64 位字母数字开头，可含 . _ -');
        return;
      }
      if (typeof body.text !== 'string') {
        sendError(res, 400, 'bad-text', '草案必须携带字符串 text');
        return;
      }
      const doc = store.createDocument(id, body.text);
      if (!doc) {
        sendError(res, 409, 'doc-exists', `草案 ${id} 已存在`);
        return;
      }
      sendJson(res, 201, { id: doc.id, revision: doc.revision, text: doc.text });
      return;
    }

    // /api/documents/:id[/patches]
    if (parts[0] === 'api' && parts[1] === 'documents' && parts.length >= 3) {
      const id = decodeURIComponent(parts[2]);
      if (parts.length === 3 && req.method === 'GET') {
        const doc = store.get(id);
        if (!doc) {
          sendError(res, 404, 'not-found', `草案 ${id} 不存在`);
          return;
        }
        sendJson(res, 200, { id: doc.id, revision: doc.revision, text: doc.text });
        return;
      }
      if (parts.length === 4 && parts[3] === 'patches' && req.method === 'POST') {
        const body = await readJson(req);
        const result = store.confirm(id, body);
        if (result === undefined) {
          sendError(res, 404, 'not-found', `草案 ${id} 不存在`);
          return;
        }
        sendJson(res, 200, result);
        return;
      }
    }

    // 页面与静态资源
    if (req.method === 'GET') {
      if (url.pathname === '/') {
        await serveStatic(res, 'index.html');
        return;
      }
      if (url.pathname === '/app.js' || url.pathname === '/style.css') {
        await serveStatic(res, url.pathname.slice(1));
        return;
      }
    }

    sendError(res, 404, 'not-found', '接口不存在');
  } catch (err) {
    if (err instanceof PatchError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    console.error(err);
    sendError(res, 500, 'internal', '服务内部错误');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`低温联锁规程确认服务已启动: http://${HOST}:${PORT} (数据目录 ${DATA_DIR})`);
});
