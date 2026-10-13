/**
 * The official Cline Pass quota windows, normalized for the panel and the tools.
 *
 * This is the piece the first port dropped: `dsh-cline-pass` reads
 * `GET {baseURL}/users/me/plan/usage-limits` and shows the account's own
 * subscription windows (5-hour / weekly / monthly) with the percentage used and
 * a reset countdown. The local request ledger in `usage.js` answers a different
 * question - what this gateway spent - and neither replaces the other: the
 * ledger covers only traffic that went through the gateway, while the official
 * windows cover everything the account did anywhere.
 *
 * Nothing here invents a number. A window the gateway did not report is absent,
 * and a percentage it did not send is not turned into a guess.
 *
 * @module cline-pass/quota
 */
'use strict'

/** Display order for the windows Cline reports, and their labels. */
const WINDOW_ORDER = ['five_hour', 'weekly', 'monthly']

/** Chinese labels, matching the panel's language. */
/** Chinese labels, matching the DSH original (本周 / 本月) and the panel. */
const WINDOW_LABELS = { five_hour: '5 小时', weekly: '本周', monthly: '本月' }

/**
 * The three-step tone ramp a quota bar uses.
 *
 * Two thresholds, not a gradient: the panel's job is to answer "do I need to
 * change what I am doing", and that answer is a band, not a decimal.
 */
const TONE_THRESHOLDS = { warn: 70, bad: 90 }

/** A label for one window type, falling back to the raw type. */
function labelFor(type) {
  return WINDOW_LABELS[type] ?? String(type ?? '')
}

/** Which band one window's usage falls in: `good`, `warn` or `bad`. */
function toneFor(percentUsed) {
  const used = Number(percentUsed)
  if (!Number.isFinite(used)) return 'good'
  if (used >= TONE_THRESHOLDS.bad) return 'bad'
  if (used >= TONE_THRESHOLDS.warn) return 'warn'
  return 'good'
}

/**
 * A coarse, glanceable countdown.
 *
 * Coarse on purpose: a quota reset is read at a glance, and seconds of
 * precision would only make the panel churn.
 */
function resetText(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) return ''
  if (value <= 0) return '已重置'
  const days = Math.floor(value / 86400000)
  const hours = Math.floor((value % 86400000) / 3600000)
  const minutes = Math.floor((value % 3600000) / 60000)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分`
}

/** Clamp a percentage into 0..100, or null when it is not a number. */
function clampPercent(value) {
  // `null` and `''` are "not reported", not zero: `Number(null)` is 0, so the
  // guard has to come before the coercion or a missing percentage reads as 0%.
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(100, Math.max(0, number))
}

/**
 * One window as the panel shows it.
 *
 * @param limit - `{ type, percentUsed, resetsAt }` as the gateway sent it.
 * @param now - the reference time for the countdown.
 */
function normalizeLimit(limit, now = Date.now()) {
  const type = String(limit?.type ?? '')
  const percentUsed = clampPercent(limit?.percentUsed)
  const resetsAt = String(limit?.resetsAt ?? '')
  const resetAtMs = resetsAt === '' ? null : Date.parse(resetsAt)
  const resetInMs = resetAtMs === null || Number.isNaN(resetAtMs) ? null : Math.max(0, resetAtMs - now)
  return {
    type,
    label: labelFor(type),
    // `percentUsed` stays null when the gateway did not send a usable number:
    // the panel shows "—" rather than claiming 0% used.
    percentUsed,
    percentRemaining: percentUsed === null ? null : Number((100 - percentUsed).toFixed(1)),
    tone: toneFor(percentUsed),
    resetsAt,
    resetInMs,
    resetText: resetInMs === null ? '' : resetText(resetInMs),
  }
}

/**
 * Every window, in the panel's display order.
 *
 * A window Cline adds later is appended after the known ones rather than
 * dropped: the list is not a fixed shape, and the endpoint is the source of
 * truth about which windows exist.
 */
function summarizeLimits(limits, now = Date.now()) {
  const normalized = (Array.isArray(limits) ? limits : []).map((limit) => normalizeLimit(limit, now)).filter((limit) => limit.type.length > 0)
  const rank = (limit) => {
    const index = WINDOW_ORDER.indexOf(limit.type)
    return index < 0 ? WINDOW_ORDER.length : index
  }
  return normalized.sort((a, b) => rank(a) - rank(b))
}

/** One line per account, for the tools: windows plus the worst tone. */
function summarizeAccount(account) {
  const limits = Array.isArray(account?.limits) ? account.limits : []
  const worst = limits.reduce((tone, limit) => {
    const order = ['good', 'warn', 'bad']
    return order.indexOf(limit.tone) > order.indexOf(tone) ? limit.tone : tone
  }, 'good')
  return {
    name: String(account?.name ?? ''),
    displayName: String(account?.displayName ?? '') || String(account?.name ?? ''),
    keyHint: String(account?.keyHint ?? ''),
    duplicate: account?.duplicate === true,
    source: account?.source === 'host' ? 'host' : 'inline',
    ok: account?.ok === true,
    error: String(account?.error ?? ''),
    tone: limits.length === 0 ? 'unknown' : worst,
    limits,
  }
}

module.exports = { WINDOW_ORDER, WINDOW_LABELS, TONE_THRESHOLDS, labelFor, toneFor, resetText, clampPercent, normalizeLimit, summarizeLimits, summarizeAccount }
