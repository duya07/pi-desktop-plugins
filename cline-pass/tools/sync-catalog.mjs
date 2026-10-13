/**
 * Refresh `src/catalog.js` from models.dev.
 *
 * The plugin ships a frozen table (context window, max output, image support and
 * the reasoning ladder per model) so that the gateway, the panel and `/v1/models`
 * all answer without any network call. This script is how that table is brought
 * up to date: it reads models.dev, maps each catalog entry onto its
 * `cline-pass/<slug>` counterpart, and rewrites the `MODEL_CATALOG` literal.
 *
 * It is a development tool. Nothing in `src/` imports it, it needs no plugin
 * permission, and it never runs inside PI-Desktop.
 *
 *   node tools/sync-catalog.mjs                 # report the difference only
 *   node tools/sync-catalog.mjs --write         # rewrite src/catalog.js
 *   node tools/sync-catalog.mjs --snapshot <p>  # use another api.json
 *   node tools/sync-catalog.mjs --remote        # fetch https://models.dev/api.json
 *
 * Default snapshot: PI-Desktop's bundled `resources/models.dev/api.json` (the
 * same file the host reads), so the reported numbers are the ones the app shows.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const CATALOG_PATH = path.join(PLUGIN, 'src', 'catalog.js')
const REMOTE_URL = 'https://models.dev/api.json'
const DEFAULT_SNAPSHOTS = [
  process.env.PI_MODELS_DEV_SNAPSHOT,
  'D:\\Programs Files\\PI-Desktop\\resources\\models.dev\\api.json',
  '/Applications/PI-Desktop.app/Contents/Resources/models.dev/api.json',
  '/opt/PI-Desktop/resources/models.dev/api.json',
].filter(Boolean)

const require = createRequire(import.meta.url)
const { MODEL_CATALOG } = require(CATALOG_PATH)

/** The ladder the host understands, minus the value that means "no thinking". */
const OFF_TOKENS = new Set(['none', 'off', 'disabled', 'false'])

function readCatalog({ snapshot, remote }) {
  if (remote) return { source: REMOTE_URL, text: null }
  for (const candidate of snapshot ? [snapshot] : DEFAULT_SNAPSHOTS) {
    if (fs.existsSync(candidate)) return { source: candidate, text: fs.readFileSync(candidate, 'utf8') }
  }
  throw new Error(`no models.dev snapshot found (tried: ${(snapshot ? [snapshot] : DEFAULT_SNAPSHOTS).join(', ')}); pass --snapshot <path> or --remote`)
}

/** What models.dev says about one slug, in this plugin's vocabulary. */
function fromCatalog(entry) {
  if (!entry) return null
  const limit = entry.limit ?? {}
  const options = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : []
  const effort = options.find((option) => option?.type === 'effort')
  const toggle = options.find((option) => option?.type === 'toggle' || option?.type === 'budget_tokens')
  let thinking = { lever: 'none', levels: [] }
  if (effort && Array.isArray(effort.values)) {
    const levels = effort.values
      .map((value) => String(value).trim())
      .filter((value) => value && !OFF_TOKENS.has(value.toLowerCase()))
    thinking = { lever: levels.length > 0 ? 'effort' : 'none', levels }
  } else if (toggle) {
    thinking = { lever: 'toggle', levels: [] }
  }
  const input = Array.isArray(entry.modalities?.input) ? entry.modalities.input : []
  return {
    contextWindow: Number.isInteger(limit.context) && limit.context > 0 ? limit.context : null,
    maxTokens: Number.isInteger(limit.output) && limit.output > 0 ? limit.output : null,
    supportsImages: input.includes('image'),
    thinking,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null,
  }
}

const words = (list) => list.map((level) => `'${level}'`).join(', ')
/** These five are derived from models.dev; anything else is hand-written state. */
const DERIVED = new Set(['name', 'contextWindow', 'maxTokens', 'supportsImages', 'thinking'])
const jsValue = (input) => {
  if (typeof input === 'string') return `'${input.replace(/'/g, "\\'")}'`
  if (Array.isArray(input)) return `[${input.map(jsValue).join(', ')}]`
  return String(input)
}
function serialize(id, entry) {
  const rows = [
    `    name: '${entry.name.replace(/'/g, "\\'")}',`,
    `    contextWindow: ${entry.contextWindow},`,
    `    maxTokens: ${entry.maxTokens},`,
    `    supportsImages: ${entry.supportsImages},`,
    `    thinking: { lever: '${entry.thinking.lever}', levels: [${words(entry.thinking.levels)}] },`,
  ]
  for (const [key, value] of Object.entries(entry)) {
    if (!DERIVED.has(key)) rows.push(`    ${key}: ${jsValue(value)},`)
  }
  return [`  '${id}': {`, ...rows, `  },`].join('\n')
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

const { source, text } = readCatalog({ snapshot: value('snapshot'), remote: flag('remote') })
const catalog = text === null ? await (await fetch(source)).json() : JSON.parse(text)
const provider = catalog['cline-pass']
if (!provider) throw new Error(`models.dev has no provider "cline-pass" in ${source}`)
console.log(`models.dev: ${source}  (cline-pass: ${Object.keys(provider.models ?? {}).length} models, api ${provider.api ?? '—'})`)

const next = {}
const changed = []
const missing = []
for (const [id, current] of Object.entries(MODEL_CATALOG)) {
  const slug = id.replace(/^cline-pass\//, '')
  const published = fromCatalog(provider.models?.[slug] ?? provider.models?.[id] ?? null)
  if (!published) {
    // Not in models.dev: keep the hand-written numbers and say so - that flag is
    // what the panel's "兜底默认值，别当真实能力" warning reads.
    next[id] = { ...current, fallback: true }
    missing.push(slug)
    continue
  }
  // Whatever models.dev publishes wins; `fallback` disappears the moment an
  // entry stops being a stand-in. Any *other* hand-written key is kept - and
  // only those, or spreading the entry back would undo the update.
  const extra = {}
  for (const [key, value] of Object.entries(current)) {
    if (!DERIVED.has(key) && key !== 'fallback') extra[key] = value
  }
  const merged = {
    name: published.name ?? current.name,
    contextWindow: published.contextWindow ?? current.contextWindow,
    maxTokens: published.maxTokens ?? current.maxTokens,
    supportsImages: published.supportsImages,
    thinking: published.thinking,
    ...extra,
  }
  next[id] = merged
  if (JSON.stringify(merged) !== JSON.stringify(current)) {
    changed.push({ id, from: current, to: merged })
  }
}

console.log(`\n条目 ${Object.keys(MODEL_CATALOG).length}：需要更新 ${changed.length}，models.dev 里没有 ${missing.length}${missing.length ? `（${missing.join(', ')}）` : ''}`)
for (const { id, from, to } of changed) {
  const bits = []
  if (from.contextWindow !== to.contextWindow) bits.push(`ctx ${from.contextWindow}→${to.contextWindow}`)
  if (from.maxTokens !== to.maxTokens) bits.push(`out ${from.maxTokens}→${to.maxTokens}`)
  if (from.supportsImages !== to.supportsImages) bits.push(`img ${from.supportsImages}→${to.supportsImages}`)
  if (JSON.stringify(from.thinking) !== JSON.stringify(to.thinking)) bits.push(`thinking ${JSON.stringify(from.thinking)}→${JSON.stringify(to.thinking)}`)
  console.log(`  ${id}: ${bits.join('  ')}`)
}

if (!flag('write')) {
  console.log('\n（只报告差异；加 --write 才改写 src/catalog.js）')
  process.exit(0)
}

const file = fs.readFileSync(CATALOG_PATH, 'utf8')
const block = /const MODEL_CATALOG = \{[\s\S]*?\n\}\n/
if (!block.test(file)) throw new Error('MODEL_CATALOG block not found in src/catalog.js')
const literal = `const MODEL_CATALOG = {\n${Object.entries(next).map(([id, entry]) => serialize(id, entry)).join('\n')}\n}\n`
fs.writeFileSync(CATALOG_PATH, file.replace(block, literal), 'utf8')
console.log(`\n已写入 ${CATALOG_PATH}`)
