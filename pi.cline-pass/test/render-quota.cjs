/**
 * Asserts the quota card behaves like the DSH original's UsageCard.
 *
 * The card is a plain ES5 script inside renderer/index.html, so this harness
 * slices that block out of the live file, runs it against a tiny fake DOM, and
 * checks what the reference implementation would show: the *used* percentage,
 * a bar coloured by used share (>=90 red, >=70 amber, else green), a pool read
 * one account at a time through pager arrows, and a grey line - never red - for
 * an account that could not be read.
 *
 *   node test/render-quota.cjs      # 单独一条命令，不参与 node --test
 */
const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html')
const PAGE = fs.readFileSync(RENDERER, 'utf8')

/* ---------- slice the quota block out of the panel script ---------- */
const scriptOpen = PAGE.indexOf('<script>', PAGE.indexOf('</head>'))
const scriptClose = PAGE.lastIndexOf('</script>')
const pageScript = PAGE.slice(PAGE.indexOf('>', scriptOpen) + 1, scriptClose)
const start = pageScript.indexOf('/* ------------------------------- 官方额度')
const end = pageScript.indexOf('function loadQuota(')
if (start < 0 || end < 0) throw new Error('quota block not found in the panel script')
const chunk = pageScript.slice(start, end)

/* ---------- a fake DOM, just enough for this card ---------- */
function el(tag) {
  const e = {
    tagName: tag,
    className: '',
    textContent: '',
    title: '',
    style: {},
    attributes: {},
    children: [],
    onclick: null,
    appendChild(child) { e.children.push(child); return child },
    removeChild(child) {
      const at = e.children.indexOf(child)
      if (at >= 0) e.children.splice(at, 1)
      return child
    },
    setAttribute(name, value) { e.attributes[name] = String(value) },
    get firstChild() { return e.children.length > 0 ? e.children[0] : null },
  }
  return e
}
function flat(node) {
  let out = node.textContent || ''
  ;(node.children || []).forEach((child) => { out += ' ' + flat(child) })
  return out.replace(/\s+/g, ' ').trim()
}
function walk(node, visit) {
  visit(node)
  ;(node.children || []).forEach((child) => walk(child, visit))
}
function collect(root, predicate) {
  const found = []
  walk(root, (n) => { if (predicate(n)) found.push(n) })
  return found
}

const elements = { 'quota-body': el('div'), 'quota-title': el('div') }
const state = { quota: null, quotaFailed: false, quotaPending: false, quotaPicked: 0, status: null }

const sandbox = {
  state,
  document: { getElementById: (id) => elements[id] || null },
  node: (tag, className, text) => {
    const created = el(tag)
    if (className) created.className = className
    if (text !== undefined && text !== null) created.textContent = text
    return created
  },
}
const factory = new Function('state', 'document', 'node',
  chunk + '\nreturn { renderQuota: renderQuota, stepQuota: stepQuota, quotaUsed: quotaUsed, quotaTone: quotaTone, quotaCountdown: quotaCountdown, quotaWindowName: quotaWindowName, quotaWindows: quotaWindows, quotaAccounts: quotaAccounts, quotaErrorText: quotaErrorText };')
const api = factory(sandbox.state, sandbox.document, sandbox.node)

let failures = 0
function check(ok, text) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + text)
}

function render(next) {
  Object.assign(state, { quota: null, quotaFailed: false, quotaPending: false, quotaPicked: 0, status: null }, next)
  elements['quota-body'].children = []
  elements['quota-body'].textContent = ''
  elements['quota-title'].textContent = ''
  api.renderQuota()
  const body = elements['quota-body']
  return { title: elements['quota-title'].textContent, body: flat(body), tree: body }
}

/* ---------- fixtures ---------- */
const now = Date.now()
const HOUR = 3600000
const iso = (ms) => new Date(ms).toISOString()
const WINDOWS = [
  { type: 'five_hour', percentUsed: 0, resetsAt: iso(now + HOUR) },
  { type: 'weekly', percentUsed: 100, resetsAt: iso(now + 3 * 24 * HOUR + 2 * HOUR) },
  { type: 'monthly', percentUsed: 84, resetsAt: iso(now + 10 * 24 * HOUR + 22 * HOUR) },
]
// The pool exactly as the gateway sends it. The host row is in here on purpose:
// it is the key typed into the model settings page, it never reaches the panel,
// and the card has to leave it out rather than render a permanent "cannot read".
const POOL = {
  ok: true,
  fetchedAt: now,
  accounts: [
    {
      name: 'host',
      displayName: 'PI 设置里的密钥',
      source: 'host',
      keyHint: '',
      ok: false,
      error: 'this account uses the key typed into the model settings page, which lives in request memory only - add an inline account in the panel to read quota for it',
      limits: [],
    },
    { name: 'alpha', displayName: 'alpha', source: 'inline', keyHint: 'sk_aaa***1111', duplicate: true, ok: true, limits: WINDOWS },
    { name: 'beta', displayName: 'beta', source: 'inline', keyHint: 'sk_aaa***1111', duplicate: true, ok: true, limits: WINDOWS },
    { name: 'broken', displayName: 'broken', source: 'inline', keyHint: 'sk_bbb***2222', ok: false, error: 'HTTP 401: {"error":"unauthenticated"}', limits: [] },
  ],
}

/* 1. the header counts the accounts the panel can actually read */
let out = render({ quota: POOL, status: { accountMode: 'roundrobin', activeAccount: '' } })
check(out.title === '官方额度 · 3 个账号', 'the header counts the readable accounts, not the raw rows (got "' + out.title + '")')
// The host account's key never reaches the panel, so the card would only ever be
// able to render a "cannot read" line for it: it is dropped, like in the pool table.
check(out.body.indexOf('PI 设置里的密钥') < 0 && out.body.indexOf('request memory only') < 0, 'the host account is not listed → "' + out.body.slice(0, 90) + '"')
check(out.body.indexOf('第 1 / 3 个') >= 0, 'positions count the listed accounts → "' + out.body + '"')

/* 2. an unreadable account is one grey line: a short Chinese reason in the row,
      the gateway's own wording kept in the tooltip */
const failed = render({ quota: { ok: true, fetchedAt: now, accounts: [POOL.accounts[3]] }, status: { accountMode: 'single', activeAccount: '' } })
const failedLine = collect(failed.tree, (n) => /quota-muted/.test(n.className))[0]
check(failedLine !== undefined && failedLine.textContent === '暂时读不到官方额度。密钥被官方拒绝了（HTTP 401）。', 'an unreadable account says why in one short Chinese line → "' + failed.body + '"')
check(failedLine !== undefined && failedLine.title === 'HTTP 401: {"error":"unauthenticated"}', 'the raw gateway text stays reachable in the tooltip (got "' + (failedLine && failedLine.title) + '")')
check(failed.body.indexOf('unauthenticated') < 0, 'and it is not spilled into the card')
check(collect(failed.tree, (n) => /bad-text|cp-error|error-text/.test(n.className)).length === 0, 'a failed read is grey, never red')

/* 3. a pool is paged, not stacked */
out = render({ quota: POOL, status: { accountMode: 'roundrobin', activeAccount: '' } })
const navs = collect(out.tree, (n) => n.tagName === 'button' && /quota-nav/.test(n.className))
check(navs.length === 2, 'a pool shows exactly two pager buttons (got ' + navs.length + ')')
check(navs.length === 2 && navs[0].attributes['aria-label'] === '上一个账号' && navs[1].attributes['aria-label'] === '下一个账号', 'the arrows are labelled 上一个账号 / 下一个账号')
check(out.body.indexOf('alpha') >= 0, 'the picked account is named')
check(flat(out.tree).indexOf('beta') < 0, 'the other accounts are not on screen at the same time')

/* 4. paging moves to the next account without re-reading */
navs[1].onclick()
const paged = { title: elements['quota-title'].textContent, body: flat(elements['quota-body']), tree: elements['quota-body'] }
check(paged.body.indexOf('第 2 / 3 个') >= 0 && paged.body.indexOf('beta') >= 0, 'the › arrow shows account 2 → "' + paged.body.slice(0, 90) + '"')
check(paged.body.indexOf('5 小时') >= 0 && paged.body.indexOf('本周') >= 0 && paged.body.indexOf('本月') >= 0, 'windows use the reference labels 5 小时 / 本周 / 本月')
// The mask rides along in the pager row, so two rows holding one key are obvious
// before anyone compares the numbers.
check(paged.body.indexOf('sk_aaa***1111') >= 0, 'the pager row shows the masked key → "' + paged.body.slice(0, 60) + '"')
check(paged.body.indexOf('同一个 key') >= 0, 'a duplicated key is explained instead of showing one account under two names')
out = render({ quota: { ok: true, fetchedAt: now, accounts: [{ name: 'solo', displayName: 'solo', source: 'inline', keyHint: '', ok: true, limits: WINDOWS }] }, status: { accountMode: 'single', activeAccount: '' } })
check(collect(out.tree, (n) => /quota-key/.test(n.className)).length === 0, 'an account with no key shows no mask')
check(out.body.indexOf('同一个 key') < 0, 'and says nothing about duplicates when there is no collision')

/* 5. the reading is the USED share, rounded, with the reference colour ramp */
const values = collect(paged.tree, (n) => /quota-value/.test(n.className)).map((n) => n.textContent)
check(values.join('|') === '0%|100%|84%', 'each window shows the used percentage (got ' + values.join('|') + ')')
const fills = collect(paged.tree, (n) => /quota-fill/.test(n.className)).map((n) => ({ cls: n.className, width: n.style.width }))
check(fills.length === 3, 'one bar per window (got ' + fills.length + ')')
check(fills[0].cls === 'quota-fill' && fills[0].width === '0%', '0% used → plain green fill, empty bar')
check(fills[1].cls === 'quota-fill bad' && fills[1].width === '100%', '100% used → .bad (red) at full width')
check(fills[2].cls === 'quota-fill warn' && fills[2].width === '84%', '84% used → .warn (amber) at 84%')
check(paged.body.indexOf('剩余') < 0, 'the card never says 剩余 (that was the port\'s own invention)')

/* 6. reset countdowns come from resetsAt, reference format */
check(paged.body.indexOf('3 天 2 小时后重置') >= 0, 'the weekly note reads 3 天 2 小时后重置 → "' + paged.body + '"')
check(paged.body.indexOf('10 天 22 小时后重置') >= 0, 'the monthly note reads 10 天 22 小时后重置')

/* 7. accessibility: the bar is a progressbar labelled as used */
const tracks = collect(paged.tree, (n) => n.className === 'quota-track')
check(tracks.length === 3 && tracks.every((t) => t.attributes.role === 'progressbar'), 'every bar is a progressbar')
check(tracks[1].attributes['aria-valuenow'] === '100' && tracks[1].attributes['aria-label'] === '本周已用额度', 'aria-valuenow is the used share and the label says 已用额度')
check(tracks[1].title === '已用 100%', 'the tooltip reads 已用 100% (got "' + tracks[1].title + '")')

/* 8. a window the gateway did not report a percentage for stays unknown */
out = render({ quota: { ok: true, fetchedAt: now, accounts: [{ name: 'a', ok: true, limits: [{ type: 'weekly' }, { type: 'daily', label: '每日', percentUsed: 10 }] }] } })
const unknownTracks = collect(out.tree, (n) => n.className === 'quota-track')
check(out.body.indexOf('本周 —') >= 0, 'an unreported percentage reads 本周 — (got "' + out.body + '")')
check(unknownTracks[0].attributes['aria-valuenow'] === undefined && unknownTracks[0].title === '官方没有返回这一档的百分比', 'it claims nothing: no aria-valuenow, an honest tooltip')
check(unknownTracks[0].children[0].style.width === '0%', 'and its bar is empty rather than full')
check(out.body.indexOf('每日 10%') >= 0, 'an unknown window type renders under its own name, after the known ones')

/* 9. a single account gets no arrows, and 当前 marks the pinned one */
out = render({ quota: { ok: true, fetchedAt: now, accounts: [{ name: 'beta', displayName: '工作号', ok: true, limits: WINDOWS }] }, status: { accountMode: 'single', activeAccount: 'beta' } })
check(out.title === '官方额度 · 账号 beta', 'a single account is named by its id in the header (got "' + out.title + '")')
check(collect(out.tree, (n) => /quota-nav/.test(n.className)).length === 0, 'a single account gets no pager arrows')
// The reference renders the account row - and the badge inside it - only for a pool:
// a lone account is already named by the header, so there is nothing to mark.
check(out.body.indexOf('当前') < 0, 'a single account shows no 当前 badge')
const TWIN = { ok: true, fetchedAt: now, accounts: [{ name: 'a', displayName: 'a', ok: true, limits: WINDOWS }, { name: 'b', displayName: 'b', ok: true, limits: WINDOWS }] }
out = render({ quota: TWIN, status: { accountMode: 'single', activeAccount: 'a' } })
check(out.body.indexOf('当前') >= 0, 'inside a pool the pinned account is marked 当前 → "' + out.body.slice(0, 40) + '"')
out = render({ quota: TWIN, status: { accountMode: 'single', activeAccount: '' } })
check(out.body.indexOf('当前') >= 0, 'single mode with no explicit account marks the first one (that is who the pool resolves to)')
out = render({ quota: TWIN, status: { accountMode: 'roundrobin', activeAccount: 'a' } })
check(out.body.indexOf('当前') < 0, 'round-robin marks nobody: every request rotates')

/* 10. loading / failed / no accounts */
out = render({ quotaPending: true })
check(out.body.indexOf('正在读取官方额度…') >= 0, 'while a read is in flight the card says 正在读取官方额度… → "' + out.body + '"')
out = render({})
check(out.body.indexOf('点标题行右边的「刷新」') >= 0, 'nothing read and nothing running says so instead of spinning forever → "' + out.body + '"')
out = render({ quotaFailed: true })
check(out.body.indexOf('暂时读不到官方额度。') >= 0, 'a failed read says 暂时读不到官方额度。')
check(collect(out.tree, (n) => n.tagName === 'button').length === 0, 'no extra retry button: the header 刷新 is the retry')
out = render({ quota: { ok: true, fetchedAt: now, accounts: [] } })
check(out.title === '官方额度' && out.body.indexOf('还没有内联账号') >= 0, 'an empty pool points at the 账号池 tab')

/* 11. the helpers themselves */
check(api.quotaUsed({ percentUsed: 99.6 }) === 99.6 && api.quotaUsed({ percentUsed: -5 }) === 0 && api.quotaUsed({ percentUsed: 150 }) === 100, 'the used share is clamped but not rounded: the reference rounds only for display')
check(api.quotaUsed({}) === null && api.quotaUsed({ percentUsed: null }) === null && api.quotaUsed({ percentUsed: '' }) === null, 'a missing percentage is null, not 0')
check(api.quotaTone({ percentUsed: 89 }) === 'warn' && api.quotaTone({ percentUsed: 90 }) === 'bad' && api.quotaTone({ percentUsed: 69 }) === 'good', 'the ramp switches at 70 and 90')
check(api.quotaTone({ percentUsed: 89.6 }) === 'warn', 'the ramp reads the raw share, so 89.6% is amber, not red')
out = render({ quota: { ok: true, fetchedAt: now, accounts: [{ name: 'a', ok: true, limits: [{ type: 'weekly', percentUsed: 89.6 }] }] } })
check(collect(out.tree, (n) => /quota-value/.test(n.className))[0].textContent === '90%', 'the printed text rounds to 90%')
check(collect(out.tree, (n) => /quota-fill/.test(n.className))[0].style.width === '89.6%', 'while the bar keeps the raw 89.6% width')
check(api.quotaCountdown({ resetsAt: iso(now + 5 * HOUR + 10 * 60000) }) === '5 小时 10 分钟', 'countdown format matches the reference (hours + minutes)')
check(api.quotaCountdown({ resetsAt: iso(now + 42 * 60000) }) === '42 分钟', 'countdown below an hour reads minutes')
check(api.quotaCountdown({ resetsAt: iso(now - 1000) }) === '' && api.quotaCountdown({}) === '', 'a past or missing reset instant yields no countdown')
check(api.quotaWindowName({ type: 'weird', label: '每日' }) === '每日' && api.quotaWindowName({ type: 'weird' }) === 'weird', 'an unknown window prefers the upstream label, then its type')
const ordered = api.quotaWindows([{ type: 'monthly' }, { type: 'daily' }, { type: 'five_hour' }]).map((l) => l.type)
check(ordered.join('|') === 'five_hour|monthly|daily', 'known windows come first in table order, unknowns follow (got ' + ordered.join('|') + ')')
const deduped = api.quotaWindows([{ type: 'weekly', percentUsed: 10 }, { type: 'weekly', percentUsed: 20 }])
check(deduped.length === 1 && deduped[0].percentUsed === 20, 'a duplicated known window collapses to its last report, like the reference Map')

/* 12. a pool holding nothing but the host account says what is out of reach, and
       the gateway's own English strings map onto short Chinese */
out = render({ quota: { ok: true, fetchedAt: now, accounts: [POOL.accounts[0]] } })
check(out.title === '官方额度' && out.body.indexOf('官方额度只认插件读得到密钥的账号') >= 0, 'a host-only pool explains that the key is out of reach → "' + out.body + '"')
check(collect(out.tree, (n) => /quota-nav/.test(n.className)).length === 0, 'and offers no pager over zero accounts')
out = render({ quota: { ok: true, fetchedAt: now, accounts: [POOL.accounts[0], POOL.accounts[1]] } })
check(out.title === '官方额度 · 账号 alpha' && out.body.indexOf('当前') < 0, 'host plus one inline account reads as that single account (got "' + out.title + '")')
check(api.quotaErrorText({ error: 'this account has no key right now' }) === '这个账号现在没有密钥。', 'a keyless account is explained in Chinese')
check(api.quotaErrorText({ error: 'HTTP 500: the quota service is having a moment' }) === '官方接口返回 HTTP 500。', 'a 5xx is reported as a status, not a wall of English')
check(api.quotaErrorText({ error: 'HTTP 429: slow down' }) === '官方限流了（HTTP 429）。', 'a 429 says the service is rate limiting')
check(api.quotaErrorText({ error: 'fetch failed' }) === '连不上官方接口。', 'a transport failure reads as a connection problem')
check(api.quotaErrorText({}) === '', 'no error means no reason line at all')

console.log('\n' + (failures === 0 ? 'ALL QUOTA CARD CHECKS PASSED' : failures + ' QUOTA CARD CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)
