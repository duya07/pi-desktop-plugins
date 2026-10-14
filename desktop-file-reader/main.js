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
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_CHUNK = 1024 * 1024; // 单次读取上限 1 MiB
const DEFAULT_CHUNK = 256 * 1024;
const MAX_WRITE = 4 * 1024 * 1024; // 单次写入上限 4 MiB

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

async function readDesktopFile(args) {
  const raw = String(args?.path ?? "");
  if (!raw) return { ok: false, error: "path is required" };
  const abs = path.resolve(raw);

  const offset = Math.max(0, Number(args?.offset ?? 0) | 0);
  const length = Math.min(MAX_CHUNK, Math.max(1, Number(args?.length ?? DEFAULT_CHUNK) | 0));

  const st = await fsp.stat(abs);
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

  const entries = await fsp.readdir(abs, { withFileTypes: true });
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
}

async function onUnload() {
  await pi.agent.unregisterTool("read_desktop_file");
  await pi.agent.unregisterTool("list_desktop_dir");
  await pi.agent.unregisterTool("write_desktop_file");
  await pi.agent.unregisterTool("delete_desktop_file");
}

module.exports = { onLoad, onUnload };
