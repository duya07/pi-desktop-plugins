"use strict";

/**
 * Transcript Doctor — PI-Desktop 插件入口。
 *
 * 宿主注入全局 `pi`，每个调用都受 manifest.json 里声明的权限约束。
 *
 * 它做什么：体检会话转录的行偏移索引（`~/.pi-desktop/sessions/*.jsonl.layout`）
 * 是否与 `.jsonl` 内容对得上，脏了就备份并清掉，让下一次重启能重建干净的索引。
 * 它不做什么：不调用模型（零 token），不改 jsonl 内容，不重启宿主
 * —— 内存里的旧索引只能靠重启进程丢弃，这一点插件无能为力。
 *
 * 权限对应：
 *   ui.panel            → manifest.ui.panel 面板入口
 *   background.service  → contributes.services 的 watchdog
 *   notify              → 发现脏索引/持久化卡住时发原生通知
 *   agent.tool.register → transcript_doctor 工具
 *
 * 文件访问走 Node fs（见 src/scan.js 顶部说明）：宿主的 pi.fs.* 沙箱在
 * workspace 内，够不到 ~/.pi-desktop。
 */

const path = require("node:path");
const scan = require("./src/scan.js");

const COMMAND_OPEN = "transcript-doctor.open";
const COMMAND_SCAN = "transcript-doctor.scan";
const COMMAND_CLEAN = "transcript-doctor.clean";
const TOOL_NAME = "transcript_doctor";
const SERVICE_ID = "watchdog";

const DEFAULT_WATCH_MINUTES = 5;
/** 等 host-core 起来再自检，避免和启动争 IO */
const STARTUP_DELAY_MS = 15000;
/** 同一个问题指纹在该窗口内只提醒一次 */
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

let watchTimer = null;
let startupTimer = null;
let lastNotifyFingerprint = "";
let lastNotifyAt = 0;

/* ------------------------------------------------------------------ 设置 */

async function readSettings() {
  try {
    const s = (await pi.plugin.getSettings()) || {};
    const minutes = Number(s.watchIntervalMinutes);
    return {
      watchEnabled: s.watchEnabled !== false,
      notifyOnStale: s.notifyOnStale !== false,
      watchIntervalMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_WATCH_MINUTES,
    };
  } catch {
    return { watchEnabled: true, notifyOnStale: true, watchIntervalMinutes: DEFAULT_WATCH_MINUTES };
  }
}

/* ------------------------------------------------------------------ 动作 */

/** 面板与工具共用的扫描：一次扫描 + 日志/队列信号 */
function doScan(sessionId) {
  return scan.scanAll(sessionId);
}

/** 只给 agent 的瘦身版结果：控制进入对话上下文的体积 */
function summarizeForAgent(result) {
  return {
    ok: true,
    scannedAt: result.scannedAt,
    total: result.total,
    healthy: result.healthy,
    behind: result.behind,
    stale: result.stale,
    staleSessions: result.sessions
      .filter((s) => s.status === "stale" || s.status === "error")
      .map((s) => ({
        sessionId: s.sessionId,
        jsonlBytes: s.jsonlBytes,
        headerMatches: s.headerMatches,
        spans: s.spans,
        misaligned: s.misaligned,
        midUTF8: s.midUTF8,
        hasInflight: s.hasInflight,
        note: s.note,
      })),
    signals: {
      flushPausedRecent: result.signals.flushPausedRecent,
      flushPausedLastAt: result.signals.flushPausedLastAt,
      outboxEntries: result.signals.outboxEntries,
      outboxBySession: result.signals.outboxBySession.slice(0, 5),
    },
  };
}

async function backupDirNow() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 宿主实现是 `getDataPath: async () => dataPath()`，必须 await：
  // 当同步值用会拿到 Promise，path.join 会抛 TypeError 且面板侧只表现为“点了没反应”。
  const base = await pi.plugin.getDataPath();
  return path.join(base, "backups", stamp);
}

/** 备份 + 删除；dryRun 时不落盘 */
async function doClean(sessionIds, dryRun) {
  return scan.cleanLayouts({
    sessionIds: sessionIds && sessionIds.length ? sessionIds : undefined,
    dryRun,
    backupDir: dryRun ? null : await backupDirNow(),
  });
}

function staleFingerprint(result) {
  return result.sessions
    .filter((s) => s.status === "stale")
    .map((s) => `${s.sessionId}:${s.misaligned}:${s.midUTF8}:${s.headerMatches}`)
    .sort()
    .join("|");
}

/* ------------------------------------------------------------- 后台守护 */

/**
 * 低频自检。发现脏索引或近期 flush 卡住时发一次原生通知。
 * 同一个指纹在 NOTIFY_COOLDOWN_MS 内不重复提醒。
 */
async function watchdogTick(log, settings) {
  let result;
  try {
    result = doScan();
  } catch (err) {
    log(`scan failed: ${err && err.message ? err.message : err}`);
    return;
  }

  const staleCount = result.stale;
  const stalled = result.signals.flushPausedRecent;

  if (!staleCount && !stalled) {
    lastNotifyFingerprint = "";
    return;
  }

  const fingerprint = `${staleCount}|${stalled}|${staleFingerprint(result)}`;
  const now = Date.now();
  if (fingerprint === lastNotifyFingerprint && now - lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
  lastNotifyFingerprint = fingerprint;
  lastNotifyAt = now;

  if (!settings.notifyOnStale) {
    log(`stale=${staleCount} flushPaused=${stalled} (notification suppressed)`);
    return;
  }

  let zh = true;
  try {
    zh = String((await pi.app.getLocale()) || "").toLowerCase().startsWith("zh");
  } catch {
    /* 保持中文 */
  }

  const title = zh ? "转录索引需要处理" : "Transcript index needs attention";
  const parts = [];
  if (staleCount) {
    parts.push(zh ? `${staleCount} 个会话的 .jsonl.layout 已过期` : `${staleCount} session(s) have a stale .jsonl.layout`);
  }
  if (stalled) {
    parts.push(zh ? "持久化队列近期被暂停过" : "the persistence queue was paused recently");
  }
  const body = parts.join("；") + (zh ? "。打开 Transcript Doctor 面板可备份并清理。" : ". Open the Transcript Doctor panel to back up and clean.");

  log(`notify: stale=${staleCount} flushPaused=${stalled}`);
  try {
    const res = await pi.ui.showNativeNotification({ title, body });
    if (!res || !res.shown) {
      await pi.ui.notify({ title, body }).catch(() => {});
    }
  } catch {
    try {
      await pi.ui.notify({ title, body }).catch(() => {});
    } catch {
      /* 通知失败不影响体检 */
    }
  }
}

function stopWatchdog() {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

/* ---------------------------------------------------------------- 生命周期 */

async function onLoad() {
  await pi.commands.register({
    id: COMMAND_OPEN,
    title: "转录体检：打开面板",
    keywords: ["transcript", "layout", "utf8", "持久化", "索引", "体检"],
    run: async () => {
      await pi.ui.openPanel({ title: "转录体检" });
    },
  });

  await pi.commands.register({
    id: COMMAND_SCAN,
    title: "转录体检：立即扫描",
    keywords: ["transcript", "scan", "扫描"],
    run: async () => {
      const result = doScan();
      const msg = result.stale
        ? `发现 ${result.stale} 个会话索引过期（共 ${result.total}）`
        : `索引全部正常（共 ${result.total} 个会话）`;
      await pi.ui.showToast(msg);
    },
  });

  await pi.commands.register({
    id: COMMAND_CLEAN,
    title: "转录体检：备份并清理过期索引",
    keywords: ["transcript", "clean", "清理", "备份"],
    run: async () => {
      const before = doScan();
      if (!before.stale) {
        await pi.ui.showToast("没有需要清理的索引");
        return;
      }
      const ids = before.sessions.filter((s) => s.status === "stale").map((s) => s.sessionId);
      const res = await doClean(ids, false);
      const n = res.deleted ? res.deleted.length : 0;
      const f = res.failed ? res.failed.length : 0;
      await pi.ui.showToast(
        f
          ? `清理完成 ${n} 个，失败 ${f} 个（备份：${res.backupDir}）`
          : `已清理 ${n} 个索引并备份到 ${res.backupDir}；重启 PI 后生效`,
      );
    },
  });

  await pi.agent.registerTool({
    name: TOOL_NAME,
    description:
      "体检 PI-Desktop 的会话转录索引（~/.pi-desktop/sessions/*.jsonl.layout）。" +
      "宿主 host-core 会把每条消息的行偏移缓存在 .jsonl 旁边；当转录被原地重写（流式回复落地、子代理 Task 状态更新）而缓存未失效时，偏移会漂移，" +
      "宿主 seek 到行中间或多字节 UTF-8 字符内部，报 \"stream did not contain valid UTF-8\" 并永久暂停持久化队列（消息积压在 session-message-outbox.json）。" +
      "action=scan 列出所有会话的健康状况（只返回有问题的会话，结果很小）；action=inspect 看单个会话的完整字段（需要 sessionId）；" +
      "action=clean 备份并删除过期索引（默认 dry-run，必须显式 confirm=true 才真的删除）；action=verify 返回每个会话一行摘要。" +
      "注意：清理只让『下一次重启』干净，宿主内存里的旧索引必须重启进程才会丢弃；本工具不重启宿主、不改 .jsonl 内容、不调用模型。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["scan", "inspect", "clean", "verify"],
          description: "要执行的操作",
        },
        sessionId: {
          type: "string",
          description: "inspect 必填；clean 可选，限定只清理该会话",
        },
        confirm: {
          type: "boolean",
          description: "clean 必须显式 true 才真正删除；省略或 false 时只返回将要删除的清单（dry-run）",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String((args && args.action) || "");
      const sessionId = args && args.sessionId ? String(args.sessionId) : "";

      if (action === "scan") {
        return summarizeForAgent(doScan(sessionId || undefined));
      }

      if (action === "verify") {
        const result = doScan(sessionId || undefined);
        return {
          ok: true,
          total: result.total,
          stale: result.stale,
          lines: result.sessions.map(
            (s) =>
              `${s.sessionId}  ${s.status}  bytes=${s.jsonlBytes}  spans=${s.spans}  mis=${s.misaligned}  midUTF8=${s.midUTF8}  hdrMatch=${s.headerMatches}${s.hasInflight ? "  inflight" : ""}`,
          ),
        };
      }

      if (action === "inspect") {
        if (!sessionId) return { ok: false, error: "inspect requires sessionId" };
        return { ok: true, session: scan.inspectSession(sessionId) };
      }

      if (action === "clean") {
        const dryRun = !(args && args.confirm === true);
        const result = await doClean(sessionId ? [sessionId] : undefined, dryRun);
        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            plannedCount: result.planned.length,
            planned: result.planned.map((p) => `${path.basename(p.path)} (${p.bytes} B)`),
            hint: "再次调用并带 confirm=true 才会真的备份并删除；清理后需重启 PI 才生效。",
          };
        }
        return {
          ok: true,
          dryRun: false,
          deleted: result.deleted.map((d) => path.basename(d.path)),
          failed: result.failed,
          backupDir: result.backupDir,
          hint: "索引已清理；宿主内存里的旧索引仍在，重启 PI 后才会重建干净的索引。",
        };
      }

      return { ok: false, error: `unknown action: ${action}` };
    },
  });

  const settings = await readSettings();
  pi.services.register({
    id: SERVICE_ID,
    start: ({ log }) => {
      log(`watchdog started (every ${settings.watchIntervalMinutes} min, enabled=${settings.watchEnabled})`);
      startupTimer = setTimeout(() => {
        startupTimer = null;
        void watchdogTick(log, settings);
      }, STARTUP_DELAY_MS);
      if (settings.watchEnabled) {
        const interval = Math.max(1, settings.watchIntervalMinutes) * 60 * 1000;
        watchTimer = setInterval(() => {
          void watchdogTick(log, settings);
        }, interval);
      }
    },
    stop: () => {
      stopWatchdog();
    },
  });

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", () => {
      void readSettings().then((next) => {
        if (!next.watchEnabled) {
          if (watchTimer) {
            clearInterval(watchTimer);
            watchTimer = null;
          }
          return;
        }
        if (watchTimer) clearInterval(watchTimer);
        watchTimer = setInterval(() => {
          void watchdogTick(() => {}, next);
        }, Math.max(1, next.watchIntervalMinutes) * 60 * 1000);
      });
    });
  }
}

async function onUnload() {
  stopWatchdog();
  try {
    await pi.services.unregister(SERVICE_ID);
  } catch {
    /* 宿主卸载前已停服务，可忽略 */
  }
  try {
    await pi.commands.unregister(COMMAND_OPEN);
    await pi.commands.unregister(COMMAND_SCAN);
    await pi.commands.unregister(COMMAND_CLEAN);
  } catch {
    /* 忽略 */
  }
  try {
    await pi.agent.unregisterTool(TOOL_NAME);
  } catch {
    /* 忽略 */
  }
}

/**
 * 面板 → 插件进程通道（面板侧用 window.pluginBridge.invoke(channel, payload)）。
 */
async function onPanelInvoke(channel, payload) {
  if (channel === "doctor.scan") {
    return doScan(payload && payload.sessionId ? String(payload.sessionId) : undefined);
  }
  if (channel === "doctor.signals") {
    return scan.readSignals();
  }
  if (channel === "doctor.clean") {
    const sessionIds = payload && Array.isArray(payload.sessionIds) ? payload.sessionIds : undefined;
    const dryRun = !(payload && payload.confirm === true);
    return await doClean(sessionIds, dryRun);
  }
  if (channel === "doctor.paths") {
    return {
      dataDir: scan.DATA_DIR,
      sessionsDir: scan.SESSIONS_DIR,
      persistenceLog: scan.PERSISTENCE_LOG,
      outboxFile: scan.OUTBOX_FILE,
      backupRoot: path.join(await pi.plugin.getDataPath(), "backups"),
      layoutCacheMinLen: scan.LAYOUT_CACHE_MIN_LEN,
    };
  }
  throw new Error(`unsupported panel channel: ${channel}`);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
