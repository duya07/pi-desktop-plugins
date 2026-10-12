"use strict";

/**
 * Transcript Doctor — 转录索引体检核心。
 *
 * 纯本地字节比对，不调用任何模型：判断某个会话的 `.jsonl.layout`
 * （宿主 host-core 缓存在转录旁边的行偏移索引）是否与 `.jsonl` 内容对得上。
 *
 * 背景：PI-Desktop 宿主在转录被原地重写后没有让磁盘上的 layout 缓存失效
 * （Windows 上 file_identity 恒为 0，见 vastsa/PI-Desktop#1585），
 * 于是 host-core 会 seek 到行中间甚至多字节 UTF-8 字符的续字节，
 * read_line() 抛 "stream did not contain valid UTF-8"，持久化队列被永久暂停。
 * 本模块负责在事情变糟之前把它指出来。
 *
 * 只读 + 白名单删除：
 *   - 读：~/.pi-desktop/sessions/*.jsonl(.layout)、logs/app/persistence.log、
 *         session-message-outbox.json
 *   - 删：仅 sessions 目录下匹配 *.jsonl.layout / *.layout.tmp 的文件，
 *         且必须先备份成功
 *   - 永不触碰 .jsonl / .inflight.json / outbox
 *
 * 宿主提供的 pi.fs.* 被沙箱在 workspace 内，够不到 ~/.pi-desktop，
 * 因此这里使用 Node fs（与 cn.star.skill-learning / pi.file-manager 同做法）。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DATA_DIR = path.join(os.homedir(), ".pi-desktop");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const PERSISTENCE_LOG = path.join(DATA_DIR, "logs", "app", "persistence.log");
const OUTBOX_FILE = path.join(DATA_DIR, "session-message-outbox.json");

/** 宿主只在转录 >= 2 MiB 时才写 layout 缓存（host-core: LAYOUT_CACHE_MIN_LEN） */
const LAYOUT_CACHE_MIN_LEN = 2 * 1024 * 1024;

/** 读日志只取尾部，避免整读大文件 */
const LOG_TAIL_BYTES = 512 * 1024;

/** 判定为“持久化卡住”的最近窗口 */
const STALL_WINDOW_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ 工具 */

function isLayoutFileName(name) {
  return name.endsWith(".jsonl.layout") || name.endsWith(".layout.tmp");
}

/**
 * 删除白名单校验：必须是 sessions 目录的直接子项，且文件名是 layout 缓存。
 * 任何不满足的路径直接拒绝——这是本插件唯一的破坏性动作。
 */
function assertDeletable(filePath) {
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(SESSIONS_DIR)) {
    throw new Error("refused: path is outside the sessions directory");
  }
  if (!isLayoutFileName(path.basename(resolved))) {
    throw new Error("refused: not a layout cache file");
  }
  return resolved;
}

/**
 * data[off] 是否落在多字节 UTF-8 字符的中间（即不是一个字符的起点）。
 * 正是这种偏移会让 host-core 的 read_line() 报 invalid UTF-8。
 */
function utf8BadStart(buf, off) {
  if (off < 0 || off >= buf.length) return false;
  const b = buf[off];
  if (b < 0x80) return false;
  let need;
  if (b >= 0xc2 && b <= 0xdf) need = 1;
  else if (b >= 0xe0 && b <= 0xef) need = 2;
  else if (b >= 0xf0 && b <= 0xf4) need = 3;
  else return true; // 裸续字节 0x80-0xbf 或非法首字节
  if (off + need >= buf.length) return true;
  for (let i = 1; i <= need; i++) {
    const c = buf[off + i];
    if (c < 0x80 || c > 0xbf) return true;
  }
  return false;
}

/**
 * 解析 layout 缓存文本。
 * 结构：第 1 行 "<revision> <fileBytes>"，第 2 行 "<count> <x>"，
 * 其后为每条消息的行起始字节偏移。
 */
function parseLayout(raw) {
  const nums = [];
  for (const tok of raw.split(/\s+/)) {
    if (/^-?\d+$/.test(tok)) nums.push(Number(tok));
  }
  if (nums.length < 4) return null;
  return {
    revision: nums[0],
    headerBytes: nums[1],
    headerCount: nums[2],
    offsets: nums.slice(4),
  };
}

function countLines(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

function readTail(file, maxBytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------- 单会话体检 */

/**
 * 体检一个会话。任何异常都被收敛进返回值，不向上抛。
 */
function inspectSession(sessionId) {
  const jsonlPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  const layoutPath = `${jsonlPath}.layout`;
  const inflightPath = path.join(SESSIONS_DIR, `${sessionId}.inflight.json`);

  const out = {
    sessionId,
    jsonlBytes: 0,
    mtime: null,
    lines: null,
    hasInflight: false,
    cachePresent: false,
    headerBytes: null,
    headerMatches: null,
    spans: 0,
    misaligned: 0,
    midUTF8: 0,
    sampleBadOffsets: [],
    status: "unknown",
    note: "",
  };

  try {
    const st = fs.statSync(jsonlPath);
    out.jsonlBytes = st.size;
    out.mtime = st.mtime.toISOString();
  } catch (err) {
    out.status = "error";
    out.note = `cannot read transcript: ${err && err.message ? err.message : err}`;
    return out;
  }

  try {
    out.hasInflight = fs.existsSync(inflightPath);
  } catch {
    out.hasInflight = false;
  }

  // 没有 layout 缓存就没有会错位的偏移：不必读转录全文（大会话很贵）
  if (!fs.existsSync(layoutPath)) {
    out.cachePresent = false;
    out.status = "no-cache";
    out.note =
      out.jsonlBytes >= LAYOUT_CACHE_MIN_LEN
        ? ">=2MiB but no layout cache on disk (host will rescan)"
        : "below the 2 MiB cache threshold";
    return out;
  }

  out.cachePresent = true;

  let buf;
  try {
    buf = fs.readFileSync(jsonlPath);
    out.lines = countLines(buf);
  } catch (err) {
    out.status = "error";
    out.note = `cannot read transcript: ${err && err.message ? err.message : err}`;
    return out;
  }
  let parsed;
  try {
    parsed = parseLayout(fs.readFileSync(layoutPath, "utf8"));
  } catch (err) {
    out.status = "error";
    out.note = `cannot read layout: ${err && err.message ? err.message : err}`;
    return out;
  }

  if (!parsed) {
    out.status = "stale";
    out.note = "layout file is malformed";
    return out;
  }

  out.headerBytes = parsed.headerBytes;
  out.headerMatches = parsed.headerBytes === buf.length;
  out.spans = parsed.offsets.length;

  for (const off of parsed.offsets) {
    if (off === 0) continue;
    const onLineStart = off > 0 && off < buf.length && buf[off - 1] === 0x0a;
    if (!onLineStart) out.misaligned++;
    if (utf8BadStart(buf, off)) {
      out.midUTF8++;
      if (out.sampleBadOffsets.length < 3) out.sampleBadOffsets.push(off);
    }
  }

  // 偏移是否还能安全使用：都在行首就意味着 seek 不会切进行中间或字符内部。
  const offsetsSafe = out.misaligned === 0 && out.midUTF8 === 0;

  if (out.headerMatches && offsetsSafe) {
    out.status = "healthy";
  } else if (offsetsSafe) {
    // 宿主容忍一定量的追加落后（LAYOUT_CACHE_MAX_LAG）：文件只长了尾巴时
    // 旧偏移依然指向行首，读取不会出错。但一旦转录被原地重写，这批偏移
    // 就会整体漂移成 stale，所以这里单独标一档、不算问题。
    out.status = "behind";
    out.note = `cache lags the transcript (header ${parsed.headerBytes} vs file ${buf.length}); offsets still line up`;
  } else {
    out.status = "stale";
    const bits = [];
    if (!out.headerMatches) bits.push(`header ${parsed.headerBytes} != file ${buf.length}`);
    if (out.misaligned) bits.push(`${out.misaligned} offset(s) not on a line start`);
    if (out.midUTF8) bits.push(`${out.midUTF8} offset(s) inside a multi-byte character`);
    out.note = bits.join("; ");
  }
  return out;
}

/* ------------------------------------------------------------- 全量扫描 */

/** 只认标准的 <uuid>.jsonl，排除 <uuid>.revisions.jsonl 这类同后缀文件 */
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function listSessions() {
  let entries = [];
  try {
    entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = new Set();
  for (const e of entries) {
    if (!e.isFile() || !SESSION_FILE_RE.test(e.name)) continue;
    ids.add(e.name.slice(0, -".jsonl".length));
  }
  return [...ids].sort();
}

function scanAll(filterSessionId) {
  const ids = filterSessionId ? [filterSessionId] : listSessions();
  const sessions = ids.map((id) => {
    try {
      return inspectSession(id);
    } catch (err) {
      return {
        sessionId: id,
        status: "error",
        note: String(err && err.message ? err.message : err),
      };
    }
  });
  return {
    dataDir: DATA_DIR,
    scannedAt: new Date().toISOString(),
    total: sessions.length,
    healthy: sessions.filter((s) => s.status === "healthy").length,
    behind: sessions.filter((s) => s.status === "behind").length,
    stale: sessions.filter((s) => s.status === "stale").length,
    sessions,
    signals: readSignals(),
  };
}

/* --------------------------------------------------------- 日志 / 队列信号 */

function readSignals() {
  const signals = {
    flushPausedRecent: false,
    flushPausedLastAt: null,
    flushPausedKeys: [],
    outboxBytes: 0,
    outboxEntries: 0,
    outboxBySession: [],
  };

  try {
    if (fs.existsSync(PERSISTENCE_LOG)) {
      const tail = readTail(PERSISTENCE_LOG, LOG_TAIL_BYTES);
      const keys = new Set();
      let lastAt = null;
      for (const line of tail.split(/\r?\n/)) {
        if (!line.includes("session.persistence.flush.paused")) continue;
        const m = line.match(/"ts":"([^"]+)"/);
        if (m) lastAt = m[1];
        const k = line.match(/"key":"([^"]+)"/);
        if (k && keys.size < 5) keys.add(k[1]);
      }
      signals.flushPausedLastAt = lastAt;
      signals.flushPausedKeys = [...keys];
      if (lastAt) {
        const age = Date.now() - new Date(lastAt).getTime();
        signals.flushPausedRecent = Number.isFinite(age) && age >= 0 && age <= STALL_WINDOW_MS;
      }
    }
  } catch {
    /* 日志不可读时保持默认值 */
  }

  try {
    if (fs.existsSync(OUTBOX_FILE)) {
      const raw = fs.readFileSync(OUTBOX_FILE, "utf8");
      signals.outboxBytes = Buffer.byteLength(raw, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        signals.outboxEntries = parsed.length;
        const bySession = new Map();
        for (const e of parsed) {
          const id = e && typeof e.sessionId === "string" ? e.sessionId : "(unknown)";
          bySession.set(id, (bySession.get(id) || 0) + 1);
        }
        signals.outboxBySession = [...bySession.entries()]
          .map(([sessionId, count]) => ({ sessionId, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
      }
    }
  } catch {
    /* 队列解析失败时保持默认值 */
  }

  return signals;
}

/* --------------------------------------------------------------- 清理 */

/**
 * 备份并删除 layout 缓存。默认 dryRun，只有显式 dryRun:false 才真正落盘。
 * 备份失败则拒绝删除——宁可留着脏缓存，也不做不可回退的删除。
 */
function cleanLayouts(opts) {
  const options = opts || {};
  const dryRun = options.dryRun !== false;
  const ids = options.sessionIds && options.sessionIds.length
    ? options.sessionIds
    : listSessions();

  const targets = [];
  for (const id of ids) {
    const layoutPath = path.join(SESSIONS_DIR, `${id}.jsonl.layout`);
    const tmpPath = path.join(SESSIONS_DIR, `${id}.jsonl.layout.tmp`);
    for (const p of [layoutPath, tmpPath]) {
      try {
        if (fs.existsSync(p)) targets.push(p);
      } catch {
        /* 忽略 */
      }
    }
  }

  // 全部先过白名单，任一不合规就整体中止
  const approved = targets.map((p) => assertDeletable(p));

  const plan = approved.map((p) => ({ path: p, bytes: fs.statSync(p).size }));
  if (dryRun) {
    return { dryRun: true, deleted: [], planned: plan, backupDir: null };
  }

  const backupDir = options.backupDir;
  if (!backupDir) throw new Error("backupDir is required for a real clean");

  fs.mkdirSync(backupDir, { recursive: true });
  const deleted = [];
  const failed = [];
  for (const p of approved) {
    const dest = path.join(backupDir, path.basename(p));
    try {
      fs.copyFileSync(p, dest);
      if (fs.statSync(dest).size !== fs.statSync(p).size) {
        throw new Error("backup size mismatch");
      }
      fs.unlinkSync(p);
      deleted.push({ path: p, bytes: fs.statSync(dest).size, backup: dest });
    } catch (err) {
      failed.push({ path: p, error: String(err && err.message ? err.message : err) });
    }
  }
  return { dryRun: false, deleted, failed, planned: plan, backupDir };
}

/* --------------------------------------------------------------- 备份管理 */

/** 备份目录白名单：必须是备份根目录的直接子目录，且名字是安全字符。 */
function assertBackupDir(backupRoot, dirPath) {
  const resolved = path.resolve(dirPath);
  if (path.dirname(resolved) !== path.resolve(backupRoot)) {
    throw new Error("refused: not a direct child of the backup root");
  }
  if (!/^[0-9A-Za-z._-]+$/.test(path.basename(resolved))) {
    throw new Error("refused: unexpected backup directory name");
  }
  return resolved;
}

/**
 * 列出已有备份。备份目录名就是生成时的 ISO 时间戳（`:`/`.` 换成 `-`），
 * 所以按名字倒序即"最新在前"，不需要额外取 mtime。
 */
function listBackups(backupRoot) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(backupRoot, e.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((n) => isLayoutFileName(n));
    } catch {
      /* 读不了就当空目录 */
    }
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
      } catch {
        /* 忽略单个文件 */
      }
    }
    out.push({ name: e.name, dir, files: files.length, bytes });
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

/** 只保留最近 keep 份备份，更旧的删掉。keep <= 0 表示不清理。 */
function pruneBackups(backupRoot, keep) {
  const k = Number(keep);
  if (!Number.isFinite(k) || k <= 0) return { pruned: [], failed: [], kept: null };
  const all = listBackups(backupRoot);
  const doomed = all.slice(Math.max(0, Math.trunc(k)));
  const pruned = [];
  const failed = [];
  for (const b of doomed) {
    try {
      assertBackupDir(backupRoot, b.dir);
      fs.rmSync(b.dir, { recursive: true, force: true });
      pruned.push({ name: b.name, files: b.files, bytes: b.bytes });
    } catch (err) {
      failed.push({ name: b.name, error: String(err && err.message ? err.message : err) });
    }
  }
  return { pruned, failed, kept: Math.min(all.length, Math.max(0, Math.trunc(k))) };
}

/** 删掉指定的一份备份（按目录名）。 */
function removeBackup(backupRoot, name) {
  const dir = path.join(backupRoot, String(name || ""));
  assertBackupDir(backupRoot, dir);
  const files = fs.readdirSync(dir).length;
  fs.rmSync(dir, { recursive: true, force: true });
  return { name: String(name), files };
}

module.exports = {
  DATA_DIR,
  SESSIONS_DIR,
  PERSISTENCE_LOG,
  OUTBOX_FILE,
  LAYOUT_CACHE_MIN_LEN,
  isLayoutFileName,
  assertDeletable,
  assertBackupDir,
  inspectSession,
  scanAll,
  readSignals,
  cleanLayouts,
  listBackups,
  pruneBackups,
  removeBackup,
  listSessions,
};
