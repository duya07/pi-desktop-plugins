/**
 * Self-test for src/hostladder.js - the one place this plugin writes the host's
 * own database.
 *
 * Runs against a throwaway SQLite file with the host's `providers` shape, so the
 * real code path (transaction, read-back, backup, undo) is exercised without
 * touching the live database:
 *
 *   node test/host-ladder.cjs
 *
 * What it pins down: only the gateway row is touched, only the two ladder fields
 * change, every other row stays byte-identical, an already-correct row is left
 * alone, the original is saved before the write, undo restores it, and every
 * refusal (no row, two rows, unparsable JSON, a default outside its own ladder)
 * writes nothing.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const hostLadder = require('../src/hostladder.js')
const { GATEWAY_BASE_URL } = require('../src/protocol.js')

let checks = 0
let failures = 0
function check(ok, label) {
  checks += 1
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-hostladder-'))
const dataDir = path.join(work, 'plugin-data')
fs.mkdirSync(dataDir, { recursive: true })
const dbPath = path.join(work, 'pi.sqlite')

const HARDCODED = { thinkingLevels: ['off', 'low', 'medium', 'high'], defaultThinkingLevel: 'medium' }
const GATEWAY_ROW = {
  id: 'gw-row',
  name: 'Cline Pass（本地网关）',
  base_url: GATEWAY_BASE_URL,
  config_json: JSON.stringify({
    compatibility: { supportsReasoning: true },
    models: [
      { id: 'cline-pass-local/deepseek-v4.1-flash', ...HARDCODED, contextWindow: 1000000, maxTokens: 384000 },
      { id: 'cline-pass-local/minimax-m3', thinkingLevels: [], defaultThinkingLevel: null },
      { id: 'hand/typed-by-the-user', ...HARDCODED },
    ],
  }),
}
const OTHER_ROW = {
  id: 'other-row',
  name: 'Cline Pass',
  base_url: 'https://api.cline.bot/api/v1',
  config_json: JSON.stringify({ models: [{ id: 'cline-pass/deepseek-v4.1-flash', thinkingLevels: ['off', 'low', 'high', 'max'], defaultThinkingLevel: 'max' }] }),
}

function buildDb() {
  fs.rmSync(dbPath, { force: true })
  const db = new DatabaseSync(dbPath)
  db.exec('create table providers (id text primary key, name text, base_url text, config_json text)')
  const insert = db.prepare('insert into providers (id, name, base_url, config_json) values (?, ?, ?, ?)')
  insert.run(GATEWAY_ROW.id, GATEWAY_ROW.name, GATEWAY_ROW.base_url, GATEWAY_ROW.config_json)
  insert.run(OTHER_ROW.id, OTHER_ROW.name, OTHER_ROW.base_url, OTHER_ROW.config_json)
  db.close()
}

function rows() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare('select id, name, base_url, config_json from providers').all()
  } finally {
    db.close()
  }
}

const wanted = new Map([
  ['cline-pass/deepseek-v4.1-flash', { thinkingLevels: ['off', 'low', 'high', 'max'], defaultThinkingLevel: 'max' }],
  ['cline-pass/minimax-m3', { thinkingLevels: ['off'], defaultThinkingLevel: 'off' }],
])

/* ------------------------------ pure planning ----------------------------- */

const planned = hostLadder.planLadder(GATEWAY_ROW.config_json, wanted)
check(planned.ok === true, 'planLadder accepts a well-formed row')
check(planned.changes.length === 1, 'planLadder plans one change (the hardcoded model)')
check(planned.changes[0].id === 'cline-pass-local/deepseek-v4.1-flash', 'the change names the stored id, not the catalog id')
check(planned.changes[0].to.thinkingLevels.join('/') === 'off/low/high/max', 'the change carries the catalog ladder')
check(planned.skipped.some((s) => s.id === 'cline-pass-local/minimax-m3'), 'a model with no real level is skipped')
check(planned.skipped.some((s) => s.id === 'hand/typed-by-the-user'), 'a model outside the generated config is skipped')
const keptKeys = Object.keys(JSON.parse(planned.next).models[0]).sort().join(',')
check(keptKeys === 'contextWindow,defaultThinkingLevel,id,maxTokens,thinkingLevels', 'the rewrite keeps every other key of the model (got ' + keptKeys + ')')
check(JSON.parse(planned.next).compatibility.supportsReasoning === true, 'the rewrite keeps the provider-level compatibility block')

check(hostLadder.planLadder('{not json', wanted).ok === false, 'planLadder refuses unparsable JSON')
check(hostLadder.planLadder(JSON.stringify({ models: 'nope' }), wanted).ok === false, 'planLadder refuses a row without a models array')
const badDefault = hostLadder.planLadder(GATEWAY_ROW.config_json, new Map([['cline-pass/deepseek-v4.1-flash', { thinkingLevels: ['off', 'high'], defaultThinkingLevel: 'max' }]]))
check(badDefault.ok === false, 'planLadder refuses a default level outside its own ladder')

/* --------------------------------- writing -------------------------------- */

buildDb()
const otherBefore = rows().find((r) => r.id === OTHER_ROW.id).config_json

const first = hostLadder.syncLadder({ dataDir, wanted, dbPath })
check(first.ok === true, 'syncLadder writes the gateway row')
check(first.changed === 1, 'syncLadder reports one changed model (got ' + first.changed + ')')
check(fs.existsSync(path.join(dataDir, hostLadder.BACKUP_FILENAME)), 'syncLadder saves the original first')

const after = rows()
const gatewayAfter = after.find((r) => r.id === GATEWAY_ROW.id)
const otherAfter = after.find((r) => r.id === OTHER_ROW.id)
check(otherAfter.config_json === otherBefore, 'the other provider row is byte-identical')
check(otherAfter.name === OTHER_ROW.name && otherAfter.base_url === OTHER_ROW.base_url, 'the other provider row keeps its columns')
const written = JSON.parse(gatewayAfter.config_json)
const flash = written.models.find((m) => m.id === 'cline-pass-local/deepseek-v4.1-flash')
check(flash.thinkingLevels.join('/') === 'off/low/high/max', 'the stored ladder is the catalog ladder')
check(flash.defaultThinkingLevel === 'max', 'the stored default is the catalog default')
check(flash.contextWindow === 1000000 && flash.maxTokens === 384000, 'the window and output cap are untouched')
check(written.models.find((m) => m.id === 'hand/typed-by-the-user').thinkingLevels.join('/') === 'off/low/medium/high', 'a model outside the generated config keeps its own ladder')
check(rows().length === 2, 'no row was added or removed')

const second = hostLadder.syncLadder({ dataDir, wanted, dbPath })
check(second.ok === true && second.changed === 0, 'a second sync is a no-op')
check(rows().find((r) => r.id === GATEWAY_ROW.id).config_json === gatewayAfter.config_json, 'the no-op left the row untouched')

/* ---------------------------------- undo ---------------------------------- */

const undone = hostLadder.undoLadder({ dataDir, dbPath })
check(undone.ok === true, 'undoLadder restores the saved original')
check(rows().find((r) => r.id === GATEWAY_ROW.id).config_json === GATEWAY_ROW.config_json, 'the row is back to its exact original bytes')
check(rows().find((r) => r.id === OTHER_ROW.id).config_json === otherBefore, 'undo still leaves the other row alone')

/* ------------------------------- reading it ------------------------------- */

// The read half: the host's own parameters, keyed by catalog id. This is what the
// gateway now maps levels with, so it has to be exactly what the row holds.
hostLadder.invalidateHostModels()
const read = hostLadder.readHostModels({ dataDir, dbPath })
check(read instanceof Map, 'readHostModels returns a map')
check(read.size === 3, 'it reads every model of the row (got ' + (read ? read.size : 'null') + ')')
check(read.get('cline-pass/deepseek-v4.1-flash').thinkingLevels.join('/') === 'off/low/medium/high', 'the stored ladder comes back as-is')
check(read.get('cline-pass/deepseek-v4.1-flash').contextWindow === 1000000, 'the stored window comes back')
check(read.get('cline-pass/minimax-m3').maxTokens === null, 'a field the row does not carry reads as null, never as 0')
check(read.has('cline-pass/minimax-m3') && !read.has('cline-pass-local/minimax-m3'), 'the map is keyed by catalog id, not by the stored spelling')
check(hostLadder.readHostModels({ dataDir, dbPath }) === read, 'a read inside the TTL is reused')
hostLadder.invalidateHostModels()
check(hostLadder.readHostModels({ dataDir, dbPath }) !== read, 'invalidateHostModels forces a fresh read')
check(hostLadder.readHostModels({ dataDir, dbPath: path.join(work, 'missing.sqlite') }) === null, 'a missing database reads as null')
check(hostLadder.readHostModels({}) === null, 'an empty dataDir reads as null instead of guessing the real host file')

// "Unreadable" must never look like "no parameters": a database without this
// plugin's row reads as null, so the caller falls back to the catalog instead of
// concluding the models have no window at all.
buildDb()
const db4 = new DatabaseSync(dbPath)
db4.prepare('update providers set base_url = ? where id = ?').run('https://example.test/v1', GATEWAY_ROW.id)
db4.close()
hostLadder.invalidateHostModels()
check(hostLadder.readHostModels({ dataDir, dbPath }) === null, 'no gateway row reads as null, not as an empty map')

/* --------------------------------- refusals ------------------------------- */

buildDb()
const db = new DatabaseSync(dbPath)
db.prepare('update providers set base_url = ? where id = ?').run('https://example.test/v1', GATEWAY_ROW.id)
db.close()
const noRow = hostLadder.syncLadder({ dataDir, wanted, dbPath })
check(noRow.ok === false && /没有指向/.test(noRow.error), 'no gateway row is refused, not guessed (got: ' + noRow.error + ')')

buildDb()
const db2 = new DatabaseSync(dbPath)
db2.prepare('insert into providers (id, name, base_url, config_json) values (?, ?, ?, ?)').run('gw-row-2', 'second', GATEWAY_BASE_URL, GATEWAY_ROW.config_json)
db2.close()
const twoRows = hostLadder.syncLadder({ dataDir, wanted, dbPath })
check(twoRows.ok === false && /2 行/.test(twoRows.error), 'two gateway rows are refused (got: ' + twoRows.error + ')')
check(rows().find((r) => r.id === GATEWAY_ROW.id).config_json === GATEWAY_ROW.config_json, 'the refusal wrote nothing')

buildDb()
const db3 = new DatabaseSync(dbPath)
db3.prepare('update providers set config_json = ? where id = ?').run('{oops', GATEWAY_ROW.id)
db3.close()
const broken = hostLadder.syncLadder({ dataDir, wanted, dbPath })
check(broken.ok === false && /不是合法 JSON/.test(broken.error), 'an unparsable row is refused (got: ' + broken.error + ')')

check(hostLadder.syncLadder({ dataDir, wanted, dbPath: path.join(work, 'missing.sqlite') }).ok === false, 'a missing database file is refused')

/* ------------------------------- row matching ----------------------------- */

check(hostLadder.isGatewayRow({ base_url: GATEWAY_BASE_URL }) === true, 'the gateway row is recognised by its base_url')
check(hostLadder.isGatewayRow({ base_url: 'https://api.cline.bot/api/v1' }) === false, 'a row pointed straight at Cline is not the gateway row')
check(hostLadder.isGatewayRow(null) === false, 'a missing row is not the gateway row')

fs.rmSync(work, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' HOST LADDER CHECKS PASSED' : failures + ' of ' + checks + ' HOST LADDER CHECKS FAILED'))
process.exit(failures === 0 ? 0 : 1)
