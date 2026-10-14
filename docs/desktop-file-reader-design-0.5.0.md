# desktop-file-reader 0.5.0 设计：SSH 直传（零用户操作）

版本：0.5.0 · 日期：2026-10-14 · 作者：fixer subagent

## 0. 为什么推翻 0.4.0 的落地路径

0.4.0 实现了 push/pull（HTTP 直传，字节不经 LLM），功能本身正确，但**落地路径有致命缺陷**：
DESIGN-0.4.0.md §4.4 把「首选」定为**用户手工建 SSH 本地转发**
（`ssh -L 9876:127.0.0.1:9876 <别名>`），次选为**改远端 nginx 配置**。

- 首选要求用户每次使用前先开一个 `ssh -L` 进程（或常驻后台转发）；
- 次选要求用户授权改远端反代配置并 `reload`。

用户明确否决了这个前提：**「我不要需要用户才能操作的路径」**——每次使用前都要用户先做动作的方案等于不可用。
这直接推翻了 0.4.0 设计文档里「首选 SSH 本地转发」的结论。

0.5.0 的目标：**agent 调一次工具就完成传输，用户不做任何事**。

### 已知环境事实（设计前提）

- 桌面（Windows）已有可用的 OpenSSH 客户端与到远端的配置：`C:/Users/me/.ssh/config` 里存在本主机条目，
  PI-Desktop 自身就是靠 SSH 隧道连接远端的（RACP 经 `127.0.0.1:35991`）。**不需要用户新增任何配置。**
- 插件跑在桌面 Node 进程里，**不是 OS 沙箱**（官方文档明确），可用 `node:child_process`。
- 远端：Linux root，有 `sshd`/`scp`/`sftp`/coreutils。
- 网络方向：桌面在 NAT 后，**远端不能主动连桌面**；只能桌面主动连远端——SSH 正好是这个方向。

## 1. 工具形态决策：给现有 push/pull 加 `mode` 参数（默认 SSH），不新增工具

候选 A：新增 `ssh_push_*` / `ssh_pull_*` 工具。
候选 B：现有 push/pull 加 `mode: "ssh" | "http"`，默认 SSH。

**选 B**，理由：

1. **对 agent 更不易选错**。传输能力是同一个意图（把文件搬到另一端），拆成两个工具会让 agent
   在「选哪个工具」上做决策，而选错的代价是失败重试；一个工具 + 一个参数，意图唯一，
   且**给定 `host` 时 mode 可省略**（自动推断为 ssh），最小化 agent 的决策面。
2. **对旧接口不破坏**。0.4.0 的调用（只带 `remoteUrl`）在无 mode 时仍推断为 http，
   旧 51 项测试**原样全过**；新调用（带 `host`）自动走 ssh，agent 无需显式 mode。
3. **校验与收尾逻辑复用**。`pullTargetGuard` / `finalizePulledFile`（乐观锁、TOCTOU 复核、
   原子 rename、sha 终核）对两条通道是同一套语义，新工具会造成双份维护。

`mode` 决议规则（`resolveTransferMode`）：

- 显式 `mode:"ssh"|"http"` 直接生效，其余值报错；
- 未给 mode：给了 `host` → ssh；给了 `remoteUrl` → http；两者都给了 → 报歧义错误（要求显式 mode）；
- 两者都没给 → 报错并提示用法。

manifest 的 `required` 相应从 `["path","remoteUrl"]` 放宽为 `["path"]`（传输目标由代码校验并给出可读错误）。

## 2. 传输载体决策：sftp 批处理（不用 scp，更不用 `ssh <host> <cmd>`）

| 载体 | 判定 | 理由 |
|---|---|---|
| `ssh <host> <cmd>` | **不用** | 远端命令经远端 shell 解析，参数转义做错就是命令注入；需要严格的字符白名单才能安全，风险面不必要 |
| `scp` | **不用** | 老式 SCP 协议（`-O`）会把远端路径交给远端 shell；新式默认走 SFTP 但客户端版本差异大（Windows 各版本行为不一），且本地/远端路径都要做 shell 级转义 |
| `sftp -b <batch>` | **用** | 恒走 SFTP 协议：远端路径是协议字段，**远端 shell 完全不参与解析**；批处理文件只有 `put`/`get` 两条命令，本地参数由 sftp 自己的解析器处理（引号 + 反斜杠转义，无任何 shell 展开） |

`sftp` 与 `scp` 同属 OpenSSH 套件、同读 `~/.ssh/config`、同用既有密钥——复用桌面配置的目标不变，
但把「路径是否会经过远端 shell」这个注入面直接消灭在协议选择里。

## 3. 安全设计（逐条理由）

### 3.1 命令注入防护：不拼 shell 字符串，argv 数组 + 批处理协议

- `spawn("sftp", args, { shell: false })`：**不经过任何 shell**，argv 逐元素传递；
- 所有 `-o` 选项值是**本文件内常量**（`BatchMode=yes`、`StrictHostKeyChecking=accept-new`、`ConnectTimeout=10`），
  用户输入进不了选项位置；
- 用户输入只有两个去处：
  1. **host**（位置参数）——白名单字符集 `[A-Za-z0-9._@-]`（可选 `[IPv6]`），长度 ≤253，
     **禁止 `-` 开头**（否则会被 ssh/sftp 解析成选项，`-oProxyCommand=...` 即由此注入）；
  2. **批处理文件内容**——路径用 `"` 包裹、`\` 与 `"` 反斜杠转义（`quoteBatchArg`），
     控制字符（`\x00-\x1f`、`\x7f`）在入口拒绝（保证批处理永远单行、格式完整）；
- 因此 `$`、反引号、`;`、`|` 等元字符**允许出现且按字面处理**——sftp 批处理解析器只做分词与引号处理，
  不做 shell 展开，远端更没有 shell 参与。靠「字符黑名单」拒绝它们反而会挡住含这些字符的合法文件名，
  所以这里**刻意不做**元字符黑名单，安全性来自协议选择而非黑名单（黑名单思维在此是安全剧场）。

### 3.2 禁止交互卡死：`BatchMode=yes`

- `BatchMode=yes` 让 ssh 在需要密码/口令短语/任何提示时**直接失败退出**（非零退出码 + stderr），
  而不是挂起等待输入——agent 得到明确错误而不是永远卡住；
- 代价：密码认证的条目不可用（报「Permission denied (publickey)」）。这是**有意取舍**：
  零用户操作与交互提示天然互斥；本环境的桌面到远端是密钥认证（PI-Desktop 自身隧道同源），不受影响。

### 3.3 `StrictHostKeyChecking`：`accept-new`，绝不设 `no`

- `no` 会关闭主机指纹校验，等于把 SSH 的 MITM 防线拆掉——**不用**；
- `yes`（严格）要求 host 已在 `known_hosts` 里：首次连接会失败并要求用户操作，违反零用户操作目标；
- `accept-new`（OpenSSH ≥7.6，Windows 10 1809+ 自带版本满足）：**未知 host 自动记录指纹（TOFU，
  与用户手工首次确认等价的行为自动化），已记录 host 的指纹一旦变化仍拒绝**——MITM 防线在第一次连接之后完全保留。
  本环境桌面 `known_hosts` 已含该主机（PI-Desktop 隧道同源），实际行为等同 `yes`。
- 若桌面 ssh 版本过旧不支持 `accept-new`，sftp 会非零退出并把原因回传到 stderr——可诊断，不会静默降级。

### 3.4 超时与进程清理

- `ConnectTimeout=10` 只约束 TCP 建连；
- **整体超时**（SSH 默认 300s、上限 1800s）由插件自己的计时器约束：到时 `child.kill()`（POSIX SIGTERM，
  Windows 上是 TerminateProcess，不经 shell），5s 宽限后补 `SIGKILL`，最迟 15s 强制收敛
  ——**Promise 绝不悬挂、不留僵尸**；
- 未启用 `ControlMaster`/`ControlPersist`，sftp 退出即连接关闭，**没有后台常驻进程**；
- 批处理临时文件（`os.tmpdir()/.dfr-sftp-<rand>.batch`，0600）在传输结束后**立即删除**（含失败与超时路径，`finally`）；
  写不进去则直接返回结构化错误、不 spawn（见 3.7）。

### 3.5 远端路径边界：不做目录前缀限制（刻意）

只要求 `remotePath` 是绝对路径（`/` 开头）、无控制字符、长度 ≤4096。**不加** `/srv/transfer/` 之类的前缀白名单。理由：

1. **前缀白名单提供不了真实保护**：通道的权限边界本来就是远端 SSH 账号自己的文件权限
   （本环境是 root，即整盘）。在 root 账号上做前缀限制是安全剧场——绕过的意义为零，
   因为账号本来就能读写任何路径；
2. **会挡住合法工作流**：用户要传的就是「任意目标路径」（工作区、数据目录、临时目录……），
   前缀限制要么形同虚设（前缀太宽）要么每次都要用户改配置（又回到「需要用户操作」）;
3. 真正的防护是**使用纪律**（与插件其余工具一致：只对用户明确授权的路径调用）+ 工具返回的
   `remotePath`/`sha256` 供复盘。这与 0.3.0 删除工具「无绕过开关的保护清单」不同：
   删除是**不可逆破坏**需要硬护栏；上传到 root 可写的地方不引入新权限，只引入需授权的使用。

`put` 覆盖已存在的远端文件（scp/sftp 惯例），文档明示。

### 3.6 流式：字节不经 LLM、不进 Node 内存

- push：sftp 直接从桌面磁盘读文件走 SSH 隧道，Node 侧零文件内容缓冲（只算一次 sha256，分块流式）；
- pull：sftp 直接写同目录 `.<name>.tmp-<rand>` 临时文件 → 落盘后 sha 校验 → TOCTOU 复核 → 原子 `rename`，
  失败路径清理临时文件；
- 无 50 MiB 上限（那是 HTTP/nginx 的限制），超大文件靠流式 + 超时兜底。

### 3.7 错误可诊断：stderr 截断回传 + 等 stdio 排空才收尾

- sftp 的 stdout/stderr 各截断 4 KiB，失败时放进返回对象（`sftpStderr`/`sftpStdout`），
  连同 `exitCode`/`signal`/`timedOut`/`killed` 一起回传——用户看到的不只是「失败」，而是
  `Permission denied (publickey).`、`No such file or directory`、超时等具体原因；
- **收尾时机**：Node 的 `'exit'` 事件可能在 stdout/stderr 关闭**之前**触发，若在 `'exit'` 上直接收尾会丢掉
  stderr 的最后一段——而认证失败原因恰好就在最后。实现改为等 `'close'`（stdio 关闭后的事件），
  并保留兜底：`'exit'` 之后最多再等 1s（`KILL_DRAIN_MS`），避免 `ProxyCommand` 之类留下持有 fd 的子进程时无限等待；
- spawn 失败（如 PATH 里没有 sftp）返回明确错误：「sftp executable not found on PATH (OpenSSH client is required)」；
- **批处理文件写失败**（临时目录不可写 / 磁盘满）返回结构化错误 `could not write the sftp batch file …`，
  不让异常穿透成未捕获拒绝（调用方拿到的是 `{ok:false, error}` 而不是栈）。

### 3.8 主机标识：ssh-config 别名优先

- **推荐/默认**：`host` 直接填桌面 `~/.ssh/config` 里的**别名**（如 `<remote-host>`）——
  sftp 自动读取配置里的 HostName/User/Port/IdentityFile，**agent 不需要知道 IP、用户名、密钥路径**，
  也不需要在参数里携带这些；
- 也接受 `user@host` 形式与可选 `port`（`-P`）参数（配置里没有时才需要）；
- 校验：白名单字符集、≤253 字符、禁止 `-` 开头（见 3.1）。错误信息会解释允许的格式。

### 3.9 sftp 批处理参数的转义与 glob 语义（源码核对 + 真实 sftp 实测）

- 批处理行形如 `put "<本地源>" "<远端目标>"` / `get "<远端源>" "<本地目标>"`；引号内 `\` 与 `"` 由 `quoteBatchArg` 转义（每个 `\` 写成 `\\`、每个 `"` 写成 `\"`），控制字符在入口拒绝。
- **已用真实 sftp 实测**（OpenSSH 9.2p1，用 `sftp -D <本地假 SFTP 服务端>` 直接观察客户端发出的协议请求，见 `test/ssh-0.5.0.test.js` 的“真实 sftp”用例）：
  - 本地源路径含反斜杠（`…/C:\Users\me\report.pdf`，与 Windows 绝对路径同形状）→ 服务端收到的 WRITE 数据就是该文件的字节：**反斜杠没有被吃掉**，路径往返精确；
  - 目标路径含 `[` 与 `*`（`/dest/a[1]*b.bin`）→ 服务端收到的 OPEN 路径就是字面值：**目标侧不被 glob**（`undo_glob_escape` 往返精确）。
- **源码核对**（`sftp.c`；V_7_9_P1 / V_8_0_P1 / V_8_4_P1 / V_9_0_P1 / V_9_1_P1 / V_9_2_P1 / master 一致）：`makeargv` 对**双引号内**出现的 `?`/`[`/`*` 会自动补一个 `\`（注释即 “escape quoted glob(3) wildcards”），随后 `glob()` 把这一层反斜杠当转义处理 → 引号内的通配符最终按**字面**匹配。本插件**始终**把两个路径写成双引号参数，所以在 7.9p1 及以后的客户端上，源路径里的 `*?[` **不会**被展开成另一个文件。
- 那为什么仍然拒绝源路径里的 `*?[`（`rejectGlobMeta`）？这是**保守取舍**，不是在修一个可复现的错传：
  - 上述“自动转义”是客户端实现细节：**7.9p1（2018-10）之前**的客户端、以及非 OpenSSH 的 sftp 实现没有它，那种情况下源路径里的 `*?[` 会被 `glob()` 展开，可能命中同名模式匹配项而**静默传错文件**（最难发现的一类事故）；
  - 代价只是“源路径不能含 `*?[`”这一条限制（Windows 文件名里唯一合法的是 `[`），换来的是与客户端版本/实现无关的确定性；
  - 若日后确认目标环境只用现代 OpenSSH 客户端，可以把这条限制放宽——届时删掉两处 `rejectGlobMeta` 调用即可，语义不受影响。
- **反斜杠绝不在拦截集内**：Windows 绝对路径必然含 `\`，拦它等于 push 全废；`\` 由 `quoteBatchArg` 正确转义，已由上面的实测证明。实现上刻意用字符数组 `SFTP_GLOB_META = ["*", "?", "["]` 而不是正则字符类——正则写法 `[*?\[]` 里的 `\[` 极易被误读成“类里含反斜杠”（本轮就发生过一次误判）。
- 目标侧（`put`/`get` 的第二个参数）不走 glob（`undo_glob_escape`），因此不拦 `*?[`。
- 证据等级：多版本源码一致 + 真实 sftp 9.2p1 实测；**未**在 Windows OpenSSH 上实测（见 §6）。
## 4. 接口契约（0.5.0）

```
push_desktop_file_to_remote(path, host?, remotePath?, port?, remoteUrl?, mode?, token?, expectedSha256?, timeoutMs?, method?)
pull_remote_file_to_desktop(path, host?, remotePath?, port?, remoteUrl?, mode?, token?, expectedRemoteSha256?, expectedSha256?, allowCreate?, timeoutMs?)
```

- `required: ["path"]`（传输目标由代码校验，报错信息说明两种用法）；
- SSH 成功返回：`{ ok, transport:"ssh", host, remotePath, bytesSent|bytesReceived, sha256, action(pull) }`；
- HTTP 成功返回不变（0.4.0 语义）；旧 4 工具语义不变；权限仍仅 `agent.tool.register`；
- SSH **源路径**不得含 `*` `?` `[`（见 3.9）；`expectedRemoteSha256` 在 SSH pull 上兑现、在 SSH push 上被显式拒绝。

**真实调用示例（agent 侧）**：

```json
// 桌面 → 远端（零用户操作）
{
  "path": "C:/Users/me/Documents/report.pdf",
  "host": "<remote-host>",
  "remotePath": "/srv/transfer/report.pdf"
}

// 远端 → 桌面
{
  "path": "C:/Users/me/Downloads/report.pdf",
  "host": "<remote-host>",
  "remotePath": "/srv/transfer/report.pdf",
  "allowCreate": true
}
```

## 5. 测试与验证

容器 `node:22-bookworm-slim` 内：

- `node --check main.js` 通过；
- 旧 43 项（delete-0.3.0）与旧 51 项（transfer-0.4.0）**原样全过**（无 mode 的旧调用推断为 http）；
- 新增 `ssh-0.5.0.test.js` **45 项**：假 `sftp` stub（记录 argv/batch，可模拟 copy / fail / hang / late）验证
  argv 拼装（`-b` / `-o BatchMode=yes` / `-o StrictHostKeyChecking=accept-new` / `-o ConnectTimeout=10` / `-P` / host 位置参数）、
  批处理转义往返、注入字符拒绝、mode 决议、非零退出码与 stderr 回传、超时杀进程（stub pid 消失）、
  tmp 清理、sftp 缺失报错，以及复核阶段新增的四类：**源路径 glob 元字符拒绝**、
  **`expectedRemoteSha256`（SSH pull 兑现 / SSH push 显式拒绝）**、**批处理文件写失败返回结构化错误**、
  **stderr 尾巴（父进程退出后子进程续写）也被捕获**；
- 上述四类修复都做了**红/绿对照**：把收尾改回 `'exit'`、关掉 glob 拦截、让批处理写失败抛异常、
  让 `expectedRemoteSha256` 静默忽略，各自都能让对应新用例变红（原始输出见 VERIFICATION.md）；
- 官方 `pi-plugin check` OK、`pack` 产物 sha256 记录于 VERIFICATION.md。

## 6. 未验证项（需真机确认）

- **真实 Windows 桌面 + 真实远端**的端到端传输：stub 测试证明的是参数拼装与进程管理，
  未证明 Windows OpenSSH 的 sftp 在真实配置下工作（以下各点同理，均为推断/未验证）：
  - Windows sftp 读 `%USERPROFILE%\.ssh\config` 与 known_hosts 的实际行为（OpenSSH 行为一致，推断成立）；
  - `accept-new` 在桌面 ssh 版本上的可用性（要求 OpenSSH ≥7.6；若报错，stderr 会说明原因）；
  - 大文件（GB 级）经 SSH 隧道的速率与 30 分钟上限是否够用；
  - 插件进程环境变量是否继承 USERPROFILE/HOME（spawn 继承 PI-Desktop 进程环境，推断成立）。
- **Windows 侧未实测**：`put` 的本地源路径 glob 由**桌面侧** sftp 执行。本轮用 Linux OpenSSH 9.2p1
  以 `-D` 假服务端实测了“反斜杠路径往返精确”与“引号内通配符按字面匹配”，但**未**在 Windows OpenSSH 上实测；
  按源码（7.9p1…master 一致）行为应相同。
  源码结论 fail-closed 拒绝，因此不会「该拦没拦」，只可能对极少数合法文件名（Windows 文件名里
  唯一合法的是 `[`）产生过度拒绝。
- **批处理临时文件在 Windows 下的权限**：`fsp.writeFile(..., { mode: 0o600 })` 在 Windows 上不生效，
  实际 ACL 由用户 Temp 目录继承；文件内容只有路径、无凭据，且用完即删。未在真机核对 ACL。
- LLM 侧真实调用 push/pull 的集成（仅工具层测试，未走 PI-Desktop 宿主分发链）。
- 宿主对 `required:["path"]` 放宽后的 schema 校验行为（若宿主强制 required 与旧 manifest 一致，
  真机需在插件页重新加载一次以应用新 manifest）。
