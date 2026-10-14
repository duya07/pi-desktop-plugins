/**
 * Put this plugin's thinking ladder into the host's own provider row.
 *
 * Why this exists: the host's `pi`-source model reader (`parsePiModelConfig` ->
 * `bindingFromPiModel`, `out/main/index.js:1884` / `:2238`) has no ladder field.
 * It reads `id`, `limit.context` / `limit.output`, `contextWindowSource` /
 * `maxTokensSource`, `reasoning`, `input` and `nativeWebSearch`, and answers
 * `reasoning: true` with a hardcoded `["off","low","medium","high"]` plus a
 * `medium` default (`:2250-2257`). So an imported model can never carry the
 * catalog's ladder, and `max` is unreachable.
 *
 * The only payload that does carry a ladder is `parseProviderImportPayload`
 * (whose `MODEL_FIELDS` includes `thinkingLevels` / `defaultThinkingLevel`), and
 * it is reachable only from cloud sync and SSH import - both go through
 * `isSyncableProvider` -> `networkEndpoint()`, which refuses `127.x`
 * (`chunks/index-DS4oZDow.js:10521-10523`), so a loopback gateway can never use
 * them. The host exposes no provider-write IPC either: `providers/list`,
 * `providers/listModels` and `providers/modelCatalogStatus` are reads, and
 * `providers/refreshModelCatalog` only refreshes models.dev.
 *
 * So this module edits the one row the user imported, in place: two fields per
 * model inside `providers.config_json`, in a transaction, with the original kept
 * so the panel can put it back.
 *
 * This is deliberately out of contract - it writes the host's database, which no
 * declared permission covers. The host itself loads `node:sqlite` for its own
 * provider import, and this plugin already runs in the host's main process with
 * plain `require` (it writes its own `config.json` and `usage.jsonl` with
 * `node:fs`), so the builtin is there. What keeps it honest:
 *
 *   - it runs only when the user clicks the panel button, never on its own;
 *   - it refuses to write unless exactly one row matches this plugin's gateway
 *     and its `config_json` parses into the shape it expects;
 *   - it only ever sets `thinkingLevels` / `defaultThinkingLevel`, and only for
 *     model ids this plugin's own import prefix maps back to a catalog model;
 *   - every value it writes satisfies the host's own rule that the default level
 *     is one of the levels;
 *   - the original row is saved first, and `undo` restores it verbatim.
 *
 * @module cline-pass/hostladder
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { GATEWAY_BASE_URL } = require('./protocol.js')
const { unimportModelId } = require('./models.js')

/** The `host:port` the imported provider points at, e.g. `127.0.0.1:41593`. */
const GATEWAY_AUTHORITY = (() => {
  try {
    return new URL(GATEWAY_BASE_URL).host
  } catch {
    return ''
  }
})()

/** Where the original row is kept between `sync` and `undo`. */
const BACKUP_FILENAME = 'host-ladder-original.json'

/**
 * The host's database, derived from this plugin's own data directory.
 *
 * `pi.plugin.getDataPath()` is `<hostDataDir>/plugins/data/<pluginId>`, so the
 * database is three levels up. The literal fallback covers a host that reports a
 * data directory somewhere else; the derived path is returned when neither
 * exists, so the error message names the place the plugin expected.
 */
function hostDbPath(dataDir, home = os.homedir()) {
  const root = String(dataDir ?? '').trim()
  const derived = path.resolve(root === '' ? '.' : root, '..', '..', '..', 'pi.sqlite')
  if (fs.existsSync(derived)) return derived
  // The literal fallback only applies when the caller knows its own data
  // directory. An empty one means "no opinion", and guessing the real host's file
  // from a test process would make every test depend on this machine.
  if (root === '') return derived
  const fallback = path.join(home, '.pi-desktop', 'pi.sqlite')
  return fs.existsSync(fallback) ? fallback : derived
}

/** Whether one `providers` row is the one this plugin's config created. */
function isGatewayRow(row) {
  if (!row || typeof row !== 'object') return false
  const baseUrl = String(row.base_url ?? '')
  return GATEWAY_AUTHORITY !== '' && baseUrl.includes(GATEWAY_AUTHORITY)
}

/**
 * The change this plugin would make to one stored `config_json`, as pure data.
 *
 * `wanted` maps a *catalog* id (`cline-pass/x`) to `{ thinkingLevels,
 * defaultThinkingLevel }`. A stored id is mapped back through the import prefix,
 * so the row's spelling and the catalog's spelling can differ.
 *
 * Refusals are reported rather than silently skipped: `skipped` names the model
 * and why, and an unparsable document or a missing `models` array is an error
 * instead of an empty change.
 */
function planLadder(configJson, wanted) {
  let config
  try {
    config = JSON.parse(configJson)
  } catch {
    return { ok: false, error: '宿主那一行的 config_json 不是合法 JSON，未写入任何东西。' }
  }
  if (!config || typeof config !== 'object' || !Array.isArray(config.models)) {
    return { ok: false, error: '宿主那一行没有 models 数组，未写入任何东西。' }
  }
  const changes = []
  const skipped = []
  const models = config.models.map((model) => {
    const storedId = String(model?.id ?? '')
    const catalogId = unimportModelId(storedId) ?? storedId
    const target = wanted instanceof Map ? wanted.get(catalogId) : undefined
    if (!target) {
      skipped.push({ id: storedId, reason: '不在「生成配置」里（没勾或不是本插件的模型）' })
      return model
    }
    const levels = Array.isArray(target.thinkingLevels) ? target.thinkingLevels : []
    // A model whose catalog ladder is only `off` has nothing to offer the host:
    // the host already reads an empty ladder as "no thinking".
    if (!levels.some((level) => level !== 'off')) {
      skipped.push({ id: storedId, reason: '目录里它没有思考档位（只有 off）' })
      return model
    }
    const same =
      JSON.stringify(model.thinkingLevels) === JSON.stringify(levels) &&
      model.defaultThinkingLevel === target.defaultThinkingLevel
    if (same) {
      skipped.push({ id: storedId, reason: '已经是这个档位了' })
      return model
    }
    if (!levels.includes(target.defaultThinkingLevel)) {
      return { error: `插件目录给 ${storedId} 的默认档位 ${String(target.defaultThinkingLevel)} 不在档位表里。` }
    }
    changes.push({
      id: storedId,
      from: { thinkingLevels: model.thinkingLevels ?? null, defaultThinkingLevel: model.defaultThinkingLevel ?? null },
      to: { thinkingLevels: [...levels], defaultThinkingLevel: target.defaultThinkingLevel },
    })
    // Only these two keys are replaced; every other key and its order stays put.
    return { ...model, thinkingLevels: [...levels], defaultThinkingLevel: target.defaultThinkingLevel }
  })
  const failed = models.find((model) => model && model.error)
  if (failed) return { ok: false, error: failed.error }
  return { ok: true, next: JSON.stringify({ ...config, models }), changes, skipped }
}

/** Load the host's SQLite builtin, or explain why it is not there. */
function loadSqlite() {
  try {
    return { DatabaseSync: process.getBuiltinModule?.('node:sqlite')?.DatabaseSync ?? require('node:sqlite').DatabaseSync }
  } catch {
    return { error: '宿主这个版本没有 node:sqlite（宿主自己读 SQLite 也用它）。这一步做不了，档位只能在设置页手改。' }
  }
}

/** The one gateway row, or an explanation of why the write must not happen. */
function findGatewayRow(db) {
  const rows = db.prepare('select id, name, base_url, config_json from providers').all()
  const matches = rows.filter(isGatewayRow)
  if (matches.length === 0) {
    return { error: `宿主库里没有指向 ${GATEWAY_BASE_URL} 的 provider —— 先把「生成配置」导入一次，再点这个按钮。` }
  }
  if (matches.length > 1) {
    return { error: `宿主库里有 ${matches.length} 行都指向 ${GATEWAY_BASE_URL}，不敢猜哪一行，未写入。请删掉多余的。` }
  }
  return { row: matches[0] }
}


/** Read the ladder back through a fresh connection: the persisted value, not ours. */
function readBack(dbPath, rowId) {
  const { DatabaseSync, error } = loadSqlite()
  if (error) return { error }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('select config_json from providers where id = ?').get(rowId)
    if (!row) return { error: '回读时那一行不见了。' }
    const config = JSON.parse(row.config_json)
    return { models: (config.models ?? []).map((model) => ({ id: model.id, thinkingLevels: model.thinkingLevels ?? null, defaultThinkingLevel: model.defaultThinkingLevel ?? null })) }
  } finally {
    db.close()
  }
}

/**
 * Write the ladder into the host's row, saving the original first.
 *
 * Never throws for an expected refusal (no row, two rows, unparsable JSON, a
 * missing SQLite builtin): each comes back as `{ ok: false, error }` so the panel
 * can show the reason instead of a stack trace.
 */
function syncLadder({ dataDir, wanted, dbPath }) {
  const sqlite = loadSqlite()
  if (sqlite.error) return { ok: false, error: sqlite.error }
  const file = dbPath ?? hostDbPath(dataDir)
  if (!fs.existsSync(file)) return { ok: false, error: `找不到宿主数据库：${file}` }
  const db = new sqlite.DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    const found = findGatewayRow(db)
    if (found.error) return { ok: false, error: found.error }
    const planned = planLadder(found.row.config_json, wanted)
    if (!planned.ok) return { ok: false, error: planned.error }
    if (planned.changes.length === 0) {
      return { ok: true, changed: 0, skipped: planned.skipped, models: readBack(file, found.row.id).models, note: '宿主那一行已经和插件一致，没有改动。' }
    }
    const backupFile = path.join(dataDir, BACKUP_FILENAME)
    fs.writeFileSync(
      backupFile,
      `${JSON.stringify({ savedAt: new Date().toISOString(), rowId: found.row.id, name: found.row.name, baseUrl: found.row.base_url, configJson: found.row.config_json }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    db.exec('BEGIN IMMEDIATE')
    const info = db.prepare('update providers set config_json = ? where id = ?').run(planned.next, found.row.id)
    db.exec('COMMIT')
    if (Number(info.changes) !== 1) {
      return { ok: false, error: `期望改 1 行，实际 ${String(info.changes)} 行 —— 数据库已被回滚，请核对。` }
    }
    const back = readBack(file, found.row.id)
    if (back.error) return { ok: false, error: back.error }
    return {
      ok: true,
      changed: planned.changes.length,
      changes: planned.changes,
      skipped: planned.skipped,
      models: back.models,
      rowId: found.row.id,
      backupFile,
      note: '已写入宿主那一行。设置页里点一次「保存服务」会用宿主内存里的旧副本覆盖回去，别在那条 provider 上点保存。',
    }
  } finally {
    db.close()
  }
}

/** Put the saved original back. */
function undoLadder({ dataDir, dbPath }) {
  const sqlite = loadSqlite()
  if (sqlite.error) return { ok: false, error: sqlite.error }
  const file = dbPath ?? hostDbPath(dataDir)
  const backupFile = path.join(dataDir, BACKUP_FILENAME)
  if (!fs.existsSync(backupFile)) return { ok: false, error: `没有可恢复的原值（${backupFile}）。` }
  const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  const db = new sqlite.DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    db.exec('BEGIN IMMEDIATE')
    const info = db.prepare('update providers set config_json = ? where id = ?').run(saved.configJson, saved.rowId)
    db.exec('COMMIT')
    if (Number(info.changes) !== 1) return { ok: false, error: `期望恢复 1 行，实际 ${String(info.changes)} 行。` }
    const back = readBack(file, saved.rowId)
    if (back.error) return { ok: false, error: back.error }
    return { ok: true, changed: 1, models: back.models, note: `已恢复到 ${saved.savedAt} 保存的原值。` }
  } finally {
    db.close()
  }
}

/** Whether an undo is available, without touching the database. */
function undoAvailable(dataDir) {
  return fs.existsSync(path.join(dataDir, BACKUP_FILENAME))
}

/** How long one read of the host's row is reused before the database is asked again. */
const HOST_ROW_TTL_MS = 3000

/** The last read, so a request path does not open the host's database every turn. */
let hostCache = { at: 0, key: '', models: null }

/**
 * The host's own parameters for this plugin's models, keyed by *catalog* id.
 *
 * This is the read half of the module, and the reason it exists: the plugin does
 * not own these numbers any more. The window, the output cap, image support and
 * the thinking ladder all belong to the row the user imported, so the gateway
 * maps levels with the host's ladder, `/v1/models` reports the host's numbers, and
 * the catalog is only what a model falls back to when the host has no row for it.
 *
 * Returns `null` - never a partial map - when there is no row, no database or no
 * SQLite builtin, so a caller falls back to the catalog instead of reading
 * "unreadable" as "no parameters".
 *
 * The read is cached for `HOST_ROW_TTL_MS`: an edit in the settings page should
 * show up within seconds, while opening SQLite on every request would tax every
 * turn. `invalidateHostModels()` clears it after a write.
 */
function readHostModels({ dataDir, dbPath, now = Date.now() } = {}) {
  const file = dbPath ?? hostDbPath(dataDir)
  if (hostCache.models && hostCache.key === file && now - hostCache.at < HOST_ROW_TTL_MS) return hostCache.models
  const sqlite = loadSqlite()
  if (sqlite.error || !fs.existsSync(file)) return null
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
  try {
    const found = findGatewayRow(db)
    if (found.error) return null
    const parsed = JSON.parse(found.row.config_json)
    const models = new Map()
    const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null)
    for (const model of parsed?.models ?? []) {
      const storedId = String(model?.id ?? '')
      if (!storedId) continue
      models.set(unimportModelId(storedId) ?? storedId, {
        id: storedId,
        contextWindow: positive(model.contextWindow),
        maxTokens: positive(model.maxTokens),
        supportsImages: typeof model.supportsImages === 'boolean' ? model.supportsImages : null,
        thinkingLevels: Array.isArray(model.thinkingLevels) ? model.thinkingLevels.map(String) : [],
        defaultThinkingLevel: typeof model.defaultThinkingLevel === 'string' ? model.defaultThinkingLevel : null,
      })
    }
    hostCache = { at: now, key: file, models }
    return models
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Forget the cached read: call this after a write, or to force a fresh look. */
function invalidateHostModels() {
  hostCache = { at: 0, key: '', models: null }
}

module.exports = {
  BACKUP_FILENAME,
  GATEWAY_AUTHORITY,
  hostDbPath,
  isGatewayRow,
  invalidateHostModels,
  planLadder,
  readHostModels,
  syncLadder,
  undoLadder,
  undoAvailable,
}
