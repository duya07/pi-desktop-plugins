/**
 * Self-test for the cline-pass gateway. Runs on plain Node (>=20.3), with no
 * PI-Desktop host involved: a local mock upstream stands in for Cline Pass, and
 * the gateway is driven over real HTTP on a random loopback port.
 *
 *   node --test test/
 *
 * @module cline-pass/test
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createConfig } = require('../src/config.js')
const configModule = require('../src/config.js')
const { createGateway } = require('../src/gateway.js')
const gatewayModule = require('../src/gateway.js')
const protocol = require('../src/protocol.js')
const catalog = require('../src/catalog.js')
const manifest = require('../manifest.json')
const modelRegistry = require('../src/models.js')
const usageLog = require('../src/usage.js')
const mainModule = require('../main.js')

const MODEL = 'cline-pass/deepseek-v4.1-flash'

/** The channels the mock router claims to offer. */
const CHANNELS = ['alpha', 'beta']

/**
 * A stand-in for api.cline.bot: OpenAI-compatible chat completions, an SSE
 * stream, a per-key failure switch, and the `__probe__` routing error that the
 * real gateway answers a harvest with.
 */
function startMockUpstream() {
  const state = { requests: [], forKey: new Map(), jsonRefused: false, refuseShape: 'content', streamRouting: '', quotaMode: 'ok', quotaCalls: 0, quotaKeys: [] }
  // `jsonRefused` is the real-world quirk: a non-streaming call is refused while
  // the identical request streams fine. `refuseShape` picks what that refusal
  // looks like - `'content'` is api.cline.bot's own body, `'empty'` a bodyless
  // 500 (what a proxy's error page leaves behind) and `'detail'` a 502 whose
  // JSON carries no `error` key at all. `streamRouting` picks which pipeline the
  // stream frames imitate: `''` keeps the frame-root `provider_metadata`,
  // `'planner'` nests the route under `choices[0].delta.provider_metadata`, and
  // `'direct'` puts a bare root-level `provider` on the frame.
  const server = http.createServer((req, res) => {
    if (req.url.includes('/users/me/plan/usage-limits')) {
      state.quotaCalls += 1
      state.quotaKeys.push(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
      if (state.quotaMode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unauthorized: invalid api key' } }))
        return
      }
      if (state.quotaMode === 'boom') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'the quota service is having a moment' }))
        return
      }
      const limits =
        state.quotaMode === 'empty'
          ? []
          : state.quotaMode === 'partial'
            ? [
                // A window Cline reported without a percentage: the panel has to
                // say "unknown" rather than claim the window is untouched.
                { type: 'five_hour' },
                { type: 'weekly', percentUsed: 40 },
              ]
            : [
                { type: 'five_hour', percentUsed: 12.5, resetsAt: new Date(Date.now() + 3600000).toISOString() },
                { type: 'weekly', percentUsed: 72, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() },
                { type: 'monthly', percentUsed: 95, resetsAt: new Date(Date.now() + 20 * 86400000).toISOString() },
              ]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { limits } }))
      return
    }
    if (!req.url.endsWith('/chat/completions') || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        body = {}
      }
      const key = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      state.requests.push({ key, body })
      const mode = state.forKey.get(key) ?? 'ok'
      if (mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unauthorized: invalid api key' } }))
        return
      }
      if (mode === 'rate') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'rate limited, try again later' } }))
        return
      }
      const pinned = body?.provider?.only?.[0] ?? body?.providerOptions?.gateway?.only?.[0] ?? null
      if (pinned === '__probe__') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              message: `Available providers are: ${CHANNELS.join(', ')}. {"error":{"metadata":{"available_providers":["alpha","beta"]}}}`,
            },
          }),
        )
        return
      }
      const served = pinned ?? CHANNELS[0]
      // Mode for the real-world quirk: api.cline.bot answers stream:false with
      // HTTP 500 {"error":"empty response content"} while streaming the same
      // request perfectly, so the gateway has to assemble JSON from the stream.
      if (state.jsonRefused && body.stream !== true) {
        if (state.refuseShape === 'empty') {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end()
          return
        }
        if (state.refuseShape === 'detail') {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ detail: 'upstream down' }))
          return
        }
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'empty response content', success: false }))
        return
      }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (state.jsonRefused) {
          res.write(`data: ${JSON.stringify({ id: 'chunk-0', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { reasoning: 'think' } }] })}\n\n`)
        }
        // Where a frame reports its route depends on the pipeline, and the two
        // spellings are not interchangeable: the planner nests it under the
        // delta, while the direct pipeline puts a bare `provider` on the frame.
        const route =
          state.streamRouting === 'planner'
            ? {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      content: 'Hello',
                      provider_metadata: { gateway: { routing: { finalProvider: 'openrouter', canonicalSlug: 'openrouter/anthropic/claude-sonnet-4.5' } } },
                    },
                  },
                ],
              }
            : state.streamRouting === 'direct'
              ? { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }], provider: 'deepseek' }
              : { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }], provider_metadata: { gateway: { routing: { finalProvider: served } } } }
        res.write(
          `data: ${JSON.stringify({
            id: 'chunk-1',
            object: 'chat.completion.chunk',
            model: body.model,
            ...route,
          })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({
            id: 'chunk-2',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
            usage: { total_tokens: 7 },
          })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          model: body.model,
          provider: served,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { total_tokens: 3 },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}/api/v1` })
    })
  })
}

const mock = await startMockUpstream()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piclinepass-test-'))
const configStore = createConfig({ dataDir })
configStore.update({
  baseUrl: mock.baseUrl,
  accountMode: 'roundrobin',
  accounts: [
    { name: 'host', displayName: 'host', source: 'host', enabled: true },
    { name: 'a1', displayName: 'a1', source: 'inline', key: 'key-a1', enabled: true },
    { name: 'a2', displayName: 'a2', source: 'inline', key: 'key-a2', enabled: true },
  ],
})
const gateway = createGateway({ configStore, portOverride: 0 })
await gateway.start()
const base = `http://127.0.0.1:${gateway.port}`

test.after(async () => {
  await gateway.stop()
  await new Promise((resolve) => mock.server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** One chat request against the gateway, as the host would send it. */
function chat(body, { key = 'host-key', stream = false } = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream, ...body }),
  })
}

/** One raw GET, so a test can forge a Host header (fetch refuses to). */
function rawStatus(pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: gateway.port, path: pathname, method: 'GET', headers }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
}

test('manifest, catalog and entry point agree with each other', () => {
  // No provider declaration at all. The plugin used to declare one (with an empty
  // model list, so the settings page carried a row with 0 models beside the
  // provider the user imports); `contributes.providers` is gone now, and
  // `provider.register` with it. The host drops the leftover row on its next sync
  // of this plugin.
  assert.equal(manifest.contributes.providers, undefined, 'the manifest must not declare a provider any more')
  assert.equal(
    manifest.permissions.includes('provider.register'),
    false,
    'a manifest that declares no provider does not need provider.register',
  )
  // The address the host has to reach is spelled once, in src/protocol.js, and the
  // generated config is the only place the host ever learns it.
  assert.equal(protocol.GATEWAY_PORT, 41593)
  assert.equal(protocol.GATEWAY_BASE_URL, 'http://127.0.0.1:41593/v1')
  assert.equal(gatewayModule.LISTEN_PORT, protocol.GATEWAY_PORT, 'the gateway binds that same port')
  assert.equal(
    modelRegistry.importConfigPayload().providers[modelRegistry.IMPORT_PROVIDER_ID].baseUrl,
    protocol.GATEWAY_BASE_URL,
    'the generated config must point at the gateway',
  )
  // The catalog still holds every model Cline publishes; the generated config
  // carries the ones the user ticked, which start out as the five defaults.
  const shipped = Object.keys(catalog.MODEL_CATALOG).sort()
  assert.equal(shipped.length, 14)
  const defaults = modelRegistry.effectiveModels({})
  assert.equal(defaults.length, shipped.length)
  assert.deepEqual(defaults.map((model) => model.id).sort(), shipped)
  const generated = modelRegistry.importConfigPayload()
  const entries = generated.providers[modelRegistry.IMPORT_PROVIDER_ID].models
  const carried = entries.map((model) => model.id)
  // The generated ids are re-spelled (`cline-pass-local/x`); the catalog behind them
  // is what has to line up.
  const carriedCatalog = carried.map((id) => modelRegistry.unimportModelId(id))
  for (const id of carriedCatalog) assert.ok(shipped.includes(id), `the generated config carries ${id}, which the catalog does not ship`)
  assert.deepEqual([...carriedCatalog].sort(), [...catalog.DEFAULT_REGISTERED].sort())
  assert.deepEqual([...carriedCatalog].sort(), defaults.filter((model) => model.registered).map((model) => model.id).sort())
  // Three counts have to be the same number: what the generated config carries,
  // what the registry ticks by default, and what the catalog marks as default.
  assert.equal(carried.length, 5)
  assert.equal(carried.length, catalog.DEFAULT_REGISTERED.length)
  assert.equal(carried.length, defaults.filter((model) => model.registered).length)
  for (const entry of entries) {
    const published = catalog.MODEL_CATALOG[modelRegistry.unimportModelId(entry.id)]
    const effective = defaults.find((candidate) => candidate.id === modelRegistry.unimportModelId(entry.id))
    // The generated entry carries the effective values under the *host's* field
    // names - and they are the published numbers, not a mis-merged copy of them.
    assert.equal(entry.name, effective.name, `${entry.id} name`)
    assert.deepEqual(entry.limit, { context: effective.contextWindow, output: effective.maxTokens }, `${entry.id} limit`)
    assert.equal(entry.reasoning, effective.thinkingLevels.length > 1, `${entry.id} reasoning`)
    assert.deepEqual(entry.input, effective.supportsImages ? ['text', 'image'] : ['text'], `${entry.id} input`)
    assert.equal(entry.limit.context, published.contextWindow, `${entry.id} published contextWindow`)
    assert.equal(entry.limit.output, published.maxTokens, `${entry.id} published maxTokens`)
    assert.equal(entry.reasoning, catalog.thinkingLevelsFor(published).length > 1, `${entry.id} published thinkingLevels`)
  }
  assert.equal(entries.length <= 64, true)
  const toolNames = manifest.contributes.agentTools.map((tool) => tool.name).sort()
  assert.deepEqual(
    toolNames,
    [...mainModule.TOOL_NAMES].sort(),
    `the manifest must declare every tool main.js registers: manifest=[${toolNames.join(', ')}] main=[${[...mainModule.TOOL_NAMES].sort().join(', ')}]`,
  )
  assert.equal(typeof mainModule.onLoad, 'function')
  assert.equal(typeof mainModule.onPanelInvoke, 'function')
  for (const permission of ['background.service', 'agent.tool.register', 'ui.panel']) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`)
  }
  assert.ok(manifest.activationEvents.includes('onStartup'))
})

test('a localized object only appears where the host resolves i18n', () => {
  // The host resolves i18n for a handful of manifest fields and renders the rest
  // verbatim. A `{ en, zh-CN }` object handed to a field that is rendered as
  // text reaches React as a child and takes the whole app down - that is exactly
  // what happened with `contributes.services[].label` (minified React error #31,
  // "object with keys {en, zh-CN}"). So the object form is allowed only where a
  // shipped plugin demonstrates it: the `i18n` block itself, and `ui.title`.
  // Everywhere else the value must be a plain string.
  const LOCALES = ['en', 'zh-CN']
  const allowed = new Set(['i18n', 'ui.title'])
  const offenders = []
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (!value || typeof value !== 'object') return
    const keys = Object.keys(value)
    if (keys.length > 0 && keys.every((key) => LOCALES.includes(key)) && !allowed.has(path)) offenders.push(path)
    for (const [key, entry] of Object.entries(value)) walk(entry, path === '' ? key : `${path}.${key}`)
  }
  walk(manifest, '')
  assert.deepEqual(offenders, [], `localized objects outside an i18n-resolved field: ${offenders.join(', ')}`)
  // The fields that are rendered as plain text, spelled out so a future edit
  // cannot quietly put an object back.
  assert.equal(typeof manifest.contributes.services[0].label, 'string')
  assert.equal(manifest.contributes.providers, undefined, 'no provider row is rendered any more')
  for (const command of manifest.contributes.commands) assert.equal(typeof command.title, 'string', `command ${command.id}`)
  for (const tool of manifest.contributes.agentTools) assert.equal(typeof tool.description, 'string', `tool ${tool.name}`)
})

test('protocol writes a strict pin in both pipeline spellings', () => {
  const attempt = { upstream: 'zai', strict: true, sort: null, excludeList: [], orderRest: [] }
  const body = protocol.injectPrefs({ model: MODEL }, { upstreams: ['zai'] }, attempt)
  assert.deepEqual(body.provider.only, ['z-ai'])
  assert.deepEqual(body.providerOptions.gateway.only, ['zai'])
})

test('protocol expands a pin list into ordered failover candidates', () => {
  const attempts = protocol.buildAttempts({ upstreams: ['alpha', 'beta', 'gamma'], exclude: ['beta'], pinMode: 'strict' })
  assert.deepEqual(attempts.map((entry) => entry.upstream), ['alpha', 'gamma'])
  const preferred = protocol.buildAttempts({ upstreams: ['alpha', 'gamma'], pinMode: 'preferred' })
  assert.deepEqual(preferred[0].orderRest, ['gamma'])
  const manual = protocol.buildAttempts({ upstreams: [], exclude: ['alpha'] })
  assert.equal(manual.length, 1)
  assert.equal(manual[0].upstream, null)
  assert.deepEqual(manual[0].excludeList, ['alpha'])
})

test('protocol reads pin adherence from the served channel', () => {
  assert.equal(protocol.pinAdherence({ upstream: 'alpha' }, { finalProvider: 'alpha' }), 'adopted')
  assert.equal(protocol.pinAdherence({ upstream: 'alpha', orderRest: ['beta'] }, { finalProvider: 'beta' }), 'fallback')
  assert.equal(protocol.pinAdherence({ upstream: 'alpha' }, { finalProvider: 'beta' }), 'not-adopted')
  assert.equal(protocol.pinAdherence({ upstream: 'alpha', excludeList: ['beta'] }, { finalProvider: 'beta' }), 'violated')
  assert.equal(protocol.pinAdherence({ upstream: null }, { finalProvider: 'beta' }), 'unresolved')
})

test('gateway serves the model list and rejects foreign hosts', async () => {
  const response = await fetch(`${base}/v1/models`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.object, 'list')
  assert.equal(payload.data.length, Object.keys(catalog.MODEL_CATALOG).length)
  assert.equal(payload.data.length, 14)
  // The registered flag is what tells a client (and the test) which of the 14
  // models the generated config carries - the ones the user ticked.
  const registered = payload.data.filter((row) => row.registered)
  assert.equal(registered.length, 5)
  assert.deepEqual(registered.map((row) => row.id).sort(), [...catalog.DEFAULT_REGISTERED].sort())
  const flash = payload.data.find((row) => row.id === MODEL)
  assert.equal(flash.object, 'model')
  assert.equal(flash.owned_by, 'cline-pass')
  assert.equal(flash.name, 'DeepSeek V4.1 Flash')
  assert.equal(flash.context_window, 1000000)
  assert.equal(flash.max_tokens, 384000)
  assert.deepEqual(flash.capabilities, ['text', 'image'])
  assert.equal(flash.thinking, 'effort')
  const minimax = payload.data.find((row) => row.id === 'cline-pass/minimax-m3')
  assert.equal(minimax.thinking, 'toggle')
  assert.equal(minimax.registered, true)
  const unticked = payload.data.find((row) => row.id === 'cline-pass/qwen3.8-max')
  assert.equal(unticked.context_window, 1000000)
  assert.equal(unticked.max_tokens, 131072)
  assert.equal(unticked.registered, false, 'only the ticked models are in the generated config')
  assert.equal(await rawStatus('/v1/models', { host: 'evil.example' }), 403)
  assert.equal(await rawStatus('/v1/models', { host: `127.0.0.1:${gateway.port}` }), 200)
})

test('gateway streams an OpenAI SSE answer and records the request', async () => {
  mock.state.forKey.clear()
  const response = await chat({}, { stream: true })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await response.text()
  assert.match(text, /"content":"Hello"/)
  assert.match(text, /"content":" world"/)
  assert.match(text, /data: \[DONE\]/)
  assert.ok(text.indexOf('[DONE]') > text.indexOf('"content":"Hello"'))
  const history = gateway.ops.history({ limit: 3 })
  assert.ok(history.rows.length >= 1)
  assert.equal(history.rows[0].status, 200)
  assert.equal(history.rows[0].upstream, 'alpha')
  assert.equal(history.rows[0].model, MODEL)
})

test('gateway answers a non-streaming request with OpenAI JSON', async () => {
  mock.state.forKey.clear()
  const response = await chat({ stream: false })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.choices[0].message.content, 'OK')
  assert.equal(payload.model, MODEL)
})

test('gateway fails over across accounts and benches the failed ones', async () => {
  // The pool is stateful - round-robin position, cooldowns and the host key all
  // outlive a single test - so this one starts from a known pool: host-key is
  // rejected, the first inline key is rate limited, and only the second answers.
  mock.state.forKey.clear()
  await gateway.ops.accounts({ action: 'resetCooldowns' })
  mock.state.forKey.set('host-key', 'auth')
  mock.state.forKey.set('key-a1', 'rate')
  const response = await chat({}, { key: 'host-key' })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.choices[0].message.content, 'OK')
  assert.equal(mock.state.requests.at(-1).key, 'key-a2')
  const accounts = gateway.ops.status().accounts
  assert.equal(accounts.find((entry) => entry.name === 'host').cooling, true)
  assert.equal(accounts.find((entry) => entry.name === 'a1').cooling, true)
  assert.equal(accounts.find((entry) => entry.name === 'a2').cooling, false)
  await gateway.ops.accounts({ action: 'resetCooldowns' })
  mock.state.forKey.clear()
})

test('gateway injects the configured pin into the upstream request', async () => {
  gateway.ops.pin({ model: MODEL, upstreams: ['beta'], pinMode: 'strict' })
  mock.state.requests.length = 0
  const response = await chat({}, { stream: true })
  assert.equal(response.status, 200)
  await response.text()
  const sent = mock.state.requests.at(-1)
  assert.deepEqual(sent.body.provider.only, ['beta'])
  assert.deepEqual(sent.body.providerOptions.gateway.only, ['beta'])
  const history = gateway.ops.history({ limit: 1 })
  assert.equal(history.rows[0].upstream, 'beta')
  gateway.ops.clearPin({ model: MODEL })
})

test('gateway clamps the host thinking level onto the model the request names', async () => {
  mock.state.requests.length = 0
  // The model under test publishes low/high/max only, so a host level it never
  // advertised is clamped to the nearest published one; a tie goes to the
  // cheaper side (high before max for `xhigh`).
  await (await chat({ stream: false, reasoning_effort: 'xhigh' })).json()
  assert.equal(mock.state.requests.at(-1).body.reasoning_effort, 'high')
  await (await chat({ stream: false, reasoning_effort: 'minimal' })).json()
  assert.equal(mock.state.requests.at(-1).body.reasoning_effort, 'low')
  await (await chat({ stream: false, reasoning_effort: 'max' })).json()
  assert.equal(mock.state.requests.at(-1).body.reasoning_effort, 'max')
  // `off` is "no field at all": the upstream default is the honest reading of it.
  await (await chat({ stream: false, reasoning_effort: 'off' })).json()
  assert.equal('reasoning_effort' in mock.state.requests.at(-1).body, false)
  // A level nobody published is not invented either.
  await (await chat({ stream: false, reasoning_effort: 'bogus' })).json()
  assert.equal('reasoning_effort' in mock.state.requests.at(-1).body, false)
  // A model whose control is just an on/off switch never gets an effort string.
  await (await chat({ stream: false, model: 'cline-pass/minimax-m3', reasoning_effort: 'high' })).json()
  assert.equal(mock.state.requests.at(-1).body.model, 'cline-pass/minimax-m3')
  assert.equal('reasoning_effort' in mock.state.requests.at(-1).body, false)
  assert.equal('reasoningEffort' in mock.state.requests.at(-1).body, false)
})

test('the imported config spelling routes back to the catalog model', async () => {
  // The generated config spells model ids `cline-pass-local/x`. Why: the host's
  // delegation catalog keys a model as `<vendorKey>/<modelId>`, and every provider
  // the user builds is `custom` - so an imported model carrying the same id as one
  // already served by a provider pointed straight at Cline (`api.cline.bot`) would
  // collide, and a subagent asking for that key can be served by the other provider
  // instead (measured: the request never reached this gateway at all). A distinct
  // spelling is the only thing the plugin can control - the provider's own name
  // never appears in that key. The gateway must therefore accept its own imported
  // spelling and route it back to the catalog id.
  mock.state.requests.length = 0
  const response = await chat({ stream: false, model: 'cline-pass-local/deepseek-v4.1-flash' })
  assert.equal(response.status, 200)
  assert.equal(mock.state.requests.at(-1).body.model, 'cline-pass/deepseek-v4.1-flash')
  // The ledger keeps the canonical id, so one model stays one bucket no matter
  // which spelling the caller used.
  assert.equal(gateway.ops.history({ limit: 1 }).rows[0].model, 'cline-pass/deepseek-v4.1-flash')
  // A pin configured on the catalog id still applies to the imported spelling.
  gateway.ops.pin({ model: 'cline-pass/deepseek-v4.1-flash', upstreams: ['beta'], pinMode: 'strict' })
  mock.state.requests.length = 0
  await (await chat({ stream: false, model: 'cline-pass-local/deepseek-v4.1-flash' })).json()
  assert.deepEqual(mock.state.requests.at(-1).body.provider.only, ['beta'])
  gateway.ops.clearPin({ model: 'cline-pass/deepseek-v4.1-flash' })
  // A config generated before the prefix existed keeps working...
  mock.state.requests.length = 0
  await (await chat({ stream: false, model: 'cline-pass/deepseek-v4.1-flash' })).json()
  assert.equal(mock.state.requests.at(-1).body.model, 'cline-pass/deepseek-v4.1-flash')
  // ...and so does the host's own short spelling.
  mock.state.requests.length = 0
  await (await chat({ stream: false, model: 'deepseek-v4.1-flash' })).json()
  assert.equal(mock.state.requests.at(-1).body.model, 'cline-pass/deepseek-v4.1-flash')
  // An unknown id is still passed through untouched rather than mapped onto some
  // other model: a wrong model answering is worse than an upstream error.
  mock.state.requests.length = 0
  await (await chat({ stream: false, model: 'cline-pass-local/nope' })).json()
  assert.equal(mock.state.requests.at(-1).body.model, 'cline-pass-local/nope')
})

test('gateway refuses a request without any usable account', async () => {
  const saved = configStore.get().accounts
  configStore.update({ accounts: [{ name: 'host', displayName: 'host', source: 'host', enabled: false }] })
  const response = await chat({ stream: false }, { key: '' })
  assert.equal(response.status, 502)
  const payload = await response.json()
  assert.match(payload.error.message, /no usable account/i)
  configStore.update({ accounts: saved })
})

test("the host's no-auth placeholder never reaches the upstream", async () => {
  // A keyless plugin provider (`authKind: "none"`) still gets a bearer token
  // from the host - the literal string `pi-desktop-no-auth`. It is not a Cline
  // key: if the pool used it, the `host` account would look usable and every
  // request would spend one failed upstream call on it before failing over.
  const placeholder = configModule.HOST_NO_AUTH_KEY
  const saved = configStore.get().accounts
  mock.state.requests.length = 0
  configStore.update({ accounts: [{ name: 'host', displayName: 'host', source: 'host', enabled: true }] })
  const refused = await chat({ stream: false }, { key: placeholder })
  assert.equal(refused.status, 502, 'a placeholder-only pool has no usable account')
  assert.equal(mock.state.requests.length, 0, 'the placeholder must never be sent to Cline')

  // Beside a real inline account the request goes out on that account's key.
  configStore.update({
    accounts: [
      { name: 'host', displayName: 'host', source: 'host', enabled: true },
      { name: 'inline-one', displayName: 'one', source: 'inline', enabled: true, key: 'key-inline' },
    ],
  })
  const response = await chat({ stream: false }, { key: placeholder })
  assert.equal(response.status, 200)
  assert.equal(mock.state.requests.at(-1).key, 'key-inline')
  // The status the panel reads must agree: the host account has no key here.
  const host = gateway.ops.status(placeholder).accounts.find((entry) => entry.name === 'host')
  assert.equal(host.keyConfigured, false)
  assert.equal(host.keyHint, '')
  configStore.update({ accounts: saved })
})

test('probe harvests the channel list from the routing error', async () => {
  gateway.ops.clearPin({ model: 'cline-pass/glm-5.3' })
  const result = await gateway.ops.probe({ model: 'cline-pass/glm-5.3' })
  assert.equal(result.ok, true)
  assert.equal(result.pipeline, 'direct')
  for (const channel of CHANNELS) assert.ok(result.upstreams.includes(channel), `missing channel ${channel}`)
})

test('validate pins every discovered channel and records the verdicts', async () => {
  const result = await gateway.ops.validate({ model: 'cline-pass/glm-5.3' })
  assert.equal(result.ok, true)
  assert.ok(result.results.length >= CHANNELS.length)
  for (const entry of result.results) assert.equal(entry.status, 'ok', `${entry.upstream} => ${entry.status} (${entry.note})`)
  assert.equal(result.summary.ok, result.results.length)
})

test('test walks the pin chain and reports the trace', async () => {
  const result = await gateway.ops.test({ model: 'cline-pass/glm-5.3', upstreams: ['beta', 'alpha'], pinMode: 'strict' })
  assert.equal(result.ok, true)
  assert.equal(result.trace.length, 1)
  assert.equal(result.trace[0].upstream, 'beta')
  assert.equal(result.upstream, 'beta')
})

test('account CRUD keeps the host account and never leaks a key', async () => {
  const added = await gateway.ops.accounts({ action: 'add', name: 'backup', source: 'inline', key: 'key-backup' })
  assert.equal(added.ok, true)
  const entry = added.accounts.find((account) => account.name === 'backup')
  assert.equal(entry.keyConfigured, true)
  assert.ok(entry.keyHint.includes('*'), `expected a masked hint, got "${entry.keyHint}"`)
  assert.equal(JSON.stringify(added.accounts).includes('key-backup'), false)
  const removed = await gateway.ops.accounts({ action: 'remove', name: 'backup' })
  assert.equal(removed.ok, true)
  await assert.rejects(() => gateway.ops.accounts({ action: 'remove', name: 'host' }))
  await assert.rejects(() => gateway.ops.accounts({ action: 'add', name: 'x', source: 'inline' }))
})

test('the gateway port, status and settings stay consistent', () => {
  const status = gateway.ops.status()
  assert.equal(status.running, true)
  assert.equal(status.port, gateway.port)
  assert.equal(status.providerBaseUrl, `http://127.0.0.1:${gateway.port}/v1`)
  assert.equal(status.models.length, Object.keys(catalog.MODEL_CATALOG).length)
  assert.equal(status.models.length, 14)
  // status().models now carries the registry's view of each model: what the
  // catalog publishes, what the user overrode, and which lever it uses.
  const flash = status.models.find((model) => model.id === MODEL)
  assert.equal(flash.registered, true)
  assert.equal(flash.fallback, false)
  assert.equal(flash.lever, 'effort')
  assert.deepEqual(flash.thinkingLevels, ['off', 'low', 'high', 'max'])
  assert.equal(flash.defaultThinkingLevel, 'low')
  assert.equal(flash.supportsImages, true)
  assert.deepEqual(flash.edited, [])
  assert.deepEqual(flash.published, {
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    supportsImages: true,
    thinkingLevels: ['off', 'low', 'high', 'max'],
  })
  // The two older summaries the shipped panel already reads are still there.
  assert.equal(flash.reasoning, true)
  assert.deepEqual(flash.input, ['text', 'image'])
  assert.equal(status.models.filter((model) => model.registered).length, 5)
  const minimax = status.models.find((model) => model.id === 'cline-pass/minimax-m3')
  assert.equal(minimax.fallback, false)
  assert.equal(minimax.registered, true)
  assert.equal(minimax.lever, 'toggle')
  assert.deepEqual(minimax.thinkingLevels, ['off'], 'an on/off model only offers off to the host')
  assert.equal(minimax.reasoning, false)
  assert.deepEqual(minimax.input, ['text', 'image'])
  // No entry is a stand-in any more, so a model the user did not tick is simply
  // not part of the generated config.
  const unticked = status.models.find((model) => model.id === 'cline-pass/qwen3.8-max')
  assert.equal(unticked.fallback, false)
  assert.equal(unticked.registered, false)
  assert.equal(unticked.lever, 'effort')
  assert.deepEqual(unticked.thinkingLevels, ['off', 'low', 'medium', 'xhigh'])
  gateway.ops.setConfig({ streamIdleTimeoutMs: 123456 })
  assert.equal(configStore.get().streamIdleTimeoutMs, 123456)
  gateway.ops.setConfig({ streamIdleTimeoutMs: 300000 })
  const written = JSON.parse(fs.readFileSync(configStore.file, 'utf8'))
  assert.equal(written.streamIdleTimeoutMs, 300000)
})

test('panel and tool budgets stay inside the host timeouts', () => {
  // PI-Desktop 0.19.1 aborts a panel call after 30s and an agent tool after 110s
  // (PLUGIN_PANEL_TIMEOUT_MS / PLUGIN_TOOL_TIMEOUT_MS; a command gets 30s). The
  // plugin keeps its own budgets just inside those, so that a spend budget is
  // reported as a sentence instead of the host killing the call with nothing.
  const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  const rendererSource = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8')
  const panelBudget = Number(/const PANEL_BUDGET_MS = (\d+)/.exec(mainSource)?.[1])
  const toolBudget = Number(/const TOOL_BUDGET_MS = (\d+)/.exec(mainSource)?.[1])
  assert.equal(Number.isFinite(panelBudget) && panelBudget > 0 && panelBudget <= 30000, true, `panel budget ${panelBudget}`)
  assert.equal(Number.isFinite(toolBudget) && toolBudget > 0 && toolBudget <= 110000, true, `tool budget ${toolBudget}`)
  // Every panel call passes its own timeout as the second argument. The renderer
  // in this tree spells that `run(payload, ms)`; the rewritten panel adds a third
  // `quiet` flag, so both shapes are accepted - what matters is that no call site
  // asks for more than the budget main.js keeps.
  const asked = [
    ...rendererSource.matchAll(/run\(\s*\{[\s\S]*?\}\s*,\s*(\d+)/g),
    ...rendererSource.matchAll(/run\(\s*[A-Za-z_$][\w$.]*\s*,\s*(\d+)/g),
  ].map((match) => Number(match[1]))
  assert.ok(asked.length > 0, 'the panel should pass explicit timeouts')
  for (const ms of asked) assert.equal(ms <= panelBudget, true, `a panel action asks for ${ms}ms, over the ${panelBudget}ms budget`)
  // The account source that read environment variables is gone: the host starts a
  // plugin process with a minimal environment, so it could never have worked.
  const accounts = manifest.contributes.agentTools.find((tool) => tool.name === 'cline_pass_accounts')
  assert.deepEqual(accounts.schema.properties.source.enum, ['inline'])
  assert.equal(JSON.stringify(manifest).includes('apiKeyEnv'), false)
  assert.equal(/new-source|new-env/.test(rendererSource), false, 'the panel still references the removed fields')
})

test('progress goes to the plugin log, only failures reach stderr', () => {
  // The host files every stderr line as a `level:"error"` entry in its own
  // plugin log, so a chatty plugin looks broken. Measured on 0.19.1: ten
  // informational lines from this plugin were archived as errors while nothing
  // had failed. The plugin's own file still keeps every line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-log-'))
  const captured = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => {
    captured.push(String(chunk))
    return true
  }
  try {
    const write = mainModule.createLogger(dir)
    write('gateway ready on 127.0.0.1:41593', { port: 41593 })
    write('probe complete', { model: MODEL, upstreams: 18 })
    write('gateway did not start', { error: 'EADDRINUSE' })
    write('explicitly levelled warning', {}, 'warn')
  } finally {
    process.stderr.write = original
  }
  const text = fs.readFileSync(path.join(dir, 'gateway.log'), 'utf8')
  for (const needle of ['gateway ready', 'probe complete', 'did not start', 'levelled warning']) {
    assert.ok(text.includes(needle), `the file keeps every line: ${needle}`)
  }
  assert.equal(text.includes('[info] gateway ready'), true)
  assert.equal(text.includes('[error] gateway did not start'), true)
  assert.equal(captured.length, 2, `stderr should carry only the two failures, got ${captured.length}`)
  const forwarded = captured.join('')
  assert.ok(forwarded.includes('did not start'), 'the real failure must be forwarded')
  assert.ok(forwarded.includes('levelled warning'), 'an explicit level must be honoured')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a non-streaming call is assembled from the stream when the upstream refuses JSON', async () => {
  // Real behaviour of api.cline.bot (measured 2026-10-13): stream:false gets
  // HTTP 500 {"error":"empty response content"}, and the identical request as a
  // stream answers normally. The host's non-streaming calls (title generation,
  // agent.complete) must not fail because of it.
  mock.state.jsonRefused = true
  mock.state.forKey.clear()
  try {
    const response = await chat({ stream: false })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, 'Hello world')
    assert.equal(payload.choices[0].message.reasoning, 'think', 'the thinking field must survive the assembly')
    assert.equal(payload.usage.total_tokens, 7)
    const row = gateway.ops.history({ limit: 1 }).rows[0]
    assert.equal(row.note, 'assembled from the upstream stream')
    assert.equal(row.status, 200)
  } finally {
    mock.state.jsonRefused = false
  }
})

test("the panel's account test survives the upstream's JSON refusal", async () => {
  // The 测试 button and the probe go out over the same non-streaming path as
  // everything else, so they hit the same wall: HTTP 500 "empty response
  // content" for a request that streams perfectly. A false red mark on the
  // account row is worse than no button at all - the key is fine, the upstream
  // just will not answer this way.
  mock.state.jsonRefused = true
  mock.state.forKey.clear()
  try {
    const result = await gateway.ops.accounts({ action: 'test', name: 'a1' })
    assert.equal(result.ok, true, `the account test failed: ${result.error}`)
    assert.equal(result.status, 200)
    assert.equal(result.model, MODEL)
    assert.equal(result.error, '')
  } finally {
    mock.state.jsonRefused = false
  }
})

test("the panel's account test says why when the refusal has no body", async () => {
  // The same wall as above in a worse shape: the refusal carries no body at all,
  // so there is no `error` object to read and no text to show. The row still has
  // to explain itself - a failure with an empty reason is not a diagnosis.
  mock.state.jsonRefused = true
  mock.state.refuseShape = 'empty'
  mock.state.forKey.clear()
  try {
    const result = await gateway.ops.accounts({ action: 'test', name: 'a1' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'HTTP 500')
  } finally {
    mock.state.jsonRefused = false
    mock.state.refuseShape = 'content'
  }
})

/* ----------------------------- probe under the quirk ----------------------------- */

/** A model no other case probes, so these verdicts cannot leak into them. */
const PROBE_MODEL = 'cline-pass/deepseek-v4-pro'

test('probe keeps the planner pipeline when the answer was assembled from the stream', async () => {
  // api.cline.bot refuses every non-streaming call, so a probe on the real box
  // always reads an assembled body - and its pipeline verdict comes from that
  // body. The planner reports its route nested under `provider_metadata`, while
  // a bare root-level `provider` is the *direct* pipeline's own marker, so
  // flattening the planner's route into the root reports the wrong pipeline.
  mock.state.jsonRefused = true
  mock.state.streamRouting = 'planner'
  mock.state.forKey.clear()
  try {
    const result = await gateway.ops.probe({ model: PROBE_MODEL })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.pipeline, 'planner')
    // The channel that served the probe comes back as `lastProvider`: probe has
    // no `finalProvider` field of its own.
    assert.equal(result.lastProvider, 'openrouter')
    assert.equal(result.canonicalSlug, 'openrouter/anthropic/claude-sonnet-4.5')
    assert.ok(result.upstreams.includes('openrouter'), `upstreams=${result.upstreams.join(',')}`)
  } finally {
    mock.state.jsonRefused = false
    mock.state.streamRouting = ''
  }
})

test('probe reads the direct pipeline from a bare provider on the stream', async () => {
  mock.state.jsonRefused = true
  mock.state.streamRouting = 'direct'
  mock.state.forKey.clear()
  try {
    const result = await gateway.ops.probe({ model: PROBE_MODEL })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.pipeline, 'direct')
    assert.equal(result.lastProvider, 'deepseek')
  } finally {
    mock.state.jsonRefused = false
    mock.state.streamRouting = ''
  }
})

test('probe reports a bodyless refusal instead of throwing on it', async () => {
  // A proxy in front of the gateway answers 500 with no body at all, so the
  // failure carries no `error` object either: reading into it threw a TypeError,
  // which reached the panel as a failed probe with nothing to act on.
  mock.state.jsonRefused = true
  mock.state.refuseShape = 'empty'
  mock.state.forKey.clear()
  try {
    const result = await gateway.ops.probe({ model: PROBE_MODEL })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'HTTP 500')
  } finally {
    mock.state.jsonRefused = false
    mock.state.refuseShape = 'content'
  }
})

test('probe reports a refusal whose JSON has no error key', async () => {
  mock.state.jsonRefused = true
  mock.state.refuseShape = 'detail'
  mock.state.forKey.clear()
  try {
    const result = await gateway.ops.probe({ model: PROBE_MODEL })
    assert.equal(result.ok, false)
    assert.match(result.error, /upstream down/, 'the body itself is the only reason there is')
  } finally {
    mock.state.jsonRefused = false
    mock.state.refuseShape = 'content'
  }
})

test('parseRouting reads the router from a streamed delta as well', () => {
  // api.cline.bot reports routing on `choices[0].delta.provider_metadata` in its
  // stream chunks; only the mock used to put it on the frame root. Missing this
  // made every streamed request look like it had no channel at all.
  const streamed = protocol.parseRouting({
    choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } } }],
  })
  assert.equal(streamed.finalProvider, 'deepseek')
  assert.equal(streamed.pipeline, 'planner')
  const answered = protocol.parseRouting({
    choices: [{ index: 0, message: { provider_metadata: { gateway: { routing: { finalProvider: 'glm' } } } } }],
  })
  assert.equal(answered.finalProvider, 'glm')
  assert.equal(protocol.parseRouting({ provider: 'Z.AI' }).finalProvider, 'z.ai', 'a bare provider string is slugified, not alias-mapped')
})

/* ------------------------------ reasoning clamp ------------------------------ */

test('reasoningEffortFor clamps a host level onto the model it was given', () => {
  const { reasoningEffortFor, EFFORT_ORDER } = catalog
  assert.deepEqual(EFFORT_ORDER, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  // No published list means "send no effort field": inventing a value the model
  // never advertised is how a request starts failing for no visible reason.
  assert.equal(reasoningEffortFor('high', []), null)
  assert.equal(reasoningEffortFor('high', undefined), null)
  assert.equal(reasoningEffortFor('high', ['nonsense']), null)
  assert.equal(reasoningEffortFor(undefined, ['low', 'high']), null)
  assert.equal(reasoningEffortFor(null, ['low', 'high']), null)
  assert.equal(reasoningEffortFor('', ['low', 'high']), null)
  // The host's `off` - and the internal `omit` - mean "no field at all".
  assert.equal(reasoningEffortFor('off', ['low', 'high']), null)
  assert.equal(reasoningEffortFor('omit', ['low', 'high']), null)
  // A published level travels through untouched.
  assert.equal(reasoningEffortFor('high', ['low', 'high', 'max']), 'high')
  assert.equal(reasoningEffortFor('  HIGH ', ['low', 'high']), 'high')
  // An unpublished level clamps to the nearest published one, and a tie goes to
  // the cheaper (smaller) effort.
  assert.equal(reasoningEffortFor('medium', ['low', 'high', 'max']), 'low')
  assert.equal(reasoningEffortFor('xhigh', ['low', 'high', 'max']), 'high')
  assert.equal(reasoningEffortFor('minimal', ['low', 'high', 'max']), 'low')
  assert.equal(reasoningEffortFor('max', ['low', 'high']), 'high')
  assert.equal(reasoningEffortFor('none', ['low', 'high']), null, 'the upstream spelling of off is not an effort')
  // A level nobody published is never guessed at.
  assert.equal(reasoningEffortFor('bogus', ['low', 'high']), null)
})

test('the thinking ladder of every model follows the published catalog', () => {
  const ladder = (id) => catalog.thinkingLevelsFor(catalog.catalogEntry(id))
  assert.deepEqual(ladder('cline-pass/deepseek-v4.1-flash'), ['off', 'low', 'high', 'max'])
  assert.deepEqual(ladder('cline-pass/deepseek-v4-pro'), ['off', 'high', 'max'])
  assert.deepEqual(ladder('cline-pass/minimax-m3'), ['off'], 'a toggle model only offers off to the host')
  assert.deepEqual(ladder('cline-pass/qwen3.8-max'), ['off', 'low', 'medium', 'xhigh'], 'the refreshed catalog gives it three efforts')
  assert.deepEqual(ladder('cline-pass/mimo-v2.5'), ['off'], 'an on/off model only offers off')
  assert.deepEqual(
    ladder('cline-pass/muse-spark-1.3-contributor'),
    catalog.PI_THINKING_LEVELS.filter((level) => level !== 'max'),
    'the one model that publishes every effort except max',
  )
  assert.equal(catalog.defaultThinkingLevel(catalog.catalogEntry('cline-pass/deepseek-v4-pro')), 'high')
  assert.equal(catalog.defaultThinkingLevel(catalog.catalogEntry('cline-pass/minimax-m3')), 'off')
  assert.equal(catalog.defaultThinkingLevel(catalog.catalogEntry('cline-pass/nope')), 'off')
  for (const id of modelRegistry.modelIds()) {
    const entry = catalog.catalogEntry(id)
    const levels = catalog.thinkingLevelsFor(entry)
    assert.equal(levels[0], 'off', `${id} must offer off`)
    for (const level of levels) assert.ok(catalog.PI_THINKING_LEVELS.includes(level), `${id} level ${level}`)
    // The effort list is the ladder minus off, and it exists exactly when the
    // upstream takes discrete levels.
    assert.deepEqual(modelRegistry.effortsFor({ thinkingLevels: levels }), levels.filter((level) => level !== 'off'))
    assert.equal(levels.length > 1, entry.thinking.lever === 'effort', `${id} lever ${entry.thinking.lever}`)
  }
})

test('the catalog holds the 14 published models and marks no stand-in', () => {
  assert.deepEqual(modelRegistry.modelIds(), Object.keys(catalog.MODEL_CATALOG))
  assert.equal(modelRegistry.modelIds().length, 14)
  assert.equal(catalog.DEFAULT_REGISTERED.length, 5)
  assert.equal(catalog.PI_DEFAULT_THINKING_LEVEL, 'low')
  assert.deepEqual(catalog.REASONING_EFFORTS.map((entry) => entry.id), ['none', ...catalog.EFFORT_ORDER])
  assert.equal(catalog.catalogEntry('cline-pass/nope'), undefined)
  for (const id of modelRegistry.modelIds()) {
    const entry = catalog.catalogEntry(id)
    assert.equal(typeof entry.name, 'string', `${id} name`)
    assert.ok(entry.contextWindow >= 1000 && entry.maxTokens >= 1, `${id} window/output`)
    assert.equal(typeof entry.supportsImages, 'boolean', `${id} supportsImages`)
    assert.ok(['effort', 'toggle', 'none'].includes(entry.thinking.lever), `${id} lever`)
    assert.equal(Array.isArray(entry.thinking.levels), true, `${id} levels`)
    // `fallback` marks numbers that are a stand-in rather than a published
    // capability, so the panel can say so instead of presenting them as facts.
    // Nothing is flagged today: the last stand-in (`cline-pass/qwen3.8-max`)
    // turned out to be published after all, which is what the flag now says.
    assert.equal(entry.fallback === true, false, `${id} fallback flag`)
  }
})

/* --------------------------------- model registry --------------------------------- */

test('model settings: fourteen models, five registered, nothing edited', () => {
  assert.deepEqual(modelRegistry.SETTINGS_FIELDS, [
    'registered',
    'contextWindow',
    'maxTokens',
    'supportsImages',
    'thinkingLevels',
    'defaultThinkingLevel',
  ])
  assert.deepEqual(modelRegistry.LIMITS, {
    contextWindow: { min: 1000, max: 100000000 },
    maxTokens: { min: 1, max: 100000000 },
  })
  const defaults = modelRegistry.effectiveModels()
  assert.equal(defaults.length, 14)
  assert.deepEqual(defaults.filter((model) => model.registered).map((model) => model.id), catalog.DEFAULT_REGISTERED)
  // `registered` now means "ticked into the config the user imports", so the
  // generated payload is the thing to check - in catalog order.
  assert.deepEqual(
    generatedCatalogIds(modelRegistry.importConfigPayload()),
    catalog.DEFAULT_REGISTERED,
  )
  assert.deepEqual(defaults.find((model) => model.id === MODEL), {
    id: MODEL,
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    supportsImages: true,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    defaultThinkingLevel: 'low',
    registered: true,
    published: {
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1000000,
      maxTokens: 384000,
      supportsImages: true,
      thinkingLevels: ['off', 'low', 'high', 'max'],
    },
    lever: 'effort',
    fallback: false,
    edited: [],
  })
  // Nothing is a stand-in any more: the last one (qwen3.8-max) turned out to be
  // published after all, so every entry carries published numbers.
  const published = defaults.find((model) => model.id === 'cline-pass/qwen3.8-max')
  assert.equal(published.fallback, false)
  assert.equal(published.lever, 'effort')
  assert.deepEqual(published.thinkingLevels, ['off', 'low', 'medium', 'xhigh'])
  assert.equal(published.registered, false)
  const toggled = defaults.find((model) => model.id === 'cline-pass/mimo-v2.5')
  assert.equal(toggled.lever, 'toggle')
  assert.deepEqual(toggled.thinkingLevels, ['off'], 'an on/off model offers the host only off')
  assert.equal(modelRegistry.defaultsFor('cline-pass/nope'), null)
})

test('model settings: an override wins and the published value stays visible', () => {
  const settings = {
    'cline-pass/glm-5.3': {
      registered: false,
      contextWindow: 222222,
      maxTokens: 40000,
      supportsImages: true,
      thinkingLevels: ['medium', 'high'],
      defaultThinkingLevel: 'medium',
    },
  }
  const effective = modelRegistry.effectiveModels(settings)
  const glm = effective.find((model) => model.id === 'cline-pass/glm-5.3')
  assert.equal(glm.registered, false)
  assert.equal(glm.contextWindow, 222222)
  assert.equal(glm.maxTokens, 40000)
  assert.equal(glm.supportsImages, true)
  assert.deepEqual(glm.thinkingLevels, ['off', 'medium', 'high'], 'off is forced back in')
  assert.equal(glm.defaultThinkingLevel, 'medium')
  assert.deepEqual(glm.edited.slice().sort(), [
    'contextWindow',
    'defaultThinkingLevel',
    'maxTokens',
    'registered',
    'supportsImages',
    'thinkingLevels',
  ])
  // The published numbers ride along, so an edited window is never shown as
  // Cline's own.
  assert.deepEqual(glm.published, {
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    supportsImages: false,
    thinkingLevels: ['off', 'low', 'high', 'max'],
  })
  // Deselecting one model leaves the other thirteen as they were.
  assert.equal(effective.filter((model) => model.registered).length, 4)
  assert.deepEqual(
    generatedCatalogIds(modelRegistry.importConfigPayload(settings)),
    catalog.DEFAULT_REGISTERED.filter((id) => id !== 'cline-pass/glm-5.3'),
  )
  assert.deepEqual(modelRegistry.sanitizeSettings(settings)['cline-pass/glm-5.3'].contextWindow, 222222)
  // Nothing else is touched by that patch.
  assert.equal(effective.find((model) => model.id === MODEL).contextWindow, 1000000)
  assert.deepEqual(effective.find((model) => model.id === MODEL).edited, [])
  assert.equal(effective.length, 14)
})

test('model settings: out-of-range and unknown overrides are dropped', () => {
  const sanitized = modelRegistry.sanitizeSettings({
    'cline-pass/glm-5.3': { contextWindow: 999, maxTokens: 0, registered: 'yes', supportsImages: 'no' },
    'cline-pass/kimi-k3': { contextWindow: 100000001, maxTokens: 100000001, defaultThinkingLevel: 7 },
    'cline-pass/nope': { contextWindow: 100000 },
    'cline-pass/mimo-v2.5': { contextWindow: 1200.9, maxTokens: 100000000 },
    'cline-pass/mimo-v2.6-pro': null,
    'cline-pass/qwen3.7-max': 'nonsense',
  })
  // A window below the floor would make every session unusable, one above the
  // ceiling would let a prompt silently overflow, and an unknown model is not a
  // model: all of it is dropped rather than clamped to something arbitrary.
  assert.deepEqual(sanitized, { 'cline-pass/mimo-v2.5': { contextWindow: 1200, maxTokens: 100000000 } })
  const effective = modelRegistry.effectiveModels({ 'cline-pass/glm-5.3': { contextWindow: 5, maxTokens: -3 } })
  const glm = effective.find((model) => model.id === 'cline-pass/glm-5.3')
  assert.equal(glm.contextWindow, 1000000, 'the published window, not the rejected one')
  assert.equal(glm.maxTokens, 131072)
  assert.deepEqual(glm.edited, [])
  assert.equal(effective.length, 14)
  // A settings block that is not an object at all is ignored, not thrown on.
  assert.equal(modelRegistry.effectiveModels(null).length, 14)
  assert.deepEqual(modelRegistry.sanitizeSettings(['nonsense']), {})
  assert.deepEqual(modelRegistry.sanitizeSettings(undefined), {})
  assert.deepEqual(modelRegistry.sanitizeSettings({ 'cline-pass/glm-5.3': {} }), {})
  // sanitizeLevels is the level-list half of the same rule.
  assert.deepEqual(modelRegistry.sanitizeLevels(['high', 'bogus', 'high'], ['off', 'low']), ['off', 'high'])
  assert.deepEqual(modelRegistry.sanitizeLevels(['bogus'], ['off', 'low']), ['off', 'low'])
  assert.deepEqual(modelRegistry.sanitizeLevels('high', ['off', 'low']), ['off', 'low'])
  assert.deepEqual(modelRegistry.sanitizeLevels([], ['off', 'low']), ['off', 'low'])
  assert.deepEqual(modelRegistry.sanitizeLevels(['max'], undefined), ['off', 'max'])
  // `off` is only prepended when the list does not already have it.
  assert.deepEqual(modelRegistry.sanitizeLevels(['max', 'off'], ['off', 'low']), ['max', 'off'])
})

test('model settings: thinking levels keep off and a bad default falls back', () => {
  const pick = (settings) => modelRegistry.effectiveModels(settings).find((model) => model.id === MODEL)
  // 'xhigh' is not in the overridden ladder and neither is the catalog default,
  // so the first entry - which is always `off` - is what remains.
  const offOnly = pick({ [MODEL]: { thinkingLevels: ['high', 'max'], defaultThinkingLevel: 'xhigh' } })
  assert.deepEqual(offOnly.thinkingLevels, ['off', 'high', 'max'])
  assert.equal(offOnly.defaultThinkingLevel, 'off')
  // When the catalog default survives the override it is kept.
  const keepsDefault = pick({ [MODEL]: { thinkingLevels: ['low', 'max'], defaultThinkingLevel: 'bogus' } })
  assert.deepEqual(keepsDefault.thinkingLevels, ['off', 'low', 'max'])
  assert.equal(keepsDefault.defaultThinkingLevel, 'low')
  // A model whose lever publishes no levels still defaults to off, even if the
  // user adds a level the upstream never advertised.
  const toggled = modelRegistry
    .effectiveModels({ 'cline-pass/minimax-m3': { thinkingLevels: ['high'] } })
    .find((model) => model.id === 'cline-pass/minimax-m3')
  assert.deepEqual(toggled.thinkingLevels, ['off', 'high'])
  assert.equal(toggled.defaultThinkingLevel, 'off')
  // A chosen default that is in the ladder is honoured as is.
  const chosen = pick({ [MODEL]: { thinkingLevels: ['high', 'max'], defaultThinkingLevel: 'max' } })
  assert.equal(chosen.defaultThinkingLevel, 'max')
})

test('model settings: the alias and the host omit default survive the filter', () => {
  // The panel's 显示名 field writes `name`; the host rewrites it into its own
  // `alias` column. It has to make it through sanitizeSettings, or the field is
  // a dead control that looks like it saved.
  const renamed = modelRegistry.effectiveModels({ [MODEL]: { name: '  我的主模型  ' } }).find((model) => model.id === MODEL)
  assert.equal(renamed.name, '我的主模型', 'the alias is trimmed and kept')
  assert.equal(renamed.published.name, 'DeepSeek V4.1 Flash', 'the catalog name stays visible for comparison')
  assert.ok(renamed.edited.includes('name'), 'so the panel can mark the field as edited')
  const long = modelRegistry.effectiveModels({ [MODEL]: { name: 'x'.repeat(120) } }).find((model) => model.id === MODEL)
  assert.equal(long.name.length, 60, 'the host caps an alias at 60 characters, so we cap it first')
  const blank = modelRegistry.effectiveModels({ [MODEL]: { name: '   ' } }).find((model) => model.id === MODEL)
  assert.equal(blank.name, 'DeepSeek V4.1 Flash', 'whitespace is not an alias')
  // `omit` is the host's own "send no thinking field" marker: it is not one of
  // the ticking levels, so the usual membership test would rewrite it.
  const pick = (settings) => modelRegistry.effectiveModels(settings).find((model) => model.id === MODEL)
  const omitted = pick({ [MODEL]: { thinkingLevels: ['off', 'high', 'max'], defaultThinkingLevel: 'omit' } })
  assert.equal(omitted.defaultThinkingLevel, 'omit')
  // The config the panel generates carries the alias, since that is where the
  // host reads a model's label from now.
  const generatedEntry = modelRegistry
    .importConfigPayload({ [MODEL]: { name: '主模型', defaultThinkingLevel: 'omit' } })
    .providers[modelRegistry.IMPORT_PROVIDER_ID].models.find((model) => model.id === modelRegistry.importModelId(MODEL))
  assert.equal(generatedEntry.name, '主模型')
  // `defaultThinkingLevel` has no counterpart in the host's `pi` format: an
  // imported model gets the host's generic thinking levels, so this field is
  // deliberately not written (a made-up field would just be ignored).
  assert.deepEqual(Object.keys(generatedEntry), ['id', 'name', 'limit', 'reasoning', 'input'])
})

/* ------------------------------ the generated config ------------------------------ */

/** The model ids one generated payload carries, in order. */
function generatedIds(payload) {
  return payload.providers[modelRegistry.IMPORT_PROVIDER_ID].models.map((model) => model.id)
}

/**
 * The catalog ids behind a generated payload's ids.
 *
 * The generated config re-spells them (`cline-pass-local/x`) so an imported model
 * never collides with one the user already gets from a provider pointed straight at
 * Cline - see `models.js`. Everything the plugin keys by model id stays the catalog
 * spelling, so that is what the assertions have to compare against.
 */
function generatedCatalogIds(payload) {
  return generatedIds(payload).map((id) => modelRegistry.unimportModelId(id))
}

test("the generated config carries the ticked models with the host's own field names", () => {
  // The host parses this with its `pi` source reader: a provider needs `baseUrl`,
  // `api`, a non-empty `apiKey` and at least one model carrying an `id`, or the
  // whole provider is dropped before the user ever sees it.
  const payload = modelRegistry.importConfigPayload()
  assert.deepEqual(Object.keys(payload), ['providers'])
  const provider = payload.providers[modelRegistry.IMPORT_PROVIDER_ID]
  assert.ok(provider, `the config must key its provider by ${modelRegistry.IMPORT_PROVIDER_ID}`)
  assert.equal(provider.name, 'Cline Pass（本地网关）')
  assert.equal(provider.api, 'chat_completions', 'the gateway is OpenAI compatible; the host only reads that value')
  assert.equal(provider.baseUrl, protocol.GATEWAY_BASE_URL)
  assert.equal(provider.baseUrl, 'http://127.0.0.1:41593/v1', 'the gateway address is fixed, not read from the manifest')
  assert.equal(provider.apiKey, configModule.HOST_NO_AUTH_KEY, 'a provider with no secret is filtered out of the picker, so the key must be non-empty')
  assert.ok(provider.apiKey.length > 0)
  assert.equal(provider.headers, undefined, 'the gateway needs no extra header')
  assert.deepEqual(
    generatedCatalogIds(payload),
    catalog.DEFAULT_REGISTERED,
    'the five defaults are the ones ticked out of the box, in catalog order',
  )
  for (const model of provider.models) {
    // Only these keys: the reader knows nothing else, and `id` is the only
    // spelling it accepts for a model id (`modelId`/`model` are not read).
    assert.deepEqual(Object.keys(model), ['id', 'name', 'limit', 'reasoning', 'input'], `${model.id} fields`)
    assert.deepEqual(Object.keys(model.limit), ['context', 'output'], `${model.id} limit fields`)
    const published = catalog.catalogEntry(modelRegistry.unimportModelId(model.id))
    assert.ok(published, `${model.id} is not in the catalog`)
    assert.equal(model.name, published.name, `${model.id} name`)
    // The window and the output cap are the published (models.dev) numbers, and
    // writing them makes them the user's own values - which is what stops the
    // host's catalog backfill from replacing them.
    assert.equal(model.limit.context, published.contextWindow, `${model.id} window`)
    assert.equal(model.limit.output, published.maxTokens, `${model.id} output`)
    assert.equal(model.reasoning, catalog.thinkingLevelsFor(published).length > 1, `${model.id} reasoning`)
    assert.deepEqual(model.input, published.supportsImages ? ['text', 'image'] : ['text'], `${model.id} input`)
  }
  // The id is the *imported* spelling, and that is the point: an identical id would
  // collide with a provider the user built straight from Cline's own endpoint, and
  // the host's delegation key (`<vendorKey>/<modelId>`) would then be shared - the
  // subagent can end up answered by that other provider (see `models.js`).
  assert.equal(modelRegistry.importModelId(MODEL), 'cline-pass-local/deepseek-v4.1-flash')
  assert.deepEqual(provider.models.find((model) => model.id === modelRegistry.importModelId(MODEL)), {
    id: modelRegistry.importModelId(MODEL),
    name: 'DeepSeek V4.1 Flash',
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    input: ['text', 'image'],
  })
})

test('the generated config follows the ticks and the panel overrides, and writes nothing', () => {
  const manifestPath = new URL('../manifest.json', import.meta.url)
  const realManifest = fs.readFileSync(manifestPath, 'utf8')
  const payload = modelRegistry.importConfigPayload({
    'cline-pass/minimax-m3': { registered: false },
    'cline-pass/glm-5.3': { contextWindow: 222222, maxTokens: 40000 },
    'cline-pass/mimo-v2.6-pro': { registered: true, name: '我的模型' },
  })
  assert.deepEqual(
    generatedCatalogIds(payload),
    ['cline-pass/deepseek-v4.1-flash', 'cline-pass/deepseek-v4-pro', 'cline-pass/glm-5.3', 'cline-pass/kimi-k3', 'cline-pass/mimo-v2.6-pro'],
    'the ticks decide what is in the config, in catalog order',
  )
  const models = payload.providers[modelRegistry.IMPORT_PROVIDER_ID].models
  assert.deepEqual(models.find((model) => model.id === modelRegistry.importModelId('cline-pass/glm-5.3')).limit, { context: 222222, output: 40000 })
  assert.equal(models.find((model) => model.id === modelRegistry.importModelId('cline-pass/mimo-v2.6-pro')).name, '我的模型')
  assert.equal(modelRegistry.describeImportConfig(payload), '生成配置里现在有 5 个模型')
  // Unticking everything leaves a provider the host would throw away, so the
  // panel can say so instead of handing the user a config that does nothing.
  const none = modelRegistry.importConfigPayload(
    Object.fromEntries(catalog.DEFAULT_REGISTERED.map((id) => [id, { registered: false }])),
  )
  assert.deepEqual(none.providers[modelRegistry.IMPORT_PROVIDER_ID].models, [])
  assert.equal(modelRegistry.describeImportConfig(none), '生成配置里现在没有模型')
  assert.equal(modelRegistry.describeImportConfig({ providers: {} }), '生成配置里现在没有模型')
  assert.equal(modelRegistry.describeImportConfig(undefined), '生成配置里现在没有模型')
  // Generating is pure computation: nothing in the plugin's own directory moves.
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), realManifest, 'generating a config must not touch the manifest')
  assert.equal(fs.existsSync(`${manifestPath}.bak`), false)
})

test('the shipped manifest declares no provider, and no code puts one back', () => {
  // The plugin used to declare a provider here (empty, for the reason the header
  // of src/models.js spells out). It declares none any more: that row is what the
  // settings page showed next to the provider the user imports, and the host
  // deletes it on the next sync of this plugin. With the declaration gone there is
  // no place a model list could hide either.
  const shippedManifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  assert.equal(shippedManifest.contributes.providers, undefined, 'no provider declaration means no declared model')
  assert.equal(shippedManifest.permissions.includes('provider.register'), false)
  // And nothing builds that list any more: a resurrected writer would put the
  // plugin's models back into the picker, where they can neither be edited nor
  // dispatched to a subagent.
  const sources = [
    fs.readFileSync(new URL('../src/models.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/gateway.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8'),
  ].join('\n')
  for (const gone of ['syncManifest', 'manifestModel', 'registeredManifestModels', 'describeWrite']) {
    assert.equal(sources.includes(gone), false, `${gone} is gone: nothing writes a manifest model list`)
  }
  // models.js is the one place that builds the config, and it stays a read: no
  // filesystem at all, and the address comes from the single constant in
  // protocol.js instead of from the manifest, so the JSON a user imports can never
  // point at a port the gateway does not serve.
  const registrySource = fs.readFileSync(new URL('../src/models.js', import.meta.url), 'utf8')
  assert.equal(/writeFileSync|appendFileSync|readFileSync|mkdirSync/.test(registrySource), false, 'the generated config is computed, never written')
  assert.equal(/require\('\.\.\/manifest\.json'\)/.test(registrySource), false, 'models.js never requires the manifest')
  assert.equal(/require\('\.\/protocol\.js'\)/.test(registrySource), true, 'the address comes from protocol.js')
})

/* ------------------------------- entry-point wiring ------------------------------- */
test('every declared tool and panel action has a branch in main.js', () => {
  // The manifest is not the only place a name has to exist: main.js keeps its own
  // tool map and its own dispatchers, and a name declared without a branch reaches
  // the model as a tool that only answers "unsupported".
  const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  const lines = mainSource.split(String.fromCharCode(10)).map((line) => line.trim())
  for (const tool of mainModule.TOOL_NAMES) {
    assert.ok(lines.includes(`${tool}: {`), `main.js defines no tool named ${tool}`)
  }
  const cases = lines.filter((line) => line.startsWith('case '))
  for (const name of [...mainModule.TOOL_NAMES, ...mainModule.PANEL_ACTIONS]) {
    assert.ok(cases.includes(`case '${name}':`) || cases.includes(`case '${name}': {`), `no branch for ${name}`)
  }
  // The two additions of this round, spelled out so a rename cannot pass quietly.
  assert.ok(mainModule.TOOL_NAMES.includes('cline_pass_usage'))
  for (const action of ['setModel', 'usage', 'usageClear']) {
    assert.ok(mainModule.PANEL_ACTIONS.includes(action), `PANEL_ACTIONS is missing ${action}`)
  }
})

test('setModel writes config.json only, and the shipped manifest is untouched', async () => {
  // The old behaviour wrote this plugin's own manifest on every save (and only
  // took effect after a reload). A saved parameter now lands in `config.json`
  // alone: the config the panel generates carries it to the host, so the file
  // the host loads must not move a byte.
  const manifestPath = new URL('../manifest.json', import.meta.url)
  const before = fs.readFileSync(manifestPath, 'utf8')
  assert.equal(
    JSON.parse(before).contributes.providers,
    undefined,
    'the manifest declares no provider, so a setModel has nothing to keep in sync with it',
  )
  try {
    const result = await gateway.ops.setModel({ model: 'cline-pass/glm-5.3', contextWindow: 123456 })
    assert.equal(result.ok, true)
    assert.equal(result.model, 'cline-pass/glm-5.3')
    assert.equal(result.applied.contextWindow, 123456)
    assert.equal(result.summary, '生成配置里现在有 5 个模型')
    assert.equal(result.models.length, 14)
    assert.equal(result.models.find((model) => model.id === 'cline-pass/glm-5.3').edited.includes('contextWindow'), true)
    assert.equal(configStore.get().modelSettings['cline-pass/glm-5.3'].contextWindow, 123456)
    // ...and the value the panel would hand the user is the saved one.
    const payload = modelRegistry.importConfigPayload(configStore.get().modelSettings)
    const glm = payload.providers[modelRegistry.IMPORT_PROVIDER_ID].models.find((model) => model.id === modelRegistry.importModelId('cline-pass/glm-5.3'))
    assert.equal(glm.limit.context, 123456)
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before, 'the shipped manifest must survive a setModel')
    assert.equal(fs.existsSync(`${manifestPath}.bak`), false)
    // An unknown or missing model is refused before anything is written.
    assert.throws(() => gateway.ops.setModel({ model: 'cline-pass/nope' }), /unknown model/)
    assert.throws(() => gateway.ops.setModel({}), /model is required/)
  } finally {
    configStore.update({ modelSettings: {} })
  }
  assert.deepEqual(configStore.get().modelSettings, {}, 'the temp config is back to no overrides')
  assert.deepEqual(gateway.ops.models().find((model) => model.id === 'cline-pass/glm-5.3').edited, [])
})

/* ------------------------------------ the ledger ------------------------------------ */

test('extractUsage reads the spellings upstreams use and says null when it does not know', () => {
  const { extractUsage } = usageLog
  assert.deepEqual(extractUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.25 }), {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    cachedTokens: null,
    reasoningTokens: null,
    cost: 0.25,
  })
  // The other spellings, and a total that has to be added up instead.
  const alt = extractUsage({ input_tokens: 7, output_tokens: 3 })
  assert.equal(alt.promptTokens, 7)
  assert.equal(alt.completionTokens, 3)
  assert.equal(alt.totalTokens, 10)
  // Cache reads, reasoning tokens and the two other cost spellings.
  assert.equal(extractUsage({ prompt_tokens: 1, cache_read_input_tokens: 512 }).cachedTokens, 512)
  assert.equal(extractUsage({ cached_tokens: 8 }).cachedTokens, 8)
  assert.equal(extractUsage({ prompt_cache_hit_tokens: 9 }).cachedTokens, 9)
  assert.equal(extractUsage({ cached_tokens: 0 }).cachedTokens, 0, 'a real zero is kept')
  assert.equal(extractUsage({ completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } }).reasoningTokens, 4)
  assert.equal(extractUsage({ reasoning_tokens: 6 }).reasoningTokens, 6)
  assert.equal(extractUsage({ total_cost: 1.5 }).cost, 1.5)
  assert.equal(extractUsage({ cost_details: { total: 2.5 } }).cost, 2.5)
  assert.equal(extractUsage({ cost: 0.1, cost_details: { total: 2.5 } }).cost, 0.1, 'a direct cost wins over the detail block')
  // Unknown is null, never zero: "0 tokens" and "nobody said" are different facts,
  // and a summary that adds a made-up zero to its totals lies about the cost.
  const empty = extractUsage(null)
  assert.deepEqual(empty, {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    cost: null,
  })
  assert.deepEqual(extractUsage({}), empty)
  assert.equal(extractUsage({ prompt_tokens: 'many' }).promptTokens, null)
  assert.equal(extractUsage({ prompt_tokens: 5 }).completionTokens, null)
  assert.equal(extractUsage({ prompt_tokens: 5 }).totalTokens, 5, 'a missing total is the sum of what is known')
})

/** A ledger in its own temp directory, seeded oldest row first with four known rows. */
function seedLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-usage-'))
  const log = usageLog.createUsageLog({ dataDir: dir })
  const now = Date.UTC(2026, 9, 13, 6, 0, 0)
  const row = (ts, patch) => log.record({ ts, model: 'cline-pass/a', upstream: 'alpha', account: 'host', status: 200, ms: 100, ...patch })
  row(now - 4 * 24 * 3600_000, { model: 'cline-pass/b', upstream: 'gamma', promptTokens: 1000, totalTokens: 1000, cost: 2, ms: 10 })
  row(now - 30 * 3600_000, { model: 'cline-pass/b', promptTokens: 10, completionTokens: 5, totalTokens: 15, account: 'a1', ms: 100 })
  row(now - 7200_000, { upstream: 'beta', account: 'a1', status: 502, promptTokens: null, completionTokens: null, totalTokens: null, cost: null, ms: 500 })
  row(now - 3600_000, { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.5, ms: 1000 })
  return { dir, log, now }
}

test('the usage ledger filters by window and totals what it kept', () => {
  const { dir, log, now } = seedLedger()
  try {
    assert.equal(log.file, path.join(dir, 'usage.jsonl'))
    const all = log.summary({ days: 0, now })
    assert.deepEqual(all.window, { days: 0, since: 0 }, 'days <= 0 means the whole ledger')
    assert.equal(all.rows, 4)
    assert.equal(all.rowsInWindow, 4)
    assert.equal(all.skipped, 0)
    assert.equal(all.totals.requests, 4)
    assert.equal(all.totals.failures, 1)
    assert.equal(all.totals.promptTokens, 1110)
    assert.equal(all.totals.completionTokens, 55)
    assert.equal(all.totals.tokens, 1165)
    assert.equal(all.totals.cost, 2.5)
    assert.equal(all.totals.costKnown, '2/4')
    assert.equal(all.totals.avgMs, Math.round((10 + 100 + 500 + 1000) / 4))
    assert.equal(all.totals.firstTs, now - 4 * 24 * 3600_000)
    assert.equal(all.totals.lastTs, now - 3600_000)
    const window = log.summary({ days: 2, now })
    assert.equal(window.rows, 4, 'the file itself keeps everything')
    assert.equal(window.rowsInWindow, 3, 'the window only counts the last two days')
    assert.equal(window.window.since, now - 2 * 24 * 3600 * 1000)
    assert.equal(window.totals.requests, 3)
    assert.equal(window.totals.failures, 1)
    assert.equal(window.totals.tokens, 165)
    assert.equal(window.totals.cost, 0.5)
    assert.equal(window.totals.costKnown, '1/3', 'a row whose cost nobody reported is not counted as known')
    assert.equal(window.totals.firstTs, now - 30 * 3600_000)
    const empty = log.summary({ days: 1, now: now + 400 * 24 * 3600_000 })
    assert.equal(empty.rowsInWindow, 0)
    assert.equal(empty.totals.requests, 0)
    assert.equal(empty.totals.avgMs, 0)
    assert.equal(empty.totals.firstTs, 0)
    assert.equal(empty.totals.lastTs, 0)
    assert.equal(empty.totals.costKnown, '0/0')
    assert.deepEqual(empty.byModel, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the usage ledger groups by model, channel, account and day, newest rows first', () => {
  const { dir, log, now } = seedLedger()
  try {
    const window = log.summary({ days: 2, now })
    assert.deepEqual(
      window.byModel.map((entry) => [entry.key, entry.requests, entry.failures, entry.totalTokens, entry.costKnown]),
      [
        ['cline-pass/a', 2, 1, 150, '1/2'],
        ['cline-pass/b', 1, 0, 15, '0/1'],
      ],
    )
    assert.equal(window.byModel[0].avgMs, Math.round((1000 + 500) / 2))
    assert.deepEqual(window.byUpstream.map((entry) => [entry.key, entry.requests]), [
      ['alpha', 2],
      ['beta', 1],
    ])
    assert.deepEqual(window.byAccount.map((entry) => [entry.key, entry.requests]), [
      ['a1', 2],
      ['host', 1],
    ])
    assert.deepEqual(window.byDay.map((entry) => [entry.key, entry.requests]), [
      ['2026-10-13', 2],
      ['2026-10-12', 1],
    ])
    // A row that named no channel still has a bucket, so nothing silently
    // disappears from the totals.
    const all = log.summary({ days: 0, now })
    assert.equal(all.byUpstream.length, 3)
    assert.equal(all.byUpstream.every((entry) => entry.key !== ''), true)
    // recent() is newest first, bounded, and filterable by model substring.
    assert.deepEqual(log.recent({ limit: 2 }).map((entry) => entry.ms), [1000, 500])
    assert.equal(log.recent({ limit: 2 })[0].model, 'cline-pass/a')
    assert.equal(log.recent({ limit: 2 })[0].status, 200)
    assert.equal(log.recent({ limit: 2 })[1].status, 502)
    assert.deepEqual(log.recent({ limit: 1, model: 'cline-pass/b' }).map((entry) => entry.ms), [100], 'the newest row of that model')
    assert.equal(log.recent({ model: 'cliiine' }).length, 0)
    assert.equal(log.recent({ limit: 500, model: 'CLINE-PASS/B' }).length, 2, 'the filter is case-insensitive')
    assert.equal(log.recent().length, 4)
    assert.equal(usageLog.dayKey(now), '2026-10-13')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('broken ledger lines are counted, not thrown, and clear resets the totals', () => {
  const { dir, log, now } = seedLedger()
  try {
    fs.appendFileSync(log.file, 'not json at all\n{"model":"cline-pass/a",\n\n', 'utf8')
    const sum = log.summary({ days: 0, now })
    assert.equal(sum.skipped, 2, 'two unreadable lines')
    assert.equal(sum.rows, 4, 'the four good rows are still readable')
    assert.equal(sum.totals.requests, 4)
    assert.equal(sum.totals.tokens, 1165, 'a broken line cannot change the totals')
    const read = log.readAll()
    assert.equal(read.skipped, 2)
    assert.equal(read.rows.length, 4)
    // Whatever is left of the ledger after a clear is a clean ledger.
    const cleared = log.clear()
    assert.equal(cleared.ok, true)
    assert.equal(cleared.removed, 1)
    assert.equal(fs.existsSync(log.file), false)
    const after = log.summary({ days: 0, now })
    assert.equal(after.rows, 0)
    assert.equal(after.skipped, 0)
    assert.equal(after.totals.requests, 0)
    assert.equal(after.totals.tokens, 0)
    assert.equal(after.totals.cost, 0)
    assert.deepEqual(log.recent({ limit: 5 }), [])
    assert.equal(log.clear().removed, 0, 'clearing an empty ledger is not an error')
    assert.equal(log.record({ model: 'cline-pass/a' }), true, 'the ledger starts again after a clear')
    assert.equal(log.summary({ days: 0, now: Date.now() + 1000 }).rows, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a ledger row keeps the numbers and drops the prompt', () => {
  assert.deepEqual(
    usageLog.normalizeRow({
      ts: 1234,
      model: 'm',
      upstream: 'u',
      account: 'a',
      status: 200,
      ms: 5,
      stream: true,
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cachedTokens: 4,
      reasoningTokens: 5,
      cost: 6,
      note: 'ok',
      prompt: 'SECRET',
      key: 'sk-SECRET',
    }),
    {
      ts: 1234,
      model: 'm',
      upstream: 'u',
      account: 'a',
      status: 200,
      ms: 5,
      stream: true,
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cachedTokens: 4,
      reasoningTokens: 5,
      cost: 6,
      note: 'ok',
    },
  )
  const defaults = usageLog.normalizeRow(null)
  assert.equal(defaults.model, '')
  assert.equal(defaults.upstream, '')
  assert.equal(defaults.account, '')
  assert.equal(defaults.status, 0)
  assert.equal(defaults.stream, false)
  assert.equal(defaults.cost, null)
  assert.equal(typeof defaults.ts, 'number')
  assert.equal(usageLog.dayKey(Date.UTC(2026, 9, 13, 23, 59, 59)), '2026-10-13')
  assert.equal(usageLog.MAX_BYTES, 2 * 1024 * 1024)
  assert.equal(usageLog.MAX_SKIPPED_REPORTED, 5)
  // The ledger is the one file that must never grow a prompt into it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-usage-row-'))
  const log = usageLog.createUsageLog({ dataDir: dir })
  try {
    assert.equal(log.record({ ts: 1, model: 'm', prompt: 'SECRET', key: 'sk-SECRET', note: 'n' }), true)
    const text = fs.readFileSync(log.file, 'utf8')
    assert.equal(text.includes('SECRET'), false)
    assert.equal(text.split(String.fromCharCode(10)).filter((line) => line.trim() !== '').length, 1)
    assert.equal(JSON.parse(text.trim()).ts, 1)
    assert.equal(JSON.parse(text.trim()).note, 'n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('every request lands in the usage ledger, and the panel can clear it', async () => {
  mock.state.forKey.clear()
  gateway.ops.usageClear()
  const empty = gateway.ops.usage({ days: 0 })
  assert.equal(empty.ok, true)
  assert.equal(empty.rows, 0)
  assert.deepEqual(empty.recent, [])
  assert.equal(empty.file, path.join(path.dirname(configStore.file), 'usage.jsonl'))
  await (await chat({ stream: false })).json()
  const one = gateway.ops.usage({ days: 0 })
  assert.equal(one.rows, 1)
  assert.equal(one.totals.requests, 1)
  assert.equal(one.totals.failures, 0)
  assert.equal(one.totals.tokens, 3, 'the token count comes from the final usage block')
  assert.equal(one.recent[0].model, MODEL)
  assert.equal(one.recent[0].status, 200)
  assert.ok(['host', 'a1', 'a2'].includes(one.recent[0].account), `the ledger names the account that answered, got "${one.recent[0].account}"`)
  assert.equal(one.recent[0].stream, false)
  // The streaming path records the same row, with the token count from the final
  // frame of the answer - for a stream that frame is the only place it appears.
  const streamed = await chat({}, { stream: true })
  assert.equal(streamed.status, 200)
  await streamed.text()
  const afterStream = gateway.ops.usage({ days: 0 })
  assert.equal(afterStream.rows, 2)
  assert.equal(afterStream.totals.tokens, 10, '3 from the JSON answer and 7 from the stream')
  assert.equal(afterStream.recent[0].stream, true)
  assert.equal(afterStream.recent[0].status, 200)
  // A refusal is recorded too: it cost time even though it cost no tokens.
  const saved = configStore.get().accounts
  configStore.update({ accounts: [{ name: 'host', displayName: 'host', source: 'host', enabled: false }] })
  try {
    const refused = await chat({ stream: false }, { key: '' })
    assert.equal(refused.status, 502)
  } finally {
    configStore.update({ accounts: saved })
  }
  const two = gateway.ops.usage({ days: 0 })
  assert.equal(two.rows, 3)
  assert.equal(two.totals.failures, 1)
  assert.equal(two.recent[0].status, 502)
  assert.ok(two.recent[0].note.length > 0, 'a failure row says why')
  // The model filter narrows the rows without touching the totals.
  const filtered = gateway.ops.usage({ days: 0, limit: 5, model: 'glm-5.3' })
  assert.equal(filtered.rows, 3)
  assert.deepEqual(filtered.recent, [])
  assert.equal(gateway.ops.usage({ days: 1, limit: 3, model: MODEL }).recent.length, 3)
  gateway.ops.usageClear()
  assert.equal(gateway.ops.usage({ days: 0 }).rows, 0)
})

test('wiring smoke: a second gateway starts, serves its state and writes its ledger', async () => {
  // What this test exists for: `gateway.js` once shipped calling `createUsageLog`
  // without requiring it. Every static check passed - the module loaded, the
  // provider registered - and then every request died at runtime. So this boots a
  // gateway the way main.js does, talks to it over HTTP and then reads the ledger,
  // which is the cheapest way to catch a broken require or a missing re-export.
  const realManifest = fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-smoke-'))
  const store = createConfig({ dataDir: dir })
  store.update({ baseUrl: mock.baseUrl, accounts: [{ name: 'host', displayName: 'host', source: 'host', enabled: true }] })
  const smoke = createGateway({ configStore: store, portOverride: 0 })
  mock.state.forKey.clear()
  try {
    await smoke.start()
    assert.equal(smoke.ops.status().running, true)
    assert.ok(smoke.port > 0)
    const models = await (await fetch(`http://127.0.0.1:${smoke.port}/v1/models`)).json()
    assert.equal(models.object, 'list')
    assert.equal(models.data.length, 14)
    assert.equal(models.data.filter((row) => row.registered).length, 5)
    const state = await (await fetch(`http://127.0.0.1:${smoke.port}/__pi/cline-pass/state`)).json()
    assert.equal(state.ok, true)
    assert.equal(state.running, true)
    assert.equal(state.port, smoke.port)
    assert.equal(state.models.length, 14)
    assert.equal(state.models.filter((row) => row.registered).length, 5)
    assert.equal(state.models[0].published.contextWindow, 1000000)
    const empty = smoke.ops.usage({ days: 0 })
    assert.equal(empty.ok, true)
    assert.equal(empty.rows, 0)
    assert.deepEqual(empty.recent, [])
    assert.equal(empty.file, path.join(dir, 'usage.jsonl'))
    assert.equal(empty.byModel.length, 0)
    // One real request through the second gateway, so the ledger path is proven
    // end to end rather than only by reading the code.
    const answer = await fetch(`http://127.0.0.1:${smoke.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer host-key' },
      body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 200)
    const payload = await answer.json()
    assert.equal(payload.choices[0].message.content, 'OK')
    const used = smoke.ops.usage({ days: 0 })
    assert.equal(used.rows, 1)
    assert.equal(used.totals.requests, 1)
    assert.equal(used.totals.failures, 0)
    assert.equal(used.totals.tokens, 3)
    assert.equal(used.recent[0].model, MODEL)
    assert.equal(used.recent[0].account, 'host')
  } finally {
    await smoke.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // Booting a gateway must not rewrite the plugin's own manifest either.
  assert.equal(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'), realManifest)
})

test('quota: the official windows are read per account, then served from cache', async () => {
  // The official quota is a different reading from the local ledger: it is the
  // account's own subscription windows, read from Cline with that account's key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-quota-'))
  const store = createConfig({ dataDir: dir })
  store.update({
    baseUrl: mock.baseUrl,
    accounts: [
      { name: 'host', displayName: 'host', source: 'host', enabled: true },
      { name: 'inline-one', displayName: 'inline one', source: 'inline', enabled: true, key: 'quota-key-1' },
    ],
  })
  const gw = createGateway({ configStore: store, portOverride: 0 })
  mock.state.quotaMode = 'ok'
  mock.state.quotaCalls = 0
  mock.state.quotaKeys = []
  try {
    const first = await gw.ops.quota()
    assert.equal(first.ok, true)
    assert.equal(first.cached, false)
    assert.equal(first.accounts.length, 2)
    // The host account's key only exists inside a request, so its row must say
    // so rather than pretend the account has 0% used.
    const host = first.accounts.find((row) => row.name === 'host')
    assert.equal(host.ok, false)
    // Every row says where it came from. The gateway still reports the host row
    // (an agent tool can pass a key with it), while the panel hides those rows:
    // a host account's key never reaches the panel, so its quota can never be
    // read there and a permanent "cannot read" line is just noise.
    assert.equal(host.source, 'host')
    assert.match(host.error, /request memory/)
    assert.deepEqual(host.limits, [])
    const inline = first.accounts.find((row) => row.name === 'inline-one')
    assert.equal(inline.ok, true)
    assert.equal(inline.source, 'inline')
    assert.ok(inline.keyHint.includes('***'))
    assert.equal(inline.keyHint.includes('quota-key-1'), false)
    assert.deepEqual(inline.limits.map((limit) => limit.type), ['five_hour', 'weekly', 'monthly'])
    assert.deepEqual(inline.limits.map((limit) => limit.tone), ['good', 'warn', 'bad'])
    assert.equal(inline.limits[0].percentUsed, 12.5)
    assert.equal(inline.limits[0].percentRemaining, 87.5)
    assert.equal(inline.limits[0].label, '5 小时')
    assert.ok(inline.limits[0].resetText.length > 0)
    assert.deepEqual(mock.state.quotaKeys, ['quota-key-1'])

    const cached = await gw.ops.quota()
    assert.equal(cached.cached, true)
    assert.equal(mock.state.quotaCalls, 1)

    const forced = await gw.ops.quota({ refresh: true })
    assert.equal(forced.cached, false)
    assert.equal(mock.state.quotaCalls, 2)
  } finally {
    await gw.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('quota: a refusal is reported as data, and an empty window list is not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-quota-refuse-'))
  const store = createConfig({ dataDir: dir })
  store.update({ baseUrl: mock.baseUrl, accounts: [{ name: 'inline-one', displayName: 'one', source: 'inline', enabled: true, key: 'quota-key-2' }] })
  const gw = createGateway({ configStore: store, portOverride: 0 })
  try {
    // `normalize` always keeps a `host` account, so the row under test is picked
    // by name rather than by position.
    const pick = (result) => result.accounts.find((row) => row.name === 'inline-one')
    mock.state.quotaMode = 'auth'
    const refused = await gw.ops.quota({ refresh: true })
    assert.equal(pick(refused).ok, false)
    assert.match(pick(refused).error, /HTTP 401/)
    assert.deepEqual(pick(refused).limits, [])

    mock.state.quotaMode = 'boom'
    const broken = await gw.ops.quota({ refresh: true })
    assert.equal(pick(broken).ok, false)
    assert.match(pick(broken).error, /HTTP 500/)

    mock.state.quotaMode = 'empty'
    const empty = await gw.ops.quota({ refresh: true })
    assert.equal(pick(empty).ok, true)
    assert.deepEqual(pick(empty).limits, [])
  } finally {
    await gw.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('quota: a window the gateway sent without a percentage stays unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-quota-partial-'))
  const store = createConfig({ dataDir: dir })
  store.update({ baseUrl: mock.baseUrl, accounts: [{ name: 'inline-one', displayName: 'one', source: 'inline', enabled: true, key: 'quota-key-3' }] })
  const gw = createGateway({ configStore: store, portOverride: 0 })
  try {
    mock.state.quotaMode = 'partial'
    const result = await gw.ops.quota({ refresh: true })
    const row = result.accounts.find((entry) => entry.name === 'inline-one')
    assert.equal(row.ok, true)
    assert.deepEqual(row.limits.map((limit) => limit.type), ['five_hour', 'weekly'])
    // Nothing was sent for the first window, so nothing may be claimed about it.
    assert.equal(row.limits[0].percentUsed, null)
    assert.equal(row.limits[0].percentRemaining, null)
    assert.equal(row.limits[1].percentUsed, 40)
    assert.equal(row.limits[1].percentRemaining, 60)
  } finally {
    await gw.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('quota: windows are normalized without inventing a number', () => {
  const quota = require('../src/quota.js')
  assert.equal(quota.toneFor(0), 'good')
  assert.equal(quota.toneFor(69.9), 'good')
  assert.equal(quota.toneFor(70), 'warn')
  assert.equal(quota.toneFor(89.9), 'warn')
  assert.equal(quota.toneFor(90), 'bad')
  assert.equal(quota.toneFor(Number.NaN), 'good')
  assert.equal(quota.resetText(-1), '已重置')
  assert.equal(quota.resetText(3 * 86400000 + 2 * 3600000), '3 天 2 小时')
  assert.equal(quota.resetText(5 * 3600000 + 10 * 60000), '5 小时 10 分')
  assert.equal(quota.resetText(42 * 60000), '42 分')
  // A percentage the gateway did not send stays unknown: the panel shows "—"
  // rather than claiming the window is untouched.
  const unknown = quota.normalizeLimit({ type: 'weekly' })
  assert.equal(unknown.percentUsed, null)
  assert.equal(unknown.percentRemaining, null)
  assert.equal(unknown.resetText, '')
  assert.equal(quota.normalizeLimit({ type: 'weekly', percentUsed: 150 }).percentUsed, 100)
  const ordered = quota.summarizeLimits([{ type: 'monthly', percentUsed: 1 }, { type: 'daily', percentUsed: 1 }, { type: 'five_hour', percentUsed: 1 }])
  assert.deepEqual(ordered.map((limit) => limit.type), ['five_hour', 'monthly', 'daily'])
  assert.equal(quota.summarizeAccount({ name: 'a', ok: true, limits: ordered }).tone, 'good')
  assert.equal(quota.summarizeAccount({ name: 'a', ok: true, limits: [] }).tone, 'unknown')
})

test('quota: two rows holding one key are flagged as one account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-quota-dup-'))
  const store = createConfig({ dataDir: dir })
  store.update({
    baseUrl: mock.baseUrl,
    accounts: [
      { name: 'one', displayName: 'one', source: 'inline', enabled: true, key: 'duplicate-key' },
      { name: 'two', displayName: 'two', source: 'inline', enabled: true, key: 'duplicate-key' },
      { name: 'three', displayName: 'three', source: 'inline', enabled: true, key: 'unique-key' },
    ],
  })
  const gw = createGateway({ configStore: store, portOverride: 0 })
  mock.state.quotaMode = 'ok'
  try {
    const result = await gw.ops.quota({ refresh: true })
    const byName = new Map(result.accounts.map((row) => [row.name, row]))
    // The panel has to be able to say "these two names are one account". The keys
    // themselves never leave the plugin — only this boolean and the mask do.
    assert.equal(byName.get('one').duplicate, true)
    assert.equal(byName.get('two').duplicate, true)
    assert.equal(byName.get('three').duplicate, false)
    assert.equal(byName.get('host').duplicate, false)
    assert.equal(byName.get('one').keyHint, byName.get('two').keyHint)
    assert.notEqual(byName.get('one').keyHint, byName.get('three').keyHint)
    // The list behind the panel's 账号池 tab carries the same flag.
    const listed = new Map(gw.ops.status('').accounts.map((row) => [row.name, row]))
    assert.equal(listed.get('two').duplicate, true)
    assert.equal(listed.get('three').duplicate, false)

    // Switching a twin off ends the collision: one account cannot be its own twin.
    store.update({
      accounts: [
        { name: 'one', displayName: 'one', source: 'inline', enabled: true, key: 'duplicate-key' },
        { name: 'two', displayName: 'two', source: 'inline', enabled: false, key: 'duplicate-key' },
      ],
    })
    const after = await gw.ops.quota({ refresh: true })
    assert.equal(after.accounts.find((row) => row.name === 'one').duplicate, false)
  } finally {
    await gw.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('accounts: an existing row can be renamed, re-keyed and re-labelled in place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picp-accounts-inplace-'))
  const store = createConfig({ dataDir: dir })
  store.update({
    baseUrl: mock.baseUrl,
    accounts: [
      { name: 'one', displayName: 'one', source: 'inline', enabled: true, key: 'first-secret' },
      { name: 'two', displayName: 'two', source: 'inline', enabled: true, key: 'second-secret' },
    ],
  })
  const gateway = createGateway({ configStore: store, portOverride: 0 })
  try {
    const renamed = await gateway.ops.accounts({ action: 'update', name: 'one', renameTo: 'uno', displayName: '一号', key: 'replacement-secret' })
    assert.equal(renamed.ok, true)
    assert.equal(renamed.name, 'uno')
    const row = renamed.accounts.find((entry) => entry.name === 'uno')
    assert.equal(row.displayName, '一号')
    assert.equal(row.keyConfigured, true)
    assert.match(row.keyHint, /\*\*\*/)
    assert.equal(renamed.accounts.some((entry) => entry.name === 'one'), false)
    // However the row is edited, the secret itself never comes back.
    assert.equal(JSON.stringify(renamed).includes('replacement-secret'), false)
    assert.equal(JSON.stringify(await gateway.ops.status('')).includes('replacement-secret'), false)

    // An empty key means "keep the one I have": renaming must not wipe it.
    const kept = await gateway.ops.accounts({ action: 'update', name: 'uno', renameTo: 'un', key: '' })
    assert.equal(kept.accounts.find((entry) => entry.name === 'un').keyHint, row.keyHint)

    // Names stay unique, and the virtual host row refuses to be renamed.
    await assert.rejects(() => gateway.ops.accounts({ action: 'update', name: 'un', renameTo: 'two' }), /already exists/)
    await assert.rejects(() => gateway.ops.accounts({ action: 'update', name: 'host', renameTo: 'nope' }), /cannot be renamed/)

    // Single mode pins one account by name, so the pin follows a rename.
    store.update({ accountMode: 'single', activeAccount: 'two' })
    await gateway.ops.accounts({ action: 'update', name: 'two', renameTo: 'dos' })
    assert.equal(store.get().activeAccount, 'dos')
    assert.equal(store.get().accountMode, 'single')
  } finally {
    await gateway.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
