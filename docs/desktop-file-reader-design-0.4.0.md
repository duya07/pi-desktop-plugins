# desktop-file-reader 0.4.0 设计：传输方式重构

版本：0.4.0 · 日期：2026-10-14 · 作者：fixer subagent

## 0. 背景与目标

0.3.0 的 `write_desktop_file` 字节走 LLM 工具参数（base64 字符串）。实测 37 KB 文件单次写入解码少 4 字节，偏差确定性但边界敏感，需切 11 片才绕开。根因：LLM 对长文本的序列化/截断/转义不可控，且大 payload 极易超上下文或被网关截断。上游 issue 已记录该模式不适合传二进制。

目标：提供一条字节完全不经 LLM 上下文的双向通道；旧 4 工具保留不变，新能力以新工具承载；远端准备必须简单、可回滚、默认关闭；安全约束不退化。

## 1. 调研摘要

| 主题 | 结论 | 来源 URL | 是否读到正文 |
|------|------|----------|---------------|
| LLM 工具大 payload 限制与规避 | 业界共识：工具参数适合传路径/URL/哈希，不适合传二进制；大文件应走“工具传指针 + 带外 HTTP/预签名 URL” | https://platform.openai.com/docs/guides/function-calling（跳转到 developers.openai.com） | 跳转页已读到标题，章节正文被重定向拦截，未读到参数长度细节 |
| OpenAI tool output 长度 | 官方未公开硬上限，但实践中>100KB 的 tool result 极易被截断或触发上下文溢出 | https://community.openai.com 搜索“tool output truncation”多篇 | 未抓正文，结论来自社区共识摘录（未验证） |
| Node 主动 HTTP 上传/下载 | `node:http(s).request` 流式管道最稳；需自行处理 timeout、Content-Length、非 2xx、重定向拒绝；`pipeline` 可用于落盘 | https://nodejs.org/api/http.html、https://nodejs.org/api/https.html（Node 26 文档） | 已读到目录与 API 索引，未逐段抓正文但 API 形状已核实 |
| Node `fs` 流 | `fs.createReadStream` + `crypto.createHash` 可边读边算 sha256；`http.request` 的 `write` 接受 Buffer/Stream | https://nodejs.org/api/fs.html | 已读到 `createReadStream` 索引 |
| PI-Desktop 插件能力边界 | 插件入口在独立 Node 进程，非 OS 沙箱，可用 `node:fs`/`node:http(s)`/`node:child_process`；`trust boundary` 文档明确权限网关只管 `pi.*`，不拦原生 Node API | https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/plugin-development.md、`/docs/spec/07-plugins/04-plugin-security.md` | 已读到正文 |
| Windows ssh.exe/scp 坑 | `ssh.exe` 路径不固定（`C:\Windows\System32\OpenSSH\ssh.exe` 常见但不保证）、密钥默认 `~/.ssh/id_*`、known_hosts 首次指纹需确认、Windows 路径空格需引号、`scp` 在 PowerShell 下的参数转义易错 | https://learn.microsoft.com/en-us/windows/terminal/tutorials/ssh | 已读到页头与 meta，未读到正文细节 |
| 分块+校验成熟模式 | 常见：固定块大小（256KB-1MB）+ 每块 sha256 清单 + Content-Range/Range 断点续传；服务端存临时分片，全部收齐后合并再校验总 sha | 业界通用（S3 multipart、tus 协议） | 未抓单篇正文，模式为推断总结 |

**可信度**：HTTP/Node 部分为官方文档，已核实；LLM payload 长度为社区经验，未验证（标注为未验证）。

## 2. 远端环境侦察（只读，2026-10-14）

| 项 | 结果 | 证据 |
|----|------|------|
| 远端 OS / python3 | Debian 12, python 3.11.2 | `python3 --version` |
| nginx | 未在宿主机 PATH，但容器 `openresty:1.31` 以 `host` 网络运行，`nginx.conf: client_max_body_size 50m` | `docker inspect openresty` mounts、`/srv/panel/apps/openresty/.../nginx.conf` |
| webroot | `/srv/panel/apps/openresty/openresty/root`（`index.html` 默认页）、`/www` 实际为 `/srv/panel/www` 挂载；站点根在 `/srv/panel/www/sites/<domain>/index`，代理在 `.../proxy/*.conf` | `ss -tlnp` + `ls /srv/panel/www/sites` |
| 站点 panel.example.com | 存在，`proxy/*.conf` 为 `proxy_pass https://127.0.0.1:1775`（1Panel 面板），`/` 仅代理面板，无额外静态目录对外暴露 | `cat /srv/panel/www/sites/panel.example.com/proxy/*.conf` |
| 公网可达 | `curl -sI https://panel.example.com/` 返回 200，openresty 监听 0.0.0.0:80/443 | `curl -sI` 实测 |
| easytier | 本机 <mesh-ip>（remote-host），对端 <mesh-peer-a>/5 均 DIRECT，版本 2.6.4，监听 easytier 默认端口 | `/opt/easytier/easytier-cli peer/route` |
| 容器可作文件端点的服务 | 有若干容器服务（端口仅 mesh 内可达），但**没有**现成的文件上传端点 | `ss -tlnp` + `docker ps` |
| 临时 python 能力 | `python3 -m http.server` 可用，但宿主机 80/443 被 openresty 占用，任意新端口需防火墙放行或走 mesh；未启动任何长期服务 | 仅只读探测，未起服务 |
| 桌面是否在 mesh 内 | **否**（mesh 仅 <mesh-peer-a>/2/5 三台 VPS，核实于 2026-10-14 审核）；桌面直连 `<mesh-ip>:8765` 当前不可达 | 主代理审核实测 |

**结论（已修正排序）**：首选 **SSH 本地转发**（桌面 `ssh -L` 到远端 `127.0.0.1:9876`），零远端配置改动；次选经 1Panel OpenResty 反代；不推荐公网 `0.0.0.0`；直连 `<mesh-ip>:8765` 需桌面加入 easytier，当前不成立。

## 3. 方案评估

### A. HTTP 直传（推荐，0.4.0 主方案）

机制：插件用 `node:https` 主动向远端 URL 发 `PUT/POST`（上传）或 `GET`（下载），字节走 TLS 直连，不经 LLM。两个方向都由桌面发起，恰好绕过“远端不能连桌面”的 NAT 限制：
- 桌面→远端：桌面读文件后 `PUT http(s)://...`
- 远端→桌面：远端先把文件放到可被桌面 GET 的 URL，桌面再 `GET` 落盘。

优点：不依赖桌面密钥/known_hosts 的插件侧实现；与现有 SSH 通道正交（远端准备复用 SSH 转发）；可复用成熟 HTTP 语义（Content-Length、sha256 头、Range 续传）；远端准备一条 python 命令即可，可回滚。

缺点：需远端有一个可写的 HTTP 端点（一次性 python 脚本或 nginx 反代）；公网暴露需 token 与大小限制。

**判定：推荐**。

### B. SSH 通道（`ssh.exe`/`scp`）

机制：插件 `child_process.spawn("ssh.exe", ...)` 或 `scp`，复用桌面已验证可登录远端的密钥。

优点：已有密钥可登录（auth.log 见 `Accepted publickey for root from 122.97.239.229`），链路最短。

缺点：依赖桌面侧密钥路径/known_hosts/ssh.exe 位置，Windows 下三者均不固定，首次指纹确认会阻塞；错误信息不透明；密钥持有者是通用舰队密钥，风险面大；不同桌面配置差异大，难以写出通用且可靠的代码。

**判定：否决为插件内实现**，但远端准备**复用** SSH 通道（`ssh -L` 本地转发），见 §4.4。

### C. 改进的分块 base64（gzip + 每块 sha256 清单 + 断点续传）

机制：仍经 LLM，但在当前 1 MiB/4 MiB 限制上加 gzip、每块 sha256、清单文件、失败重传单块。

优点：零远端准备，开箱即用；小文件（<100KB）成功率高。

缺点：字节仍经 LLM，确定性失真未被证实根除（换边界才绕开说明失真与序列化边界相关，gzip 后仍可能命中）；大文件需多次工具往返，上下文与超时风险不减；实现复杂度高但治标不治本。

**判定：否决为主方案**，保留旧工具的分块能力作小文件/无网络准备时的兜底，不在此版本扩展。

### D. 其他方案（桌面临时 HTTP 服务供远端 curl 拉取）

机制：桌面起一次性 `node:http` 静态服务，远端 `curl http://<mesh-ip>:8765/...` 或经 SSH 反向隧道 `curl http://127.0.0.1:<fwdPort>/...`。

优点：大文件最稳，远端只需 curl。

缺点：桌面需在 mesh 内（当前不在）或常驻 SSH 反向隧道（需用户在 Windows 侧常驻 `ssh -R`），准备成本高于 A；且远端到桌面的可达性依赖额外组网/隧道，默认不可用。

**判定：否决为默认方案**，作为 A 的互补方向在文档中说明；若用户已加入 easytier，可用 `<mesh-ip>:8765` 互通。

## 4. 0.4.0 设计

### 4.1 工具清单（旧接口一律保留）

| 工具 | 风险 | 说明 |
|------|------|------|
| `read_desktop_file` | low | 保留 |
| `list_desktop_dir` | low | 保留 |
| `write_desktop_file` | high | 保留 |
| `delete_desktop_file` | high | 保留 |
| `push_desktop_file_to_remote` | high | 新增：桌面→远端 HTTP 直传 |
| `pull_remote_file_to_desktop` | high | 新增：远端→桌面 HTTP 直传 |

仍仅声明 `agent.tool.register`，不新增权限。

### 4.2 新工具契约

#### `push_desktop_file_to_remote`

将桌面文件通过 HTTP(S) 直传到远端 URL。

参数（JSON Schema）：
- `path` string 必填：桌面绝对路径
- `remoteUrl` string 必填：`http://` 或 `https://`，长度 ≤2048（**无白名单**，仅做协议与长度校验；必须只对用户明确授权的目标使用，详见 §4.5）
- `token` string 可选：鉴权 token，**推荐走 `Authorization: Bearer <token>` 头**（≥16 才发送）；为兼容也支持 token 在路径中（`/push/<token>/...`），但会进访问日志，不推荐
- `expectedSha256` string 可选：64 hex，覆盖校验（推送前核对本地文件未变）
- `timeoutMs` integer 可选：5_000–120_000，默认 60_000
- `method` string 可选：`PUT` 或 `POST`，默认 `PUT`

行为：
1. 校验 `remoteUrl` 协议与长度；`token` 若提供则校验长度与字符集。
2. `lstat` 目标：拒绝目录/符号链接/非常规文件/不存在；`stat` 取 size，拒绝 >50 MiB（`MAX_HTTP_BYTES`，与 nginx `client_max_body_size 50m` 对齐）。
3. 若提供 `expectedSha256`，计算 `sha256OfFile` 并比对，不匹配则拒绝。
4. 以 `node:https`/`node:http` 发请求，头含 `Content-Type: application/octet-stream`、`Content-Length`、`X-File-SHA256: <hex>`、`X-File-Name: <basename>`，流式管道 `fs.createReadStream → req`，超时 `timeoutMs`，拒绝重定向（3xx 视为失败）。
5. 收集响应（≤64KB），要求 2xx 否则失败；返回 `{ ok:true, path, remoteUrl, bytesSent, sha256, remoteStatus, remoteBody }`。

错误：
- `INVALID_URL`（协议非 http/https、过长、无法解析）
- `FILE_NOT_FOUND` / `NOT_A_FILE` / `SYMLINK_REFUSED` / `FILE_TOO_LARGE`
- `SHA_MISMATCH`（expectedSha256 不匹配）
- `HTTP_ERROR`（非 2xx、重定向、响应过大）
- `TIMEOUT` / `NETWORK_ERROR`

LLM 侧只需传 `path` 与 `remoteUrl`（+ 可选 token/sha），字节不进 LLM。

#### `pull_remote_file_to_desktop`

从远端 URL 通过 HTTP(S) 拉取并落盘到桌面路径。

参数：
- `remoteUrl` string 必填：`http://`/`https://`（同样无白名单，见 §4.5）
- `path` string 必填：桌面目标绝对路径
- `token` string 可选：同上，`Authorization: Bearer`
- `expectedRemoteSha256` string 可选：64 hex，校验远端返回体的 sha（若响应头 `X-File-SHA256` 存在则优先比对该头，否则对落盘后文件算 sha；若头与实际内容不一致则拒绝）
- `allowCreate` boolean 可选：目标不存在时必填 `true` 才创建
- `expectedSha256` string 可选：覆盖已存在文件时必填（乐观锁，同 `write_desktop_file`）
- `timeoutMs` integer 可选：同上

行为：
1. 校验 URL/token 同上。
2. 检查目标当前状态：若存在则必须是普通文件（lstat 拒绝目录/符号链接），且必须提供 `expectedSha256` 否则拒绝；若不存在则要求 `allowCreate:true`。
3. `GET remoteUrl`（带 token 头），超时控制，拒绝重定向，要求 2xx，检查 `Content-Length`（若有）≤50 MiB，否则失败。
4. 流式落盘到临时文件（同目录 `.<name>.tmp-<rand>`），边写边算 sha，完成后校验 `expectedRemoteSha256`（若提供；头与内容不一致也拒绝）。
5. 再次 `lstat` 目标（若已存在）复核 size/mtime/inode 未变（缩小 TOCTOU），然后原子 `rename` 覆盖，返回 `{ ok:true, path, remoteUrl, bytesReceived, sha256, action }`。

错误：同 push，另加 `ALREADY_EXISTS_NEEDS_SHA` / `NEEDS_ALLOW_CREATE` / `REMOTE_SHA_MISMATCH` / `TARGET_CHANGED`。

### 4.3 与旧工具关系

- 旧 4 工具不动，语义与 0.3.0 完全一致，测试用例继续通过。
- 新工具是“带外字节通道”，小文件仍可用旧工具；大文件/二进制推荐新工具。
- 远端落地：push 到远端后，远端用 `sha256sum` 自检；pull 到桌面后，插件返回值含 `sha256` 供复盘。

### 4.4 远端准备（按可行性排序，必须可回滚、默认关闭）

#### 首选：SSH 本地转发（零远端配置改动，复用既有 SSH 通道，推荐）

远端（VPS，`<remote-public-ip>`）生成 token 文件并起 receiver（仅监听回环，凭据不进 `ps`）：

```bash
umask 077 && openssl rand -hex 16 > /tmp/dfr.token
python3 remote/receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr --token-file /tmp/dfr.token
# 备选：DFR_RECEIVER_TOKEN=$(cat /tmp/dfr.token) python3 remote/receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr
# 不推荐：--token $(cat /tmp/dfr.token)  # 明文会出现在 ps，仅调试用
```

桌面（Windows，已有到远端的 SSH 条目）开本地转发：

```powershell
ssh -L 9876:127.0.0.1:9876 <远端别名>
# 或带 -N -f 后台：ssh -N -f -L 9876:127.0.0.1:9876 <远端别名>
```

插件 token 取 `cat /tmp/dfr.token` 的值（走 `Authorization: Bearer` header）：

```js
push_desktop_file_to_remote({ path: "C:/Users/me/big.bin", remoteUrl: "http://127.0.0.1:9876/push/big.bin", token: "<cat /tmp/dfr.token>" })
pull_remote_file_to_desktop({ remoteUrl: "http://127.0.0.1:9876/pull/big.bin", path: "C:/Users/me/big.bin", token: "<cat /tmp/dfr.token>", allowCreate: true })
```

健康检查（需转发已建立）：`curl -i http://127.0.0.1:9876/health --header "Authorization: Bearer $(cat /tmp/dfr.token)"`（无 token 时 `curl -i http://127.0.0.1:9876/health`）。

关闭：`pkill -f receiver.py && rm /tmp/dfr.token`（远端）+ 关闭 `ssh -L` 进程（桌面），无残留。

> **凭据说明**：远端 token 不要用 `--token $(openssl ...)` 形式（`ps` 可见）；请始终用 `--token-file` 或 `DFR_RECEIVER_TOKEN`。插件侧 `token` 是 LLM 参数，不进桌面进程列表，但仍建议走 header（receiver 已对路径 token 做日志遮蔽，仍不推荐放 URL）。

#### 次选：经 1Panel OpenResty 反代到 127.0.0.1:9876（需用户授权改 nginx）

远端同样先生成 token 文件并监听 `127.0.0.1:9876`：

```bash
umask 077 && openssl rand -hex 16 > /tmp/dfr.token
python3 remote/receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr --token-file /tmp/dfr.token
```

一次性 nginx 配置（示例，默认不创建）：

```nginx
# /srv/panel/www/sites/panel.example.com/proxy/dfr.conf
location ^~ /dfr/ {
    proxy_pass http://127.0.0.1:9876/;
    client_max_body_size 50m;
    proxy_read_timeout 120s;
}
# 生效：docker exec openresty openresty -s reload
# 回滚：rm /srv/panel/www/sites/panel.example.com/proxy/dfr.conf && docker exec openresty openresty -s reload
```

此时插件 `remoteUrl` 可为 `https://panel.example.com/dfr/push/file.bin`（走公网 TLS，需 token 鉴权）。

#### 不推荐：绑 `0.0.0.0` 走公网

```bash
umask 077 && openssl rand -hex 16 > /tmp/dfr.token
python3 remote/receiver.py --bind 0.0.0.0:8765 --dir /tmp/dfr --token-file /tmp/dfr.token
```

需防火墙放行端口，暴露面大，仅调试时临时使用。

#### 关于 `<mesh-ip>:8765`（easytier mesh）

桌面当前**不在** mesh 内（mesh 仅 <mesh-peer-a>/2/5 三台 VPS），`http://<mesh-ip>:8765` 当前不可达。若需直连 mesh，需桌面安装 easytier 并加入同一 `network_name`/`network_secret`，获 `<mesh-cidr>` 后方可访问。

### 4.5 安全约束

- 端点防滥用：一次性 token（≥16 字节随机 hex，**推荐放 `Authorization: Bearer` 头**；路径 token 兼容但会进访问日志，已做遮蔽，不推荐；远端生成务必用 `--token-file`/`DFR_RECEIVER_TOKEN`，不要用 `--token $(...)`）、URL 前缀白名单（仅 `/push/` 与 `/pull/`，兼容带 token 前缀）、大小上限 50 MiB、超时 120s、默认不监听公网。
- 插件侧：`remoteUrl` 仅 `http/https`，**无白名单限制**（刻意取舍，便于复用既有 URL/反代），需调用方与用户共同保证只对授权目标使用；`token` 不写错误日志（不回显明文）；`path` 仍走 `path.resolve`，但 push/pull 不触及删除保护清单（读/写路径由用户授权，删除清单仅对 `delete_desktop_file` 生效）；receiver 侧已对 token 做日志遮蔽（`/push/<token>/` → `/push/***/`）。
- 覆盖保护：`pull` 复用 `write` 的乐观锁（`expectedSha256`/`allowCreate`），`push` 支持 `expectedSha256` 预校验。
- TOCTOU：`pull` 在落盘前复核目标未变，`push` 在发送前算 sha 并带在 `X-File-SHA256` 供远端二次校验。

### 4.6 失败模式与恢复

| 失败 | 现象 | 恢复 |
|------|------|------|
| 远端未启动 | `ECONNREFUSED / ETIMEDOUT` | 启动 receiver.py 后重试 |
| token 错 | 401/403 | 核对 token，明文不落盘 |
| 非 2xx | 413（超大）、404、500 | 按状态码提示调整（分片或换目录） |
| 超时 | `TIMEOUT` | 增大 `timeoutMs` 或分片（后续版本支持 Range） |
| sha 不匹配 | `SHA_MISMATCH` / `REMOTE_SHA_MISMATCH` | 重读本地文件或重拉远端，核对 `sha256sum` |
| 目标在写入前被改 | `TARGET_CHANGED` | 重读 `read_desktop_file` 拿新 sha 后重试 |
| 网络闪断 | `NETWORK_ERROR` | 重试；已落盘的临时文件自动清理 |

### 4.7 非目标（0.4.0 不做）

- 插件内 SSH 通道（`ssh.exe`/`scp`）——远端准备复用 SSH 转发已覆盖需求。
- 自动分块续传（`Content-Range` / `Range`），0.4.0 单次 ≤50 MiB，已覆盖 37KB 失真场景与常见文档；超大文件由调用方分片或后续版本支持。
- 服务端持久化鉴权/多租户，仅一次性 token。

## 5. 实现要点

- `main.js`：CommonJS，`node:` 前缀，函数级中文注释，错误 `{ok:false,error}` 不抛栈；新增两函数与 `onLoad` 注册；`remoteUrl` 无白名单但仅 `http(s)`。
- `manifest.json`：`version` → `0.4.0`，`agentTools` 增两项；示例改用 header 方式，注明路径 token 不推荐。
- `README.md`：中文，补充新工具章节与安全约束；远端准备按可行性排序。
- `remote/receiver.py`：标准库 `http.server`，`do_PUT/POST/GET`，`Authorization` 校验，路径白名单，大小与超时限制，日志 token 遮蔽。

## 6. 测试与校验

- 旧 43 项断言（`delete-0.3.0.test.js`）必须继续全过。
- 新增测试 `transfer-0.4.0.test.js`：覆盖 push/pull 的全部拒绝路径（无效 URL、缺 path、超大、sha 不匹配、未授权覆盖、缺 allowCreate、超时、非 2xx、重定向）、安全约束（token 长度、协议白名单、符号链接拒绝、URL 无限制的取舍）与正例（同步到本地临时 HTTP 服务器的端到端），并补：
  - receiver token 遮蔽单测（起真实 receiver 子进程，请求路径 token，断言 stdout 不含明文 token）
  - push 超 50 MiB 被拒（本地文件 size 超限前置拒绝，无需真写 50 MiB）
  - pull 时远端 `X-File-SHA256` 头与实际内容不一致被拒（确认覆盖）
- 容器校验：`node --check`、`pi-plugin check`（OK）、`pi-plugin pack`（记录条目清单、字节数、sha256）。
