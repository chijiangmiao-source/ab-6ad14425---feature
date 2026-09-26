// 经 Docker Engine API（/var/run/docker.sock）重启 compose 项目中的 app 容器，
// 并等待其恢复健康。仅用于验收编排中的“服务重启恢复”检查。
import http from 'node:http';

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const APP = (process.env.APP_URL || 'http://app:8080').replace(/\/$/, '');
const SERVICE = process.env.APP_SERVICE_NAME || 'app';

function docker(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const filters = encodeURIComponent(
  JSON.stringify({ label: [`com.docker.compose.service=${SERVICE}`] }),
);
const list = await docker('GET', `/containers/json?filters=${filters}`);
if (list.status !== 200) {
  console.error(`列举容器失败（docker.sock 不可用？）：${list.status} ${list.body}`);
  process.exit(1);
}
const containers = JSON.parse(list.body);
if (containers.length === 0) {
  console.error(`未找到服务 ${SERVICE} 的容器`);
  process.exit(1);
}
const target = containers[0];
console.log(`重启容器 ${target.Names?.[0] ?? target.Id}`);
const restarted = await docker('POST', `/containers/${target.Id}/restart?t=3`);
if (restarted.status !== 204) {
  console.error(`重启失败：${restarted.status} ${restarted.body}`);
  process.exit(1);
}

// 等待恢复健康（重启期间接口短暂不可达属正常）
const deadline = Date.now() + 60000;
for (;;) {
  try {
    const res = await fetch(`${APP}/api/health`);
    if (res.status === 200) {
      console.log('服务已重启并恢复健康');
      process.exit(0);
    }
  } catch {
    /* 尚未就绪，继续等待 */
  }
  if (Date.now() > deadline) {
    console.error('等待服务恢复健康超时');
    process.exit(1);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });
}
