# 低温联锁规程 · 离线补传协同确认服务

两台维护终端离线编辑《低温联锁规程》后补传补丁，服务端按操作变换（OT）规则确认，
保证并发补丁无论提交先后均收敛到同一文本，并提供幂等确认、原子持久化与页面终端。

## 功能与规则

- **建立草案**：`POST /api/documents` 建立规程草案（修订 0）。
- **读取当前全文与修订号**：`GET /api/documents/:id`。
- **提交补丁**：`POST /api/documents/:id/patches`，载荷为
  `{ id, baseRevision, op: "insert"|"delete", pos, text? | len? }`。
  确认后立即返回服务端确认的**全文、连续修订号与实际落点**（含规范化操作序列）。
- **迟到补丁转换**：依次转换越过 `baseRevision` 之后的每条已确认补丁：
  - 同位置插入按**补丁标识字典序**定序（小者在前）；
  - 插入落在删除区间内 → 插入保留，落点收敛到区间起点；
  - 插入跨越删除（插入点落入删除区间）→ 删除拆为两段，插入文本保留；
  - 重叠删除 → 仅删除未被对方覆盖的部分（可能拆段或成为空操作）；
  - 以上情形均为确定结果，两份并发补丁**无论提交先后均收敛到同一文本**。
- **幂等与拒绝**：
  - 同一标识携相同载荷重传 → 复现首次确认的文本、修订与落点，**不新增修订**；
  - 标识复用但载荷不同（409）、未来修订（409）、越界或长度不符的删除（422）
    → 拒绝且规程文本与修订保持不变。
- **原子持久化**：每条补丁的规范化结果与新修订随状态文件原子落盘
  （临时文件 + rename），服务重启后仍可按历史转换旧修订上的合法补丁。
- **页面终端**：保存本终端的基准修订与最近确认结果（localStorage）；
  刷新后批准稿一律从真实接口恢复，本地旧草案仅标注为“未批准”，绝不当作已批准内容。
- **健康状态**：`GET /api/health`。

## 运行

### 本地

```sh
node src/server.js          # PORT=8080 DATA_DIR=./data 可通过环境变量覆盖
node --test test/           # 单元测试
APP_URL=http://localhost:8080 sh verify/run.sh   # 完整验收
```

### Docker Compose（推荐）

```sh
HOST_PORT=8080 docker compose up --build --abort-on-container-exit --exit-code-from verify
echo $?                      # verify 的退出状态即验收成败
docker compose down
```

- `app`：页面、接口与健康状态，宿主机端口由 `HOST_PORT` 配置（默认 8080），
  状态持久化在命名卷 `app-data`。
- `verify`：等待 `app` 健康后执行 `verify/run.sh` —— 在业务检查之间穿插
  接口冒烟、代码测试（`node --test`）与构建检查（`node --check`），
  实际复核：同位并发插入的收敛文本、删除段内插入的保留结果、
  拒绝提交后文本和修订未变；全部完成即退出，退出状态如实表示验收成败。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康状态 |
| GET | `/api/documents` | 草案列表（标识与当前修订） |
| POST | `/api/documents` | 建立草案 `{ id?, text }` → 201 |
| GET | `/api/documents/:id` | 当前全文与修订号 |
| POST | `/api/documents/:id/patches` | 提交补丁 → 200 确认结果 / 4xx 拒绝 |

确认结果：`{ revision, text, landing, normalizedOps, duplicate }`。

## 目录结构

```
src/transform.js   OT 转换与应用（纯函数）
src/document.js    文档：校验、幂等、转换、确认
src/store.js       文档集合与原子持久化
src/server.js      HTTP 接口与静态页面
public/            补传确认终端页面
test/              单元测试（node --test）
verify/            验收编排（run.sh）与业务检查（acceptance.mjs）
```
