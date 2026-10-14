# 📄 Desktop File Reader · PI-Desktop 插件

[![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/duya07/pi-desktop-plugins/blob/main/LICENSE) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop)

> 让 **RACP Remote Host** 模式下的远端会话也能读写**桌面机**上的文件。注册四个在**桌面侧执行**的 agent 工具——`read_desktop_file`（分块读文件，返回 base64）、`list_desktop_dir`（列目录）、`write_desktop_file`（写入）、`delete_desktop_file`（删除）。

| 维度 | 说明 |
| --- | --- |
| **这是什么** | 四个 agent 工具：`read_desktop_file(path, offset?, length?)`、`list_desktop_dir(path)`、`write_desktop_file(path, contentBase64, …)`、`delete_desktop_file(path, confirm, …)` |
| **解决什么** | 远端会话的 `Read/Write/Edit/Glob/Grep/Bash` 全部在远端主机执行，读写不到桌面机的文件 |
| **怎么做到** | 插件工具按名字前缀被 host-core 分流到**桌面分发**分支，该分支排在「远端执行」之前——所以它们永远在桌面跑 |

---

## 为什么需要它

PI-Desktop 的 RACP Remote Host 模式下，agent 的工具调用（`Read/Write/Edit/Glob/Grep/Bash`）全部落在**远端主机**上执行：远端主机没有桌面机的磁盘，会话也就读不到桌面上的任何文件。此前唯一的读取通道是内置浏览器面板——它要求窗口保持前台，且不是给 agent 用的工具通道。

本插件利用 PI-Desktop 工具分发链的一个既有事实：**插件注册的工具永远在桌面侧执行**，哪怕会话绑定的是远端工作区。于是远端会话里 agent 调用 `read_desktop_file`，实际是在桌面机上读文件，内容以 base64 原路返回，agent 再用远端 `Write` 落盘，即完成「桌面文件 → 远端工作区」的搬运；反向的 `write_desktop_file` / `delete_desktop_file` 则用于把远端产物写回桌面、或清理桌面上的临时文件。

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

把 base64 内容写到桌面机的某个文件。**高危**，详见文末[写工具](#写工具write_desktop_file)一节。

### `delete_desktop_file(path, confirm, expectedSha256? | expectedSize?, dryRun?)`

删除桌面机上的**单个普通文件**。**高危**，四道门禁详见文末[删除工具](#删除工具delete_desktop_file)一节。

---

## 工作原理

1. **按工具名前缀分流，桌面分支排在远端分支之前。** host-core 的工具分发链按前缀判断：以 `plugin_` 或 `mcp_` 开头的工具被判为「桌面分发」（`crates/host-core/src/tools/mod.rs:961` 的 `is_desktop_dispatched`），而桌面分发分支（`crates/host-core/src/rpc/mod.rs:4226`）在代码顺序上**排在远端执行分支（`:4241`）之前**。所以插件注册的工具**永远在桌面执行**，哪怕会话绑定的是远端工作区。
   注意：这不是「远端反向请求桌面」那种反向 RPC——那条路确实没有实现；这里的机制是**远端 host 从一开始就没接管这个工具**。
2. **能跨到远端的只有 6 个工具。** `Read|Glob|Grep|Write|Edit|Bash`（见 `crates/host-core/src/rpc/remote_tools.rs:114`），其他工具名走到远端分支时直接返回 `CAPABILITY_UNAVAILABLE`——这正是插件工具必须由桌面分支先接走的原因。
3. **插件进程不是 OS 能力沙箱。** 插件入口跑在一个独立的 Node 进程里，官方文档说明它**目前不是** OS 级别的能力沙箱，因此 `node:fs` 能读到当前用户可读的任意路径。作为对照，宿主 API `pi.fs.readText` 走权限网关：受 `manifest.fs.read.scope` 限制，且无条件拒绝 `.env*` / `.ssh/` / `*.pem` 等路径——本插件**不走**那条通道（原因见「安全说明」）。
4. **数据流**：远端会话调用工具 → host-core 按前缀判定为桌面分发 → 经已有隧道向桌面 Electron main 发 `plugins.execute` → 插件进程用 `node:fs` 执行读取 → base64 原路返回给远端会话 → agent 用远端 `Write` 落盘。

```text
远端会话 agent ──调用 read_desktop_file──▶ 远端 host（前缀判定：不接管）
        │                                     │ 经已有隧道 plugins.execute
        │ ◀────────── base64 原路返回 ──────── ▼
        │                              桌面 Electron main → 插件进程（node:fs）
        ▼
远端 Write 落盘（+ sha256sum 校验一致性）
```

---

## 安全说明

> [!CAUTION]
> 本插件的权限边界 = **当前 Windows 用户的文件权限**——凡是你的账户能读、能改、能删的文件，它都能读、能改、能删。请只安装来源可信的插件，并确认你要授权的确实是这一个权限。

- 只声明 **`agent.tool.register`** 一个权限（属**高危**权限，宿主在安装/加载时会弹出确认，请显式批准）。
- **刻意不声明 `fs.read`**：声明了反而会被远端会话的工具中继排除，那样插件就失效了——桌面分发的前提是工具走插件通道而非宿主文件 API。
- 不监听任何端口、不发起任何网络请求、不写任何外部服务；纯本地文件操作。
- **不要用它把 `.env`、token、Cookie、私钥等凭据读出来交给远端**。工具不会替你拦，边界在你手上。
- **写与删都要求调用方先拿到文件的 sha256 / size**（即先「看过」再改），并且返回值都带 before/after 供复盘。删除另有不可绕过的保护清单，见下。

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

---

## 验证记录

- **manifest 结构校验**：对照官方模板（`packages/plugin-devkit/src/templates.ts`）与 `packages/plugin-devkit/src/check.ts` 的规则（`contributes.agentTools` 必须同时声明 `agent.tool.register`）校验通过。
- **语法检查**：`main.js` 用容器里的 **node v22.16.0** 跑 `node --check`，通过。
- **隔离运行时测试**：用 mock 的宿主 API 真实跑通 `onLoad` → 工具调用 → `onUnload`，**12 项断言全部通过**：
  注册两个工具、读文件 ok/eof/size、base64 解码长度、分块 offset/length/eof、分块内容与整体一致、列目录 ok/count、目录排在文件前、目录当文件读返回错误对象、空 path 返回错误对象、列目录空 path 返回错误对象、不存在路径抛 ENOENT、卸载清空注册。
- **端到端实测**：经插件读取桌面一个 18028 字节文件 → 落盘远端 → 远端 `sha256` 与桌面侧一致。
- **0.2.0**：新增 `write_desktop_file`；`node --check` 通过，逻辑测试 **14 项全部通过**（含全部拒绝路径）；官方 `pi-plugin check` = `OK … @0.2.0 — 3 files, 20.7 KB`。
- **0.3.0**：新增 `delete_desktop_file`；`node --check` 通过，隔离运行时测试 **43 项全部通过**（4 道门禁的全部拒绝路径、16 项保护清单用例、符号链接不跟随、目录不递归、`dryRun` 不落删、`confirm` 严格布尔、`expectedSize` 大文件路径）；官方 `pi-plugin check` = `OK io.github.duya07.desktop-file-reader@0.3.0`（3 个文件）；`pack` 产物挂在 Release `desktop-file-reader-v0.3.0`。测试脚本：[`tests/desktop-file-reader/delete-0.3.0.test.js`](../../tests/desktop-file-reader/delete-0.3.0.test.js)（在插件目录外，不参与打包）。

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
