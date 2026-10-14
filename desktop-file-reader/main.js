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
 */
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");

const MAX_CHUNK = 1024 * 1024; // 单次读取上限 1 MiB
const DEFAULT_CHUNK = 256 * 1024;
const MAX_WRITE = 4 * 1024 * 1024; // 单次写入上限 4 MiB
const MAX_HTTP_BYTES = 50 * 1024 * 1024; // HTTP 单次传输上限 50 MiB（与 nginx client_max_body_size 对齐）
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MIN_TIMEOUT_MS = 5 * 1000;
const MAX_TIMEOUT_MS = 120 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
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

/** 解析 timeoutMs，返回数值或错误。 */
function parseTimeoutMs(v) {
  if (v === undefined || v === null) return DEFAULT_TIMEOUT_MS;
  const n = Number(v);
  if (!Number.isInteger(n)) return { error: "timeoutMs must be an integer" };
  if (n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    return { error: "timeoutMs must be between " + MIN_TIMEOUT_MS + " and " + MAX_TIMEOUT_MS };
  }
  return n;
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
  if (args?.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      path: abs,
      wouldDelete: { size: st.size, mtimeMs: st.mtimeMs },
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
// 新增：HTTP 直传（字节不经 LLM）
// ---------------------------------------------------------------------------

/**
 * 将桌面文件通过 HTTP(S) 直传到远端 URL。
 * 字节走 TLS 直连，不经 LLM；桌面主动发起，适配远端不能连桌面的约束。
 */
async function pushDesktopFileToRemote(args) {
  const rawPath = String(args?.path ?? "");
  if (!rawPath) return { ok: false, error: "path is required" };
  const abs = path.resolve(rawPath);

  const parsed = parseRemoteUrl(args?.remoteUrl);
  if (parsed.error) return { ok: false, error: parsed.error };
  const u = parsed.url;

  const tokenErr = validateToken(args?.token);
  if (tokenErr) return { ok: false, error: tokenErr };

  const timeoutRaw = parseTimeoutMs(args?.timeoutMs);
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

/**
 * 从远端 URL 拉取并落盘到桌面路径。
 * 字节走 HTTP(S) 直连，不经 LLM。
 */
async function pullRemoteFileToDesktop(args) {
  const remoteRaw = args?.remoteUrl;
  const rawPath = String(args?.path ?? "");
  if (!rawPath) return { ok: false, error: "path is required" };
  const abs = path.resolve(rawPath);

  const parsed = parseRemoteUrl(remoteRaw);
  if (parsed.error) return { ok: false, error: parsed.error };
  const u = parsed.url;

  const tokenErr = validateToken(args?.token);
  if (tokenErr) return { ok: false, error: tokenErr };

  const timeoutRaw = parseTimeoutMs(args?.timeoutMs);
  if (timeoutRaw && typeof timeoutRaw === "object" && timeoutRaw.error) {
    return { ok: false, error: timeoutRaw.error };
  }
  const timeoutMs = timeoutRaw;

  const expectedRemoteSha = args?.expectedRemoteSha256 ? String(args.expectedRemoteSha256).trim().toLowerCase() : null;
  if (expectedRemoteSha && !isValidSha256(expectedRemoteSha)) {
    return { ok: false, error: "expectedRemoteSha256 must be 64 hex characters" };
  }
  const expectedSha = args?.expectedSha256 ? String(args.expectedSha256).trim().toLowerCase() : null;
  if (expectedSha && !isValidSha256(expectedSha)) {
    return { ok: false, error: "expectedSha256 must be 64 hex characters" };
  }

  // 目标状态检查
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
    // 若存在，校验乐观锁
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
    // 不存在
    if (args?.allowCreate !== true) {
      return { ok: false, error: "file does not exist; pass allowCreate:true to create it" };
    }
  }

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

  // TOCTOU 复核：若目标已存在，确认未被改动
  if (existed) {
    try {
      const re = await fsp.lstat(abs);
      const inodeChanged = Boolean(beforeSt.ino && re.ino && beforeSt.ino !== re.ino);
      if (inodeChanged || re.size !== beforeSt.size || re.mtimeMs !== beforeSt.mtimeMs) {
        try {
          await fsp.unlink(tmpPath);
        } catch {}
        return { ok: false, error: "target changed between verification and write; re-read it and retry" };
      }
      // 再核 sha（防御性）
      const reSha = await sha256OfFile(abs);
      if (reSha !== beforeSha) {
        try {
          await fsp.unlink(tmpPath);
        } catch {}
        return { ok: false, error: "target changed between verification and write; re-read it and retry" };
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        try {
          await fsp.unlink(tmpPath);
        } catch {}
        return { ok: false, error: "lstat failed before rename: " + (e.code || e.message) };
      }
      // 文件在验证后被删了，且调用方原本是覆盖场景，视为 changed
      try {
        await fsp.unlink(tmpPath);
      } catch {}
      return { ok: false, error: "target changed between verification and write; re-read it and retry" };
    }
  }

  // 原子重命名
  try {
    await fsp.rename(tmpPath, abs);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { ok: false, error: "rename failed: " + (e.code || e.message) };
  }

  // 最终校验
  let finalSha = receivedSha;
  try {
    // 若 rename 成功，文件 sha 即 receivedSha；再算一次以确认落盘无损
    finalSha = await sha256OfFile(abs);
    if (finalSha !== receivedSha) {
      return { ok: false, error: "sha mismatch after rename: disk content differs", expected: receivedSha, actual: finalSha };
    }
  } catch {}

  let finalSize = bytesReceived;
  try {
    finalSize = (await fsp.stat(abs)).size;
  } catch {}

  return {
    ok: true,
    path: abs,
    remoteUrl: u.toString(),
    bytesReceived,
    size: finalSize,
    sha256: finalSha,
    action: existed ? "overwritten" : "created",
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
      "Push a desktop file to a remote HTTP(S) URL (bytes go over TLS, not through LLM context). Use for large/binary files where base64 via LLM is lossy. Requires explicit user authorization for the specific path and remoteUrl (remoteUrl is unrestricted — only call with a user-authorized destination; auth via Authorization: Bearer <token> header, token in URL is compatibility-only and will appear in logs). The file is streamed via node:http(s) with X-File-SHA256 header.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path on the desktop to push" },
        remoteUrl: {
          type: "string",
          description:
            "Destination http(s) URL, e.g. http://127.0.0.1:9876/push/file.bin or https://example.com/dfr/push/file.bin (auth via Authorization: Bearer <token> header; putting token in URL is supported for compatibility but will appear in access logs — not recommended)",
        },
        token: {
          type: "string",
          description:
            "Bearer token; sent as Authorization: Bearer <token> header if >=16 chars. Do not put token in the URL — it will appear in access logs. Path token /push/<token>/ is only for compatibility.",
        },
        expectedSha256: { type: "string", description: "Optional guard: sha256 of the current file; refused if it changed" },
        timeoutMs: { type: "integer", description: "Request timeout in ms (5000-120000, default 60000)" },
        method: { type: "string", description: "HTTP method PUT or POST (default PUT)" },
      },
      required: ["path", "remoteUrl"],
    },
    execute: async (args) => pushDesktopFileToRemote(args),
  });

  await pi.agent.registerTool({
    name: "pull_remote_file_to_desktop",
    description:
      "Pull a remote HTTP(S) URL and save it to a desktop path (bytes go over TLS, not through LLM context). Use for large/binary files. Requires explicit user authorization for the specific path and remoteUrl (remoteUrl is unrestricted — only call with a user-authorized source; auth via Authorization header, token in URL is compatibility-only). Streams to a temp file then atomically renames.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        remoteUrl: {
          type: "string",
          description:
            "Source http(s) URL to GET, e.g. http://127.0.0.1:9876/pull/file.bin or https://example.com/dfr/pull/file.bin (auth via Authorization header; token in URL is compatibility-only and will appear in logs)",
        },
        path: { type: "string", description: "Absolute desktop destination path" },
        token: { type: "string", description: "Bearer token; sent as Authorization: Bearer <token> header if >=16 chars. Do not put token in the URL." },
        expectedRemoteSha256: { type: "string", description: "Optional guard: expected sha256 of the remote content" },
        expectedSha256: { type: "string", description: "Required when overwriting: sha256 of the current target file" },
        allowCreate: { type: "boolean", description: "Required when the file does not exist yet" },
        timeoutMs: { type: "integer", description: "Request timeout in ms (5000-120000, default 60000)" },
      },
      required: ["remoteUrl", "path"],
    },
    execute: async (args) => pullRemoteFileToDesktop(args),
  });

}

async function onUnload() {
  await pi.agent.unregisterTool("read_desktop_file");
  await pi.agent.unregisterTool("list_desktop_dir");
  await pi.agent.unregisterTool("write_desktop_file");
  await pi.agent.unregisterTool("delete_desktop_file");
  await pi.agent.unregisterTool("push_desktop_file_to_remote");
  await pi.agent.unregisterTool("pull_remote_file_to_desktop");
}

module.exports = { onLoad, onUnload };
