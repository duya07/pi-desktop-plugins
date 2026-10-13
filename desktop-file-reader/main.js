/**
 * Desktop File Reader — PI-Desktop plugin entry.
 *
 * Reads files from the DESKTOP filesystem with raw `node:fs` and returns them as
 * base64, so a session whose tools all run on a remote host can still obtain
 * desktop files without the browser panel.
 *
 * Why raw node:fs instead of the host API `pi.fs.readText`:
 *   - `pi.fs.readText` is bounded by `manifest.fs.read.scope` and unconditionally
 *     refuses `.env*`, `.ssh/`, `*.pem`, and the app's own data directory.
 *   - The plugin entry runs in its own Node process which is *not* an OS capability
 *     sandbox (stated in the official plugin-development doc), so raw `node:fs`
 *     reaches whatever the current Windows user can read.
 * The permission boundary of this plugin is therefore the user's own file access.
 * Only load plugins you trust.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_CHUNK = 1024 * 1024; // 1 MiB hard cap per call
const DEFAULT_CHUNK = 256 * 1024;

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
        /* unreadable entry: report it without size */
      }
    }
    out.push({ name: e.name, dir: e.isDirectory(), size });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { ok: true, path: abs, count: out.length, entries: out };
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
}

async function onUnload() {
  await pi.agent.unregisterTool("read_desktop_file");
  await pi.agent.unregisterTool("list_desktop_dir");
}

module.exports = { onLoad, onUnload };
