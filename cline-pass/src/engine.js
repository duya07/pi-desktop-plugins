/**
 * The Cline Pass engine: probe, validate and diagnose. Ported from
 * `dsh-cline-pass` 0.2.5-p3 (`lib/engine.js`, MIT).
 *
 * Everything here is non-streaming on purpose: the streaming request path lives
 * in `gateway.js` (it writes bytes straight to the host), while this module
 * answers the questions the panel and the agent tools ask - which pipeline does
 * this model run on, which channels serve it, does a pin actually stick.
 *
 * @module cline-pass/engine
 */
'use strict'

const {
  unwrapEnvelope,
  errorText,
  parseRouting,
  pinAdherence,
  isAdherenceOk,
  pinWarnings,
  buildAttempts,
  classifyUpstreamError,
  extractAvailableProviders,
  mergeUpstreams,
  channelNameFor,
  injectPrefs,
} = require('./protocol.js')
const { chatCompletion, openChatStream } = require('./cline.js')

/** How many channels one validate pass checks at the same time. */
const VALIDATE_CONCURRENCY = 5

/** A local error carrying a wire-ish code, so callers can branch on it. */
class GatewayError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

/**
 * Parse an SSE byte stream into decoded frames.
 *
 * Yields `'[DONE]'` for the sentinel and one parsed object per `data:` frame;
 * an unterminated stream raises, because a silent end is how a truncated answer
 * used to look like a complete one.
 */
async function* parseServerSentEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.length === 0 || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        yield '[DONE]'
        return
      }
      try {
        yield JSON.parse(payload)
      } catch {
        /* an unparseable frame carries nothing to deliver */
      }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload === '[DONE]') {
      yield '[DONE]'
      return
    }
    if (payload.length > 0) {
      try {
        yield JSON.parse(payload)
        yield '[DONE]'
        return
      } catch {
        /* fall through to the closed-stream error */
      }
    }
  }
  throw new GatewayError('stream ended without [DONE]', 'STREAM_CLOSED')
}

/** Await one iterator step under a deadline, so a mute upstream cannot hang a caller. */
function nextFrame(iterator, timeoutMs, what) {
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

/** Fold one streamed delta into the message an assembled completion carries. */
function mergeDelta(message, delta) {
  if (typeof delta?.content === 'string') message.content = (message.content ?? '') + delta.content
  for (const field of ['reasoning', 'reasoning_content', 'reasoning_text']) {
    if (typeof delta?.[field] === 'string') message[field] = (message[field] ?? '') + delta[field]
  }
  if (Array.isArray(delta?.reasoning_details)) message.reasoning_details = delta.reasoning_details
  if (Array.isArray(delta?.tool_calls)) {
    const calls = message.tool_calls ?? []
    for (const call of delta.tool_calls) {
      const index = Number.isInteger(call?.index) ? call.index : calls.length
      const slot = calls[index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (typeof call?.id === 'string' && call.id) slot.id = call.id
      if (typeof call?.function?.name === 'string' && call.function.name) slot.function.name = call.function.name
      if (typeof call?.function?.arguments === 'string') slot.function.arguments += call.function.arguments
      calls[index] = slot
    }
    message.tool_calls = calls
  }
}

/**
 * Create the engine.
 *
 * @param options.resolveAccount - async `() => { name, key, baseURL }`; called
 *   once per attempt, so round-robin pools rotate per attempt.
 * @param options.store - the observation store (probe results, history).
 * @param options.logger - optional `(message, detail?) => void`.
 */
function createEngine({ resolveAccount, store, logger = () => {}, attemptTimeoutMs = 180000, probeTimeoutMs = 60000 }) {
  /** Merge a gateway error's own provider list into the model's channel list. */
  function learnFromError(model, message) {
    const match = /Available providers are:\s*([^.]+)/.exec(String(message ?? ''))
    if (match === null) return
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    if (tokens.length === 0) return
    const meta = store.metaOf(model)
    const current = Array.isArray(meta.upstreams) ? meta.upstreams : []
    if (!tokens.some((token) => !current.includes(token))) return
    store.learn(model, { upstreams: mergeUpstreams(current, tokens) })
  }

  /**
   * Get one completion the way this endpoint can actually deliver it.
   *
   * Measured against `api.cline.bot` on 2026-10-13: a non-streaming request is
   * answered with `HTTP 500 {"error":"empty response content"}`, while the very
   * same request streams perfectly. So a caller that wants one JSON answer opens
   * the stream and assembles it - that is what the host gets for a
   * non-streaming call, and what probe/validate use underneath.
   *
   * @returns a `{ status, ok, json, text }` record shaped like `sendJSON`'s, or
   *   `null` when the stream never opened.
   */
  async function collectCompletion({ baseURL, apiKey, body, signal, timeoutMs = attemptTimeoutMs, idleTimeoutMs = 60000 } = {}) {
    let upstream
    try {
      upstream = await openChatStream({ baseURL, apiKey, body: { ...body, stream: true }, signal })
    } catch {
      return null
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* the raw text is the error body */
      }
      return { status: upstream.status, ok: false, json, text }
    }
    const message = { role: 'assistant', content: '' }
    const assembled = {
      id: '',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? '',
      provider: null,
      choices: [{ index: 0, message, finish_reason: null }],
      usage: null,
    }
    const frames = parseServerSentEvents(upstream.body)
    let sawFrame = false
    try {
      while (true) {
        const step = await nextFrame(frames, idleTimeoutMs, 'the upstream')
        if (step.done) break
        if (step.value === '[DONE]') break
        const frame = step.value
        sawFrame = true
        if (assembled.id === '' && typeof frame?.id === 'string') assembled.id = frame.id
        if (typeof frame?.model === 'string' && frame.model) assembled.model = frame.model
        const choice = Array.isArray(frame?.choices) ? frame.choices[0] : null
        if (choice) {
          mergeDelta(message, choice.delta)
          if (choice.finish_reason) assembled.choices[0].finish_reason = choice.finish_reason
        }
        if (frame?.usage) assembled.usage = frame.usage
        const routing = parseRouting(frame)
        if (routing.finalProvider) assembled.provider = routing.finalProvider
      }
    } catch (error) {
      if (!sawFrame) return null
      logger('assembled completion ended early', { error: error instanceof Error ? error.message : String(error) })
    }
    if (message.content === '' && message.tool_calls === undefined && message.reasoning === undefined && message.reasoning_content === undefined) {
      return { status: 502, ok: false, json: { error: { message: 'the upstream stream carried no content', type: 'upstream_error' } }, text: '' }
    }
    return { status: 200, ok: true, json: assembled, text: '' }
  }

  /**
   * One pinned request, non-streaming.
   * @returns `{ status, ok, json, text, ms, routing, attempt, account, adherence, warnings, error }`.
   */
  async function attemptChat(model, body, attempt, { signal, timeoutMs = attemptTimeoutMs, account: chosen } = {}) {
    // The gateway picks the account itself, so that the key which actually
    // failed is the one that gets benched. Resolving again here would rotate
    // the pool twice per attempt and bench an account that never ran.
    const account = chosen ?? await resolveAccount()
    const meta = store.metaOf(model)
    const pinned = injectPrefs(body, meta, attempt)
    const started = Date.now()
    let result = await chatCompletion({ baseURL: account.baseURL, apiKey: account.key, body: pinned, signal, timeoutMs })
    let payload = unwrapEnvelope(result.json)
    let failed = result.ok !== true || (payload?.error !== undefined && payload?.choices === undefined)
    let note = ''
    // This endpoint refuses a non-streaming call while streaming the same
    // request happily, so answer it over the stream rather than reporting a
    // failure the upstream does not really mean.
    if (failed && /empty response content/i.test(errorText(payload?.error) || result.text)) {
      const collected = await collectCompletion({ baseURL: account.baseURL, apiKey: account.key, body: pinned, signal, timeoutMs })
      if (collected !== null && collected.ok === true) {
        result = collected
        payload = collected.json
        failed = false
        note = 'assembled from the upstream stream'
      }
    }
    const routing = failed ? {} : parseRouting(payload)
    return {
      attempt,
      account,
      status: failed ? (payload?.error === undefined ? result.status : 502) : 200,
      // The transport's own status, kept apart from `status` because the
      // account pool benches on 401/429 - and an upstream business error arrives
      // as a 200 with an `error` payload, which must not look like success.
      httpStatus: result.status,
      ok: !failed,
      json: payload,
      text: result.text,
      ms: Date.now() - started,
      note,
      routing,
      // A 200 says the gateway answered. It does not say the pin was applied,
      // and the router drops an unusable `only` without complaining.
      adherence: failed ? null : pinAdherence(attempt, routing),
      warnings: pinWarnings(attempt, meta),
      error: failed ? errorText(payload?.error) || result.text.slice(0, 400) || `HTTP ${result.status}` : '',
    }
  }

  /**
   * Run one model's ordered candidate chain until an attempt is both answered
   * and served by the channel the pin asked for.
   *
   * This is the diagnostic path, so it keeps looking past a candidate the
   * router quietly ignored: "the gateway said yes to someone else" is a failure
   * to find out, not an answer.
   */
  async function runChain(model, body, pinConfig, { signal, timeoutMs } = {}) {
    const trace = []
    let last = null
    for (const attempt of buildAttempts(pinConfig)) {
      const outcome = await attemptChat(model, body, attempt, { signal, timeoutMs })
      const honored = outcome.ok && isAdherenceOk(outcome.adherence)
      const note = !outcome.ok
        ? outcome.error
        : honored
          ? 'ok'
          : `pin not adopted: served by ${outcome.routing?.finalProvider ?? '(unknown)'}`
      trace.push({ upstream: attempt.upstream ?? '(auto)', status: outcome.status, ms: outcome.ms, note: String(note).slice(0, 160) })
      last = outcome
      if (honored) return { ok: true, result: outcome, trace, error: '', warnings: outcome.warnings }
      if (!outcome.ok) {
        if (attempt.upstream !== null && outcome.error !== '') store.learnUpstream(model, attempt.upstream, classifyUpstreamError(outcome.error), outcome.error, outcome.ms)
        if (attempt.upstream === null && (attempt.excludeList ?? []).length > 0 && outcome.error !== '') learnFromError(model, outcome.error)
      }
    }
    const error = last === null
      ? 'no candidate succeeded'
      : last.ok !== true
        ? last.error
        : last.adherence === 'violated'
          ? `an excluded channel served the request: ${last.routing?.finalProvider ?? '(unknown)'}`
          : `the gateway ignored the pin: served by ${last.routing?.finalProvider ?? '(unknown)'}`
    return { ok: false, result: last, trace, error, warnings: last?.warnings ?? [] }
  }

  /**
   * Harvest one pipeline's exact channel list by pinning a channel that cannot
   * exist: the router fails before spending a token and names every provider it
   * could have used.
   */
  async function harvest(model, pipeline, account, { signal, timeoutMs = probeTimeoutMs } = {}) {
    const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
    const body = pipeline === 'planner' ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } } : { ...base, provider: { only: ['__probe__'] } }
    try {
      const result = await chatCompletion({ baseURL: account.baseURL, apiKey: account.key, body, signal, timeoutMs })
      const payload = unwrapEnvelope(result.json)
      const message = errorText(payload?.error) || result.text
      return extractAvailableProviders(message, pipeline)
    } catch {
      return null
    }
  }

  /**
   * Probe one model: detect its pipeline, read back the upstream that served
   * it, and harvest the channel list each pipeline publishes.
   */
  async function probe(model, { signal, timeoutMs = attemptTimeoutMs } = {}) {
    const account = await resolveAccount()
    const started = Date.now()
    const result = await chatCompletion({
      baseURL: account.baseURL,
      apiKey: account.key,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      signal,
      timeoutMs,
    })
    const payload = unwrapEnvelope(result.json)
    const ms = Date.now() - started
    if (payload?.error !== undefined && payload?.choices === undefined) {
      const message = errorText(payload.error)
      store.learn(model, { ok: false, lastError: message, lastMs: ms })
      return { ok: false, ms, model, error: message }
    }
    const routing = parseRouting(payload)
    const pipeline = routing.pipeline
    const otherPipeline = pipeline === 'planner' ? 'direct' : pipeline === 'direct' ? 'planner' : null
    const harvested = pipeline === null ? null : await harvest(model, pipeline, account, { signal, timeoutMs: probeTimeoutMs })
    const otherHarvested = otherPipeline === null ? null : await harvest(model, otherPipeline, account, { signal, timeoutMs: probeTimeoutMs })
    const previous = store.metaOf(model)
    const discovered = pipeline === 'planner' ? mergeUpstreams(harvested, routing.fallbacks) : mergeUpstreams(routing.fallbacks, harvested)
    // The channel that just served the probe is a real channel whether or not
    // the router's own list mentions it, and it is the highest-confidence entry
    // there is - so it goes first, where a list bound cannot reach it.
    const servedRaw = typeof routing.finalProvider === 'string' && routing.finalProvider.length > 0 ? routing.finalProvider : null
    const served = servedRaw === null ? [] : [pipeline === null ? servedRaw : channelNameFor(servedRaw, pipeline)]
    const combined = mergeUpstreams(served, discovered, otherHarvested)
    // A probe that discovered nothing must not wipe what an earlier one found:
    // `validate` refuses to run without a list, and every allow-list is built
    // from it, so losing it silently disarms exclusions instead of failing.
    const upstreams = combined.length > 0 ? combined : Array.isArray(previous.upstreams) ? previous.upstreams : []
    const channels = { ...(previous.channels ?? {}) }
    if (pipeline !== null) {
      const scoped = mergeUpstreams(served, harvested)
      if (scoped.length > 0) channels[pipeline] = scoped
    }
    if (otherPipeline !== null && Array.isArray(otherHarvested) && otherHarvested.length > 0) channels[otherPipeline] = otherHarvested
    const meta = store.learn(model, {
      ok: true,
      pipeline,
      pinnable: pipeline !== null,
      availableProviders: harvested ?? previous.availableProviders ?? [],
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      upstreams,
      channels,
      staleAt: combined.length === 0 && upstreams.length > 0 ? Date.now() : 0,
      lastProvider: routing.finalProvider ?? previous.lastProvider ?? null,
      lastMs: ms,
      probedAt: Date.now(),
      lastError: '',
    })
    logger('probe complete', { model, pipeline, upstreams: upstreams.length, ms })
    return {
      ok: true,
      ms,
      model,
      error: '',
      pipeline: meta.pipeline,
      pinnable: meta.pinnable === true,
      canonicalSlug: meta.canonicalSlug ?? '',
      lastProvider: meta.lastProvider ?? '',
      upstreams: meta.upstreams ?? [],
      availableProviders: meta.availableProviders ?? [],
    }
  }

  /**
   * Test every known channel of a model once and record the verdicts.
   *
   * A channel counts as usable only when the response names it as the one that
   * served the request: any payload carrying `choices` used to be enough, which
   * marked every channel available while the pin was being ignored.
   */
  async function validate(model, { signal, timeoutMs = probeTimeoutMs, concurrency = VALIDATE_CONCURRENCY } = {}) {
    const meta = store.metaOf(model)
    const upstreams = Array.isArray(meta.upstreams) ? meta.upstreams : []
    if (upstreams.length === 0) {
      return { ok: false, model, error: 'no channel list yet - run cline_pass_probe for this model first', results: [], summary: { ok: 0, limited: 0, bad: 0, auth: 0, 'not-adopted': 0, unknown: 0 } }
    }
    const results = new Array(upstreams.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < upstreams.length) {
        const index = cursor++
        const upstream = upstreams[index]
        // A caller with a budget (the panel: 25s, the agent tools: 100s) may run
        // out while channels remain. Those are reported as untried instead of
        // being fired into an aborted signal, so the answer stays honest.
        if (signal?.aborted) {
          results[index] = { upstream, status: 'unknown', note: 'not tried: the caller ran out of time', ms: 0 }
          continue
        }
        const attempt = { upstream, strict: true, sort: null, excludeList: [], orderRest: [] }
        const started = Date.now()
        let status = 'unknown'
        let note = ''
        try {
          const outcome = await attemptChat(model, { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, attempt, { signal, timeoutMs })
          if (outcome.ok) {
            status = outcome.adherence === 'adopted' ? 'ok' : 'not-adopted'
            note = status === 'ok' ? 'answered by this channel' : `served by ${outcome.routing?.finalProvider ?? '(unknown)'}`
          } else {
            status = classifyUpstreamError(outcome.error)
            note = outcome.error
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          status = classifyUpstreamError(message)
          note = message
        }
        const ms = Date.now() - started
        store.learnUpstream(model, upstream, status, note, ms)
        results[index] = { upstream, status, note: String(note).slice(0, 200), ms }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, upstreams.length) }, worker))
    const summary = { ok: 0, limited: 0, bad: 0, auth: 0, 'not-adopted': 0, unknown: 0 }
    for (const entry of results) summary[entry.status] = (summary[entry.status] ?? 0) + 1
    logger('validate complete', { model, summary })
    return { ok: true, model, error: '', results, summary }
  }

  /** Send one real request through a model's configured chain and report the trace. */
  async function test(model, { upstreams, exclude, pinMode, sort, body, signal } = {}) {
    const configured = store.metaOf(model)
    const pinConfig = {
      upstreams: Array.isArray(upstreams) ? upstreams : Array.isArray(configured.pinnedUpstreams) ? configured.pinnedUpstreams : [],
      exclude: Array.isArray(exclude) ? exclude : [],
      pinMode: pinMode ?? 'strict',
      sort: sort ?? '',
    }
    const request = body ?? { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 64 }
    return await runChain(model, request, pinConfig, { signal })
  }

  /** Check one API key (and its base URL) with a single minimal request. */
  async function testAccount({ key, baseURL, model, signal, timeoutMs = probeTimeoutMs }) {
    const target = model ?? 'cline-pass/deepseek-v4.1-flash'
    try {
      const result = await chatCompletion({
        baseURL,
        apiKey: key,
        body: { model: target, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
        signal,
        timeoutMs,
      })
      const payload = unwrapEnvelope(result.json)
      const failed = result.ok !== true || (payload?.error !== undefined && payload?.choices === undefined)
      return { ok: !failed, status: result.status, model: target, error: failed ? errorText(payload?.error) || result.text.slice(0, 200) : '' }
    } catch (error) {
      return { ok: false, status: 0, model: target, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return { attemptChat, runChain, probe, harvest, validate, test, testAccount }
}

module.exports = { VALIDATE_CONCURRENCY, GatewayError, parseServerSentEvents, createEngine }
