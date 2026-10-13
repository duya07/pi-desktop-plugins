/**
 * The request ledger.
 *
 * A PI-Desktop plugin cannot ask the host what a session cost, and Cline Pass'
 * own API has no usage endpoint to read (checked against the ported DSH plugin
 * and the upstream catalog on 2026-10-13: there is no usage or credit surface).
 * What the gateway *does* see is the final `usage` block of every streamed
 * answer, including the cost fields. This module writes one JSON line per
 * completed request and answers aggregation questions over it, so "怎么花了这么多"
 * has an answer that comes from the wire rather than from an estimate.
 *
 * The ledger lives in the plugin's data directory next to `config.json`. It
 * holds token counts and cost, never prompts or keys. One rotation keeps the
 * file bounded: past `MAX_BYTES` it becomes `usage.1.jsonl` and the live file
 * starts over, so queries read at most two files.
 *
 * @module pi.cline-pass/usage
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Rotate the ledger once it grows past this. */
const MAX_BYTES = 2 * 1024 * 1024

/** Malformed lines are skipped, but a broken ledger must not hide itself. */
const MAX_SKIPPED_REPORTED = 5

/** Read one number out of a usage block, preferring the first spelling present. */
function numberFrom(source, keys) {
  if (!source || typeof source !== 'object') return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * Normalize the upstream `usage` block into the few numbers worth keeping.
 *
 * Upstream sends the OpenAI names (`prompt_tokens`, `completion_tokens`,
 * `total_tokens`) plus cache and cost detail; cost arrives either as `cost`,
 * `total_cost` or inside `cost_details.total`, so all three are accepted and
 * `null` means "the upstream did not say" rather than zero.
 */
function extractUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {}
  const details = usage.cost_details && typeof usage.cost_details === 'object' ? usage.cost_details : {}
  const promptTokens = numberFrom(usage, ['prompt_tokens', 'input_tokens'])
  const completionTokens = numberFrom(usage, ['completion_tokens', 'output_tokens'])
  const totalTokens = numberFrom(usage, ['total_tokens']) ?? (promptTokens === null && completionTokens === null ? null : (promptTokens ?? 0) + (completionTokens ?? 0))
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens: numberFrom(usage, ['cache_read_input_tokens', 'cached_tokens', 'prompt_cache_hit_tokens']),
    reasoningTokens: numberFrom(usage.completion_tokens_details, ['reasoning_tokens']) ?? numberFrom(usage, ['reasoning_tokens']),
    cost: numberFrom(usage, ['cost', 'total_cost']) ?? numberFrom(details, ['total']),
  }
}

/** Keep one ledger row to the fields the queries use; anything else is dropped. */
function normalizeRow(raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    ts: num(row.ts) ?? Date.now(),
    model: typeof row.model === 'string' ? row.model : '',
    upstream: typeof row.upstream === 'string' ? row.upstream : '',
    account: typeof row.account === 'string' ? row.account : '',
    status: num(row.status) ?? 0,
    ms: num(row.ms) ?? 0,
    stream: row.stream === true,
    promptTokens: num(row.promptTokens),
    completionTokens: num(row.completionTokens),
    totalTokens: num(row.totalTokens),
    cachedTokens: num(row.cachedTokens),
    reasoningTokens: num(row.reasoningTokens),
    cost: num(row.cost),
    note: typeof row.note === 'string' ? row.note.slice(0, 200) : '',
  }
}

/** The UTC day key one timestamp belongs to. */
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

/** Sum a list of nullable numbers, counting how many were actually known. */
function sum(values) {
  let total = 0
  let known = 0
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value
      known += 1
    }
  }
  return { total, known }
}

/**
 * The ledger: append one row per request, aggregate on demand.
 *
 * @param dataDir - the plugin's data directory (must exist).
 * @param logger - `(message, detail?) => void`.
 */
function createUsageLog({ dataDir, logger = () => {} } = {}) {
  const file = path.join(dataDir, 'usage.jsonl')
  const rotated = path.join(dataDir, 'usage.1.jsonl')

  /** Rotate before the file outgrows a read the panel wants to be instant. */
  function rotateIfNeeded() {
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size <= MAX_BYTES) return
      if (fs.existsSync(rotated)) fs.rmSync(rotated, { force: true })
      fs.renameSync(file, rotated)
    } catch (error) {
      logger('usage ledger rotation failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Append one completed request. Failures are recorded too: they cost time. */
  function record(entry) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      rotateIfNeeded()
      fs.appendFileSync(file, `${JSON.stringify(normalizeRow(entry))}\n`, { encoding: 'utf8' })
      return true
    } catch (error) {
      logger('usage ledger write failed', { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Every row, oldest file first, malformed lines counted rather than thrown. */
  function readAll() {
    const rows = []
    let skipped = 0
    for (const target of [rotated, file]) {
      if (!fs.existsSync(target)) continue
      let text = ''
      try {
        text = fs.readFileSync(target, 'utf8')
      } catch (error) {
        logger('usage ledger read failed', { file: target, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          rows.push(normalizeRow(JSON.parse(trimmed)))
        } catch {
          skipped += 1
        }
      }
    }
    if (skipped > 0) logger('usage ledger had unreadable lines', { skipped })
    return { rows, skipped }
  }

  /**
   * Aggregate the last `days` (or everything when `days <= 0`).
   *
   * Grouping is by model, day and account, because those are the three
   * questions worth asking: which model eats the quota, when, and under which
   * key.
   */
  function summary({ days = 7, now = Date.now() } = {}) {
    const { rows, skipped } = readAll()
    const since = days > 0 ? now - days * 24 * 60 * 60 * 1000 : 0
    const inWindow = rows.filter((row) => row.ts >= since)
    const group = (keyOf) => {
      const map = new Map()
      for (const row of inWindow) {
        const key = keyOf(row) || '(unknown)'
        const bucket = map.get(key) ?? { key, requests: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, costKnown: 0, ms: 0 }
        bucket.requests += 1
        if (row.status !== 200) bucket.failures += 1
        bucket.promptTokens += row.promptTokens ?? 0
        bucket.completionTokens += row.completionTokens ?? 0
        bucket.totalTokens += row.totalTokens ?? 0
        if (typeof row.cost === 'number') {
          bucket.cost += row.cost
          bucket.costKnown += 1
        }
        bucket.ms += row.ms
        map.set(key, bucket)
      }
      return [...map.values()].map((bucket) => ({
        ...bucket,
        cost: Number(bucket.cost.toFixed(6)),
        avgMs: bucket.requests > 0 ? Math.round(bucket.ms / bucket.requests) : 0,
        costKnown: `${bucket.costKnown}/${bucket.requests}`,
      }))
    }
    const cost = sum(inWindow.map((row) => row.cost))
    const ms = sum(inWindow.map((row) => row.ms))
    return {
      file,
      window: { days, since },
      rows: rows.length,
      rowsInWindow: inWindow.length,
      skipped,
      totals: {
        requests: inWindow.length,
        failures: inWindow.filter((row) => row.status !== 200).length,
        promptTokens: sum(inWindow.map((row) => row.promptTokens)).total,
        completionTokens: sum(inWindow.map((row) => row.completionTokens)).total,
        tokens: sum(inWindow.map((row) => row.totalTokens)).total,
        cost: Number(cost.total.toFixed(6)),
        costKnown: `${cost.known}/${inWindow.length}`,
        avgMs: inWindow.length > 0 ? Math.round(ms.total / inWindow.length) : 0,
        firstTs: inWindow.length > 0 ? inWindow[0].ts : 0,
        lastTs: inWindow.length > 0 ? inWindow[inWindow.length - 1].ts : 0,
      },
      byModel: group((row) => row.model).sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests),
      byUpstream: group((row) => row.upstream).sort((a, b) => b.requests - a.requests),
      byAccount: group((row) => row.account).sort((a, b) => b.requests - a.requests),
      byDay: group((row) => dayKey(row.ts)).sort((a, b) => (a.key < b.key ? 1 : -1)),
    }
  }

  /** The newest rows, optionally narrowed to one model. */
  function recent({ limit = 20, model = '' } = {}) {
    const { rows } = readAll()
    const needle = String(model ?? '').trim().toLowerCase()
    return rows
      .filter((row) => needle === '' || row.model.toLowerCase().includes(needle))
      .slice(-Math.max(1, Math.min(Number(limit) || 20, 200)))
      .reverse()
  }

  /** Drop the ledger (both generations). Only the panel asks for this. */
  function clear() {
    let removed = 0
    for (const target of [file, rotated]) {
      if (!fs.existsSync(target)) continue
      fs.rmSync(target, { force: true })
      removed += 1
    }
    logger('usage ledger cleared', { files: removed })
    return { ok: true, removed }
  }

  return { file, record, summary, recent, clear, readAll }
}

module.exports = { MAX_BYTES, MAX_SKIPPED_REPORTED, extractUsage, normalizeRow, dayKey, createUsageLog }
