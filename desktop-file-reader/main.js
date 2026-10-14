/**
 * 桌面文件读写 — PI-Desktop 插件入口。
 *
 * 让所有工具都在远端执行的会话（RACP Remote Host）能够读取与写入**桌面机**上的文件，
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
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_CHUNK = 1024 * 1024; // 单次读取上限 1 MiB
const DEFAULT_CHUNK = 256 * 1024;
const MAX_WRITE = 4 * 1024 * 1024; // 单次写入上限 4 MiB

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
}

async function onUnload() {
  await pi.agent.unregisterTool("read_desktop_file");
  await pi.agent.unregisterTool("list_desktop_dir");
  await pi.agent.unregisterTool("write_desktop_file");
}

module.exports = { onLoad, onUnload };
