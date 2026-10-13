/**
 * Plugin configuration and the account pool.
 *
 * Configuration lives in the plugin's own data directory (`config.json`),
 * because a PI-Desktop plugin setting cannot be marked secret in this release
 * and API keys must not end up in the host's settings document. The file is
 * written with owner-only permissions where the platform honours them, and the
 * panel says plainly what it holds.
 *
 * The account pool is ported from `dsh-cline-pass` 0.2.5-p3 (`lib/index.js`,
 * MIT): a round-robin cursor over the enabled accounts plus a cooldown map, so
 * a quota-limited key is skipped for a while instead of failing every request.
 *
 * @module cline-pass/config
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { sanitizeSettings } = require('./models.js')

/** Cline Pass' own endpoint; overriding it is a debugging escape hatch. */
const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

/** How long an account stays benched after one verdict. */
const COOLDOWN_MS = { QUOTA_EXCEEDED: 15 * 60 * 1000, AUTH: 30 * 60 * 1000 }

/** The account name reserved for the key the host itself sends. */
const HOST_ACCOUNT = 'host'

/**
 * The key the host puts on the wire when a plugin provider declares
 * `authKind: "none"`.
 *
 * A plugin provider that wants no host-side secret has exactly one switch:
 * `authKind: "none"` (`pi-desktop` reads it when it decides whether a provider
 * is usable at all - a provider with a missing secret and `authKind: "api_key"`
 * disappears from the model picker entirely). The host then sends this
 * placeholder as its bearer token, which is not a Cline key and must never be
 * handed to the upstream: it is treated as "the host has no key".
 */
const HOST_NO_AUTH_KEY = 'pi-desktop-no-auth'

/** A fresh, empty configuration. */
function defaultConfig() {
  return {
    baseUrl: DEFAULT_BASE_URL,
    accountMode: 'roundrobin',
    activeAccount: '',
    accounts: [{ name: HOST_ACCOUNT, displayName: 'PI 设置里的密钥', source: 'host', enabled: true }],
    pins: {},
    requestTimeoutMs: 180000,
    streamIdleTimeoutMs: 300000,
    probeTimeoutMs: 60000,
    maxConcurrentRequests: 16,
    historyLimit: 100,
    modelSettings: {},
  }
}

/** Coerce a stored document into a configuration this module can trust. */
function normalize(raw) {
  const base = defaultConfig()
  const config = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (typeof config.baseUrl !== 'string' || !/^https?:\/\//.test(config.baseUrl)) config.baseUrl = DEFAULT_BASE_URL
  if (config.accountMode !== 'single' && config.accountMode !== 'roundrobin') config.accountMode = 'roundrobin'
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) config.accounts = base.accounts
  config.accounts = config.accounts
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => {
      const source = entry.source === 'host' ? 'host' : 'inline'
      return {
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `account-${index + 1}`,
        displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : `Account ${index + 1}`,
        source,
        enabled: entry.enabled !== false,
        ...(source === 'inline' ? { key: typeof entry.key === 'string' ? entry.key : '' } : {}),
      }
    })
  if (!config.accounts.some((entry) => entry.name === HOST_ACCOUNT)) config.accounts.unshift(base.accounts[0])
  if (!config.pins || typeof config.pins !== 'object' || Array.isArray(config.pins)) config.pins = {}
  for (const key of ['requestTimeoutMs', 'streamIdleTimeoutMs', 'probeTimeoutMs', 'maxConcurrentRequests', 'historyLimit']) {
    const value = Number(config[key])
    config[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : base[key]
  }
  config.modelSettings = sanitizeSettings(config.modelSettings)
  return config
}

/**
 * The configuration document plus the account pool that reads it.
 *
 * @param dataDir - the plugin's data directory (must exist).
 * @param logger - `(message, detail?) => void`.
 */
function createConfig({ dataDir, logger = () => {} } = {}) {
  const file = path.join(dataDir, 'config.json')
  let config = defaultConfig()

  function load() {
    try {
      if (fs.existsSync(file)) config = normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      logger('config load failed; using defaults', { error: error instanceof Error ? error.message : String(error) })
      config = defaultConfig()
    }
    return config
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        fs.chmodSync(file, 0o600)
      } catch {
        /* Windows and some filesystems ignore mode; the file is per-user anyway */
      }
      return true
    } catch (error) {
      logger('config save failed', { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Merge one patch into the configuration and persist it. */
  function update(patch) {
    config = normalize({ ...config, ...patch })
    save()
    return config
  }

  /** Write one model's pin block; passing `null` clears it. */
  function setPin(model, pin) {
    const pins = { ...config.pins }
    if (pin === null) delete pins[model]
    else
      pins[model] = {
        upstreams: Array.isArray(pin.upstreams) ? pin.upstreams.map(String).filter((name) => name.trim().length > 0) : [],
        exclude: Array.isArray(pin.exclude) ? pin.exclude.map(String).filter((name) => name.trim().length > 0) : [],
        pinMode: pin.pinMode === 'preferred' ? 'preferred' : 'strict',
        sort: typeof pin.sort === 'string' && pin.sort !== 'none' ? pin.sort : '',
      }
    config = { ...config, pins }
    save()
    return config.pins[model] ?? null
  }

  /** The pin block for one model, or an empty one. */
  function pinOf(model) {
    const pin = config.pins?.[model]
    if (!pin || typeof pin !== 'object') return { upstreams: [], exclude: [], pinMode: 'strict', sort: '' }
    return {
      upstreams: Array.isArray(pin.upstreams) ? pin.upstreams : [],
      exclude: Array.isArray(pin.exclude) ? pin.exclude : [],
      pinMode: pin.pinMode === 'preferred' ? 'preferred' : 'strict',
      sort: typeof pin.sort === 'string' ? pin.sort : '',
    }
  }

  /**
   * Write one model's parameter overrides (write-into-config / window / output
   * cap / images / thinking levels). The panel is the only caller; these values
   * are what `models.importConfigPayload` turns into the config the user imports
   * into PI-Desktop's model settings, and what the gateway honours at request
   * time. Nothing here rewrites `manifest.json` any more - the plugin declares
   * no models to the host.
   */
  function setModelSettings(id, patch) {
    const settings = { ...(config.modelSettings ?? {}) }
    settings[id] = { ...(settings[id] ?? {}), ...(patch && typeof patch === 'object' ? patch : {}) }
    config = normalize({ ...config, modelSettings: settings })
    save()
    return config.modelSettings[id] ?? null
  }

  return {
    file,
    get: () => config,
    reload: load,
    update,
    setPin,
    pinOf,
    setModelSettings,
    save,
    defaultConfig,
  }
}

/**
 * The key one account contributes right now, or null when it has none.
 *
 * There is deliberately no "read it from an environment variable" source: the
 * host starts a plugin process with a minimal environment (PATH, TEMP, HOME and
 * friends plus PI_PLUGIN_ID - never the person's own variables), so an account
 * that promised to read `CLINE_API_KEY` out of the environment would silently
 * find nothing. A key is either typed into the panel (kept in config.json) or
 * arrives on the request the host sends (the `host` account, never written).
 */
function keyFor(account, hostKey) {
  if (!account || account.enabled === false) return null
  if (account.source === 'host') return hostKey && hostKey !== HOST_NO_AUTH_KEY ? hostKey : null
  return typeof account.key === 'string' && account.key.length > 0 ? account.key : null
}

/** A short, non-reversible hint for one key, safe to show and to log. */
function maskKey(key) {
  const value = String(key ?? '')
  if (value.length === 0) return ''
  if (value.length <= 10) return `${value.slice(0, 2)}***`
  return `${value.slice(0, 6)}***${value.slice(-4)}`
}

/**
 * The account pool: round-robin over enabled accounts, with cooldowns.
 *
 * @param configStore - the object returned by {@link createConfig}.
 * @param logger - `(message, detail?) => void`.
 */
function createAccountPool({ configStore, logger = () => {} }) {
  let cursor = 0
  /** @type {Map<string, { until: number, reason: string }>} */
  const cooling = new Map()

  /** Accounts that can contribute a key right now, cooldowns included. */
  /** Accounts that can contribute a key right now, cooldowns included. */
  function candidates(hostKey) {
    const config = configStore.get()
    return config.accounts
      .filter((account) => account.enabled !== false)
      .map((account) => ({ account, key: keyFor(account, hostKey) }))
      .filter((entry) => typeof entry.key === 'string' && entry.key.length > 0)
  }

  /** Drop expired cooldowns so the map cannot grow without bound. */
  function sweep(now) {
    for (const [name, entry] of cooling) if (entry.until <= now) cooling.delete(name)
  }

  /** Whether one named account is benched right now. */
  function isCooling(name, now = Date.now()) {
    const entry = cooling.get(name)
    return entry !== undefined && entry.until > now
  }

  /**
   * Pick the next account for one attempt.
   *
   * Follows the configured mode: `single` always honors `activeAccount`
   * (falling back to the first usable one), `roundrobin` walks the list. A
   * cooling account is skipped while any other account can serve; when every
   * candidate is cooling the soonest-to-recover one is used anyway, because
   * refusing to try is worse than trying the benched key.
   */
  function resolve(hostKey) {
    const all = candidates(hostKey)
    if (all.length === 0) return null
    const now = Date.now()
    sweep(now)
    const config = configStore.get()
    let ordered = all
    if (config.accountMode === 'single') {
      const active = String(config.activeAccount ?? '')
      const preferred = all.find((entry) => entry.account.name === active) ?? all[0]
      ordered = [preferred, ...all.filter((entry) => entry !== preferred)]
    } else {
      ordered = [...all.slice(cursor % all.length), ...all.slice(0, cursor % all.length)]
    }
    const ready = ordered.filter((entry) => !isCooling(entry.account.name, now))
    const chosen = ready.length > 0 ? ready[0] : ordered[0]
    if (config.accountMode !== 'single') cursor = (cursor + 1) % all.length
    return { name: chosen.account.name, displayName: chosen.account.displayName, key: chosen.key, baseURL: config.baseUrl, account: chosen.account }
  }

  /** Bench one account after a verdict, for the matching cooldown window. */
  function cooldown(name, reason = 'unknown') {
    const ms = reason === 'QUOTA_EXCEEDED' ? COOLDOWN_MS.QUOTA_EXCEEDED : reason === 'AUTH' ? COOLDOWN_MS.AUTH : 0
    if (ms <= 0 || !name) return
    cooling.set(name, { until: Date.now() + ms, reason })
    logger('account benched', { account: name, reason, ms })
  }

  /**
   * Clear every cooldown and restart the round-robin walk (the panel's reset).
   * Without the cursor reset a pool that has been walked once would answer the
   * next request with whichever account happened to be next, which is fine in
   * production but makes "try them in order" unrepeatable in the panel and in
   * the self-test.
   */
  function resetCooldowns() {
    cooling.clear()
    cursor = 0
  }

  /** The pool as the panel shows it: never the key itself, only a hint. */
  function view(hostKey) {
    const config = configStore.get()
    // Two rows holding one key are one account: every reading and every request
    // belongs to whoever that key is. The panel cannot tell unless we say so.
    const duplicates = duplicateNames(config, hostKey)
    return config.accounts.map((account) => {
      const key = keyFor(account, hostKey)
      const coolingUntil = cooling.get(account.name)?.until ?? 0
      return {
        name: account.name,
        displayName: account.displayName,
        source: account.source,
        enabled: account.enabled !== false,
        keyHint: maskKey(key),
        keyConfigured: typeof key === 'string' && key.length > 0,
        duplicate: duplicates.has(account.name),
        cooling: coolingUntil > Date.now(),
        coolingUntil,
        reason: cooling.get(account.name)?.reason ?? '',
      }
    })
  }

  return { resolve, cooldown, resetCooldowns, view, isCooling, candidates }
}

/**
 * Names of enabled accounts that share one key with another enabled account.
 *
 * The comparison uses the keys themselves — never logged, never returned. The
 * caller only learns *that* two rows collide, which is what a panel has to be
 * able to say when one key is showing another account's numbers under two names.
 */
function duplicateNames(config, hostKey) {
  const byKey = new Map()
  for (const account of config.accounts) {
    if (account.enabled === false) continue
    const key = keyFor(account, hostKey)
    if (typeof key !== 'string' || key.length === 0) continue
    const group = byKey.get(key)
    if (group) group.push(account.name)
    else byKey.set(key, [account.name])
  }
  const names = new Set()
  for (const group of byKey.values()) {
    if (group.length > 1) for (const name of group) names.add(name)
  }
  return names
}

module.exports = { DEFAULT_BASE_URL, COOLDOWN_MS, HOST_ACCOUNT, HOST_NO_AUTH_KEY, defaultConfig, normalize, createConfig, createAccountPool, keyFor, maskKey, duplicateNames }
