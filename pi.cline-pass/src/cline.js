/**
 * Upstream transport for the Cline Pass gateway. Ported from `dsh-cline-pass`
 * 0.2.5-p3 (`lib/cline.js`, MIT), minus the DSH-specific catalog and usage scans.
 *
 * The upstream speaks plain OpenAI `/chat/completions`, so this layer stays a
 * thin fetch wrapper: one JSON request, one streaming request, no retries (the
 * caller owns candidate and account failover).
 *
 * @module pi.cline-pass/cline
 */
'use strict'

const VERSION = require('../manifest.json').version

/** A stable, honest identity for requests this gateway makes. */
function attributionHeaders() {
  return { 'user-agent': `pi-desktop-cline-pass/${VERSION}` }
}

/** Combine a caller signal with a hard deadline into one abortable signal. */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 60000))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Trim trailing slashes from a configured base URL. */
function trimBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/** The gateway's own chat-completions endpoint for one base URL. */
function chatURL(baseURL) {
  return `${trimBase(baseURL)}/chat/completions`
}

/**
 * Send one JSON request and decode whatever comes back.
 * @returns `{ status, ok, json, text }`; never throws for an HTTP error status.
 */
async function sendJSON(url, { method = 'GET', apiKey = '', body, signal, timeoutMs = 60000, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...attributionHeaders(),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: withTimeout(signal, timeoutMs),
  })
  const text = await response.text()
  let json = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

/** Send one chat completion, non-streaming. */
function chatCompletion(options) {
  const { baseURL, apiKey, body, signal, timeoutMs = 180000, headers = {} } = options
  return sendJSON(chatURL(baseURL), { method: 'POST', apiKey, body, signal, timeoutMs, headers })
}

/**
 * Open a streaming chat completion and hand back the live response.
 * @returns the raw `fetch` Response so the caller owns SSE iteration and abort.
 */
async function openChatStream({ baseURL, apiKey, body, signal, headers = {} }) {
  return await fetch(chatURL(baseURL), {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...attributionHeaders(),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Fetch the list of model ids one base URL publishes, when it publishes one.
 * @returns `{ ok, ids, status, error }`; never throws.
 */
async function fetchModelIds({ baseURL, apiKey, signal, timeoutMs = 20000 } = {}) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/models`, { apiKey, signal, timeoutMs })
    const payload = result.json
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
    const ids = list.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter((id) => typeof id === 'string' && id.length > 0)
    return { ok: result.ok && ids.length > 0, ids, status: result.status, error: result.ok ? '' : result.text.slice(0, 200) }
  } catch (error) {
    return { ok: false, ids: [], status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The authenticated sub-path that reports the account's quota windows. */
const USAGE_LIMITS_PATH = '/users/me/plan/usage-limits'
/** The authenticated sub-path naming the account a usage history belongs to. */
const PROFILE_PATH = '/users/me'
/** The authenticated sub-path carrying the account's plan and its caps. */
const PLAN_PATH = '/users/me/plan'

/** The gateway's own one-line explanation, when it sent one. */
function firstMessage(envelope) {
  const message = envelope?.error ?? envelope?.message ?? envelope?.error?.message
  return typeof message === 'string' ? message.slice(0, 200) : ''
}

/**
 * Read the account's official quota windows.
 *
 * Ported from `dsh-cline-pass` (`lib/cline.js`, MIT), which reads the same
 * endpoint: the gateway answers with
 * `{ success, data: { limits: [{ type, percentUsed, resetsAt }] } }`, where
 * `type` is `five_hour`, `weekly` or `monthly`. The list is passed through in
 * the order the gateway sent it, so a window Cline adds later arrives as an
 * extra row instead of needing a release of this plugin.
 *
 * A refusal is data, not an exception: the panel shows quota next to controls
 * that keep working without it.
 *
 * @returns `{ ok, limits, status, error }`.
 */
async function fetchUsageLimits({ baseURL, apiKey, signal, timeoutMs = 15000 } = {}) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}${USAGE_LIMITS_PATH}`, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      const detail = firstMessage(envelope) || result.text.slice(0, 120)
      return { ok: false, limits: [], status: result.status, error: `the quota endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    // The envelope wrapper is not contractual: read the payload whether the
    // gateway nests it under `data` or answers with the window list itself.
    const payload = envelope?.data ?? envelope
    const limits = (Array.isArray(payload?.limits) ? payload.limits : [])
      .map((limit) => {
        const row = { type: String(limit?.type ?? ''), resetsAt: String(limit?.resetsAt ?? '') }
        // A percentage the endpoint did not send is left out entirely rather than
        // defaulted to 0: `quota.js` reads an absent number as "unknown", while a
        // present 0 would be reported to the panel as an untouched window.
        if (limit?.percentUsed !== undefined && limit?.percentUsed !== null && limit?.percentUsed !== '') {
          row.percentUsed = limit.percentUsed
        }
        return row
      })
      .filter((limit) => limit.type.length > 0)
    return { ok: true, limits, status: result.status, error: firstMessage(envelope) || '' }
  } catch (error) {
    return { ok: false, limits: [], status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The account id behind a key; the per-account usage endpoints need it. */
async function fetchProfile({ baseURL, apiKey, signal, timeoutMs = 15000 } = {}) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}${PROFILE_PATH}`, { apiKey, signal, timeoutMs })
    const payload = result.json?.data ?? result.json
    const userId = String(payload?.id ?? payload?.userId ?? payload?.user?.id ?? '')
    return {
      ok: result.ok && userId.length > 0,
      userId,
      status: result.status,
      error: result.ok ? '' : firstMessage(result.json) || result.text.slice(0, 120),
    }
  } catch (error) {
    return { ok: false, userId: '', status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Official per-day, per-model usage for one range.
 *
 * This is the only complete reading that exists: the row-level history pages at
 * 200 rows, so a busy account's month cannot be walked row by row. Rows sum
 * along either axis, and the model is kept because "which model ate the window"
 * is the question one quota figure cannot answer.
 *
 * @returns `{ ok, rows, status, error }` with rows `{ date, model, tokens, costUsd }`.
 */
async function fetchDailyUsage({ baseURL, apiKey, userId, startDate, endDate, signal, timeoutMs = 30000 } = {}) {
  try {
    const query = `${trimBase(baseURL)}/users/${encodeURIComponent(String(userId ?? ''))}/usages/daily?startDate=${encodeURIComponent(String(startDate ?? ''))}&endDate=${encodeURIComponent(String(endDate ?? ''))}`
    const result = await sendJSON(query, { apiKey, signal, timeoutMs })
    if (!result.ok) {
      const detail = firstMessage(result.json) || result.text.slice(0, 120)
      return { ok: false, rows: [], status: result.status, error: `the usage endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    const payload = result.json?.data ?? result.json
    const rows = (Array.isArray(payload?.items) ? payload.items : []).map((row) => ({
      date: String(row?.date ?? ''),
      // `aiModelName` is the wire spelling; the type name is the fallback, so a
      // row still lands somewhere named rather than in an anonymous bucket.
      model: String(row?.aiModelName ?? row?.aiModelTypeName ?? ''),
      tokens: Number(row?.promptTokens ?? 0) + Number(row?.completionTokens ?? 0),
      costUsd: Number(row?.costUsd ?? 0),
    }))
    return { ok: true, rows, status: result.status, error: '' }
  } catch (error) {
    return { ok: false, rows: [], status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = {
  VERSION,
  attributionHeaders,
  withTimeout,
  trimBase,
  chatURL,
  sendJSON,
  chatCompletion,
  openChatStream,
  fetchModelIds,
  USAGE_LIMITS_PATH,
  PROFILE_PATH,
  PLAN_PATH,
  fetchUsageLimits,
  fetchProfile,
  fetchDailyUsage,
}
