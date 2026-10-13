/**
 * Asserts the host-sync line renders the four states and hides when missing.
 *
 * The panel is a plain ES5 script inside renderer/index.html, so this harness
 * slices that block out of the live file, runs it against a tiny fake DOM and
 * checks the rendering rules from the brief:
 *   - ok===true && missing empty -> ok
 *   - ok===true && missing non-empty -> warn + first 2 ids
 *   - ok===true && total===0 -> muted (nothing is registered at all)
 *   - ok===true && synced===0 -> warn
 *   - ok===false -> muted + error
 *   - host missing / not object -> hidden + empty
 *
 *   node test/render-host-sync.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html')
const PAGE = fs.readFileSync(RENDERER, 'utf8')

const scriptOpen = PAGE.indexOf('<script>', PAGE.indexOf('</head>'))
const scriptClose = PAGE.lastIndexOf('</script>')
const pageScript = PAGE.slice(PAGE.indexOf('>', scriptOpen) + 1, scriptClose)

const start = pageScript.indexOf('function renderHostSync')
if (start < 0) {
  console.log('FAIL  renderHostSync not found in the panel script (red phase)')
  console.log('\n0 OF 1 HOST SYNC RENDER CHECK(S) FAILED')
  process.exitCode = 1
  // still exit to signal red
  throw new Error('renderHostSync not found')
}
let end = pageScript.indexOf('\n        function renderStatus', start)
if (end < 0) end = pageScript.indexOf('\n        function badge', start)
if (end < 0) end = pageScript.length
const chunk = pageScript.slice(start, end)

function el(tag) {
  const e = {
    tagName: tag,
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    setAttribute(name, value) { e.attributes[name] = String(value) },
    getAttribute(name) { return e.attributes[name] },
  }
  return e
}

let hostEl = el('div')
hostEl.id = 'host-sync'
hostEl.className = 'host-sync'
hostEl.hidden = true

const state = { status: null }

const doc = {
  getElementById(id) {
    if (id === 'host-sync') return hostEl
    return null
  },
  createElement(tag) { return el(tag) },
}

const factory = new Function('state', 'document', chunk + '\nreturn { renderHostSync: renderHostSync };')
const api = factory(state, doc)

let failures = 0
let total = 0
function check(ok, text) {
  total += 1
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + text)
}

function reset(host) {
  hostEl.className = 'host-sync'
  hostEl.textContent = ''
  hostEl.hidden = true
  state.status = { host: host }
  // also test when status.host is directly the value; if host is undefined we want missing field
  if (host === undefined) state.status = {}
  if (host === null) state.status = { host: null }
}

function render(host) {
  reset(host)
  // when host is undefined, state.status has no host field
  if (host === undefined) state.status = {}
  else state.status = { host: host }
  // special case: host is string 'no-object' means set non-object
  // we handle via caller
  api.renderHostSync()
  return { text: hostEl.textContent, cls: hostEl.className, hidden: !!hostEl.hidden }
}

// 1. ok true full sync 5/5
let out = render({ ok: true, synced: 5, total: 5, missing: [], error: '' })
check(out.hidden === false, 'ok full: element visible')
check(out.cls.indexOf('host-sync') >= 0 && out.cls.indexOf('ok') >= 0, 'ok full: class contains host-sync and ok (got "' + out.cls + '")')
check(out.text === '宿主模型已同步：5/5 已注册，模型选择器里可见', 'ok full: text "宿主模型已同步：5/5 已注册，模型选择器里可见" (got "' + out.text + '")')
check(out.text.indexOf('undefined') < 0, 'ok full: no undefined in text')

// 2. ok true partial 3/5 missing 3 ids -> only first 2 shown
out = render({ ok: true, synced: 3, total: 5, missing: ['m-a', 'm-b', 'm-c'], error: '' })
check(out.hidden === false, 'partial: element visible')
check(out.cls.indexOf('warn') >= 0, 'partial: class contains warn (got "' + out.cls + '")')
check(out.text === '宿主模型部分同步：已注册 3/5，缺 m-a、m-b（重开设置页或重启 PI-Desktop 后生效）', 'partial: text with first 2 ids (got "' + out.text + '")')
check(out.text.indexOf('m-c') < 0, 'partial: third id not shown (got "' + out.text + '")')
check(out.text.indexOf('3/5') >= 0, 'partial: uses real synced/total 3/5')

// 3. ok true synced 0
out = render({ ok: true, synced: 0, total: 5, missing: [], error: '' })
check(out.hidden === false, 'synced 0: element visible')
check(out.cls.indexOf('warn') >= 0, 'synced 0: class contains warn (got "' + out.cls + '")')
check(out.text === '宿主尚未同步本插件的模型，模型选择器里看不到它们（在设置页重开插件或重启 PI-Desktop 后生效）', 'synced 0: text exact (got "' + out.text + '")')

// 3b. ok true but nothing declared: the picker is empty because the panel
//     registered no model, so blaming the host would be wrong.
out = render({ ok: true, synced: 0, total: 0, missing: [], error: '' })
check(out.hidden === false, 'no declared models: element visible')
check(out.cls.indexOf('muted') >= 0, 'no declared models: class contains muted (got "' + out.cls + '")')
check(out.text === '本插件当前没有注册任何模型（在模型卡里勾选“注册进宿主模型选择器”并保存，重载插件后生效）', 'no declared models: text exact (got "' + out.text + '")')

// 4. ok false with error
out = render({ ok: false, synced: 0, total: 5, missing: [], error: 'no models.list' })
check(out.hidden === false, 'ok false: element visible')
check(out.cls.indexOf('muted') >= 0, 'ok false: class contains muted (got "' + out.cls + '")')
check(out.text === '读不到宿主模型清单：no models.list', 'ok false: text contains error (got "' + out.text + '")')
check(out.text.indexOf('no models.list') >= 0, 'ok false: error text rendered')

// 5. missing host field -> hidden + empty
hostEl.className = 'host-sync'
hostEl.textContent = 'stale'
hostEl.hidden = false
state.status = {}
api.renderHostSync()
check(hostEl.hidden === true, 'missing host: element hidden')
check(hostEl.textContent === '', 'missing host: text empty (got "' + hostEl.textContent + '")')

// 6. host is not object -> hidden + empty
hostEl.className = 'host-sync'
hostEl.textContent = 'stale'
hostEl.hidden = false
state.status = { host: 'not-object' }
api.renderHostSync()
check(hostEl.hidden === true, 'host not object: element hidden')
check(hostEl.textContent === '', 'host not object: text empty (got "' + hostEl.textContent + '")')

// 7. host is null -> hidden
hostEl.className = 'host-sync'
hostEl.textContent = 'stale'
hostEl.hidden = false
state.status = { host: null }
api.renderHostSync()
check(hostEl.hidden === true, 'host null: element hidden')

// 8. ensure numbers are real: synced 2 total 5 partial uses real values
out = render({ ok: true, synced: 2, total: 5, missing: ['x'], error: '' })
check(out.text.indexOf('2/5') >= 0, 'real numbers: 2/5 shown (got "' + out.text + '")')

console.log('\n' + (failures === 0 ? 'ALL ' + total + ' HOST SYNC RENDER CHECKS PASSED' : failures + ' OF ' + total + ' HOST SYNC RENDER CHECK(S) FAILED'))
process.exitCode = failures === 0 ? 0 : 1
