# 📄 Desktop File Reader · PI-Desktop 插件

[![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/duya07/pi-desktop-plugins/blob/main/LICENSE) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop)

> 让 **RACP Remote Host** 模式下的远端会话也能读写**桌面机**上的文件。注册六个在**桌面侧执行**的 agent 工具——`read_desktop_file`（分块读）、`list_desktop_dir`（列目录）、`write_desktop_file`（写入）、`delete_desktop_file`（删除）、`push_desktop_file_to_remote`（HTTP 直传到远端）、`pull_remote_file_to_desktop`（HTTP 直传到桌面）。**0.4.0 起大文件走直传，字节不经 LLM。**

| 维度 | 说明 |
| --- | --- |
| **这是什么** | 六个 agent 工具：`read_desktop_file` / `list_desktop_dir` / `write_desktop_file` / `delete_desktop_file` / `push_desktop_file_to_remote` / `pull_remote_file_to_desktop` |
| **解决什么** | 远端会话的 `Read/Write/Edit/Glob/Grep/Bash` 全部在远端主机执行，读写不到桌面机的文件；且 LLM 工具参数传大块 base64 会失真 |
| **怎么做到** | 插件工具按名字前缀被 host-core 分流到**桌面分发**分支，该分支排在「远端执行」之前——所以它们永远在桌面跑；0.4.0 新增的 push/pull 走 `node:http(s)` 直连远端，不经 LLM |

---

## 为什么需要它

PI-Desktop 的 RACP Remote Host 模式下，agent 的工具调用（`Read/Write/Edit/Glob/Grep/Bash`）全部落在**远端主机**上执行：远端主机没有桌面机的磁盘，会话也就读不到桌面上的任何文件。此前唯一的读取通道是内置浏览器面板——它要求窗口保持前台，且不是给 agent 用的工具通道。

本插件利用 PI-Desktop 工具分发链的一个既有事实：**插件注册的工具永远在桌面侧执行**，哪怕会话绑定的是远端工作区。于是远端会话里 agent 调用 `read_desktop_file`，实际是在桌面机上读文件，内容以 base64 原路返回，agent 再用远端 `Write` 落盘，即完成「桌面文件 → 远端工作区」的搬运；反向的 `write_desktop_file` / `delete_desktop_file` 则用于把远端产物写回桌面、或清理桌面上的临时文件。

**0.4.0 的痛点**：`write_desktop_file` 的字节要走 LLM 的 base64 参数，实测 37 KB 文件单次写入会少 4 字节，且偏差确定性但边界敏感，需切 11 片才绕开。根因是 LLM 对长文本的序列化/截断不可控。0.4.0 新增 `push_desktop_file_to_remote` / `pull_remote_file_to_desktop`，让字节走 `node:https` 直连远端 URL，完全不经 LLM。

---

## 提供的工具

### `read_desktop_file(path, offset?, length?)`

读取桌面机上的一个文件，返回 base64。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 桌面机上的文件路径（必填） |
| `offset` | number? | 起始字节偏移，默认 `0`（分块续读用） |
| `length` | number? | 本次最多读取的字节数，默认 **256 KiB**，单次上限 **1 MiB** |

返回：`{ ok, path, size, offset, bytesRead, eof, base64 }`——`size` 是文件总大小，`eof` 表示本次是否已读到文件末尾；大文件按 `offset` 翻页即可。

### `list_desktop_dir(path)`

列出桌面机上一个目录的条目，每项含名称 / 是否目录 / 大小，**目录排在文件前**。传入文件路径或空路径会返回错误对象而不是抛给会话一个栈。

### `write_desktop_file(path, contentBase64, expectedSha256?, allowCreate?)`

把 base64 内容写到桌面机的某个文件。**高危**，详见文末[写工具](#写工具write_desktop_file)一节。适合小文件（≤4 MiB）；大文件请用 push/pull 直传。

### `delete_desktop_file(path, confirm, expectedSha256? | expectedSize?, dryRun?)`

删除桌面机上的**单个普通文件**。**高危**，四道门禁详见文末[删除工具](#删除工具delete_desktop_file)一节。

### `push_desktop_file_to_remote(path, remoteUrl, token?, expectedSha256?, timeoutMs?, method?)`

把桌面文件通过 **HTTP(S) 直传**到远端 URL，字节不经 LLM。**高危**，`remoteUrl` 无白名单限制——只对用户明确授权的目标调用。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 桌面机上的绝对路径（必填） |
| `remoteUrl` | string | 目标 `http(s)://` URL（必填，≤2048 字符），如 `http://127.0.0.1:9876/push/file.bin`（经 `ssh -L` 转发）或 `https://example.com/dfr/push/file.bin` |
| `token` | string? | 鉴权 token，**推荐**以 `Authorization: Bearer <token>` 发送（≥16 字符才发送）；为兼容也支持 token 在路径中（`/push/<token>/...`），但会进访问日志，不推荐 |
| `expectedSha256` | string? | 可选：当前文件 sha256，推送前核对未变 |
| `timeoutMs` | number? | 超时 5000–120000ms，默认 60000 |
| `method` | string? | `PUT` 或 `POST`，默认 `PUT` |

行为：`lstat` 校验普通文件、大小 ≤50 MiB、套 `expectedSha256` 乐观锁后，以 `node:https` 流式 `fs.createReadStream → req` 发送，头含 `X-File-SHA256` 与 `X-File-Name`，拒绝重定向，要求 2xx。返回 `{ ok, bytesSent, sha256, remoteStatus, remoteBody }`。

### `pull_remote_file_to_desktop(remoteUrl, path, token?, expectedRemoteSha256?, expectedSha256?, allowCreate?, timeoutMs?)`

从远端 URL **HTTP(S) 拉取**并落盘到桌面路径，字节不经 LLM。**高危**，`remoteUrl` 同上无限制。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `remoteUrl` | string | 源 `http(s)://` URL（必填），如 `http://127.0.0.1:9876/pull/file.bin` |
| `path` | string | 桌面目标绝对路径（必填） |
| `token` | string? | 同 push，推荐走 header |
| `expectedRemoteSha256` | string? | 可选：期望的远端内容 sha256（若响应头 `X-File-SHA256` 存在则比对该头，否则比对落盘后 sha；头与实际内容不一致也拒绝） |
| `expectedSha256` | string? | 覆盖已存在目标时必填（乐观锁，同 write） |
| `allowCreate` | boolean? | 目标不存在时必填 `true` 才创建 |
| `timeoutMs` | number? | 同 push |

行为：校验目标（存在则需 `expectedSha256`，不存在则需 `allowCreate:true`，拒绝目录/符号链接）→ `GET remoteUrl`（拒绝重定向，要求 2xx，`Content-Length` ≤50 MiB）→ 流式落盘到同目录 `.<name>.tmp-<rand>` 并边写边算 sha → 校验 `expectedRemoteSha256` → TOCTOU 复核 → 原子 `rename`。返回 `{ ok, bytesReceived, sha256, action }`。

---

## 工作原理

1. **按工具名前缀分流，桌面分支排在远端分支之前。** host-core 的工具分发链按前缀判断：以 `plugin_` 或 `mcp_` 开头的工具被判为「桌面分发」（`crates/host-core/src/tools/mod.rs:961` 的 `is_desktop_dispatched`），而桌面分发分支（`crates/host-core/src/rpc/mod.rs:4226`）在代码顺序上**排在远端执行分支（`:4241`）之前**。所以插件注册的工具**永远在桌面执行**，哪怕会话绑定的是远端工作区。
   注意：这不是「远端反向请求桌面」那种反向 RPC——那条路确实没有实现；这里的机制是**远端 host 从一开始就没接管这个工具**。
2. **能跨到远端的只有 6 个工具。** `Read|Glob|Grep|Write|Edit|Bash`（见 `crates/host-core/src/rpc/remote_tools.rs:114`），其他工具名走到远端分支时直接返回 `CAPABILITY_UNAVAILABLE`——这正是插件工具必须由桌面分支先接走的原因。
3. **插件进程不是 OS 能力沙箱。** 插件入口跑在一个独立的 Node 进程里，官方文档说明它**目前不是** OS 级别的能力沙箱，因此 `node:fs`/`node:http(s)` 能读到当前用户可读的任意路径。作为对照，宿主 API `pi.fs.readText` 走权限网关：受 `manifest.fs.read.scope` 限制，且无条件拒绝 `.env*` / `.ssh/` / `*.pem` 等路径——本插件**不走**那条通道（原因见「安全说明」）。
4. **数据流（旧工具）**：远端会话调用工具 → host-core 按前缀判定为桌面分发 → 经已有隧道向桌面 Electron main 发 `plugins.execute` → 插件进程用 `node:fs` 执行读取 → base64 原路返回给远端会话 → agent 用远端 `Write` 落盘。
5. **数据流（0.4.0 直传）**：远端会话调用 `push_desktop_file_to_remote` → 桌面分发 → 插件进程用 `node:https` 直连 `remoteUrl`（TLS 字节流），**不经 LLM 上下文** → 远端 `receiver.py` 落盘；反向 `pull_remote_file_to_desktop` 同理 `GET` 远端后原子落盘。两端均走 sha256 校验。推荐链路为 `ssh -L` 本地转发（见下）。

```text
旧链路（base64 经 LLM）：
远端会话 agent ──调用 read_desktop_file──▶ 远端 host（前缀判定：不接管）
        │                                     │ 经已有隧道 plugins.execute
        │ ◀────────── base64 原路返回 ──────── ▼
        │                              桌面 Electron main → 插件进程（node:fs）
        ▼
远端 Write 落盘（+ sha256sum 校验一致性）

0.4.0 直传（字节不经 LLM，首选 ssh -L）：
远端会话 agent ──调用 push_desktop_file_to_remote(path, remoteUrl, token)──▶ 桌面插件进程
        │                                                              │
        │   node:https PUT http://127.0.0.1:9876/push/file.bin ───────▶│ 远端 127.0.0.1:9876 (receiver.py)
        │   Authorization: Bearer <token>, X-File-SHA256          ▲    │  ↑ 桌面 ssh -L 9876:127.0.0.1:9876 远端
        │◀──────── 200 + sha256 ──────────────────────────────────│    │
        ▼                                                         SSH 隧道
完成（远端 sha256sum 复核）— LLM 只传了 path 与 URL，无字节经过上下文
```

---

## 安全说明

> [!CAUTION]
> 本插件的权限边界 = **当前 Windows 用户的文件权限**——凡是你的账户能读、能改、能删的文件，它都能读、能改、能删。请只安装来源可信的插件，并确认你要授权的确实是这一个权限。

- 只声明 **`agent.tool.register`** 一个权限（属**高危**权限，宿主在安装/加载时会弹出确认，请显式批准）。
- **刻意不声明 `fs.read`**：声明了反而会被远端会话的工具中继排除，那样插件就失效了——桌面分发的前提是工具走插件通道而非宿主文件 API。
- 旧工具：不监听端口、不发起网络请求、不写外部服务；纯本地文件操作。
- 0.4.0 直传：`push`/`pull` 会主动发起 `http(s)` 请求到 **`remoteUrl`（无白名单，仅校验 `http(s)` 协议与长度）**，但**仅**当 agent 显式调用时才发起；**必须只对用户明确授权的目标使用**（否则可把桌面文件发到任意 URL）。`token` 推荐放 `Authorization: Bearer` 头（路径 token 兼容但会进访问日志，已在 receiver 侧遮蔽，仍不推荐），`token` 不回显到错误信息。
- **不要用它把 `.env`、token、Cookie、私钥等凭据读出来交给远端**。工具不会替你拦，边界在你手上。
- **写与删都要求调用方先拿到文件的 sha256 / size**（即先「看过」再改），并且返回值都带 before/after 供复盘。删除另有不可绕过的保护清单，见下。
- 直传安全：`remoteUrl` 长度上限 2048、`token` 长度 ≥16 且不含空白、单次 ≤50 MiB、超时 5–120s、拒绝重定向；`pull` 的覆盖保护与 `write` 一致（`expectedSha256` / `allowCreate`），并做 TOCTOU 复核与临时文件原子重命名。

---

## 安装

**方式一 · 开发加载**：PI-Desktop → 插件页 → **Load development plugin** → 选择本目录 → 在权限确认里授予 `agent.tool.register`。

**方式二 · 打包产物**：从 `dist/*.piplug` 安装（发行版挂在 GitHub Releases）。

> [!TIP]
> 开发插件的权限集以首次批准的 manifest 为上限。若之后 manifest 新增了权限，热重载会被宿主拒绝（`PERMISSION_DENIED`），需在插件页移除后重新加载一次。

---

## 用法

在远端会话里直接说「读一下桌面上的 X」，agent 会自己调用 `read_desktop_file` / `list_desktop_dir`；大文件由 `offset`/`length` 自动分块翻页（`eof` 为真即读完）。

典型场景：把桌面上的技能 / 配置 / 文档同步到远端工作区——

1. agent 调 `read_desktop_file` 分块读回 base64 并解码；
2. 用远端 `Write` 写入目标路径；
3. 远端跑 `sha256sum`，与桌面侧原文件的哈希比对，确认逐字节一致。

反向（远端 → 桌面）则用 `write_desktop_file`：远端 `Read` 拿到内容 → base64 → 写入桌面路径，并核对返回的 `before`/`after`。

 **0.4.0 大文件直传（推荐，字节不经 LLM）**：

 1. 远端生成 token 文件（不进 `ps`，权限 600）并起 receiver + 桌面建 SSH 转发（见“远端准备”首选）。
 2. 桌面 → 远端：`push_desktop_file_to_remote({ path: "C:/Users/me/big.bin", remoteUrl: "http://127.0.0.1:9876/push/big.bin", token: "<从 cat /tmp/dfr.token 取值，走 Authorization header>" })`，核对返回 `sha256` 与远端 `sha256sum /tmp/dfr/big.bin`。
 3. 远端 → 桌面：`pull_remote_file_to_desktop({ remoteUrl: "http://127.0.0.1:9876/pull/big.bin", path: "C:/Users/me/big.bin", token: "<同上>", allowCreate: true })`，核对 `sha256`。

 小文件（<1 MiB 文本）仍可用旧的 `write_desktop_file`；二进制/大文件请用直传。

 ### 远端准备（按可行性排序，一次性、可回滚、默认关闭）

 #### 首选：SSH 本地转发（零远端配置改动，复用既有 SSH 通道，推荐）

 远端（VPS）生成 token 文件并起 receiver（仅监听回环，凭据不进 `ps`）：

 ```bash
 umask 077 && openssl rand -hex 16 > /tmp/dfr.token
 python3 remote/receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr --token-file /tmp/dfr.token
 # 备选：DFR_RECEIVER_TOKEN=$(cat /tmp/dfr.token) python3 remote/receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr
 # 不推荐：--token $(cat /tmp/dfr.token)  # 明文会出现在 ps，仅调试用
 ```

 桌面（Windows，已有到远端的 SSH 条目）建转发：

 ```powershell
 ssh -L 9876:127.0.0.1:9876 <远端别名>
 # 或带 -N -f 后台：ssh -N -f -L 9876:127.0.0.1:9876 <远端别名>
 ```

 健康检查（需转发已建立）：`curl -i http://127.0.0.1:9876/health`

 关闭：远端 `pkill -f receiver.py` + `rm /tmp/dfr.token` + 桌面关闭 `ssh -L` 进程，无残留。


 #### 次选：经 1Panel OpenResty 反代到 127.0.0.1:9876（需用户授权改 nginx）

 远端同样先生成 token 文件并监听 `127.0.0.1:9876`：

 ```bash
 umask 077 && openssl rand -hex 16 > /tmp/dfr.token
 python3 remote/receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr --token-file /tmp/dfr.token
 ```

 另加一次性 nginx 配置（示例，默认不创建）：

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

 此时 `remoteUrl` 可为 `https://panel.example.com/dfr/push/file.bin`（走公网 TLS，需 `Authorization: Bearer $(cat /tmp/dfr.token)`）。

 #### 不推荐：绑 `0.0.0.0` 走公网

 ```bash
 umask 077 && openssl rand -hex 16 > /tmp/dfr.token
 python3 remote/receiver.py --bind 0.0.0.0:8765 --dir /tmp/dfr --token-file /tmp/dfr.token
 ```

 需防火墙放行端口，暴露面大，仅调试临时使用。

 #### 关于 `<mesh-ip>:8765`（easytier mesh）

 桌面当前**不在** mesh 内（mesh 仅 <mesh-peer-a>/2/5 三台 VPS），`http://<mesh-ip>:8765` 当前不可达。若需直连 mesh，需桌面安装 easytier 并加入同一 `network_name`/`network_secret`，获 `<mesh-cidr>` 后方可访问。

 > **凭据说明**：远端 token **不要**用 `--token $(openssl ...)` 形式（`ps` 可见）；请始终用 `umask 077 && openssl rand -hex 16 > /tmp/dfr.token` + `--token-file /tmp/dfr.token` 或 `DFR_RECEIVER_TOKEN=$(cat /tmp/dfr.token) python3 ...`；插件侧 `token` 参数取 `cat /tmp/dfr.token` 的值，走 `Authorization: Bearer` header，不进远端访问日志（路径 token 已做遮蔽但仍不推荐）。


---

## 验证记录

- **manifest 结构校验**：对照官方模板（`packages/plugin-devkit/src/templates.ts`）与 `packages/plugin-devkit/src/check.ts` 的规则（`contributes.agentTools` 必须同时声明 `agent.tool.register`）校验通过。
- **语法检查**：`main.js` 用容器里的 **node v22.16.0** 跑 `node --check`，通过；`remote/receiver.py` 用 `python3 -c "import ast;ast.parse(open(...).read())"` 校验，不写 `__pycache__`。
- **隔离运行时测试**：用 mock 的宿主 API 真实跑通 `onLoad` → 工具调用 → `onUnload`，**12 项断言全部通过**：
  注册两个工具、读文件 ok/eof/size、base64 解码长度、分块 offset/length/eof、分块内容与整体一致、列目录 ok/count、目录排在文件前、目录当文件读返回错误对象、空 path 返回错误对象、列目录空 path 返回错误对象、不存在路径抛 ENOENT、卸载清空注册。
- **端到端实测**：经插件读取桌面一个 18028 字节文件 → 落盘远端 → 远端 `sha256` 与桌面侧一致。
- **0.2.0**：新增 `write_desktop_file`；`node --check` 通过，逻辑测试 **14 项全部通过**（含全部拒绝路径）；官方 `pi-plugin check` = `OK … @0.2.0 — 3 files, 20.7 KB`。
- **0.3.0**：新增 `delete_desktop_file`；`node --check` 通过，隔离运行时测试 **43 项全部通过**（4 道门禁的全部拒绝路径、16 项保护清单用例、符号链接不跟随、目录不递归、`dryRun` 不落删、`confirm` 严格布尔、`expectedSize` 大文件路径）；官方 `pi-plugin check` = `OK io.github.duya07.desktop-file-reader@0.3.0`（3 个文件）；`pack` 产物挂在 Release `desktop-file-reader-v0.3.0`。测试脚本：[`tests/desktop-file-reader/delete-0.3.0.test.js`](../../tests/desktop-file-reader/delete-0.3.0.test.js)（在插件目录外，不参与打包）。
- **0.4.0**：新增 `push_desktop_file_to_remote` / `pull_remote_file_to_desktop`（HTTP 直传，字节不经 LLM）；`node --check` 通过；旧 43 项继续全过；新增直传测试覆盖全部拒绝路径与端到端；官方 `pi-plugin check` = `OK io.github.duya07.desktop-file-reader@0.4.0`。详见 `../upstream/VERIFICATION.md` 与 `../upstream/DESIGN-0.4.0.md`。

---

## 📄 许可

MIT，见仓库根目录 [LICENSE](../LICENSE)。

---

## 写工具：`write_desktop_file`

> [!CAUTION]
> **高危**。它能把任意内容写到你桌面上的任意路径。**只在用户明确授权某个具体路径时使用** ——
> 每次调用前先说明要改哪个文件、改什么、为什么、会影响什么，得到确认再动手。

### 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 桌面机上的绝对路径（必填） |
| `contentBase64` | string | 文件内容，**base64 编码**（必填） |
| `expectedSha256` | string? | **覆盖已存在文件时必填** —— 当前内容的 sha256（从 `read_desktop_file` 得到） |
| `allowCreate` | boolean? | **文件不存在时必填**，显式确认要新建 |

### 返回值

```json
{ "ok": true, "path": "C:\\...\\x.md", "action": "overwritten",
  "before": { "size": 123, "sha256": "..." },
  "after":  { "size": 456, "sha256": "..." } }
```

`before` / `after` 让调用方与用户都能复盘这次改动究竟动了什么。

### 防误操作（工具内置，不依赖调用方自觉）

- **覆盖已存在文件必须传 `expectedSha256`** —— 若文件在你读取之后被改动过，sha 不匹配，写入会被**拒绝**。
  这是乐观并发控制：读→改→写，中间有人动过就失败，而不是静默覆盖别人的修改。
- **新建文件必须传 `allowCreate: true`** —— 防止路径打错、意外创建垃圾文件。
- 单次写入上限 **4 MiB**；目标是目录或非常规文件时直接拒绝。

### 安全改一个文件的流程

```
1. read_desktop_file(path)                 → 内容 + 记下大小
2. 在远端改好内容，算出新的 base64
3. write_desktop_file(path, contentBase64, expectedSha256=<第 1 步文件内容的 sha256>)
4. 核对返回的 before / after
```

注意：第 3 步的 `expectedSha256` 是**当前文件内容**的 sha256（把第 1 步的 base64 解码后计算），
**不是**新内容的 sha256。

---

## 删除工具：`delete_desktop_file`

> [!CAUTION]
> **高危**。它能把桌面机上的文件删掉，**没有回收站**（`unlink` 语义，不经资源管理器）。
> **只在用户明确授权某个具体文件时使用** —— 调用前先说明要删哪个文件、为什么、会影响什么，得到确认再动手。
> 目录**不支持**（不做递归删除），这是设计上的取舍：递归删除的误伤半径不可控。

### 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 要删除的**单个文件**的绝对路径（必填） |
| `confirm` | boolean | **必填，必须为 `true`** —— 显式确认已复盘影响 |
| `expectedSha256` | string? | **首选护栏**：当前内容的 sha256（来自 `read_desktop_file`）；不匹配即拒绝 |
| `expectedSize` | number? | 备选护栏：当前字节数（来自 `list_desktop_dir`），适合没有整读的大文件 |
| `dryRun` | boolean? | 为 `true` 时只报告「将会删除什么」，**不执行删除、也不校验护栏参数** |

`expectedSha256` 与 `expectedSize` **至少要传一个**；两个都传则都必须匹配。

### 返回值

```json
{ "ok": true, "path": "C:\\...\\tmp.txt", "deleted": true,
  "before": { "size": 33, "sha256": "4392a2…", "mtimeMs": 1760000000000 },
  "verifiedGone": true }
```

预演（`dryRun:true`）返回 `{ "ok": true, "dryRun": true, "wouldDelete": { "size": …, "mtimeMs": … }, … }`。

### 四道门禁（全部在工具内实现，调用方无法绕过）

1. **保护清单** —— 命中即拒，没有任何开关可以关掉它：
   - 盘根本身（`C:\`、`D:\` …）；
   - 盘根下的 `Windows` / `Program Files` / `Program Files (x86)` / `ProgramData`（只匹配紧跟盘根的那一段，
     所以 `C:\Users\me\Windows\notes.txt` 不受影响）；
   - 路径中任意一段是 `.ssh` / `.gnupg` / `.aws` / `.pi-desktop`；
   - NTFS / 引导相关文件：`pagefile.sys`、`hiberfil.sys`、`swapfile.sys`、`bootmgr`、`BOOTNXT`、
     `ntldr`、`$MFT`、`$MFTMirr`、`$LogFile`、`$Boot`、`$Bitmap`、`$Secure`。
2. **类型必须是普通文件** —— 用 `lstat` 判定，**不跟随符号链接**：符号链接一律拒绝（避免顺着链接删到别处），
   目录一律拒绝（不递归），其他非常规文件（设备 / 管道等）一律拒绝。
3. **必须 `confirm: true`** —— 防止参数写错、模型误触发导致的静默删除。
4. **必须与「看过的内容」绑定** —— `expectedSha256`（首选）或 `expectedSize` 至少一个，
   且校验通过后还会复核 `size` / `mtime`（以及两边都可用时的 inode）未变，才真正 `unlink`，
   把 TOCTOU 窗口压到最小。

### 安全删一个文件的流程

```
1. list_desktop_dir(dir)                     → 确认要删的确实是这一个文件（名字、大小）
2. delete_desktop_file(path, dryRun=true)    → 预演，看清 willDelete 的内容
3. read_desktop_file(path)                   → 拿到内容并算出 sha256（大文件可跳过，改用第 1 步的 size）
4. delete_desktop_file(path, confirm=true, expectedSha256=<第 3 步的 sha256>)
5. 核对返回的 before 与 verifiedGone
```

### 已知边界

- **不走回收站**：删掉即不可恢复。真要留退路，先用 `read_desktop_file` 把内容取回远端保存。
- **不支持目录**：需要清空目录时，逐个文件删除（或由用户在桌面侧操作）。
- **Windows 只读文件**：`unlink` 可能因权限失败，此时工具返回 `ok:false` 与错误码，不会静默「成功」。

---

## 直传工具：`push_desktop_file_to_remote` / `pull_remote_file_to_desktop`

> [!CAUTION]
> **高危**。它们会让桌面主动发起 `http(s)` 请求到任意 `remoteUrl`（无白名单，仅校验协议与长度）。**只在用户明确授权某个具体路径与 URL 时使用**。

### 何时用 / 何时不用

- 二进制/大文件/对字节完整性要求高的场景 → 用直传。
- 小文本（<1 MiB）→ 仍可用 `write_desktop_file` / `read_desktop_file` 的 base64 链路。

### 远端接收端

仓库提供 `remote/receiver.py`（仅标准库）。它监听 `PUT /push/<name>` 与 `GET /pull/<name>`（`Authorization: Bearer <token>`），也兼容 `/push/<token>/<name>` 与 `/pull/<token>/<name>`（会进日志，不推荐），大小上限 50 MiB，`X-File-SHA256` 双向校验，日志已对路径 token 做遮蔽。详见 `../upstream/DESIGN-0.4.0.md` §4.4，远端准备见上“远端准备”。

### 安全约束（工具内置）

- `remoteUrl` 仅 `http(s)://`，**无白名单**（刻意取舍），长度 ≤2048；必须只对授权目标使用。
- `token` 若提供则 ≥16 字符且不含空白，推荐放 header，错误信息不回显 token 明文；路径 token 兼容但会进日志（已遮蔽，仍不推荐）。
- 单次 ≤50 MiB，超时 5–120s，拒绝重定向。
- `pull` 的覆盖/新建语义与 `write` 一致：已存在需 `expectedSha256`，不存在需 `allowCreate:true`；落盘前复核目标未变，原子 `rename`。

### 已知边界

- 单次 50 MiB 上限（与 nginx `client_max_body_size 50m` 对齐）；超大文件需分片或后续版本支持 `Range` 续传。
- 不支持 `file://`、`ftp://` 等非 http(s) 协议。
- 远端需有一个可达的 HTTP 端点（`receiver.py` 或你已有的文件服务）；推荐 `ssh -L` 转发到 `127.0.0.1:9876`，默认不常驻、可回滚。
