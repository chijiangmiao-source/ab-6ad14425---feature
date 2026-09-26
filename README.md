# 低温联锁规程 · 离线补传协同确认服务

两台维护终端离线编辑《低温联锁规程》后补传补丁，服务端按操作变换（OT）规则确认，
保证并发补丁无论提交先后均收敛到同一文本，并提供幂等确认、原子持久化与页面终端。
在此之上支持**受保护补传**：终端从已批准全文选定插入点或删除片段，
服务端以稳定字符标识序列与两端锚点看护原选位置，并发改动破坏前提时明确拒绝。

## 功能与规则

- **建立草案**：`POST /api/documents` 建立规程草案（修订 0）。
- **读取当前全文与修订号**：`GET /api/documents/:id`
  （响应同时携带 `charIds`：与全文逐字符对齐的稳定字符标识）。
- **提交补丁（旧式无锚）**：`POST /api/documents/:id/patches`，载荷为
  `{ id, baseRevision, op: "insert"|"delete", pos, text? | len? }`。
  确认后立即返回服务端确认的**全文、连续修订号与实际落点**（含规范化操作序列）。
- **迟到补丁转换**：依次转换越过 `baseRevision` 之后的每条已确认补丁：
  - 同位置插入按**补丁标识字典序**定序（小者在前）；
  - 插入落在删除区间内 → 插入保留，落点收敛到区间起点；
  - 插入跨越删除（插入点落入删除区间）→ 删除拆为两段，插入文本保留；
  - 重叠删除 → 仅删除未被对方覆盖的部分（可能拆段或成为空操作）；
  - 以上情形均为确定结果，两份并发补丁**无论提交先后均收敛到同一文本**。
- **稳定字符标识序列**：服务端为批准文本的每个字符位置签发稳定标识（`cN`，
  单调递增、永不复用）；旧式补丁与迟到补丁的规范化插入、删除同步推进该序列
  （插入签发新标识，删除标记不存活），任何时刻存活标识拼接的文本都等于当前全文；
  重启后由初始文本与确认历史确定性重放重建，结果与崩溃前一致。
- **受保护补传**：
  - 终端从已批准全文选定插入点（光标）或删除片段（拖选），
    `POST /api/documents/:id/protected` 注册选择，载荷携带所见修订
    `baseRevision`、位置与两端锚点（删除另含 `targetIds` 与所见内容
    `expectedText`）；服务端校验锚点为已签发标识且与所见位置一致后保存记录。
  - `POST /api/documents/:id/protected/:selId/confirm` 提交补传
    （插入携带 `text`，删除可回传 `targetIds`；均可回传锚点）。
    仅当**锚点仍围住原选位置、删除目标仍连续且内容未变**时，
    才按当前标识序列定位并原子确认（返回确认全文、修订与实际落点）；
    锚点被插入隔开（`anchors-separated`）、锚点或目标被删改
    （`anchor-deleted` / `target-changed`）、标识伪造
    （`anchor-forged` / `target-forged`）→ **409 明确拒绝，文本与修订不变**，
    状态性拒绝的结论记入选择记录并随状态落盘。
  - `GET /api/documents/:id/protected`（列表）与
    `GET /api/documents/:id/protected/:selId`（锚点与最近结论）供终端恢复；
    确认重传幂等复现，不新增修订。
- **幂等与拒绝**：
  - 同一标识携相同载荷重传 → 复现首次确认的文本、修订与落点，**不新增修订**；
  - 标识复用但载荷不同（409）、未来修订（409）、越界或长度不符的删除（422）
    → 拒绝且规程文本与修订保持不变。
- **原子持久化**：每条补丁的规范化结果、受保护选择（锚点与结论）随新修订
  原子落盘（临时文件 + rename），服务重启后仍可按历史转换旧修订上的合法补丁，
  并从接口恢复锚点与最近结论；旧格式状态文件（无受保护字段）加载后完全兼容。
- **页面终端**：保存本终端的基准修订与最近确认结果（localStorage）；
  刷新后批准稿一律从真实接口恢复，本地旧草案仅标注为“未批准”，绝不当作已批准内容；
  受保护选择的锚点与最近结论刷新或服务重启后**只从接口恢复**，
  补传成功只显示服务端确认的全文、修订与实际落点。
- **健康状态**：`GET /api/health`。

## 运行

### 本地

```sh
node src/server.js          # PORT=8080 DATA_DIR=./data 可通过环境变量覆盖
node --test test/           # 单元测试
sh verify/run.sh            # 完整验收：自管被测服务并实际重启进程（VERIFY_PORT 可改端口）
APP_URL=http://localhost:8080 sh verify/run.sh   # 对接已有服务（跳过重启恢复）
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
  拒绝提交后文本和修订未变、**受保护补传在并发改动后的接受与拒绝**；
  并经挂载的 `/var/run/docker.sock`（仅验收容器使用）**实际重启 app 容器**，
  复核重启后锚点与最近结论恢复、旧式无锚补丁/幂等重传/历史变换保持兼容；
  全部完成即退出，退出状态如实表示验收成败。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康状态 |
| GET | `/api/documents` | 草案列表（标识与当前修订） |
| POST | `/api/documents` | 建立草案 `{ id?, text }` → 201 |
| GET | `/api/documents/:id` | 当前全文、修订号与逐字符标识 `charIds` |
| POST | `/api/documents/:id/patches` | 提交旧式补丁 → 200 确认结果 / 4xx 拒绝 |
| POST | `/api/documents/:id/protected` | 注册受保护选择（所见修订 + 两端锚点）→ 201 |
| GET | `/api/documents/:id/protected` | 受保护选择列表（标识、类型、状态） |
| GET | `/api/documents/:id/protected/:selId` | 选择详情：锚点、目标与最近结论 |
| POST | `/api/documents/:id/protected/:selId/confirm` | 提交受保护补传 → 200 确认 / 409 拒绝 |

确认结果：`{ revision, text, landing, normalizedOps, duplicate }`
（受保护确认另含 `protectionId` 与 `patchId`）。

## 目录结构

```
src/transform.js   OT 转换与应用（纯函数）
src/atoms.js       稳定字符标识序列：签发、演进、重放重建
src/document.js    文档：校验、幂等、转换、确认、受保护选择
src/store.js       文档集合与原子持久化
src/server.js      HTTP 接口与静态页面
public/            补传确认终端页面（含受保护补传）
test/              单元测试（node --test）
verify/            验收编排（run.sh）、业务检查（acceptance.mjs）与容器重启器
```
