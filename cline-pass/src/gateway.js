/**
 * The local OpenAI-compatible gateway.
 *
 * PI-Desktop sends model requests itself, so the only way a plugin can own the
 * request path is to be the provider the host has been told about: the *user*
 * imports the config the panel generates (`src/models.js`), that config's
 * `baseUrl` is this server, and every call the host makes lands here. This module
 * is therefore the ported DSH request path - channel pin, failover across
 * candidates, account pool, idle watchdog, request history - expressed as an
 * HTTP handler instead of an LLM adapter.
 *
 * Streaming design: upstream frames are parsed so routing and usage can be read,
 * then re-emitted as standard OpenAI SSE frames. Nothing is written to the host
 * until the first frame of a candidate arrives, which is what keeps failover
 * invisible: a candidate that dies early is retried, a candidate that dies late
 * ends the stream with an error frame.
 *
 * @module cline-pass/gateway
 */
'use strict'

const http = require('node:http')
const path = require('node:path')

const {
  BUILD_TAG,
  GATEWAY_PORT,
  injectPrefs,
  buildAttempts,
  parseRouting,
  classifyUpstreamError,
  errorText,
  unwrapEnvelope,
} = require('./protocol.js')
const { openChatStream, fetchUsageLimits } = require('./cline.js')
const { catalogEntry, modelsEndpointPayload, reasoningEffortFor } = require('./catalog.js')
const { createStore } = require('./store.js')
const { createEngine, parseServerSentEvents, GatewayError } = require('./engine.js')
const { createAccountPool, maskKey, keyFor, duplicateNames } = require('./config.js')
const { createUsageLog, extractUsage } = require('./usage.js')
const { effectiveModels, effortsFor, importConfigPayload, describeImportConfig, unimportModelId } = require('./models.js')
const hostLadder = require('./hostladder.js')
const { summarizeLimits, summarizeAccount } = require('./quota.js')

/** Requests may carry base64 images, so the cap is generous - but not absent. */
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** How long one official-quota reading is reused before asking the gateway again. */
const QUOTA_CACHE_MS = 60000
/** One account's quota read is a single GET; a slow one must not hold the panel. */
const QUOTA_TIMEOUT_MS = 10000

/**
 * The port the gateway listens on, from the one place that spells it out
 * (`protocol.js`). Nothing reads `manifest.json` any more: the plugin declares
 * no provider, so the manifest cannot advertise a port either.
 */
const LISTEN_PORT = GATEWAY_PORT

/**
 * The model id the upstream expects.
 *
 * Three spellings arrive here: the catalog's own (`cline-pass/x`), the host's short
 * one (`x`), and the generated config's (`cline-pass-local/x` - `models.js` explains
 * why the imported ids are re-spelled). All three have to land on the catalog id,
 * because that is what the pins, the ledger and the model settings are keyed by.
 *
 * An id that matches no model is passed through untouched rather than mapped onto
 * some other model: a wrong model answering is worse than an upstream error.
 */
function normalizeModelId(model) {
  const id = String(model ?? '').trim()
  if (id === '') return ''
  if (catalogEntry(id)) return id
  const imported = unimportModelId(id)
  if (imported !== null && catalogEntry(imported)) return imported
  const prefixed = `cline-pass/${id.replace(/^cline-pass\//, '')}`
  return catalogEntry(prefixed) ? prefixed : id
}

/**
 * Translate the host's thinking level into the upstream's vocabulary.
 * `off` (the host's "no thinking") becomes "field absent": Cline Pass treats an
 * absent effort as its own default, which is the honest reading of "off".
 *
 * `allowed` carries the model's published efforts, so a level the model never
 * advertised is clamped to the nearest one it did rather than dropped - the
 * host only offers levels it was told about, so a mismatch here means the
 * imported config carries an older ladder rather than a bad request.
 */
function normalizeReasoning(body, allowed) {
  const next = { ...body }
  const level = next.reasoning_effort ?? next.reasoningEffort
  delete next.reasoningEffort
  if (level === undefined) return next
  const effort = reasoningEffortFor(level, allowed)
  if (effort === null) delete next.reasoning_effort
  else next.reasoning_effort = effort
  return next
}

/** One `data:` frame in the SSE dialect the host expects. */
function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** An error frame the host surfaces instead of a silently truncated answer. */
function sseErrorFrame(message) {
  return sseFrame({ error: { message: String(message).slice(0, 1000), type: 'upstream_error' } })
}

/** Await one iterator step under a deadline. */
function nextWithTimeout(iterator, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GatewayError(`${what} produced no frame for ${timeoutMs}ms`, 'STREAM_IDLE_TIMEOUT')), timeoutMs)
    iterator.next().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** A counting semaphore, so a burst cannot open unbounded upstream sockets. */
function createSemaphore(limit) {
  let active = 0
  const waiters = []
  return {
    async acquire() {
      if (active >= limit) await new Promise((resolve) => waiters.push(resolve))
      active += 1
    },
    release() {
      active = Math.max(0, active - 1)
      const next = waiters.shift()
      if (next) next()
    },
    get active() {
      return active
    },
    get pending() {
      return waiters.length
    },
  }
}

/** Read a request body, bounded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new GatewayError('request body too large', 'PAYLOAD_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** The bearer token the host put on the request, if any. */
function bearerOf(req) {
  const header = String(req.headers.authorization ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Create the gateway: one HTTP server plus the control surface the panel and
 * the agent tools share.
 *
 * @param configStore - from `createConfig`.
 * @param logger - `(message, detail?) => void`.
 * @param instanceId - a value that identifies this process as this plugin.
 */
function createGateway({ configStore, logger = () => {}, instanceId = '', portOverride = -1, dataDir = '' }) {
  const store = createStore({ historyLimit: configStore.get().historyLimit })

  /** The request ledger, kept beside config.json in the plugin's data directory. */
  const ledger = createUsageLog({ dataDir: path.dirname(configStore.file), logger })
  /** The last official-quota reading, reused for `QUOTA_CACHE_MS`. */
  let quotaCache = null

  /**
   * The host's own parameters for this plugin's models, cached by
   * `hostladder.readHostModels`. The host owns the window, the output cap, image
   * support and the thinking ladder once its row exists, so this is what the
   * request path maps levels with; the catalog only covers a model the host has
   * no row for.
   */
  function hostModels() {
    return hostLadder.readHostModels({ dataDir })
  }

  /** Effective parameters for one model: the host's row first, then the fallback. */
  function modelParams(id) {
    const config = configStore.get()
    return effectiveModels(config.modelSettings, config.catalogSource, hostModels()).find((model) => model.id === id) ?? null
  }
  const pool = createAccountPool({ configStore, logger })
  const semaphore = createSemaphore(configStore.get().maxConcurrentRequests)
  let port = Number.isInteger(Number(portOverride)) && Number(portOverride) >= 0 ? Math.floor(Number(portOverride)) : LISTEN_PORT
  let server = null
  const sockets = new Set()

  /** An engine whose account resolution is bound to one request's host key. */
  function engineFor(hostKey) {
    const config = configStore.get()
    return createEngine({
      resolveAccount: async () => {
        const account = pool.resolve(hostKey)
        if (!account) throw new GatewayError('no usable account: add one in the panel or fill the provider API key', 'NO_ACCOUNT')
        return { name: account.name, key: account.key, baseURL: account.baseURL }
      },
      store,
      logger,
      attemptTimeoutMs: config.requestTimeoutMs,
      probeTimeoutMs: config.probeTimeoutMs,
    })
  }

  /** Bench an account after one upstream verdict. */
  function benchFromStatus(account, status, text) {
    if (status === 429) pool.cooldown(account.name, 'QUOTA_EXCEEDED')
    else if (status === 401 || status === 403) pool.cooldown(account.name, 'AUTH')
    else if (classifyUpstreamError(text) === 'auth') pool.cooldown(account.name, 'AUTH')
  }

  /** Non-streaming request: walk candidates and accounts until one answers. */
  async function handleJsonChat({ body, model, hostKey, res, signal }) {
    const pin = configStore.pinOf(model)
    const attempts = buildAttempts(pin)
    const rounds = Math.max(1, pool.candidates(hostKey).length)
    const errors = []
    const engine = engineFor(hostKey)
    for (const attempt of attempts) {
      for (let round = 0; round < rounds; round += 1) {
        const account = pool.resolve(hostKey)
        if (!account) {
          errors.push('no usable account: add one in the panel or fill the provider API key')
          break
        }
        const request = injectPrefs(normalizeReasoning({ ...body, model, stream: false }, effortsFor(modelParams(model))), store.metaOf(model), attempt)
        const outcome = await engine.attemptChat(model, request, attempt, { signal, timeoutMs: configStore.get().requestTimeoutMs, account })
        if (outcome.ok) {
          store.record({ model, upstream: attempt.upstream ?? '(auto)', account: account.name, status: 200, ms: outcome.ms, note: outcome.note || 'ok' })
          ledger.record({
            model,
            upstream: attempt.upstream ?? outcome.routing?.finalProvider ?? '(auto)',
            account: account.name,
            status: 200,
            ms: outcome.ms,
            stream: false,
            note: outcome.note || 'ok',
            ...extractUsage(outcome.json?.usage),
          })
          return sendJson(res, 200, outcome.json)
        }
        benchFromStatus(account, outcome.httpStatus, outcome.error)
        errors.push(`${attempt.upstream ?? '(auto)'} via ${account.name}: ${outcome.error}`)
        // Only a verdict that points at the account itself is worth trying on
        // another key: 401/429/403, or a transport that never got an answer.
        // Everything else would say the same thing for every account, so the
        // remaining rounds are skipped and the next candidate is tried instead.
        const accountScoped = outcome.httpStatus === 401 || outcome.httpStatus === 403 || outcome.httpStatus === 429
          || /fetch failed|timeout|aborted|ECONN|socket/i.test(outcome.error)
        if (!accountScoped) break
      }
    }
    const message = errors.join(' | ') || 'no candidate answered'
    store.record({ model, upstream: '(none)', account: '', status: 502, ms: 0, note: message.slice(0, 160) })
    ledger.record({ model, upstream: '(none)', account: '', status: 502, ms: 0, stream: false, note: message.slice(0, 160) })
    sendJson(res, 502, { error: { message, type: 'upstream_error' } })
  }

  /** Streaming request: failover stays invisible until the first frame. */
  async function handleStreamChat({ req, body, model, hostKey, res }) {
    const pin = configStore.pinOf(model)
    const attempts = buildAttempts(pin)
    const meta = store.metaOf(model)
    const config = configStore.get()
    const rounds = Math.max(1, pool.candidates(hostKey).length)
    const errors = []
    const controller = new AbortController()
    let clientGone = false
    res.on('close', () => {
      clientGone = true
      controller.abort()
    })
    let started = false
    let headersSent = false

    const beginResponse = () => {
      headersSent = true
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
    }

    try {
      for (const attempt of attempts) {
        for (let round = 0; round < rounds; round += 1) {
          if (clientGone) return
          const account = pool.resolve(hostKey)
          if (!account) {
            errors.push('no usable account: add one in the panel or fill the provider API key')
            break
          }
          const request = injectPrefs(normalizeReasoning({ ...body, model, stream: true }, effortsFor(modelParams(model))), meta, attempt)
          const attemptStart = Date.now()
          let upstream
          try {
            upstream = await openChatStream({ baseURL: account.baseURL, apiKey: account.key, body: request, signal: controller.signal })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            errors.push(`${attempt.upstream ?? '(auto)'} via ${account.name}: ${message}`)
            continue
          }
          if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => '')
            benchFromStatus(account, upstream.status, text)
            errors.push(`${attempt.upstream ?? '(auto)'} via ${account.name}: HTTP ${upstream.status} ${text.slice(0, 200)}`)
            continue
          }
          const frames = parseServerSentEvents(upstream.body)
          let first
          try {
            first = await nextWithTimeout(frames, config.streamIdleTimeoutMs, 'the upstream')
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (error instanceof GatewayError && error.code === 'STREAM_CLOSED') errors.push(`${attempt.upstream ?? '(auto)'}: empty response content`)
            else errors.push(`${attempt.upstream ?? '(auto)'} via ${account.name}: ${message}`)
            await upstream.body.cancel().catch(() => {})
            continue
          }
          if (first.done || first.value === '[DONE]') {
            errors.push(`${attempt.upstream ?? '(auto)'}: empty response content`)
            await upstream.body.cancel().catch(() => {})
            continue
          }
          // From here on the host is committed to this candidate.
          if (!headersSent) beginResponse()
          started = true
          let routing = parseRouting(first.value)
          let usage = first.value?.usage ?? null
          res.write(sseFrame(first.value))
          let finished = false
          try {
            while (true) {
              const step = await nextWithTimeout(frames, config.streamIdleTimeoutMs, 'the upstream')
              if (step.done) break
              if (step.value === '[DONE]') {
                finished = true
                break
              }
              const frame = step.value
              const frameRouting = parseRouting(frame)
              if (frameRouting.finalProvider !== null) routing = { ...routing, ...frameRouting }
              if (frame?.usage) usage = frame.usage
              res.write(sseFrame(frame))
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            store.learnUpstream(model, attempt.upstream ?? routing.finalProvider ?? '', classifyUpstreamError(message), message, Date.now() - attemptStart)
            res.write(sseErrorFrame(message))
          }
          res.write('data: [DONE]\n\n')
          res.end()
          const note = finished ? 'ok' : 'stream ended early'
          store.record({
            model,
            upstream: attempt.upstream ?? routing.finalProvider ?? '(auto)',
            account: account.name,
            status: finished ? 200 : 502,
            ms: Date.now() - attemptStart,
            tokens: usage?.total_tokens ?? null,
            note,
          })
          // The ledger is the only cost record that exists: Cline Pass has no
          // usage endpoint, so what the final frame reported is what we keep.
          ledger.record({
            model,
            upstream: attempt.upstream ?? routing.finalProvider ?? '(auto)',
            account: account.name,
            status: finished ? 200 : 502,
            ms: Date.now() - attemptStart,
            stream: true,
            note,
            ...extractUsage(usage),
          })
          if (attempt.upstream !== null && routing.finalProvider !== null && finished) store.learnUpstream(model, attempt.upstream, 'ok', 'answered', Date.now() - attemptStart)
          return
        }
      }
      const message = errors.join(' | ') || 'no candidate answered'
      store.record({ model, upstream: '(none)', account: '', status: 502, ms: 0, note: message.slice(0, 160) })
      ledger.record({ model, upstream: '(none)', account: '', status: 502, ms: 0, stream: true, note: message.slice(0, 160) })
      if (headersSent) {
        res.write(sseErrorFrame(message))
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        sendJson(res, 502, { error: { message, type: 'upstream_error' } })
      }
    } finally {
      if (!started && !res.writableEnded) {
        try {
          res.end()
        } catch {
          /* the socket is already gone */
        }
      }
    }
  }

  /** Route one request. */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      sendJson(res, 403, { error: { message: 'the Cline Pass gateway only serves this machine', type: 'forbidden' } })
      return
    }
    if (url.pathname === '/__pi/cline-pass/health') {
      sendJson(res, 200, { ok: true, plugin: 'cline-pass', build: BUILD_TAG, instanceId, port })
      return
    }
    if (url.pathname === '/__pi/cline-pass/state') {
      sendJson(res, 200, { ok: true, build: BUILD_TAG, port, ...ops.status() })
      return
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const modelConfig = configStore.get()
      sendJson(res, 200, modelsEndpointPayload(effectiveModels(modelConfig.modelSettings, modelConfig.catalogSource, hostModels())))
      return
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      } catch {
        sendJson(res, 400, { error: { message: 'request body must be JSON', type: 'invalid_request_error' } })
        return
      }
      const model = normalizeModelId(payload.model)
      if (model === '') {
        sendJson(res, 400, { error: { message: 'model is required', type: 'invalid_request_error' } })
        return
      }
      const hostKey = bearerOf(req)
      await semaphore.acquire()
      try {
        if (payload.stream === true) await handleStreamChat({ req, body: payload, model, hostKey, res })
        else await handleJsonChat({ body: payload, model, hostKey, res, signal: AbortSignal.timeout(configStore.get().requestTimeoutMs) })
      } finally {
        semaphore.release()
      }
      return
    }
    sendJson(res, 404, { error: { message: `no route for ${url.pathname}`, type: 'not_found' } })
  }

  /* ------------------------------- control surface ------------------------------ */

  /** Everything the panel shows at a glance. */
  function status(hostKey = '') {
    const config = configStore.get()
    const meta = store.allMeta()
    return {
      build: BUILD_TAG,
      port,
      running: server !== null,
      baseUrl: config.baseUrl,
      providerBaseUrl: `http://127.0.0.1:${port}/v1`,
      accountMode: config.accountMode,
      activeAccount: config.activeAccount,
      catalogSource: config.catalogSource,
      accounts: pool.view(hostKey).map((entry) => ({ ...entry, keyHint: entry.keyHint || '' })),
      pins: config.pins,
      requestTimeoutMs: config.requestTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      probeTimeoutMs: config.probeTimeoutMs,
      maxConcurrentRequests: config.maxConcurrentRequests,
      inFlight: semaphore.active,
      queued: semaphore.pending,
      historySize: ledger.summary({ days: 0 }).rows,
      quota: quotaCache === null ? null : { fetchedAt: quotaCache.at, accounts: quotaCache.accounts.map(summarizeAccount) },
      models: effectiveModels(config.modelSettings, config.catalogSource, hostModels()).map((model) => {
        const discovered = meta.find((candidate) => candidate.id === model.id) ?? {}
        return {
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsImages: model.supportsImages,
          thinkingLevels: model.thinkingLevels,
          defaultThinkingLevel: model.defaultThinkingLevel,
          lever: model.lever,
          // Whether the catalog had to fall back to a stand-in default.
          fallback: model.fallback,
          registered: model.registered,
          // Which fields the panel has overridden, so an edited window is not
          // mistaken for Cline's published one.
          edited: model.edited,
          published: model.published,
          // Where each value came from (host / panel / catalog) and the host's own
          // block, so the panel can mark a field the host owns instead of offering
          // an edit that would do nothing.
          origin: model.origin,
          host: model.host,
          // Kept for the existing panel and tests: the two older summaries.
          reasoning: model.thinkingLevels.length > 1,
          input: model.supportsImages ? ['text', 'image'] : ['text'],
          pin: config.pins?.[model.id] ?? null,
          pipeline: discovered.pipeline ?? null,
          pinnable: discovered.pinnable === true,
          upstreams: Array.isArray(discovered.upstreams) ? discovered.upstreams : [],
          upstreamStatus: discovered.upstreamStatus ?? {},
          lastProvider: discovered.lastProvider ?? '',
          probedAt: discovered.probedAt ?? 0,
          lastError: discovered.lastError ?? '',
        }
      }),
      configFile: configStore.file,
    }
  }

  /** The control-plane operations the agent tools and the panel share. */
  const ops = {
    status,
    models() {
      return status().models
    },
    /**
     * Write one model's overrides into this plugin's own `config.json`.
     *
     * Nothing outside `config.json` changes any more: the host no longer reads a
     * model list from this plugin, so a saved parameter only has to be
     * remembered here - the config the panel generates is what carries it to the
     * host, and the user imports it themselves. The response reports what was
     * written rather than what was intended.
     */
    setModel(patch = {}) {
      const id = normalizeModelId(patch.model)
      if (id === '') throw new GatewayError('model is required', 'INVALID_ARGUMENT')
      if (!catalogEntry(id)) throw new GatewayError(`unknown model "${id}"`, 'NOT_FOUND')
      const applied = configStore.setModelSettings(id, patch)
      const summary = describeImportConfig(importConfigPayload(configStore.get().modelSettings))
      logger('model settings updated', { model: id, summary })
      return { ok: true, model: id, applied, summary, models: ops.models() }
    },
    /** Token and cost totals from the request ledger, with the newest rows. */
    usage({ days, limit, model } = {}) {
      const windowDays = Number.isFinite(Number(days)) ? Math.max(0, Math.floor(Number(days))) : 7
      return {
        ok: true,
        ...ledger.summary({ days: windowDays }),
        recent: ledger.recent({ limit: Number.isFinite(Number(limit)) ? Number(limit) : 20, model: model ?? '' }),
      }
    },
    usageClear() {
      return { ok: true, ...ledger.clear() }
    },
    /**
     * The accounts' official quota windows (Cline's own
     * `GET /users/me/plan/usage-limits`).
     *
     * This is not the request ledger: the ledger knows what this gateway spent,
     * while these windows are what the account spent anywhere. A `host` account
     * can only be read while a request carries its key, so the panel is told
     * that plainly instead of being shown a 0%.
     *
     * Readings are reused for `QUOTA_CACHE_MS`; `refresh: true` bypasses that,
     * which is what the panel's own refresh asks for.
     */
    async quota({ apiKey, refresh, signal } = {}) {
      const hostKey = String(apiKey ?? '')
      const config = configStore.get()
      const accounts = config.accounts.filter((entry) => entry.enabled !== false)
      const cacheKey = accounts.map((entry) => `${entry.name}:${maskKey(keyFor(entry, hostKey) ?? '')}`).join('|')
      const now = Date.now()
      if (refresh !== true && quotaCache !== null && quotaCache.key === cacheKey && now - quotaCache.at < QUOTA_CACHE_MS) {
        return { ok: true, fetchedAt: quotaCache.at, cached: true, accounts: quotaCache.accounts }
      }
      // Two rows with one key are one account: the panel has to be able to say
      // so, otherwise a duplicated key silently shows one account's numbers
      // under another account's name.
      const duplicates = duplicateNames(config, hostKey)
      const rows = await Promise.all(
        accounts.map(async (account) => {
          const key = keyFor(account, hostKey)
          const keyHint = maskKey(key ?? '')
          const duplicate = duplicates.has(account.name)
          if (typeof key !== 'string' || key.length === 0) {
            return {
              name: account.name,
              displayName: account.displayName || account.name,
              keyHint,
              duplicate,
              // `source` rides along with every row: the panel lists only the
              // accounts it can read (a host account's key lives in request
              // memory, so the panel can never read that one's quota).
              source: account.source === 'host' ? 'host' : 'inline',
              ok: false,
              error:
                account.source === 'host'
                  ? 'this account uses the key typed into the model settings page, which lives in request memory only - add an inline account in the panel to read quota for it'
                  : 'this account has no key right now',
              limits: [],
            }
          }
          const result = await fetchUsageLimits({ baseURL: config.baseUrl, apiKey: key, signal, timeoutMs: QUOTA_TIMEOUT_MS })
          return { name: account.name, displayName: account.displayName || account.name, keyHint, duplicate, source: account.source === 'host' ? 'host' : 'inline', ok: result.ok, error: result.error, limits: summarizeLimits(result.limits, Date.now()) }
        }),
      )
      quotaCache = { key: cacheKey, at: now, accounts: rows }
      logger('quota read', { accounts: rows.length, ok: rows.filter((row) => row.ok).length })
      return { ok: true, fetchedAt: now, cached: false, accounts: rows }
    },
    setConfig(patch) {
      const allowed = {}
      if (typeof patch?.baseUrl === 'string') allowed.baseUrl = patch.baseUrl.trim()
      if (patch?.accountMode === 'single' || patch?.accountMode === 'roundrobin') allowed.accountMode = patch.accountMode
      if (typeof patch?.activeAccount === 'string') allowed.activeAccount = patch.activeAccount
      // Which published set the panel shows and the generated config carries.
      if (patch?.catalogSource === 'models.dev' || patch?.catalogSource === 'cline-pass') allowed.catalogSource = patch.catalogSource
      for (const key of ['requestTimeoutMs', 'streamIdleTimeoutMs', 'probeTimeoutMs', 'maxConcurrentRequests', 'historyLimit']) {
        if (Number.isFinite(Number(patch?.[key])) && Number(patch[key]) > 0) allowed[key] = Math.floor(Number(patch[key]))
      }
      if (Object.keys(allowed).length === 0) throw new GatewayError('nothing to update', 'INVALID_ARGUMENT')
      const next = configStore.update(allowed)
      logger('configuration updated', { keys: Object.keys(allowed) })
      return { ok: true, config: { baseUrl: next.baseUrl, accountMode: next.accountMode, activeAccount: next.activeAccount, catalogSource: next.catalogSource } }
    },
    pin({ model, upstreams, exclude, pinMode, sort }) {
      const id = normalizeModelId(model)
      if (id === '') throw new GatewayError('model is required', 'INVALID_ARGUMENT')
      const written = configStore.setPin(id, { upstreams, exclude, pinMode, sort })
      logger('pin written', { model: id, upstreams: written?.upstreams ?? [], exclude: written?.exclude ?? [], pinMode: written?.pinMode })
      return { ok: true, model: id, pin: written }
    },
    clearPin({ model }) {
      const id = normalizeModelId(model)
      configStore.setPin(id, null)
      return { ok: true, model: id, pin: null }
    },
    async probe({ model, apiKey, signal }) {
      const id = normalizeModelId(model)
      if (id === '') throw new GatewayError('model is required', 'INVALID_ARGUMENT')
      return await engineFor(apiKey ?? '').probe(id, { signal })
    },
    async validate({ model, apiKey, signal }) {
      const id = normalizeModelId(model)
      if (id === '') throw new GatewayError('model is required', 'INVALID_ARGUMENT')
      return await engineFor(apiKey ?? '').validate(id, { signal })
    },
    async test({ model, upstreams, exclude, pinMode, sort, apiKey, signal }) {
      const id = normalizeModelId(model)
      if (id === '') throw new GatewayError('model is required', 'INVALID_ARGUMENT')
      const result = await engineFor(apiKey ?? '').test(id, { upstreams, exclude, pinMode, sort, signal })
      return {
        ok: result.ok,
        error: result.error,
        trace: result.trace,
        warnings: result.warnings,
        upstream: result.result?.routing?.finalProvider ?? '',
        text: typeof result.result?.json?.choices?.[0]?.message?.content === 'string' ? result.result.json.choices[0].message.content.slice(0, 400) : '',
      }
    },
    history({ limit, model } = {}) {
      // Read the same ledger the 用量 tab sums, instead of the in-memory store: the
      // ledger is on disk, so rows survive a plugin reload. The in-memory copy only
      // lives for one run, which is why this tab was empty every time the panel was
      return {
        size: ledger.summary({ days: 0 }).rows,
        rows: ledger.recent({ limit: Number.isFinite(Number(limit)) ? Number(limit) : 50, model: model ?? '' }),
      }
    },
    async accounts({ action, name, renameTo, displayName, source, key, enabled, accountMode, activeAccount, model, apiKey } = {}) {
      const config = configStore.get()
      const accounts = config.accounts.slice()
      const input = String(name ?? '').trim()
      switch (action) {
        case 'list':
          return { ok: true, accountMode: config.accountMode, activeAccount: config.activeAccount, accounts: pool.view(apiKey ?? '') }
        case 'add': {
          if (input === '') throw new GatewayError('an account needs a name', 'INVALID_ARGUMENT')
          if (accounts.some((entry) => entry.name === input)) throw new GatewayError(`account "${input}" already exists`, 'INVALID_ARGUMENT')
          if (source === 'env') {
            throw new GatewayError('environment-variable accounts are not supported: the host starts a plugin process with a minimal environment, so it can never see your variables - add the key instead', 'INVALID_ARGUMENT')
          }
          if (typeof key !== 'string') throw new GatewayError('an account needs a key', 'INVALID_ARGUMENT')
          accounts.push({
            name: input,
            displayName: String(displayName ?? '').trim() || input,
            source: 'inline',
            enabled: enabled !== false,
            key: String(key ?? ''),
          })
          configStore.update({ accounts })
          return { ok: true, accounts: pool.view(apiKey ?? ''), keyHint: maskKey(key) }
        }
        case 'update': {
          const index = accounts.findIndex((entry) => entry.name === input)
          if (index < 0) throw new GatewayError(`unknown account "${input}"`, 'NOT_FOUND')
          const next = { ...accounts[index] }
          // A rename has to be checked against the other rows first: two accounts
          // sharing a name would make the pool's lookup ambiguous.
          const wanted = String(renameTo ?? '').trim()
          if (wanted !== '' && wanted !== input) {
            if (accounts.some((entry) => entry.name === wanted)) throw new GatewayError(`account "${wanted}" already exists`, 'INVALID_ARGUMENT')
            if (next.source === 'host') throw new GatewayError('the host account cannot be renamed', 'INVALID_ARGUMENT')
            next.name = wanted
          }
          if (typeof displayName === 'string' && displayName.trim()) next.displayName = displayName.trim()
          if (typeof enabled === 'boolean') next.enabled = enabled
          if (next.source === 'inline' && typeof key === 'string' && key.length > 0) next.key = key
          accounts[index] = next
          // Single mode pins one account by name, so it has to follow the rename.
          const pinned = config.activeAccount === input && next.name !== input ? next.name : config.activeAccount
          configStore.update({ accounts, activeAccount: pinned })
          return { ok: true, accounts: pool.view(apiKey ?? ''), name: next.name }
        }
        case 'remove': {
          if (!accounts.some((entry) => entry.name === input)) throw new GatewayError(`unknown account "${input}"`, 'NOT_FOUND')
          if (input === 'host') throw new GatewayError('the host account cannot be removed', 'INVALID_ARGUMENT')
          configStore.update({ accounts: accounts.filter((entry) => entry.name !== input) })
          return { ok: true, accounts: pool.view(apiKey ?? '') }
        }
        case 'mode': {
          if (accountMode !== 'single' && accountMode !== 'roundrobin') throw new GatewayError('mode must be single or roundrobin', 'INVALID_ARGUMENT')
          configStore.update({ accountMode, ...(typeof activeAccount === 'string' ? { activeAccount } : {}) })
          return { ok: true, accountMode, activeAccount: configStore.get().activeAccount }
        }
        case 'test': {
          const target = accounts.find((entry) => entry.name === input)
          if (!target) throw new GatewayError(`unknown account "${input}"`, 'NOT_FOUND')
          const poolView = pool.view(apiKey ?? '').find((entry) => entry.name === input)
          if (!poolView?.keyConfigured) throw new GatewayError(`account "${input}" has no key available right now`, 'INVALID_ARGUMENT')
          const resolved = keyFor(target, apiKey ?? '')
          const result = await engineFor('').testAccount({ key: resolved, baseURL: config.baseUrl, model: normalizeModelId(model) || undefined })
          if (result.ok) pool.resetCooldowns()
          return result
        }
        case 'resetCooldowns':
          pool.resetCooldowns()
          return { ok: true, accounts: pool.view(apiKey ?? '') }
        default:
          throw new GatewayError(`unsupported account action "${action ?? ''}"`, 'INVALID_ARGUMENT')
      }
    },
  }

  /** Bind the socket. Rejects when the port is taken by something else. */
  function start() {
    return new Promise((resolve, reject) => {
      if (server) {
        resolve({ port })
        return
      }
      const created = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          logger('request handler failed', { error: error instanceof Error ? error.message : String(error) })
          if (!res.headersSent) sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error), type: 'internal_error' } })
          else res.end()
        })
      })
      created.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      created.on('error', (error) => {
        logger('gateway bind failed', { port, error: error.message })
        reject(error)
      })
      created.listen(port, '127.0.0.1', () => {
        const bound = created.address()
        if (bound && typeof bound === 'object' && bound.port) port = bound.port
        server = created
        logger('gateway listening', { port, build: BUILD_TAG })
        resolve({ port })
      })
    })
  }

  /** Stop accepting work and close every live socket. */
  function stop() {
    return new Promise((resolve) => {
      if (!server) {
        resolve()
        return
      }
      const closing = server
      server = null
      closing.close(() => resolve())
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    })
  }

  return {
    start,
    stop,
    ops,
    status,
    // A getter, not a snapshot: the bound port is only known once listen() reports it.
    get port() {
      return port
    },
    store,
    pool,
    instanceId,
  }
}

module.exports = { MAX_BODY_BYTES, LISTEN_PORT, normalizeModelId, normalizeReasoning, sseFrame, createGateway, GatewayError }
