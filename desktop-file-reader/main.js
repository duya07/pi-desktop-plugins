/**
 * 桌面文件读写删 — PI-Desktop 插件入口。
 *
 * 让所有工具都在远端执行的会话（RACP Remote Host）能够读取、写入与删除**桌面机**上的文件，
 * 从而不再依赖内置浏览器面板。
 *
 * 为什么用原生 node:fs 而不是宿主 API：
 *   - `pi.fs.readText` / `pi.fs.writeText` 受 `manifest.fs.*.scope` 限制，且无条件拒绝
 *     `.env*`、`.ssh/`、`*.pem` 以及应用自身数据目录；
 *   - 插件入口跑在自己的 Node 进程里，官方文档明确说明它**目前不是 OS 能力沙箱**，
 *     所以原生 `node:fs` 能到达当前用户可读写的任何路径。
 * 因此本插件的权限边界就是**用户自己的文件权限**。请只加载可信来源的插件。
 *
 * 写操作的安全设计（防误操作，不依赖调用方自觉）：
 *   - 覆盖**已存在**文件时必须提供 `expectedSha256`（来自 read_desktop_file）；
 *     文件在读取之后被改动过则写入被拒绝（乐观并发控制）。
 *   - **新建**文件必须显式传 `allowCreate: true`。
 *   - 返回值包含操作前后的 size 与 sha256，便于事后复盘。
 *
 * 删除操作的安全设计（四道门，任一不满足即拒绝）：
 *   1. 路径必须落在**保护清单之外**（盘根、Windows/Program Files/ProgramData、
 *      .ssh/.gnupg/.aws/.pi-desktop、NTFS 系统文件……）——没有绕过开关；
 *   2. 目标必须是**普通文件**：符号链接一律拒绝（不跟随），目录一律拒绝（不做递归）；
 *   3. 必须传 `confirm: true`（显式确认已复盘影响）；
 *   4. 必须传 `expectedSha256`（首选）或 `expectedSize`，与调用方**看过的内容**绑定；
 *      校验通过后还会复核 size/mtime/inode 未变才真正 unlink（缩小 TOCTOU 窗口）。
 *   另支持 `dryRun: true` 只预演不删除。
 *
 * 传输重构（0.4.0）：
 *   - `push_desktop_file_to_remote` / `pull_remote_file_to_desktop` 通过 HTTP(S) 直传字节，
 *     字节不经 LLM 上下文，避免长 base64 失真；桌面主动发起，适配“远端不能连桌面”的网络约束。
 * 传输重构（0.5.0）：
 *   - push/pull 新增 `mode` 参数（可选）：给定 `host` 时默认走 **SSH（sftp 批处理）**，
 *     给定 `remoteUrl` 时走 HTTP；显式 `mode:"http"` 保留 0.4.0 通道。
 *   - SSH 通道零用户操作：直接复用桌面既有 `~/.ssh/config` 与密钥（sftp 自动读取），
 *     不再要求用户先手工建 `ssh -L` 隧道或改远端 nginx；也不起任何远端服务。
 *   - 参数注入面：host 白名单 + 禁 `-` 开头（位置参数，避免被解析成 ssh 选项）；
 *     远端路径只拒绝控制字符（不经过远端 shell，sftp 批处理不做 shell 展开）。
 *   - sftp 会对 `put` 的本地源路径与 `get` 的远端源路径做 glob 展开，而双引号参数
 *     无法表达字面 `*` `?` `[`，因此这两条路径命中 glob 元字符即拒绝（见 rejectGlobMeta）。
 *   - 超时先 SIGTERM 再 SIGKILL，最迟 15s 收敛；stdout/stderr 各截断 4 KiB 回传。
 */
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const { spawn } = require("node:child_process");
const MAX_CHUNK = 1024 * 1024; // 单次读取上限 1 MiB
const DEFAULT_CHUNK = 256 * 1024;
const MAX_WRITE = 4 * 1024 * 1024; // 单次写入上限 4 MiB
const MAX_HTTP_BYTES = 50 * 1024 * 1024; // HTTP 单次传输上限 50 MiB（与 nginx client_max_body_size 对齐）
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MIN_TIMEOUT_MS = 5 * 1000;
const MAX_TIMEOUT_MS = 120 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;


// SSH（sftp）通道参数
const SSH_TIMEOUT_DEFAULT_MS = 300 * 1000; // 默认 5 分钟（大文件可能超过 HTTP 的 60s）
const SSH_TIMEOUT_MAX_MS = 30 * 60 * 1000; // 上限 30 分钟
const SSH_CONNECT_TIMEOUT_S = 10; // 仅 TCP 建连；整次传输由下面的整体超时约束
const SSH_STRICT_HOST_KEY_CHECKING = "accept-new"; // 首次 TOFU，已记录的 key 变化仍拒绝；绝不设 no
const SFTP_IO_CAP = 4 * 1024; // sftp stdout/stderr 回传截断上限（错误可诊断，又不无限膨胀）
const MAX_REMOTE_PATH_LEN = 4096;
const MAX_HOST_LEN = 253;
const KILL_GRACE_MS = 5000; // SIGTERM 后等待退出的宽限
const KILL_HARD_CEILING_MS = 15000; // 宽限后仍不退出则强制收敛，绝不让 Promise 悬挂
const KILL_DRAIN_MS = 1000; // 子进程 exit 后最多再等 1s 收完 stdout/stderr 尾巴（见 runSftpTransfer）
// sftp 会对“put 的本地源路径”和“get 的远端源路径”做 glob 展开（源码核对见 DESIGN-0.5.0.md §3.9），
// 而批处理的双引号参数无法表达字面 * ? [ —— 命中即拒绝（fail closed），避免静默传错文件。
// **反斜杠必须不在拦截集内**：Windows 的绝对路径必然含 `\`（如 `C:\Users\me\f.txt`），拦它会让 push
// 在 Windows 上 100% 失败。`\` 是转义字符而非 glob 元字符：quoteBatchArg 把每个 `\` 写成 `\\`，
// 下游 makeargv / glob / undo_glob_escape 都恰好反转义一层，往返精确（见 §3.9 与 ssh-0.5.0.test.js）。
// 这里刻意用字符数组而不是正则字符类——正则写法 `[*?\[]` 里的 `\[` 极易被误读成“类里含反斜杠”。
const SFTP_GLOB_META = ["*", "?", "["];
// 删除工具的保护清单：这些路径"删了就出事"，无条件拒绝，且没有参数可以绕过。
// ---------------------------------------------------------------------------

/** 盘根目录下第一段命中即拒绝（大小写不敏感）。 */
const PROTECTED_ROOT_DIRS = ["windows", "program files", "program files (x86)", "programdata"];
/** 路径中任意一段命中即拒绝（用户级敏感目录）。 */
const PROTECTED_SEGMENTS = [".ssh", ".gnupg", ".aws", ".pi-desktop"];
/** 文件名命中即拒绝（NTFS / 引导相关系统文件）。 */
const PROTECTED_BASENAMES = [
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "bootmgr",
  "bootnxt",
  "ntldr",
  "$mft",
  "$mftmirr",
  "$logfile",
  "$boot",
  "$bitmap",
  "$secure",
];

function isFilesystemRoot(s) {
  const t = String(s).trim().replace(/\\/g, "/");
  return /^[a-zA-Z]:\/?$/.test(t) || /^\/+$/.test(t);
}

/** 去掉盘符与前导斜杠，返回小写的路径分段。 */
function pathSegments(s) {
  return String(s)
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

/**
 * 命中保护清单时返回原因字符串，否则返回 null。
 *
 * 同时检查**调用方给的原始路径**与 `path.resolve` 后的绝对路径：
 * `C:/Windows/...` 这类路径在非 Windows 平台上 resolve 会被加上工作目录前缀，
 * 只看 resolve 结果会漏判。
 */
function protectedReason(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isFilesystemRoot(candidate)) return "refusing to delete a filesystem root";

    const segs = pathSegments(candidate);
    if (!segs.length) continue;

    // 系统目录：只看根之后的第一段，避免误伤 C:/Users/me/Windows/foo.txt 这类同名目录
    if (PROTECTED_ROOT_DIRS.includes(segs[0])) {
      return "refusing to delete inside the protected system directory '" + segs[0] + "'";
    }

    const hitSegment = segs.find((s) => PROTECTED_SEGMENTS.includes(s));
    if (hitSegment) {
      return "refusing to delete inside the protected directory '" + hitSegment + "'";
    }

    const base = segs[segs.length - 1];
    if (PROTECTED_BASENAMES.includes(base)) {
      return "refusing to delete the protected system file '" + base + "'";
    }
  }
  return null;
}

async function sha256OfFile(abs) {
  const h = crypto.createHash("sha256");
  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP 直传共用校验
// ---------------------------------------------------------------------------

/** 校验 remoteUrl 合法性，返回 URL 对象或错误字符串。 */
function parseRemoteUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "remoteUrl is required" };
  if (s.length > 2048) return { error: "remoteUrl too long (>2048)" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "remoteUrl is not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "remoteUrl must be http:// or https://" };
  }
  return { url: u };
}

/** 校验 token（若提供），返回错误字符串或 null。token 不回显。 */
function validateToken(token) {
  if (token === undefined || token === null || token === "") return null;
  const s = String(token);
  if (s.length < 16) return "token too short (min 16 characters)";
  if (s.length > 512) return "token too long (>512)";
  if (/\s/.test(s)) return "token must not contain whitespace";
  return null;
}

/** 校验 sha256 hex。 */
function isValidSha256(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s.trim().toLowerCase());
}

/** 解析 timeoutMs，返回数值或错误。bounds: { def, min, max }（HTTP 与 SSH 两套上限）。 */
function parseTimeoutMs(v, bounds) {
  if (v === undefined || v === null) return bounds.def;
  const n = Number(v);
  if (!Number.isInteger(n)) return { error: "timeoutMs must be an integer" };
  if (n < bounds.min || n > bounds.max) {
    return { error: "timeoutMs must be between " + bounds.min + " and " + bounds.max };
  }
  return n;
}

const HTTP_TIMEOUT_BOUNDS = { def: DEFAULT_TIMEOUT_MS, min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS };
const SSH_TIMEOUT_BOUNDS = { def: SSH_TIMEOUT_DEFAULT_MS, min: MIN_TIMEOUT_MS, max: SSH_TIMEOUT_MAX_MS };

// ---------------------------------------------------------------------------
// SSH（sftp）通道：校验与传输
// ---------------------------------------------------------------------------

/**
 * 传输模式决议（0.5.0）：
 *   - 显式 `mode: "ssh" | "http"` 直接生效（其余值报错）；
 *   - 未给 mode 时：给了 `host` → ssh；给了 `remoteUrl` → http；两者都给了 → 歧义报错；
 *   - 两者都没给 → 报错并提示用法。
 * 这样 0.4.0 的旧调用（只带 remoteUrl）继续走 HTTP 不被破坏，新调用（只带 host）零配置走 SSH。
 */
function resolveTransferMode(args) {
  const raw = args?.mode === undefined || args?.mode === null ? null : String(args.mode).toLowerCase();
  if (raw !== null) {
    if (raw !== "ssh" && raw !== "http") return { error: "mode must be 'ssh' or 'http'" };
    return { mode: raw };
  }
  const hasHost = args?.host !== undefined && args?.host !== null && String(args.host).trim() !== "";
  const hasUrl = args?.remoteUrl !== undefined && args?.remoteUrl !== null && String(args.remoteUrl).trim() !== "";
  if (hasHost && hasUrl) {
    return { error: "ambiguous transport: both host and remoteUrl were given; pass mode:'ssh' or mode:'http' explicitly" };
  }
  if (hasHost) return { mode: "ssh" };
  if (hasUrl) return { mode: "http" };
  return {
    error:
      "no transport target: pass host + remotePath for the SSH channel (recommended, zero setup) or mode:'http' with remoteUrl for the 0.4.0 HTTP channel",
  };
}

/**
 * 校验远端主机标识。接受：
 *   - ssh-config 别名（推荐：复用桌面既有配置，无需任何新配置）；
 *   - `user@host` 形式；
 *   - 可选 IPv6 字面量（`[::1]` 或 `user@[::1]`）。
 * 白名单字符集 + 禁止 `-` 开头：host 是 spawn 的位置参数，若以 `-` 开头会被 ssh/sftp
 * 解析成选项（如 `-oProxyCommand=...`），因此必须拒绝——这是参数注入的入口，靠白名单堵死。
 */
function validateSshHost(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "host is required for the ssh channel (ssh-config alias or user@host)" };
  if (s.length > MAX_HOST_LEN) return { error: "host too long (>253)" };
  if (s.startsWith("-")) return { error: "host must not start with '-' (would be parsed as an ssh option)" };
  const ok =
    /^[A-Za-z0-9._-]+(?:@(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]))?$/.test(s) ||
    /^\[[0-9A-Fa-f:]+\]$/.test(s);
  if (!ok) {
    return { error: "host must be an ssh-config alias or user@host (allowed: letters, digits, '.', '_', '-', '@'; IPv6 literals in brackets)" };
  }
  return { host: s };
}

/** 校验远端绝对路径：仅保证 sftp 批处理格式的完整性，不做目录前缀限制（理由见 DESIGN-0.5.0.md）。 */
function validateRemotePath(raw) {
  const s = String(raw ?? "");
  if (!s) return { error: "remotePath is required for the ssh channel" };
  if (s.length > MAX_REMOTE_PATH_LEN) return { error: "remotePath too long (>4096)" };
  if (!s.startsWith("/")) return { error: "remotePath must be an absolute path starting with '/'" };
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return { error: "remotePath must not contain control characters (newline/NUL/tab/…) — they would corrupt the sftp batch file" };
  }
  return { remotePath: s };
}

/**
 * sftp 会对两条“源路径”做 glob 展开（已在 OpenSSH master 源码核对）：
 *   - `put` 的本地源：process_put 里 `glob(src, GLOB_NOCHECK | GLOB_MARK, NULL, &g)`（sftp.c:774）；
 *   - `get` 的远端源：process_get 里 `sftp_glob(conn, abs_src, GLOB_MARK, NULL, &g)`（sftp.c:672，无 NOCHECK）。
 * 而批处理的双引号参数**无法**表达字面 `*` `?` `[`：parse_args/makeargv 只对 `\?`/`\[`/`\*`
 * 追加“双重转义”（sftp.c:1286-1299），在双引号里写 `\*` 最终会得到字面反斜杠 + 字面星号。
 * 后果是静默传错文件（存在模式匹配项时）或令人困惑的 `stat …: No such file or directory`。
 * 因此对这两条路径直接拒绝（fail closed）。
 * 目标侧不受影响：`put`/`get` 的第二个参数走 undo_glob_escape，只反转义、不展开。
 * **反斜杠不拦**（`SFTP_GLOB_META` 里没有 `\`）：Windows 绝对路径必然含 `\`，拦它等于 push 全废；
 * 且 `\` 由 quoteBatchArg 正确转义（见该常量处的注释）。
 */
function rejectGlobMeta(s, label) {
  const hit = SFTP_GLOB_META.find((c) => s.includes(c));
  if (hit) {
    return {
      error:
        label +
        " contains sftp glob metacharacters (* ? [) — found " + JSON.stringify(hit) + "; such source paths are rejected conservatively (older or non-OpenSSH sftp clients glob-expand them and could silently target a different file). Rename it or copy it to a path without those characters.",
    };
  }
  return null;
}

/** 校验本地路径参数（桌面侧）：仅拒绝控制字符（批处理格式完整性）；路径语义由 path.resolve + lstat 处理。 */
function validateLocalPathArg(raw) {
  const s = String(raw ?? "");
  if (!s) return "path is required";
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return "path must not contain control characters (newline/NUL/tab/…)";
  }
  return null;
}

function validateSshPort(raw) {
  if (raw === undefined || raw === null) return { port: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: "port must be an integer between 1 and 65535" };
  return { port: n };
}

/**
 * sftp 批处理行的引号转义：`"` 包住参数，`\` 与 `"` 用反斜杠转义。
 * 控制字符已在入口校验拒绝，所以这一行永远是单行、可被 sftp 正确解析。
 * sftp 的批处理解析器只做分词与引号/反斜杠处理，不做 shell 展开——`$`、反引号、`;`
 * 在引号内都是字面字符，不会被远端 shell 执行（远端本来也没有 shell 参与，见 DESIGN）。
 */
function quoteBatchArg(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * 传给 sftp 子进程的环境：继承当前 env，并保证 Windows OpenSSH 需要的 %ProgramData% 存在。
 *
 * 为什么必须补：Windows 版 sftp/ssh 启动时会读全局配置 <ProgramData>\ssh\ssh_config。
 * 宿主给插件进程的是最小 env（PATH/SystemRoot/windir/TEMP/TMP/TMPDIR/LANG/HOME/USER/USERPROFILE），
 * 不含 ProgramData；缺失时 sftp 立即退出 255，且 stdout/stderr **全空**，调用侧完全看不出原因。
 *
 * 本机实测（PI-Desktop 0.20.1 + Windows OpenSSH，对同一远端做 put）：
 *   最小 env                      -> exit 255，零输出
 *   最小 env + ProgramData        -> exit 0，文件到达远端且 sha256 与源文件一致
 *   最小 env + 其余 13 个候选变量  -> 仍然 255（USER/USERNAME/HOME/HOMEDRIVE/HOMEPATH/LANG/APPDATA/
 *                                    LOCALAPPDATA/SystemDrive/ComSpec/PATHEXT/ALLUSERSPROFILE/ProgramFiles）
 */
function sftpChildEnv() {
  const env = Object.assign({}, process.env);
  // 只在 Windows 上补：Windows 版 sftp/ssh 启动时要读 <ProgramData>\ssh\ssh_config，
  // 而宿主给插件进程的最小 env 不含 ProgramData。类 Unix 上不注入这个 Windows 路径。
  if (process.platform === "win32" && !env.ProgramData) {
    const root = env.SystemRoot || env.windir || "C:\\Windows";
    env.ProgramData = path.join(root, "..", "ProgramData");
  }
  return env;
}

/** ssh config 的默认路径（Windows 用 USERPROFILE，类 Unix 用 HOME）。 */
function sshConfigPath() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return home ? path.join(home, ".ssh", "config") : null;
}

/**
 * ssh config 的 Host 模式匹配：只处理 * 与 ?。
 *
 * **大小写敏感**——OpenSSH 的 Host 匹配走 fnmatch，不做大小写折叠。
 * 实测：config 里写 `Host MyHost` 时，`ssh -G myhost` 解析不到该条目
 * （hostname 不展开、stricthostkeychecking 回落到默认 ask）。
 * 若这里用 "i" 标志，就会把"用户没表态"误判成"已表态"，进而不补 accept-new，
 * 让 BatchMode 下的首次连接失败，而且错误看起来像认证问题。
 */
function sshHostPatternMatches(pattern, host) {
  if (!pattern) return false;
  if (pattern === "*") return true;
  const rx = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return rx.test(host);
}

/**
 * 目标 host 是否在用户的 ssh 配置里显式设置了 StrictHostKeyChecking。
 *
 * 返回 true  = 用户已表态 → 不要传命令行 -o（命令行优先级高于 config，会把它悄悄降级）；
 * 返回 false = 未表态 → 可以补 accept-new，保持“首次连接零操作”。
 * 任何读取/解析失败都按 false 处理：读不到 config 不该让传输失败。
 * 支持 Include（相对路径按 ssh 语义解析到 ~/.ssh 下），限制递归规模防环。
 */
/** ssh config 里本插件关心的选项（其余一律忽略）。 */
const SSH_INTERESTING_KEYS = new Set(["hostname", "port", "user", "stricthostkeychecking"]);

/**
 * 顺序读取 ssh config（含 Include，相对路径按 ssh 语义解析到 ~/.ssh 下），
 * 把每个 Host 块摊平成 { patterns, opts }；Host 块之外的全局选项视为 patterns:["*"]。
 * 读取失败就跳过该文件（读不到 config 不该让调用方失败），递归规模限制防环。
 */
async function readSshConfigBlocks() {
  const root = sshConfigPath();
  const sshDir = root ? path.dirname(root) : null;
  const queue = root ? [root] : [];
  const seen = new Set();
  const blocks = [];
  while (queue.length > 0 && seen.size < 32) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    let current = null; // 当前 Host 块的记录；null 表示还没进过 Host 块
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z][A-Za-z0-9]*)[\s=]+(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "include") {
        for (const p of value.split(/\s+/)) {
          if (!p) continue;
          if (p.startsWith("~")) queue.push(path.join(os.homedir(), p.slice(1).replace(/^[\\/]/, "")));
          else if (path.isAbsolute(p)) queue.push(p);
          else if (sshDir) queue.push(path.join(sshDir, p));
        }
        continue;
      }
      if (key === "host") {
        current = { patterns: value.split(/\s+/).filter(Boolean), opts: {} };
        blocks.push(current);
        continue;
      }
      if (!current) {
        current = { patterns: ["*"], opts: {} }; // Host 之前的全局选项对所有主机生效
        blocks.push(current);
      }
      if (SSH_INTERESTING_KEYS.has(key)) current.opts[key] = value;
    }
  }
  return blocks;
}

/** ssh 的取值语义：每个选项各自取“第一个匹配到的块”的值。 */
function resolveSshHostEntry(alias, blocks) {
  const out = { alias, hostname: null, port: null, user: null };
  for (const b of blocks) {
    if (!b.patterns.some((p) => sshHostPatternMatches(p, alias))) continue;
    if (out.hostname === null && b.opts.hostname !== undefined) out.hostname = b.opts.hostname;
    if (out.port === null && b.opts.port !== undefined) out.port = b.opts.port;
    if (out.user === null && b.opts.user !== undefined) out.user = b.opts.user;
  }
  if (out.port !== null) {
    const n = Number(out.port);
    out.port = Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  }
  return out;
}

/**
 * 目标 host 是否在 ssh 配置里显式设置了 StrictHostKeyChecking。
 * 返回 true  = 用户已表态 → 不要传命令行 -o（命令行优先级高于 config，会把它悄悄降级）；
 * 返回 false = 未表态 → 可以补 accept-new，保持“首次连接零操作”。
 */
async function sshConfigSetsHostKeyChecking(host) {
  for (const b of await readSshConfigBlocks()) {
    if (b.opts.stricthostkeychecking !== undefined && b.patterns.some((p) => sshHostPatternMatches(p, host))) {
      return true;
    }
  }
  return false;
}

/**
 * 列出 ssh config 里可用的**具体**主机别名（跳过 * ? ! 模式），
 * 以及每个别名按 ssh 取值语义解析出的 hostname / port / user。
 *
 * 这是给 agent 的“发现目标”工具：agent 先调它拿到候选，把候选交给用户选定，
 * 再用选中的别名调 push/pull —— 插件自己绝不替调用方挑主机。
 * 只读；不返回 IdentityFile 等密钥路径。
 */
async function listSshHosts() {
  const configPath = sshConfigPath();
  const blocks = await readSshConfigBlocks();
  const aliases = [];
  for (const b of blocks) {
    for (const p of b.patterns) {
      if (!p || p === "*" || p.includes("*") || p.includes("?") || p.includes("!")) continue;
      if (!aliases.includes(p)) aliases.push(p);
    }
  }
  const hosts = aliases.map((a) => resolveSshHostEntry(a, blocks));

  // 区分“配置文件不存在”“存在但只有通配条目”“正常”，
  // 让 agent 能把“到底缺什么、下一步该让用户做什么”原样讲给用户，而不是笼统报空。
  let configExists = false;
  if (configPath) {
    try {
      configExists = (await fsp.stat(configPath)).isFile();
    } catch {
      configExists = false;
    }
  }
  const status = hosts.length > 0 ? "ok" : configExists ? "no-concrete-aliases" : "no-config-file";
  const note =
    status === "ok"
      ? "Show these to the user and let them choose, then pass the chosen alias as the `host` argument of push/pull. The alias is resolved by the desktop's own ssh client, including its IdentityFile; the plugin never picks a host on its own."
      : status === "no-concrete-aliases"
        ? "The ssh config exists but contains only wildcard Host patterns, so there is no alias to name. Tell the user this and ask for the alias (or a user@host) they want to use. If they want an alias, they add a concrete entry on the DESKTOP machine, e.g. `Host myhost` + `HostName <address>` + `User <user>` + `IdentityFile <key>`. Nothing is created automatically — report what is missing instead of guessing a host."
        : "No ssh config file at " +
          (configPath || "(HOME/USERPROFILE could not be resolved)") +
          ". Tell the user this and ask for the ssh alias or a user@host. The ssh channel needs either an alias in that file or user@host plus a usable key/ssh-agent on the desktop; without it, push/pull over SSH cannot work. Nothing is created automatically.";
  return {
    ok: true,
    configPath,
    configExists,
    status,
    count: hosts.length,
    hosts,
    note,
  };
}
/**
 * 跑一次 sftp 批处理传输（put 或 get）。
 * 安全设计：
 *   - spawn 不用 shell，argv 数组传递，所有 `-o` 值都是本文件内的常量；
 *     用户输入只出现在位置参数（host，已白名单校验）与批处理文件内容（已引号转义）里；
 *   - `BatchMode=yes`：禁止任何交互（密码/指纹确认），认证失败立刻非零退出，绝不卡住；
 *   - `StrictHostKeyChecking=accept-new`：首次连接 TOFU 记录指纹，之后指纹变化仍拒绝
 *     （MITM 防线保留），绝不设 `no`；
 *   - `ConnectTimeout=10` 只约束 TCP 建连；整次传输由整体计时器约束，
 *     超时先 SIGTERM，5s 不退出再 SIGKILL（Windows 上 child.kill() 即 TerminateProcess），
 *     最迟 15s 强制收敛，不留悬挂的 Promise，也不留僵尸 ssh 进程
 *     （未启用 ControlMaster/ControlPersist，无后台常驻进程）；
 *   - stderr/stdout 各截断 4 KiB 回传，保证错误可诊断。
 * 返回 { ok, exitCode, signal, stdout, stderr, timedOut, killed, spawnError }。
 */
async function runSftpTransfer({ batchLine, host, port, timeoutMs }) {
  const batchFile = path.join(
    os.tmpdir(),
    ".dfr-sftp-" + crypto.randomBytes(6).toString("hex") + ".batch"
  );
  try {
    await fsp.writeFile(batchFile, batchLine + "\n", { mode: 0o600 });
  } catch (e) {
    // 临时目录不可写（EACCES/ENOSPC/只读盘…）：返回结构化错误，不让异常穿透成未捕获拒绝
    return { ok: false, batchFileError: e.code || e.message || String(e) };
  }

  // 命令行 -o 的优先级高于 ~/.ssh/config：只有用户没表态时才补 accept-new，
  // 否则会把用户 config 里的 StrictHostKeyChecking 悄悄降级。
  const userSetHostKey = await sshConfigSetsHostKeyChecking(host);
  const args = ["-b", batchFile, "-o", "BatchMode=yes"];
  if (!userSetHostKey) args.push("-o", "StrictHostKeyChecking=" + SSH_STRICT_HOST_KEY_CHECKING);
  args.push("-o", "ConnectTimeout=" + SSH_CONNECT_TIMEOUT_S);
  if (port) args.push("-P", String(port));
  args.push(host);

  try {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killed = false;
      let notExited = false;
      let settled = false;
      let timer = null;
      let graceTimer = null;
      let hardTimer = null;
      let exitInfo = null;
      let drainTimer = null;

      const capAppend = (acc, chunk) => {
        const next = acc + chunk.toString("utf8");
        return next.length > SFTP_IO_CAP ? next.slice(0, SFTP_IO_CAP) : next;
      };

      const child = spawn("sftp", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: sftpChildEnv() });

      const settle = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        clearTimeout(hardTimer);
        clearTimeout(drainTimer);
        resolve(Object.assign({ ok: true, timedOut, killed, notExited, stdout, stderr, argv: args, batchLine }, payload));
      };

      child.stdout.on("data", (c) => (stdout = capAppend(stdout, c)));
      child.stderr.on("data", (c) => (stderr = capAppend(stderr, c)));

      child.on("error", (e) => settle({ ok: false, spawnError: e }));
      // 收尾必须等 stdio 排空：Node 的 'exit' 可能在 stdout/stderr 关闭前触发，
      // 直接 settle 会丢掉 stderr 的最后一段（恰好是认证失败原因所在）。'close' 才是流关闭后的事件；
      // 若 'close' 迟迟不来（例如 ProxyCommand 留下持有 fd 的子进程），exit 后最多再等 1s 强制收敛。
      child.on("exit", (code, signal) => {
        exitInfo = { exitCode: code, signal: signal || null };
        drainTimer = setTimeout(() => settle(exitInfo), KILL_DRAIN_MS);
      });
      child.on("close", (code, signal) => {
        settle(exitInfo || { exitCode: code, signal: signal || null });
      });

      timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill(); // POSIX: SIGTERM；Windows: TerminateProcess（不经 shell，直接终止）
        graceTimer = setTimeout(() => {
          child.kill("SIGKILL"); // Windows 上无效果，无害
        }, KILL_GRACE_MS);
        hardTimer = setTimeout(() => {
          if (!settled) {
            notExited = true;
            settle({ exitCode: null, signal: null });
          }
        }, KILL_HARD_CEILING_MS);
      }, timeoutMs);
    });
  } finally {
    // 批处理文件用完即删（含敏感路径时不留痕迹）
    try {
      await fsp.unlink(batchFile);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// HTTP 底层：流式请求与响应收集
// ---------------------------------------------------------------------------

/**
 * 发起 HTTP(S) 请求，返回 { statusCode, headers, body }。
 * body 收集上限 MAX_RESPONSE_BYTES，超出则截断。
 * 超时通过 req.setTimeout 实现。
 */
function httpRequestRaw(u, opts, bodyStream) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const reqOpts = {
      method: opts.method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: opts.headers,
    };
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on("data", (chunk) => {
        if (truncated) return;
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          truncated = true;
          // 仍需消费剩余数据以释放连接
          res.resume();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: truncated ? body.slice(0, MAX_RESPONSE_BYTES) + "…(truncated)" : body,
          truncated,
        });
      });
      res.on("error", (e) => reject(e));
    });
    req.on("error", (e) => reject(e));
    // 超时
    req.setTimeout(opts.timeoutMs, () => {
      const err = new Error("request timeout after " + opts.timeoutMs + "ms");
      err.code = "TIMEOUT";
      req.destroy(err);
    });
    if (bodyStream) {
      bodyStream.on("error", (e) => {
        req.destroy(e);
      });
      bodyStream.pipe(req);
    } else {
      req.end();
    }
  });
}

async function readDesktopFile(args) {
  const raw = String(args?.path ?? "");
  if (!raw) return { ok: false, error: "path is required" };
  const abs = path.resolve(raw);

  const offset = Math.max(0, Number(args?.offset ?? 0) | 0);
  const length = Math.min(MAX_CHUNK, Math.max(1, Number(args?.length ?? DEFAULT_CHUNK) | 0));

  let st;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "file not found: " + abs };
    return { ok: false, error: "stat failed: " + (e.code || e.message) };
  }
  if (st.isDirectory()) {
    return { ok: false, error: "path is a directory; use list_desktop_dir" };
  }
  if (!st.isFile()) {
    return { ok: false, error: "path is not a regular file" };
  }

  const size = st.size;
  const toRead = Math.max(0, Math.min(length, size - offset));

  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, offset);
    const slice = buf.subarray(0, bytesRead);
    return {
      ok: true,
      path: abs,
      size,
      offset,
      bytesRead,
      eof: offset + bytesRead >= size,
      base64: slice.toString("base64"),
    };
  } finally {
    await fh.close();
  }
}

async function listDesktopDir(args) {
  const raw = String(args?.path ?? "");
  if (!raw) return { ok: false, error: "path is required" };
  const abs = path.resolve(raw);

  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: "readdir failed: " + (e.code || e.message) };
  }
  const out = [];
  for (const e of entries) {
    const full = path.join(abs, e.name);
    let size = null;
    if (e.isFile()) {
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        /* 读不到大小就只报名字 */
      }
    }
    out.push({ name: e.name, dir: e.isDirectory(), size });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { ok: true, path: abs, count: out.length, entries: out };
}

async function writeDesktopFile(args) {
  const raw = String(args?.path ?? "");
  if (!raw) return { ok: false, error: "path is required" };
  const abs = path.resolve(raw);

  const b64 = String(args?.contentBase64 ?? "");
  if (!b64) return { ok: false, error: "contentBase64 is required" };

  let data;
  try {
    data = Buffer.from(b64, "base64");
  } catch {
    return { ok: false, error: "contentBase64 is not valid base64" };
  }
  if (data.length === 0 && b64.length > 0) {
    return { ok: false, error: "contentBase64 decoded to zero bytes; check the encoding" };
  }
  if (data.length > MAX_WRITE) {
    return { ok: false, error: "payload too large: " + data.length + " > " + MAX_WRITE };
  }

  // 目标当前状态（用于复盘与覆盖保护）
  let existed = false;
  let beforeSize = null;
  let beforeSha = null;
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) return { ok: false, error: "path is a directory" };
    if (!st.isFile()) return { ok: false, error: "path is not a regular file" };
    existed = true;
    beforeSize = st.size;
    beforeSha = await sha256OfFile(abs);
  } catch (e) {
    if (e.code !== "ENOENT") return { ok: false, error: "stat failed: " + (e.code || e.message) };
  }

  const expected = args?.expectedSha256 ? String(args.expectedSha256).toLowerCase() : null;

  if (existed && !expected) {
    return {
      ok: false,
      error: "file exists; pass expectedSha256 (from read_desktop_file) to overwrite",
      existing: { size: beforeSize, sha256: beforeSha },
    };
  }
  if (existed && expected && expected !== beforeSha) {
    return {
      ok: false,
      error: "expectedSha256 mismatch: the file changed after you read it",
      expected: expected,
      actual: beforeSha,
    };
  }
  if (!existed && args?.allowCreate !== true) {
    return { ok: false, error: "file does not exist; pass allowCreate:true to create it" };
  }

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data);
  const afterSha = await sha256OfFile(abs);

  return {
    ok: true,
    path: abs,
    action: existed ? "overwritten" : "created",
    before: existed ? { size: beforeSize, sha256: beforeSha } : null,
    after: { size: data.length, sha256: afterSha },
  };
}

async function deleteDesktopFile(args) {
  const raw = String(args?.path ?? "");
  if (!raw) return { ok: false, error: "path is required" };
  const abs = path.resolve(raw);

  // 第 1 道门：保护清单（无绕过开关）
  const blocked = protectedReason(raw, abs);
  if (blocked) return { ok: false, path: abs, error: blocked };

  // 第 2 道门：类型（用 lstat，不跟随符号链接）
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, path: abs, error: "path does not exist" };
    return { ok: false, path: abs, error: "lstat failed: " + (e.code || e.message) };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      path: abs,
      error: "path is a symbolic link; refusing (this tool never follows links)",
    };
  }
  if (st.isDirectory()) {
    return {
      ok: false,
      path: abs,
      error: "path is a directory; refusing to delete directories (only single regular files)",
    };
  }
  if (!st.isFile()) {
    return { ok: false, path: abs, error: "path is not a regular file" };
  }

  // 预演：只报告影响，不校验也不删除
  // 预演：只报告影响，不校验也不删除
  if (args?.dryRun === true) {
    let sha = null;
    try {
      sha = await sha256OfFile(abs);
    } catch {
      // 读不动就只报 size/mtime：预演不该因为算不出哈希而挡路
    }
    return {
      ok: true,
      dryRun: true,
      path: abs,
      wouldDelete: { size: st.size, mtimeMs: st.mtimeMs, sha256: sha },
      note: "nothing was deleted; re-call without dryRun (and with confirm + expectedSha256/expectedSize) to delete",
    };
  }

  // 第 3 道门：显式确认
  if (args?.confirm !== true) {
    return {
      ok: false,
      path: abs,
      error: "pass confirm:true to delete (review the impact first, e.g. with dryRun:true)",
      existing: { size: st.size },
    };
  }

  // 第 4 道门：与调用方看过的内容绑定
  const expectedSha = args?.expectedSha256 ? String(args.expectedSha256).trim().toLowerCase() : null;
  const expectedSize =
    args?.expectedSize === undefined || args?.expectedSize === null ? null : Number(args.expectedSize);

  if (!expectedSha && expectedSize === null) {
    return {
      ok: false,
      path: abs,
      error: "pass expectedSha256 (preferred) or expectedSize, so the delete is bound to the content you reviewed",
      existing: { size: st.size },
    };
  }
  if (expectedSha && !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return { ok: false, path: abs, error: "expectedSha256 must be 64 hex characters" };
  }
  if (expectedSize !== null && (!Number.isInteger(expectedSize) || expectedSize < 0)) {
    return { ok: false, path: abs, error: "expectedSize must be a non-negative integer" };
  }
  if (expectedSize !== null && expectedSize !== st.size) {
    return {
      ok: false,
      path: abs,
      error: "expectedSize mismatch: the file changed after you reviewed it",
      expected: expectedSize,
      actual: st.size,
    };
  }

  const beforeSha = expectedSha ? await sha256OfFile(abs) : null;
  if (expectedSha && expectedSha !== beforeSha) {
    return {
      ok: false,
      path: abs,
      error: "expectedSha256 mismatch: the file changed after you reviewed it",
      expected: expectedSha,
      actual: beforeSha,
    };
  }

  // 删除前复核：size / mtime 未变（两边都提供 inode 时也要求一致），缩小 TOCTOU 窗口
  const re = await fsp.lstat(abs);
  const inodeChanged = Boolean(st.ino && re.ino && st.ino !== re.ino);
  if (inodeChanged || re.size !== st.size || re.mtimeMs !== st.mtimeMs) {
    return {
      ok: false,
      path: abs,
      error: "the file changed between verification and deletion; re-read it and retry",
    };
  }

  await fsp.unlink(abs);

  let verifiedGone = false;
  try {
    await fsp.lstat(abs);
  } catch (e) {
    verifiedGone = e.code === "ENOENT";
  }

  return {
    ok: true,
    path: abs,
    deleted: true,
    before: { size: st.size, sha256: beforeSha, mtimeMs: st.mtimeMs },
    verifiedGone,
  };
}

// ---------------------------------------------------------------------------
// 直传入口：push / pull（0.5.0 起 mode 可显式选择 ssh|http，缺省按参数推断）
// ---------------------------------------------------------------------------

/** SSH push 的公共前置校验（本地源文件 + 参数），返回 null 或错误对象。 */
async function sshPushGuard(args) {
  const localErr = validateLocalPathArg(args?.path);
  if (localErr) return { ok: false, error: localErr };

  const hostRes = validateSshHost(args?.host);
  if (hostRes.error) return { ok: false, error: hostRes.error };
  const portRes = validateSshPort(args?.port);
  if (portRes.error) return { ok: false, error: portRes.error };
  const rpRes = validateRemotePath(args?.remotePath);
  if (rpRes.error) return { ok: false, error: rpRes.error };

  const timeoutRaw = parseTimeoutMs(args?.timeoutMs, SSH_TIMEOUT_BOUNDS);
  if (timeoutRaw && typeof timeoutRaw === "object" && timeoutRaw.error) {
    return { ok: false, error: timeoutRaw.error };
  }

  // expectedRemoteSha256 在 push 上无法兑现（不回读远端文件）。静默忽略会让调用方
  // 误以为拿到了校验，因此显式拒绝而不是无声放过。
  const expRemote = args?.expectedRemoteSha256;
  if (expRemote !== undefined && expRemote !== null && String(expRemote).trim() !== "") {
    return {
      ok: false,
      error:
        "expectedRemoteSha256 is not supported on the ssh channel for push (the remote file is never read back, so it cannot be verified); drop it or use mode:'http'",
    };
  }
  return { host: hostRes.host, port: portRes.port, remotePath: rpRes.remotePath, timeoutMs: timeoutRaw };
}

/**
 * SSH push：sftp `put`，字节由 sftp 经 SSH 隧道流式传输，不经 LLM、不进 Node 内存。
 * 远端路径不做目录前缀限制：SSH 账号本身可写的路径就是边界（root 即整盘）；
 * 目录限制只会挡住合法工作流而不提供任何真实保护（理由见 DESIGN-0.5.0.md）。
 * 注意：put 覆盖已存在的远端文件（与 scp/sftp 惯例一致）。
 */
async function pushViaSsh(args) {
  const g = await sshPushGuard(args);
  if (g.error !== undefined) return g;

  const abs = path.resolve(String(args?.path ?? ""));
  const globErr = rejectGlobMeta(abs, "local source path");
  if (globErr) return { ok: false, error: globErr.error };
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "file not found: " + abs };
    return { ok: false, error: "lstat failed: " + (e.code || e.message) };
  }
  if (st.isSymbolicLink()) return { ok: false, error: "path is a symbolic link; refusing (this tool never follows links)" };
  if (st.isDirectory()) return { ok: false, error: "path is a directory; refusing" };
  if (!st.isFile()) return { ok: false, error: "path is not a regular file" };

  let stat2;
  try {
    stat2 = await fsp.stat(abs);
  } catch (e) {
    return { ok: false, error: "stat failed: " + (e.code || e.message) };
  }
  // SSH 通道不设 50 MiB 上限（那是 HTTP/nginx 的限制）；大文件靠流式 + 超时兜底

  const expectedSha = args?.expectedSha256 ? String(args.expectedSha256).trim().toLowerCase() : null;
  if (expectedSha && !isValidSha256(expectedSha)) {
    return { ok: false, error: "expectedSha256 must be 64 hex characters" };
  }
  let fileSha = null;
  try {
    fileSha = await sha256OfFile(abs);
  } catch (e) {
    return { ok: false, error: "sha256 failed: " + (e.code || e.message) };
  }
  if (expectedSha && expectedSha !== fileSha) {
    return { ok: false, error: "expectedSha256 mismatch: the file changed after you read it", expected: expectedSha, actual: fileSha };
  }

  const batchLine = "put " + quoteBatchArg(abs) + " " + quoteBatchArg(g.remotePath);
  const res = await runSftpTransfer({ batchLine, host: g.host, port: g.port, timeoutMs: g.timeoutMs });
  const err = sftpErrorOf(res, "push", g.timeoutMs);
  if (err) return err;

  return {
    ok: true,
    path: abs,
    host: g.host,
    remotePath: g.remotePath,
    transport: "ssh",
    bytesSent: stat2.size,
    sha256: fileSha,
  };
}

/** 把 runSftpTransfer 的结果翻译成工具错误对象；成功返回 null。stderr 截断回传，不吞。 */
function sftpErrorOf(res, verb, timeoutMs) {
  if (res.batchFileError) {
    return {
      ok: false,
      error: "could not write the sftp batch file into the temp directory: " + res.batchFileError,
      sftpStderr: res.stderr || "",
    };
  }
  if (res.spawnError) {
    return {
      ok: false,
      error: "sftp executable not found on PATH or failed to start (OpenSSH client is required): " + (res.spawnError.code || res.spawnError.message || String(res.spawnError)),
      sftpStderr: res.stderr || "",
    };
  }
  if (res.timedOut) {
    return {
      ok: false,
      error: "sftp " + verb + " timed out after " + timeoutMs + "ms (process killed)",
      timedOut: true,
      killed: res.killed,
      notExited: res.notExited,
      sftpStderr: res.stderr || "",
      sftpStdout: res.stdout || "",
    };
  }
  if (res.exitCode !== 0) {
    const out = {
      ok: false,
      error: "sftp " + verb + " failed: exit code " + res.exitCode + (res.signal ? " (signal " + res.signal + ")" : ""),
      exitCode: res.exitCode,
      signal: res.signal,
      sftpStderr: res.stderr || "",
      sftpStdout: res.stdout || "",
      sftpArgv: res.argv || null,
      sftpBatch: res.batchLine || null,
    };
    if (res.exitCode === 255 && !res.stderr && !res.stdout) {
      out.hint =
        "sftp exited 255 with zero output. On Windows that is what the OpenSSH client does when it cannot " +
        "initialise at all — typically a missing environment variable it needs (e.g. %ProgramData%, which is " +
        "required to read <ProgramData>\\ssh\\ssh_config), or a broken client install. Reproduce by hand with " +
        "sftpArgv, and check that ProgramData is present in the plugin process env.";
    }
    return out;
  }
  return null;
}

/** push 入口：mode 决议后分流 ssh / http。 */
async function pushDesktopFileToRemote(args) {
  const pathErr = validateLocalPathArg(args?.path);
  if (pathErr) return { ok: false, error: pathErr };
  const modeRes = resolveTransferMode(args);
  if (modeRes.error) return { ok: false, error: modeRes.error };
  if (modeRes.mode === "ssh") return pushViaSsh(args);
  return pushViaHttp(args);
}

/**
 * 将桌面文件通过 HTTP(S) 直传到远端 URL（0.4.0 通道，mode:"http" 或仅给 remoteUrl 时走这里）。
 * 字节走 TLS 直连，不经 LLM；桌面主动发起，适配远端不能连桌面的约束。
 */
async function pushViaHttp(args) {
  const rawPath = String(args?.path ?? "");
  if (!rawPath) return { ok: false, error: "path is required" };
  const abs = path.resolve(rawPath);

  const parsed = parseRemoteUrl(args?.remoteUrl);
  if (parsed.error) return { ok: false, error: parsed.error };
  const u = parsed.url;

  const tokenErr = validateToken(args?.token);
  if (tokenErr) return { ok: false, error: tokenErr };

  const timeoutRaw = parseTimeoutMs(args?.timeoutMs, HTTP_TIMEOUT_BOUNDS);
  if (timeoutRaw && typeof timeoutRaw === "object" && timeoutRaw.error) {
    return { ok: false, error: timeoutRaw.error };
  }
  const timeoutMs = timeoutRaw;

  const methodRaw = args?.method ? String(args.method).toUpperCase() : "PUT";
  if (methodRaw !== "PUT" && methodRaw !== "POST") {
    return { ok: false, error: "method must be PUT or POST" };
  }

  const expectedSha = args?.expectedSha256 ? String(args.expectedSha256).trim().toLowerCase() : null;
  if (expectedSha && !isValidSha256(expectedSha)) {
    return { ok: false, error: "expectedSha256 must be 64 hex characters" };
  }

  // 文件校验
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "file not found: " + abs };
    return { ok: false, error: "lstat failed: " + (e.code || e.message) };
  }
  if (st.isSymbolicLink()) return { ok: false, error: "path is a symbolic link; refusing (this tool never follows links)" };
  if (st.isDirectory()) return { ok: false, error: "path is a directory; refusing" };
  if (!st.isFile()) return { ok: false, error: "path is not a regular file" };

  let stat2;
  try {
    stat2 = await fsp.stat(abs);
  } catch (e) {
    return { ok: false, error: "stat failed: " + (e.code || e.message) };
  }
  if (stat2.size > MAX_HTTP_BYTES) {
    return { ok: false, error: "file too large: " + stat2.size + " > " + MAX_HTTP_BYTES + " (50 MiB limit)" };
  }

  // 乐观锁校验
  let fileSha = null;
  try {
    fileSha = await sha256OfFile(abs);
  } catch (e) {
    return { ok: false, error: "sha256 failed: " + (e.code || e.message) };
  }
  if (expectedSha && expectedSha !== fileSha) {
    return { ok: false, error: "expectedSha256 mismatch: the file changed after you read it", expected: expectedSha, actual: fileSha };
  }

  // 发起请求
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(stat2.size),
    "X-File-SHA256": fileSha,
    "X-File-Name": path.basename(abs),
  };
  if (args?.token) headers["Authorization"] = "Bearer " + String(args.token);

  let bodyStream;
  try {
    bodyStream = fs.createReadStream(abs);
  } catch (e) {
    return { ok: false, error: "failed to open file for reading: " + (e.message || String(e)) };
  }

  let resp;
  try {
    resp = await httpRequestRaw(u, { method: methodRaw, headers, timeoutMs }, bodyStream);
  } catch (e) {
    // 确保流关闭
    try {
      bodyStream.destroy();
    } catch {}
    if (e.code === "TIMEOUT" || /timeout/i.test(e.message || "")) {
      return { ok: false, error: "request timeout after " + timeoutMs + "ms" };
    }
    return { ok: false, error: "network error: " + (e.code || e.message || String(e)) };
  }

  // 拒绝重定向
  if (resp.statusCode >= 300 && resp.statusCode < 400) {
    return { ok: false, error: "redirect not allowed: remote returned " + resp.statusCode, remoteStatus: resp.statusCode, remoteBody: resp.body };
  }
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    return { ok: false, error: "remote returned HTTP " + resp.statusCode, remoteStatus: resp.statusCode, remoteBody: resp.body };
  }

  return {
    ok: true,
    path: abs,
    remoteUrl: u.toString(),
    bytesSent: stat2.size,
    sha256: fileSha,
    remoteStatus: resp.statusCode,
    remoteBody: resp.body,
  };
}

/** pull 落盘收尾（HTTP 与 SSH 共用）：TOCTOU 复核 → 原子 rename → 落盘 sha 终核。失败时已尽力清理 tmpPath。 */
async function finalizePulledFile({ abs, tmpPath, existed, beforeSt, beforeSha, receivedSha }) {
  // TOCTOU 复核：若目标已存在，确认未被改动
  if (existed) {
    try {
      const re = await fsp.lstat(abs);
      const inodeChanged = Boolean(beforeSt.ino && re.ino && beforeSt.ino !== re.ino);
      if (inodeChanged || re.size !== beforeSt.size || re.mtimeMs !== beforeSt.mtimeMs) {
        try { await fsp.unlink(tmpPath); } catch {}
        return { ok: false, error: "target changed between verification and write; re-read it and retry" };
      }
      const reSha = await sha256OfFile(abs);
      if (reSha !== beforeSha) {
        try { await fsp.unlink(tmpPath); } catch {}
        return { ok: false, error: "target changed between verification and write; re-read it and retry" };
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        try { await fsp.unlink(tmpPath); } catch {}
        return { ok: false, error: "lstat failed before rename: " + (e.code || e.message) };
      }
      // 文件在验证后被删了，且调用方原本是覆盖场景，视为 changed
      try { await fsp.unlink(tmpPath); } catch {}
      return { ok: false, error: "target changed between verification and write; re-read it and retry" };
    }
  }

  // 原子重命名
  try {
    await fsp.rename(tmpPath, abs);
  } catch (e) {
    try { await fsp.unlink(tmpPath); } catch {}
    return { ok: false, error: "rename failed: " + (e.code || e.message) };
  }

  // 最终校验：rename 成功后 sha 应与 receivedSha 一致；再算一次确认落盘无损
  let finalSha = receivedSha;
  try {
    finalSha = await sha256OfFile(abs);
    if (finalSha !== receivedSha) {
      return { ok: false, error: "sha mismatch after rename: disk content differs", expected: receivedSha, actual: finalSha };
    }
  } catch {}

  let finalSize = 0;
  try {
    finalSize = (await fsp.stat(abs)).size;
  } catch {}
  return { ok: true, sha256: finalSha, size: finalSize, action: existed ? "overwritten" : "created" };
}

/** pull 落盘目标的共享校验（HTTP 与 SSH 共用）：路径、目标状态、乐观锁。 */
async function pullTargetGuard(args) {
  const localErr = validateLocalPathArg(args?.path);
  if (localErr) return { ok: false, error: localErr };
  const abs = path.resolve(String(args?.path ?? ""));

  const expectedSha = args?.expectedSha256 ? String(args.expectedSha256).trim().toLowerCase() : null;
  if (expectedSha && !isValidSha256(expectedSha)) {
    return { ok: false, error: "expectedSha256 must be 64 hex characters" };
  }

  let existed = false;
  let beforeSt = null;
  let beforeSha = null;
  try {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) return { ok: false, error: "target is a symbolic link; refusing" };
    if (st.isDirectory()) return { ok: false, error: "target is a directory; refusing" };
    if (!st.isFile()) return { ok: false, error: "target is not a regular file" };
    existed = true;
    beforeSt = st;
    if (!expectedSha) {
      return { ok: false, error: "file exists; pass expectedSha256 (from read_desktop_file) to overwrite", existing: { size: st.size } };
    }
    try {
      beforeSha = await sha256OfFile(abs);
    } catch (e) {
      return { ok: false, error: "sha256 failed: " + (e.code || e.message) };
    }
    if (expectedSha !== beforeSha) {
      return { ok: false, error: "expectedSha256 mismatch: the file changed after you read it", expected: expectedSha, actual: beforeSha };
    }
  } catch (e) {
    if (e.code !== "ENOENT") return { ok: false, error: "lstat failed: " + (e.code || e.message) };
    if (args?.allowCreate !== true) {
      return { ok: false, error: "file does not exist; pass allowCreate:true to create it" };
    }
  }
  return { abs, existed, beforeSt, beforeSha };
}

/**
 * SSH pull：sftp `get` 到同目录临时文件，再走与 HTTP pull 相同的 TOCTOU 复核 + 原子 rename。
 * 字节由 sftp 经 SSH 隧道流式落盘，不经 LLM、不进 Node 内存。
 */
async function pullViaSsh(args) {
  const hostRes = validateSshHost(args?.host);
  if (hostRes.error) return { ok: false, error: hostRes.error };
  const portRes = validateSshPort(args?.port);
  if (portRes.error) return { ok: false, error: portRes.error };
  const rpRes = validateRemotePath(args?.remotePath);
  if (rpRes.error) return { ok: false, error: rpRes.error };

  // get 的远端源路径会被 sftp_glob 展开（见 rejectGlobMeta 注释），命中 glob 元字符即拒绝
  const globErr = rejectGlobMeta(rpRes.remotePath, "remotePath");
  if (globErr) return { ok: false, error: globErr.error };
  const timeoutRaw = parseTimeoutMs(args?.timeoutMs, SSH_TIMEOUT_BOUNDS);
  if (timeoutRaw && typeof timeoutRaw === "object" && timeoutRaw.error) {
    return { ok: false, error: timeoutRaw.error };
  }
  const timeoutMs = timeoutRaw;

  const tg = await pullTargetGuard(args);
  if (tg.error !== undefined) return tg;

  const tmpName = "." + path.basename(tg.abs) + ".tmp-" + crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(path.dirname(tg.abs), tmpName);

  try {
    await fsp.mkdir(path.dirname(tg.abs), { recursive: true });
  } catch (e) {
    return { ok: false, error: "mkdir failed: " + (e.code || e.message) };
  }

  const batchLine = "get " + quoteBatchArg(rpRes.remotePath) + " " + quoteBatchArg(tmpPath);
  const res = await runSftpTransfer({ batchLine, host: hostRes.host, port: portRes.port, timeoutMs });
  const err = sftpErrorOf(res, "pull", timeoutMs);
  if (err) {
    try { await fsp.unlink(tmpPath); } catch {}
    return err;
  }

  let receivedSha;
  try {
    receivedSha = await sha256OfFile(tmpPath);
  } catch (e) {
    try { await fsp.unlink(tmpPath); } catch {}
    return { ok: false, error: "sha256 of received temp file failed: " + (e.code || e.message) };
  }

  // expectedRemoteSha256：SSH 通道用“收到内容的 sha”兑现（HTTP 通道比对响应头 / 落盘 sha）。
  // 之前这里会静默忽略该参数，调用方会误以为校验过。
  const expectedRemoteSha = args?.expectedRemoteSha256 ? String(args.expectedRemoteSha256).trim().toLowerCase() : null;
  if (expectedRemoteSha) {
    if (!isValidSha256(expectedRemoteSha)) {
      try { await fsp.unlink(tmpPath); } catch {}
      return { ok: false, error: "expectedRemoteSha256 must be 64 hex characters" };
    }
    if (expectedRemoteSha !== receivedSha) {
      try { await fsp.unlink(tmpPath); } catch {}
      return {
        ok: false,
        error: "expectedRemoteSha256 mismatch: the received remote content differs",
        expected: expectedRemoteSha,
        actual: receivedSha,
      };
    }
  }

  const fin = await finalizePulledFile({
    abs: tg.abs,
    tmpPath,
    existed: tg.existed,
    beforeSt: tg.beforeSt,
    beforeSha: tg.beforeSha,
    receivedSha,
  });
  if (!fin.ok) return { ok: false, error: fin.error };

  return {
    ok: true,
    path: tg.abs,
    host: hostRes.host,
    remotePath: rpRes.remotePath,
    transport: "ssh",
    bytesReceived: fin.size,
    size: fin.size,
    sha256: fin.sha256,
    action: fin.action,
  };
}

/** pull 入口：mode 决议后分流 ssh / http。 */
async function pullRemoteFileToDesktop(args) {
  const pathErr = validateLocalPathArg(args?.path);
  if (pathErr) return { ok: false, error: pathErr };
  const modeRes = resolveTransferMode(args);
  if (modeRes.error) return { ok: false, error: modeRes.error };
  if (modeRes.mode === "ssh") return pullViaSsh(args);
  return pullViaHttp(args);
}

/**
 * 从远端 URL 拉取并落盘到桌面路径（0.4.0 通道，mode:"http" 或仅给 remoteUrl 时走这里）。
 * 字节走 HTTP(S) 直连，不经 LLM。
 */
async function pullViaHttp(args) {
  const remoteRaw = args?.remoteUrl;
  // path 校验与解析由 pullRemoteFileToDesktop 入口 + pullTargetGuard 完成

  const parsed = parseRemoteUrl(remoteRaw);
  if (parsed.error) return { ok: false, error: parsed.error };
  const u = parsed.url;

  const tokenErr = validateToken(args?.token);
  if (tokenErr) return { ok: false, error: tokenErr };

  const timeoutRaw = parseTimeoutMs(args?.timeoutMs, HTTP_TIMEOUT_BOUNDS);
  if (timeoutRaw && typeof timeoutRaw === "object" && timeoutRaw.error) {
    return { ok: false, error: timeoutRaw.error };
  }
  const timeoutMs = timeoutRaw;

  const expectedRemoteSha = args?.expectedRemoteSha256 ? String(args.expectedRemoteSha256).trim().toLowerCase() : null;
  if (expectedRemoteSha && !isValidSha256(expectedRemoteSha)) {
    return { ok: false, error: "expectedRemoteSha256 must be 64 hex characters" };
  }
  // 目标状态检查与乐观锁（与 SSH pull 共用）
  const tg = await pullTargetGuard(args);
  if (tg.error !== undefined) return tg;
  const abs = tg.abs;
  const existed = tg.existed;
  const beforeSt = tg.beforeSt;
  const beforeSha = tg.beforeSha;

  // 发起 GET
  const headers = {};
  if (args?.token) headers["Authorization"] = "Bearer " + String(args.token);

  const tmpName = "." + path.basename(abs) + ".tmp-" + crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(path.dirname(abs), tmpName);

  // 确保目录存在
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
  } catch (e) {
    return { ok: false, error: "mkdir failed: " + (e.code || e.message) };
  }

  let responseInfo = null;
  let hash = crypto.createHash("sha256");
  let bytesReceived = 0;
  let responseFailed = null;

  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;

  const getPromise = new Promise((resolve, reject) => {
    const reqOpts = {
      method: "GET",
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    };
    const req = mod.request(reqOpts, (res) => {
      // 先检查状态码与重定向
      if (res.statusCode >= 300 && res.statusCode < 400) {
        responseFailed = "redirect not allowed: remote returned " + res.statusCode;
        res.resume();
        // 收集一点 body 供诊断
        const chunks = [];
        res.on("data", (c) => {
          if (chunks.length < 4) chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 2048);
          reject(Object.assign(new Error(responseFailed), { code: "REDIRECT", remoteStatus: res.statusCode, remoteBody: body }));
        });
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on("data", (c) => {
          if (Buffer.concat(chunks).length < MAX_RESPONSE_BYTES) chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 4096);
          reject(Object.assign(new Error("remote returned HTTP " + res.statusCode), { code: "HTTP_ERROR", remoteStatus: res.statusCode, remoteBody: body }));
        });
        return;
      }

      // 检查 Content-Length
      const clen = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
      if (clen !== null && Number.isFinite(clen) && clen > MAX_HTTP_BYTES) {
        res.resume();
        reject(Object.assign(new Error("remote file too large: Content-Length " + clen + " > " + MAX_HTTP_BYTES), { code: "TOO_LARGE" }));
        return;
      }

      // 检查远端声明的 sha（若有）
      const remoteShaHeader = res.headers["x-file-sha256"] ? String(res.headers["x-file-sha256"]).toLowerCase() : null;
      if (expectedRemoteSha && remoteShaHeader && expectedRemoteSha !== remoteShaHeader) {
        res.resume();
        reject(Object.assign(new Error("expectedRemoteSha256 mismatch with X-File-SHA256 header"), { code: "SHA_MISMATCH", expected: expectedRemoteSha, actual: remoteShaHeader }));
        return;
      }

      responseInfo = { statusCode: res.statusCode, headers: res.headers, remoteShaHeader };

      const out = fs.createWriteStream(tmpPath);
      let finished = false;

      out.on("error", (e) => {
        if (!finished) {
          finished = true;
          res.destroy();
          reject(e);
        }
      });

      res.on("data", (chunk) => {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_HTTP_BYTES) {
          if (!finished) {
            finished = true;
            res.destroy();
            out.destroy();
            reject(Object.assign(new Error("remote file too large: received " + bytesReceived + " > " + MAX_HTTP_BYTES), { code: "TOO_LARGE" }));
          }
          return;
        }
        hash.update(chunk);
      });

      res.on("error", (e) => {
        if (!finished) {
          finished = true;
          out.destroy();
          reject(e);
        }
      });

      // 管道
      res.pipe(out);
      out.on("finish", () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.setTimeout(timeoutMs, () => {
      const err = new Error("request timeout after " + timeoutMs + "ms");
      err.code = "TIMEOUT";
      req.destroy(err);
    });
    req.end();
  });

  let getError = null;
  try {
    await getPromise;
  } catch (e) {
    getError = e;
    // 清理临时文件
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    if (e.code === "TIMEOUT" || /timeout/i.test(e.message || "")) {
      return { ok: false, error: "request timeout after " + timeoutMs + "ms" };
    }
    if (e.code === "REDIRECT") {
      return { ok: false, error: e.message, remoteStatus: e.remoteStatus, remoteBody: e.remoteBody };
    }
    if (e.code === "HTTP_ERROR") {
      return { ok: false, error: e.message, remoteStatus: e.remoteStatus, remoteBody: e.remoteBody };
    }
    if (e.code === "TOO_LARGE") {
      return { ok: false, error: e.message };
    }
    if (e.code === "SHA_MISMATCH") {
      return { ok: false, error: e.message, expected: e.expected, actual: e.actual };
    }
    return { ok: false, error: "network error: " + (e.code || e.message || String(e)) };
  }

  // 此时已落盘到 tmpPath，计算 sha
  const receivedSha = hash.digest("hex");

  // 若提供了 expectedRemoteSha256 且响应头未提供，则比对落盘后 sha
  if (expectedRemoteSha && !responseInfo.remoteShaHeader && expectedRemoteSha !== receivedSha) {
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { ok: false, error: "expectedRemoteSha256 mismatch: received file sha differs", expected: expectedRemoteSha, actual: receivedSha };
  }
  // 若提供了 expectedRemoteSha256 且响应头已提供过，此处不再重复比对（已在 header 阶段比对），但仍可用 receivedSha 二次校验
  if (expectedRemoteSha && responseInfo.remoteShaHeader && expectedRemoteSha !== receivedSha) {
    // 响应头的 sha 与实际内容不一致，说明远端声明不可信
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { ok: false, error: "received file sha does not match X-File-SHA256 header", expected: responseInfo.remoteShaHeader, actual: receivedSha };
  }

  // 落盘收尾（TOCTOU 复核 → 原子 rename → 终核），与 SSH pull 共用
  const fin = await finalizePulledFile({ abs, tmpPath, existed, beforeSt, beforeSha, receivedSha });
  if (!fin.ok) return { ok: false, error: fin.error };

  return {
    ok: true,
    path: abs,
    remoteUrl: u.toString(),
    bytesReceived,
    size: fin.size,
    sha256: fin.sha256,
    action: fin.action,
    remoteStatus: responseInfo.statusCode,
  };
}

async function onLoad() {
  await pi.agent.registerTool({
    name: "read_desktop_file",
    description:
      "Read a file from the local (desktop) filesystem and return its bytes as base64. Use when a session running against a remote host needs a file that only exists on the desktop machine. Supports offset/length for chunked reads.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path on the desktop, e.g. C:/Users/me/notes.txt" },
        offset: { type: "integer", description: "Byte offset to start at (default 0)" },
        length: { type: "integer", description: "Max bytes to read (default 262144, max 1048576)" },
      },
      required: ["path"],
    },
    execute: async (args) => readDesktopFile(args),
  });

  await pi.agent.registerTool({
    name: "list_desktop_dir",
    description: "List one directory's entries on the local (desktop) filesystem.",
    risk: "low",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute directory path on the desktop" } },
      required: ["path"],
    },
    execute: async (args) => listDesktopDir(args),
  });

  await pi.agent.registerTool({
    name: "write_desktop_file",
    description:
      "Write bytes (base64) to a file on the local (desktop) filesystem. Overwriting an existing file REQUIRES expectedSha256 taken from read_desktop_file; creating a new file REQUIRES allowCreate:true. Returns before/after size and sha256 so the caller can audit the change. Only use with explicit user authorization for the specific path.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path on the desktop" },
        contentBase64: { type: "string", description: "File content, base64-encoded" },
        expectedSha256: {
          type: "string",
          description: "Required when overwriting: sha256 of the current file content (from read_desktop_file)",
        },
        allowCreate: { type: "boolean", description: "Required when the file does not exist yet" },
      },
      required: ["path", "contentBase64"],
    },
    execute: async (args) => writeDesktopFile(args),
  });

  await pi.agent.registerTool({
    name: "delete_desktop_file",
    description:
      "Delete ONE regular file on the local (desktop) filesystem. Refuses directories (no recursion), symbolic links, filesystem roots, Windows/Program Files/ProgramData, .ssh/.gnupg/.aws/.pi-desktop and NTFS system files. Requires confirm:true plus expectedSha256 (preferred) or expectedSize taken from read_desktop_file/list_desktop_dir; the delete is refused if the file changed since. Use dryRun:true first to preview. Only use with explicit user authorization for the specific path.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the single file to delete" },
        confirm: { type: "boolean", description: "Must be true: explicit confirmation that the impact was reviewed" },
        expectedSha256: {
          type: "string",
          description: "Preferred guard: sha256 of the current content (from read_desktop_file). Refused if it changed.",
        },
        expectedSize: {
          type: "integer",
          description: "Alternative guard for large files you did not read in full: current byte size (from list_desktop_dir)",
        },
        dryRun: { type: "boolean", description: "If true, only report what would be deleted; nothing is removed" },
      },
      required: ["path"],
    },
    execute: async (args) => deleteDesktopFile(args),
  });

  await pi.agent.registerTool({
    name: "push_desktop_file_to_remote",
    description:
      "Push a desktop file to the remote host, bytes never pass through LLM context. Default channel is SSH over the desktop's existing ssh config (zero user setup): call list_ssh_hosts first to see which aliases exist and let the user pick one, then pass host (ssh-config alias or user@host) + remotePath and the file is uploaded with sftp (BatchMode, no interaction, put overwrites an existing remote file). The local source path must not contain the glob metacharacters * ? [ (rejected conservatively; backslashes are fine, so Windows paths work); expectedRemoteSha256 is rejected on the ssh channel. The 0.4.0 HTTP channel is kept: pass mode:'http' with remoteUrl (unrestricted — only call with a user-authorized destination; auth via Authorization: Bearer <token> header). Requires explicit user authorization for the specific path and destination. Returns sha256/size for verification.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path on the desktop to push" },
        mode: {
          type: "string",
          description:
            "Transport: 'ssh' (sftp, default when host is given) or 'http' (0.4.0 channel, needs remoteUrl). Omit to infer from which fields are present; passing both host and remoteUrl without mode is an error.",
        },
        host: {
          type: "string",
          description:
            "SSH: ssh-config alias on the desktop (recommended — reuses its existing ssh config and key, nothing to set up) or user@host. Call list_ssh_hosts first and let the user pick when it is not obvious. No spaces; must not start with '-'.",
        },
        port: { type: "integer", description: "SSH: TCP port (1-65535) if not already set in the ssh config entry" },
        remotePath: {
          type: "string",
          description:
            "SSH: absolute remote destination path, e.g. /srv/transfer/file.bin. No control characters. put overwrites if the file exists (scp-like semantics).",
        },
        remoteUrl: {
          type: "string",
          description:
            "HTTP: destination http(s) URL, e.g. http://127.0.0.1:9876/push/file.bin or https://example.com/dfr/push/file.bin (auth via Authorization: Bearer <token> header; putting token in URL is supported for compatibility but will appear in access logs — not recommended)",
        },
        token: {
          type: "string",
          description:
            "HTTP only: Bearer token; sent as Authorization: Bearer <token> header if >=16 chars. Do not put token in the URL — it will appear in access logs. Path token /push/<token>/ is only for compatibility.",
        },
        expectedSha256: { type: "string", description: "Optional guard: sha256 of the current file; refused if it changed" },
        timeoutMs: {
          type: "integer",
          description:
            "Timeout in ms. HTTP: 5000-120000, default 60000. SSH: 5000-1800000, default 300000. On SSH timeout the sftp process is killed.",
        },
        method: { type: "string", description: "HTTP only: PUT or POST (default PUT)" },
      },
      required: ["path"],
    },
    execute: async (args) => pushDesktopFileToRemote(args),
  });

  await pi.agent.registerTool({
    name: "pull_remote_file_to_desktop",
    description:
      "Pull a remote file and save it to a desktop path, bytes never pass through LLM context. Default channel is SSH over the desktop's existing ssh config (zero user setup): call list_ssh_hosts first to see which aliases exist and let the user pick one, then pass host (ssh-config alias or user@host) + remotePath and the file is downloaded with sftp (BatchMode, no interaction) to a temp file, sha256-verified, then atomically renamed. The remote source path must not contain the glob metacharacters * ? [ (rejected conservatively); expectedRemoteSha256 is honoured on the ssh channel. The 0.4.0 HTTP channel is kept: pass mode:'http' with remoteUrl (unrestricted — only call with a user-authorized source; auth via Authorization header). Overwrite requires expectedSha256 of the current target; create requires allowCreate:true. Requires explicit user authorization for the specific path and source.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute desktop destination path" },
        mode: {
          type: "string",
          description:
            "Transport: 'ssh' (sftp, default when host is given) or 'http' (0.4.0 channel, needs remoteUrl). Omit to infer from which fields are present; passing both host and remoteUrl without mode is an error.",
        },
        host: {
          type: "string",
          description:
            "SSH: ssh-config alias on the desktop (recommended — reuses its existing ssh config and key, nothing to set up) or user@host. Call list_ssh_hosts first and let the user pick when it is not obvious. No spaces; must not start with '-'.",
        },
        port: { type: "integer", description: "SSH: TCP port (1-65535) if not already set in the ssh config entry" },
        remotePath: {
          type: "string",
          description:
            "SSH: absolute remote source path, e.g. /srv/transfer/file.bin. No control characters.",
        },
        remoteUrl: {
          type: "string",
          description:
            "HTTP: source http(s) URL to GET, e.g. http://127.0.0.1:9876/pull/file.bin or https://example.com/dfr/pull/file.bin (auth via Authorization header; token in URL is compatibility-only and will appear in logs)",
        },
        token: { type: "string", description: "HTTP only: Bearer token; sent as Authorization: Bearer <token> header if >=16 chars. Do not put token in the URL." },
        expectedRemoteSha256: { type: "string", description: "HTTP only: optional guard, expected sha256 of the remote content" },
        expectedSha256: { type: "string", description: "Required when overwriting: sha256 of the current target file" },
        allowCreate: { type: "boolean", description: "Required when the file does not exist yet" },
        timeoutMs: {
          type: "integer",
          description:
            "Timeout in ms. HTTP: 5000-120000, default 60000. SSH: 5000-1800000, default 300000. On SSH timeout the sftp process is killed.",
        },
      },
      required: ["path"],
    },
    execute: async (args) => pullRemoteFileToDesktop(args),
  });
  await pi.agent.registerTool({
    name: "list_ssh_hosts",
    description:
      "List the concrete Host aliases defined in the DESKTOP machine's ~/.ssh/config, together with the hostname / port / user each alias resolves to (never key paths). Read-only, no network. Call this FIRST whenever you need to move a file to or from a remote host: show the candidates to the user, let them choose, then pass the chosen alias as the `host` argument of push_desktop_file_to_remote / pull_remote_file_to_desktop. The plugin never picks a host by itself.",
    risk: "low",
    schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => listSshHosts(),
  });
}

async function onUnload() {
  await pi.agent.unregisterTool("read_desktop_file");
  await pi.agent.unregisterTool("list_desktop_dir");
  await pi.agent.unregisterTool("write_desktop_file");
  await pi.agent.unregisterTool("delete_desktop_file");
  await pi.agent.unregisterTool("push_desktop_file_to_remote");
  await pi.agent.unregisterTool("pull_remote_file_to_desktop");
  await pi.agent.unregisterTool("list_ssh_hosts");
}

module.exports = { onLoad, onUnload };
