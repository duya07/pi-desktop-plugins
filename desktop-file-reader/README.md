# 📄 Desktop File Reader · PI-Desktop 插件

[![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/duya07/pi-desktop-plugins/blob/main/LICENSE) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop)

> 让 **RACP Remote Host** 模式下的远端会话也能读写**桌面机**上的文件。注册六个在**桌面侧执行**的 agent 工具——`read_desktop_file`（分块读）、`list_desktop_dir`（列目录）、`write_desktop_file`（写入）、`delete_desktop_file`（删除）、`push_desktop_file_to_remote`（直传到远端）、`pull_remote_file_to_desktop`（从远端直传回桌面）。**0.4.0 起大文件走直传，字节不经 LLM；0.5.0 起直传默认走 SSH（sftp），零用户操作、零远端服务、零远端配置改动。**

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

**0.5.0 的修正**：0.4.0 的 HTTP 落地路径要求用户先手工建 `ssh -L` 隧道或改远端 nginx 配置——**任何每次使用前都要用户先做动作的方案等于不可用**，已被用户明确否决。0.5.0 给 push/pull 加 `mode` 参数：给定 `host`（ssh-config 别名）即默认走 **SSH（sftp）**，直接复用桌面**既有**的 SSH 配置与密钥，一次工具调用完成传输，**用户不做任何事、远端不起任何服务、不改任何配置**。HTTP 通道保留为 `mode:"http"`（远端已有 HTTP 端点时仍有用）。设计依据见 `DESIGN-0.5.0.md`。

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

### `push_desktop_file_to_remote(path, host?, remotePath?, port?, remoteUrl?, mode?, token?, expectedSha256?, timeoutMs?, method?)`

把桌面文件直传到远端，字节不经 LLM。**默认走 SSH**（给定 `host` 即走 SSH，`mode` 可省略）；`mode:"http"` 保留 0.4.0 通道。**高危**，只对用户明确授权的目标调用。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 桌面机上的绝对路径（必填）。**SSH 源路径**：不得含 `*` `?` `[`（保守拒绝，见“安全约束”） |
| `host` | string | SSH：ssh-config 别名（**推荐**，复用桌面既有配置与密钥）或 `user@host`；不含空格、不以 `-` 开头 |
| `remotePath` | string | SSH：远端绝对路径（以 `/` 开头），如 `/srv/transfer/file.bin`；`put` 会**覆盖**已存在的同名远端文件（与 scp 惯例一致）。目标侧不走 glob，`[` `*` `?` 均可用 |
| `port` | number? | SSH：TCP 端口（1–65535），ssh 配置里已有时可省 |
| `remoteUrl` | string | HTTP：目标 `http(s)://` URL（≤2048 字符），如 `https://example.com/dfr/push/file.bin` |
| `mode` | string? | `"ssh"`（默认，给定 `host` 时）或 `"http"`；两者参数都给了且未给 `mode` 时报歧义错误 |
| `token` | string? | 仅 HTTP：`Authorization: Bearer <token>`（≥16 字符才发送） |
| `expectedSha256` | string? | 可选：当前文件 sha256，推送前核对未变 |
| `timeoutMs` | number? | SSH 默认 300000ms（上限 1800000），HTTP 默认 60000ms（上限 120000）；SSH 超时会杀掉 sftp 进程 |
| `method` | string? | 仅 HTTP：`PUT` 或 `POST`，默认 `PUT` |

SSH 通道另有一条拒绝：`expectedRemoteSha256` 在 push 上无法兑现（不回读远端文件），传入即报错，不静默忽略。

行为：`lstat` 校验普通文件、拒绝符号链接 → 套 `expectedSha256` 乐观锁 → **SSH**：`sftp` 批处理 `put`（流式，字节不进 Node 内存），返回 `{ ok, transport:"ssh", host, remotePath, bytesSent, sha256 }`；**HTTP**：流式 `node:https` PUT/POST，头含 `X-File-SHA256`，拒绝重定向，要求 2xx，返回 `{ ok, bytesSent, sha256, remoteStatus, remoteBody }`。SSH 失败时 stderr 截断（4 KiB）回传。

### `pull_remote_file_to_desktop(path, host?, remotePath?, port?, remoteUrl?, mode?, token?, expectedRemoteSha256?, expectedSha256?, allowCreate?, timeoutMs?)`

从远端直传文件落盘到桌面路径，字节不经 LLM。**默认走 SSH**；`mode:"http"` 保留 0.4.0 通道。**高危**。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 桌面目标绝对路径（必填） |
| `host` | string | SSH：ssh-config 别名或 `user@host`（同 push） |
| `remotePath` | string | SSH：远端源文件绝对路径（以 `/` 开头）。**不得含 `*` `?` `[`**——sftp 会对 `get` 的远端源做 glob 展开（现代客户端会自行转义，老客户端/非 OpenSSH 实现不会），故保守拒绝 |
| `port` | number? | SSH：TCP 端口（1–65535），配置里已有时可省 |
| `remoteUrl` | string | HTTP：源 `http(s)://` URL |
| `mode` | string? | `"ssh"`（默认，给定 `host` 时）或 `"http"`；歧义时报错 |
| `token` | string? | 仅 HTTP：Bearer token（header） |
| `expectedRemoteSha256` | string? | HTTP：期望的远端内容 sha256（`X-File-SHA256` 头或落盘后比对）；SSH pull：与收到内容的 sha 比对，不匹配则不落盘并清理临时文件 |
| `expectedSha256` | string? | 覆盖已存在目标时必填（乐观锁，同 write） |
| `allowCreate` | boolean? | 目标不存在时必填 `true` 才创建 |
| `timeoutMs` | number? | 同 push（SSH 默认 300000 / HTTP 默认 60000） |

行为：校验目标（存在则需 `expectedSha256`，不存在则需 `allowCreate:true`，拒绝目录/符号链接）→ **SSH**：`sftp` 批处理 `get` 到同目录 `.<name>.tmp-<rand>`，算 sha → TOCTOU 复核 → 原子 `rename`，返回 `{ ok, transport:"ssh", bytesReceived, sha256, action }`；**HTTP**：`GET remoteUrl`（拒绝重定向，要求 2xx，`Content-Length` ≤50 MiB）后走同样的落盘收尾。失败时临时文件清理、stderr 回传。

### `list_ssh_hosts()`

列出桌面机 `~/.ssh/config` 里**具体**的 `Host` 别名，以及每个别名按 ssh 取值语义（每个选项取"第一个匹配块"的值）解析出的 `hostname` / `port` / `user`。只读、不联网、无参数；**不返回 `IdentityFile` 等密钥路径**。

返回 `{ ok, configPath, configExists, status, count, hosts[], note }`，其中 `hosts[]` 每项只有 `{ alias, hostname, port, user }`，`status` 三态见「使用前准备」一节。

设计意图：**插件从不自己挑主机**。别名由调用方给出、由桌面机的 ssh 客户端解析（含其 `IdentityFile`）——避免"猜错别名，把文件传到另一台机器"（`put` 是覆盖语义，猜错的代价不小）。所以标准流程是：`list_ssh_hosts` → 让用户选定 → 再调 push/pull。

> 返回的 `hostname` 是桌面机的真实连接地址（本机基础设施信息），它会随工具结果进入模型上下文。功能上必要——调用方得知道自己要连哪台机；若你的工作流对"地址进上下文"敏感，请自行权衡（`hosts[]` 里**不含** `IdentityFile` 等密钥路径，这一条是硬保证）。

---

## 工作原理

1. **按工具名前缀分流，桌面分支排在远端分支之前。** host-core 的工具分发链按前缀判断：以 `plugin_` 或 `mcp_` 开头的工具被判为「桌面分发」（`crates/host-core/src/tools/mod.rs:961` 的 `is_desktop_dispatched`），而桌面分发分支（`crates/host-core/src/rpc/mod.rs:4226`）在代码顺序上**排在远端执行分支（`:4241`）之前**。所以插件注册的工具**永远在桌面执行**，哪怕会话绑定的是远端工作区。
   注意：这不是「远端反向请求桌面」那种反向 RPC——那条路确实没有实现；这里的机制是**远端 host 从一开始就没接管这个工具**。
2. **能跨到远端的只有 6 个工具。** `Read|Glob|Grep|Write|Edit|Bash`（见 `crates/host-core/src/rpc/remote_tools.rs:114`），其他工具名走到远端分支时直接返回 `CAPABILITY_UNAVAILABLE`——这正是插件工具必须由桌面分支先接走的原因。
3. **插件进程不是 OS 能力沙箱。** 插件入口跑在一个独立的 Node 进程里，官方文档说明它**目前不是** OS 级别的能力沙箱，因此 `node:fs`/`node:http(s)` 能读到当前用户可读的任意路径。作为对照，宿主 API `pi.fs.readText` 走权限网关：受 `manifest.fs.read.scope` 限制，且无条件拒绝 `.env*` / `.ssh/` / `*.pem` 等路径——本插件**不走**那条通道（原因见「安全说明」）。
4. **数据流（旧工具）**：远端会话调用工具 → host-core 按前缀判定为桌面分发 → 经已有隧道向桌面 Electron main 发 `plugins.execute` → 插件进程用 `node:fs` 执行读取 → base64 原路返回给远端会话 → agent 用远端 `Write` 落盘。
5. **数据流（0.5.0 直传，默认 SSH）**：远端会话调用 `push_desktop_file_to_remote` → 桌面分发 → 插件进程在桌面 `spawn("sftp", [...])`（`BatchMode=yes`、`StrictHostKeyChecking=accept-new`），批处理 `put`/`get` 经**桌面既有 SSH 通道**直连远端，字节流式传输、**不经 LLM 上下文**；pull 落盘走临时文件 + sha 校验 + 原子 rename。零用户操作、零远端服务。`mode:"http"` 保留 0.4.0 的 HTTP 直连链路（需远端有 HTTP 端点）。

```text
旧链路（base64 经 LLM）：
远端会话 agent ──调用 read_desktop_file──▶ 远端 host（前缀判定：不接管）
        │                                     │ 经已有隧道 plugins.execute
        │ ◀────────── base64 原路返回 ──────── ▼
        │                              桌面 Electron main → 插件进程（node:fs）
        ▼
远端 Write 落盘（+ sha256sum 校验一致性）

0.5.0 直传（字节不经 LLM，默认 SSH，零用户操作）：
远端会话 agent ──调用 push_desktop_file_to_remote(path, host, remotePath)──▶ 桌面插件进程
        │                                                                  │
        │   sftp -b batch -o BatchMode=yes -o StrictHostKeyChecking=accept-new <host>  │
        │   batch: put "C:/Users/me/big.bin" "/srv/transfer/big.bin" ──────▶│ 远端 sshd（既有服务，无新配置）
        │◀────────── exit 0 + sha256 复核 ─────────────────────────────────│
        ▼
完成（远端 sha256sum 复核）— LLM 只传了 path 与 host/remotePath，无字节经过上下文
```

> 注：上图里的 `-o StrictHostKeyChecking=accept-new` 只在用户 `~/.ssh/config` **未对该 host 表态**时才传；用户写过 `yes`/`no` 时不传，由 ssh 按 config 决定。详见「安全说明」。

---

## 安全说明

> [!CAUTION]
> 本插件的权限边界 = **当前 Windows 用户的文件权限**——凡是你的账户能读、能改、能删的文件，它都能读、能改、能删。请只安装来源可信的插件，并确认你要授权的确实是这一个权限。

- 只声明 **`agent.tool.register`** 一个权限（属**高危**权限，宿主在安装/加载时会弹出确认，请显式批准）。
- **刻意不声明 `fs.read`**：声明了反而会被远端会话的工具中继排除，那样插件就失效了——桌面分发的前提是工具走插件通道而非宿主文件 API。
- 旧工具：不监听端口、不发起网络请求、不写外部服务；纯本地文件操作。
- 直传（SSH，0.5.0 默认）：`push`/`pull` 会在**桌面侧**启动一次 `sftp` 连到 `host`（ssh-config 别名），复用桌面既有 SSH 密钥；**仅**当 agent 显式调用时才发起，**必须只对用户明确授权的目标使用**。安全设计：不拼 shell 字符串（`spawn` argv 数组 + sftp 批处理协议，不经远端 shell 解析）；`host` 白名单字符集、禁止 `-` 开头（堵 ssh 选项注入）；`BatchMode=yes`（禁止交互，认证失败立刻报错，绝不卡住）；`StrictHostKeyChecking` **只在用户 `~/.ssh/config` 未对目标 host 表态时才补 `accept-new`**（首次记录指纹、指纹变化仍拒绝，绝不设 `no`；用户自己写了 `yes`/`no` 就不传 `-o`，由 ssh 按 config 决定。判定与 ssh 的 Host 匹配保持一致——**大小写敏感**）；`ConnectTimeout` 与整体超时（超时杀进程，不留僵尸）；失败时 sftp stderr 截断（4 KiB）回传，并附上 argv / batch 内容便于定位。
- 直传（HTTP，0.4.0 通道，`mode:"http"`）：`push`/`pull` 会主动发起 `http(s)` 请求到 **`remoteUrl`（无白名单，仅校验 `http(s)` 协议与长度）**，**必须只对用户明确授权的目标使用**。`token` 推荐放 `Authorization: Bearer` 头（路径 token 兼容但会进访问日志，已在 receiver 侧遮蔽，仍不推荐），`token` 不回显到错误信息。
- **不要用它把 `.env`、token、Cookie、私钥等凭据读出来交给远端**。工具不会替你拦，边界在你手上。
- **写与删都要求调用方先拿到文件的 sha256 / size**（即先「看过」再改），并且返回值都带 before/after 供复盘。删除另有不可绕过的保护清单，见下。
- 直传安全（SSH）：`host` 只允许 ssh-config 别名 / `user@host` 字符集；`remotePath` 必须绝对路径、不含控制字符——**不做目录前缀限制**（SSH 账号自身可写的范围就是边界，root 即整盘；前缀白名单只会挡活而提供不了真实保护）；`$`、反引号、`;` 等元字符在 sftp 批处理引号内是字面字符，不会被远端 shell 执行；pull 的覆盖保护与 `write` 一致（`expectedSha256` / `allowCreate`），TOCTOU 复核 + 原子 rename；`put` 覆盖已存在的远端文件（scp 惯例）。
- 直传安全（HTTP）：`remoteUrl` 长度上限 2048、`token` 长度 ≥16 且不含空白、单次 ≤50 MiB、超时 5–120s、拒绝重定向；`pull` 的覆盖保护与 `write` 一致（`expectedSha256` / `allowCreate`），并做 TOCTOU 复核与临时文件原子重命名。

---

## 使用前准备

只用 `read_desktop_file` / `list_desktop_dir` / `write_desktop_file` / `delete_desktop_file` 的话，**什么都不用准备**。

要用 `push_desktop_file_to_remote` / `pull_remote_file_to_desktop` 的 SSH 通道，桌面机需要满足**任意一条**：

1. 桌面机 `~/.ssh/config` 里有一个能连到目标主机的 `Host` 别名（推荐条目自带 `HostName` / `User` / `IdentityFile`）；或
2. 直接给 `user@host`，且桌面机的 ssh 能用默认密钥或 ssh-agent 完成认证。

**不准备会怎样**：不会只丢一句看不懂的错。agent 调 `list_ssh_hosts` 会拿到 `status` 与一句 `note`，据此告诉你"缺什么、下一步做什么"：

| `status` | 含义 | 会转达给你的话（大意） |
| --- | --- | --- |
| `ok` | 有可用别名 | 列出候选，请你选一个 |
| `no-concrete-aliases` | 配置文件在，但只有 `Host *` 这类通配条目 | 没有可指名的别名；请提供别名或 `user@host`，或自行加一条具体条目 |
| `no-config-file` | 桌面机没有 `~/.ssh/config` | 同上，并给出它找的具体路径 |

**插件自身不会创建或修改 `~/.ssh/config`**——没有这种逻辑，也不会替用户挑主机。想省事的话，可以让 agent 用 `write_desktop_file` 帮你补一条，但请当成"改一个能锁死你 SSH 访问的文件"来对待：先读原文、只追加、留备份、用 `expectedSha256` 绑定版本，并明确授权具体路径。

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

 **0.5.0 大文件直传（推荐：SSH，零用户操作，字节不经 LLM）**：

 0. 先调 `list_ssh_hosts()` 看桌面机有哪些别名可用（会给出每个别名的 `hostname`/`port`/`user`），**让用户选定**；别名不确定时不要猜。
 1. 桌面 → 远端：`push_desktop_file_to_remote({ path: "C:/Users/me/big.bin", host: "<remote-host>", remotePath: "/srv/transfer/big.bin" })`（`<remote-host>` 是桌面 `~/.ssh/config` 里**已有**的条目别名；无 mode 即默认 SSH）。核对返回 `sha256` 与远端 `sha256sum /srv/transfer/big.bin`。
 2. 远端 → 桌面：`pull_remote_file_to_desktop({ path: "C:/Users/me/big.bin", host: "<remote-host>", remotePath: "/srv/transfer/big.bin", allowCreate: true })`，核对返回 `sha256`。
 3. 全程不要求用户开隧道、改 nginx、起任何远端服务；认证走桌面既有 SSH 密钥，`BatchMode` 保证绝不交互卡住。

**0.4.0 HTTP 直传（保留，仅当远端已经存在可达的 HTTP 文件端点时）**：

1. 桌面 → 远端：`push_desktop_file_to_remote({ path: "C:/Users/me/big.bin", mode: "http", remoteUrl: "http://127.0.0.1:9876/push/big.bin", token: "<token>" })`，核对返回 `sha256` 与远端 `sha256sum`。
2. 远端 → 桌面：`pull_remote_file_to_desktop({ mode: "http", remoteUrl: "http://127.0.0.1:9876/pull/big.bin", path: "C:/Users/me/big.bin", token: "<token>", allowCreate: true })`，核对 `sha256`。
3. `127.0.0.1:9876` 只是示例；该端点由调用方自己的环境提供，本插件不代为搭建、也不要求用户为它做任何准备。

 小文件（<1 MiB 文本）仍可用旧的 `write_desktop_file`；二进制/大文件请用直传。

### 远端准备：**不需要**（0.5.0 默认 SSH 通道）

SSH 通道的设计目标就是**用户零操作**：

- 不改远端任何配置、不起任何远端服务、不开任何隧道、不装任何东西；
- 只复用桌面**既有**的 OpenSSH 客户端与 `~/.ssh/config`（`sftp` 自动读取配置与密钥），agent 一次工具调用完成传输；
- 唯一“前提”是 `host` 指向的 ssh-config 条目本来就能用密钥登录——而桌面本来就连着这台远端。若该条目需要交互输入密码或确认指纹，`BatchMode=yes` 会让它**立刻失败并给出明确错误**，而不是卡住等用户；这是刻意选择的行为。

> 0.4.0 曾把“用户手工 `ssh -L` 本地转发”或“改远端反代”写成落地步骤。**该前提已被用户否决**（任何每次使用前都要用户先做动作的方案等于不可用），相应指引已从本文档删除。为什么不可接受、SSH 通道如何保证安全，见 [`../upstream/DESIGN-0.5.0.md`](../upstream/DESIGN-0.5.0.md)。

HTTP 通道（`mode:"http"`）仍然保留，但它**要求远端已经存在一个可达的 HTTP 文件端点**（带 token 鉴权）。那属于调用方自己环境的既有条件，不在本插件的落地路径里，本文档不再给出任何“先让用户搭一遍”的步骤。

> **凭据说明（仅 HTTP）**：插件侧 `token` 参数走 `Authorization: Bearer` header，不进远端访问日志；**不要**把 token 写进 URL（路径 token 已做日志遮蔽，但仍不推荐）；远端也**不要**用 `--token $(...)` 形式传 token（会出现在 `ps` 里）。

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
- **0.5.0**：push/pull 新增 `mode` 参数，**默认走 SSH（sftp）**——零用户操作、零远端服务、零远端配置改动，HTTP 通道保留为 `mode:"http"`；`node --check` 通过；旧 43 项 + 旧 51 项继续全过；新增 SSH 测试 **45 项**（参数拼装、注入拒绝、超时杀进程、非零退出码与 stderr 回传、子进程清理，复核轮补的源路径 glob 拒绝、`expectedRemoteSha256`、批处理写失败、stderr 尾巴，以及 Windows 语义回归与“真实 sftp”实测）；官方 `pi-plugin check` = `OK io.github.duya07.desktop-file-reader@0.5.0`。详见 `../upstream/VERIFICATION.md` 与 `../upstream/DESIGN-0.5.0.md`。
- **0.5.1**：修掉 SSH 通道在 Windows 上**必然失败**的缺陷——插件进程由宿主以最小 env 启动，不含 `%ProgramData%`，而 Windows 版 `sftp`/`ssh` 启动时要读 `<ProgramData>\ssh\ssh_config`；缺失时 `sftp` 立即退出 **255 且 stdout/stderr 全空**，调用侧完全看不出原因（不是认证失败、远端 sshd 也没有连接记录）。修法：`spawn("sftp", …)` 显式补 `ProgramData`（缺省时由 `SystemRoot` 推导）。
  同版本另外三处：`delete_desktop_file` 的 `dryRun` 现在返回 `wouldDelete.sha256`（"预览 → 真删"不必再退到弱一档的 `expectedSize`）；`-o StrictHostKeyChecking=accept-new` 只在用户 `~/.ssh/config` **未表态**时才补（此前命令行会覆盖用户写的 `yes`，属安全降级）；新增只读工具 `list_ssh_hosts`。
  验证：`node --check` 通过；真机对照实验（最小 env 无修复 = 255 且零输出；补 `ProgramData` = exit 0，远端 sha256 与源文件逐字节一致）；ssh 取值语义探针（用户 config 显式设置 → `true`，未设置 → `false`）；`list_ssh_hosts` 三态逐分支实测；`dryRun` 返回的 sha256 与独立计算结果一致；`onLoad` 注册的 7 个工具名与 manifest 逐一对齐。

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
> **高危**。SSH 通道会以你的 SSH 身份在远端读写任意路径（无目录前缀限制），HTTP 通道会把桌面文件发到任意 `remoteUrl`。**只在用户明确授权某个具体路径与目标时使用**。

### 何时用 / 何时不用

- 二进制/大文件/对字节完整性要求高的场景 → 用直传。
- 小文本（<1 MiB）→ 仍可用 `write_desktop_file` / `read_desktop_file` 的 base64 链路。
- 默认用 **SSH**（`host` + `remotePath`）：零用户操作、零远端服务、零远端配置改动。
- 远端已有 HTTP 文件端点（如 `receiver.py` / 反代）且你愿意带 token 时 → `mode:"http"`。

### SSH 通道（0.5.0 默认）

- 桌面 → 远端：`sftp` 批处理 `put`；远端 → 桌面：`sftp` 批处理 `get`（落盘走临时文件 + sha + 原子 rename）。
- 只依赖桌面**既有**的 OpenSSH 客户端与 `~/.ssh/config`（sftp 自动读取配置与密钥），**不需要用户新做任何事**。
- 前提：`host` 条目已配好密钥认证（BatchMode 下密码认证会直接失败并给出明确错误——这正是设计目标，绝不交互卡死）。
- `put` 覆盖已存在的远端文件（scp 惯例）；远端路径不做前缀限制（SSH 账号权限即边界）。

### HTTP 通道（0.4.0 保留，`mode:"http"`）

仓库提供 `remote/receiver.py`（仅标准库）。它监听 `PUT /push/<name>` 与 `GET /pull/<name>`（`Authorization: Bearer <token>`），也兼容 `/push/<token>/<name>` 与 `/pull/<token>/<name>`（会进日志，不推荐），大小上限 50 MiB，`X-File-SHA256` 双向校验，日志已对路径 token 做遮蔽。详见 `../upstream/DESIGN-0.4.0.md` §4.4。**远端端点由调用方自行提供**：0.5.0 起默认走 SSH，任何“先让用户开隧道 / 改反代”的步骤都已从本文档移除。

### 安全约束（工具内置，两条通道共同）

- 不拼 shell 字符串；SSH 通道 `spawn` argv 数组 + sftp 批处理（不经远端 shell 解析）；HTTP 通道 `remoteUrl` 仅 `http(s)://`、长度 ≤2048。
- `host` 白名单字符集、禁止 `-` 开头；`remotePath` 必须绝对路径、不含控制字符。
- `BatchMode=yes` / `StrictHostKeyChecking=accept-new`（绝不设 `no`）/ 超时杀进程 / stderr 截断回传。
- `pull` 的覆盖/新建语义与 `write` 一致：已存在需 `expectedSha256`，不存在需 `allowCreate:true`；落盘前复核目标未变，原子 `rename`。
- **注入面**：`spawn("sftp", argv)` 不经 shell，用户输入只出现在两个位置——`host` 位置参数（白名单字符集 + 禁 `-` 开头，避免被当成 ssh 选项）与批处理文件内容（引号/反斜杠转义，且拒绝控制字符）；sftp 批处理本身不做 shell 展开，远端不参与解析。
- **源路径的 `*` `?` `[` 保守拒绝**：`put` 的**本地源**与 `get` 的**远端源**会被 sftp 做 glob 展开。现代 OpenSSH 客户端（≥7.9p1，2018）对**双引号参数**里的这些字符会自动转义、按字面匹配（已用真实 sftp 9.2p1 实测）；更老的客户端与非 OpenSSH 实现没有这层转义，会把它们当模式，可能**静默传错文件**。因此这两条源路径命中 `*` `?` `[` 时直接拒绝（fail closed，报错让调用方改名或换目录）。**反斜杠不在拒绝集内**——Windows 绝对路径必然含 `\`，且 `\` 由转义正确往返（实测确认）。`put`/`get` 的第二个参数（目标路径）不走 glob，不拦。
- **超时与收敛**：整体超时先 `SIGTERM`，5s 后 `SIGKILL`，最迟 15s 强制收敛（绝不留悬挂 Promise 或僵尸 ssh）；子进程 `exit` 后还要等 stdio 关闭（或最多 1s）才收尾，保证 stderr 尾巴（认证失败原因）不丢；stdout/stderr 各截断 4 KiB 回传。
- **`expectedRemoteSha256` 语义**：SSH **pull** 用收到内容的 sha 兑现；SSH **push** 无法回读远端文件，因此**显式拒绝**该参数而不是静默忽略（避免调用方误以为校验过）。

### 已知边界

- SSH 通道**无** 50 MiB 上限（那是 HTTP/nginx 的限制），大文件靠流式传输 + 超时（默认 5 分钟、上限 30 分钟）兜底；HTTP 通道仍 ≤50 MiB。
- SSH 通道要求桌面装有 OpenSSH 客户端（Windows 10 1809+ 自带）且 `host` 条目可用密钥认证；否则报错信息会明确给出原因。
- SSH 通道**保守拒绝**含 `*` `?` `[` 的**源**路径（见上“源路径的 `*` `?` `[` 保守拒绝”）；目标路径不受此限，反斜杠也不受限制。
- HTTP 通道不支持 `file://`、`ftp://` 等非 http(s) 协议，且需要远端有一个可达的 HTTP 端点。
