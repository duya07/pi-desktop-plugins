/**
 * host-sync - the plugin's only in-contract view of what the *host* really has.
 *
 * A PI-Desktop plugin can only *declare* a provider; the host owns the row in
 * `pi.sqlite` and its model picker. When that row is stale - the observed case
 * was `auth_kind='api_key'` with no secret - every model of this provider
 * disappears from the picker while the gateway keeps answering requests, and
 * nothing the plugin can see from its own side changes. So the panel asks the
 * host directly with `pi.models.list()` (permission name: `models.list`) and
 * reports the count of declared ids the host actually answers with.
 *
 * The last checks read `main.js` as text, the way `test/panel-wiring.cjs`
 * already does, to prove the panel's `status` branch really carries the result
 * and the `cline_pass_status` tool result was left alone.
 *
 * Pure Node, no host, no gateway, no network: `globalThis.pi` is a stub and
 * nothing is started.
 *
 *   node test/host-sync.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAIN = path.join(__dirname, '..', 'main.js')
const MANIFEST = path.join(__dirname, '..', 'manifest.json')

const main = require(MAIN)
const hostModelSync = main.hostModelSync

let failures = 0
const check = (ok, text) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + text)
}

/** The shape `hostModelSync` promises, whatever the outcome. */
const isShape = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof value.ok === 'boolean' &&
  typeof value.synced === 'number' &&
  typeof value.total === 'number' &&
  Array.isArray(value.missing) &&
  typeof value.error === 'string'

/** Compare the promised fields, and say which one was wrong instead of just "false". */
function expect(label, actual, wanted) {
  if (!isShape(actual)) {
    check(false, `${label} — not the promised shape: ${JSON.stringify(actual)}`)
    return
  }
  const wrong = []
  for (const [key, want] of Object.entries(wanted)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(want)) {
      wrong.push(`${key}=${JSON.stringify(actual[key])} (want ${JSON.stringify(want)})`)
    }
  }
  check(wrong.length === 0, label + (wrong.length === 0 ? '' : ' — ' + wrong.join('; ')))
}

/* ------------------------------- the stubs ------------------------------- */

/** No field may ever be NaN, whatever the input. */
const numberSafe = (value) => Number.isFinite(value.total) && Number.isFinite(value.synced) && !/NaN/.test(JSON.stringify(value))

const realPi = globalThis.pi
const stubPi = (value) => {
  if (value === undefined) delete globalThis.pi
  else globalThis.pi = value
}

/** A host entry exactly as `models.list` returns one. */
const entry = (id) => ({
  key: `cline-pass/${id}`,
  providerId: 'cline-pass',
  providerName: 'Cline Pass（本地网关）',
  modelId: id,
  label: id,
  alias: undefined,
  availableForSubagents: true,
  isDefault: false,
  supportsReasoning: true,
  thinkingLevels: ['off', 'low', 'high', 'max'],
})

/** A model belonging to somebody else. */
const foreign = (providerId, modelId) => ({ key: `${providerId}/${modelId}`, providerId, modelId, label: modelId })

const manifestText = fs.readFileSync(MANIFEST, 'utf8')
const manifest = JSON.parse(manifestText)
const IDS = manifest.contributes.providers[0].models.map((model) => model.id)

/* --------------------------- static wiring checks -------------------------- */

check(IDS.length === 5, `the manifest declares 5 models (found ${IDS.length})`)
check(Array.isArray(manifest.permissions) && manifest.permissions.includes('models.list'), 'manifest.json lists the models.list permission')

const source = fs.readFileSync(MAIN, 'utf8')
const panelAt = source.indexOf('async function onPanelInvoke')
const panelBody = panelAt === -1 ? '' : source.slice(panelAt, source.indexOf('\nmodule.exports', panelAt))
const statusAt = panelBody.indexOf("case 'status':")
const statusBody = statusAt === -1 ? '' : panelBody.slice(statusAt, panelBody.indexOf("case 'probe':", statusAt))
check(
  /host:\s*await\s+hostModelSync\(/.test(statusBody),
  "the panel 'status' branch carries `host: await hostModelSync(...)` (wiring check on main.js source)",
)
check(/ok:\s*true/.test(statusBody) && /status:/.test(statusBody), "the panel 'status' branch still returns ok + status (wiring check)")
check(!statusBody.includes('throw'), "the panel 'status' branch adds no throw (wiring check)")

const toolsAt = source.indexOf('async function runTool')
const toolsBody = toolsAt === -1 ? '' : source.slice(toolsAt, source.indexOf('/* -------------------------------- lifecycle', toolsAt))
check(toolsBody !== '' && !/hostModelSync|host:/.test(toolsBody), 'the cline_pass_status tool result is untouched (no host field, wiring check)')
check(/module\.exports[\s\S]*\bhostModelSync\b/.test(source), 'main.js exports hostModelSync (wiring check)')

if (typeof hostModelSync !== 'function') {
  console.log(`\nFAILURES: ${failures === 0 ? 1 : failures}`)
  process.exitCode = 1
} else {
  void run()
}

/* ------------------------------ behaviour ------------------------------- */

async function run() {
  /* 0. the ids the panel feeds in: `gw.ops.models()` is `status().models`,
   * which is `effectiveModels()` (src/models.js) with `id` and `registered`
   * passed through verbatim (src/gateway.js `models:`), so these two fields are
   * the shape main.js may rely on - and the registered ones must be exactly the
   * ids this manifest declares. */
  const registry = require(path.join(__dirname, '..', 'src', 'models.js'))
  const effective = registry.effectiveModels()
  check(
    effective.length > 0 && effective.every((model) => typeof model.id === 'string' && model.id !== ''),
    `every gateway model carries a usable id (${effective.length} models)`,
  )
  check(
    effective.every((model) => typeof model.registered === 'boolean'),
    'every gateway model carries the registered flag the panel filters on',
  )
  check(
    effective.filter((model) => model.registered).length === IDS.length &&
      effective.filter((model) => model.registered).every((model) => IDS.includes(model.id)),
    `the registered models are exactly the ${IDS.length} ids the manifest declares`,
  )

  /* 1. the happy path: every declared id is in the host's listing */
  stubPi({ models: { list: async () => IDS.map(entry) } })
  const all = await hostModelSync(IDS)
  expect('every declared id present → ok:true, synced 5/5, no missing', all, {
    ok: true,
    synced: 5,
    total: 5,
    missing: [],
    error: '',
  })
  check(Object.isFrozen(all), 'the result is frozen, so a caller cannot quietly rewrite it')

  /* 2. the host knows this provider but has no model: 0 of 5 */
  stubPi({ models: { list: async () => [] } })
  expect('an empty host listing → ok:true, 0 synced, every id missing in order', await hostModelSync(IDS), {
    ok: true,
    synced: 0,
    total: 5,
    missing: IDS,
    error: '',
  })

  /* 3. other providers' models are not ours */
  stubPi({
    models: {
      list: async () => [
        foreign('openai', 'gpt-5.1'),
        entry(IDS[2]),
        foreign('anthropic', 'claude-sonnet-4.5'),
        // Same tail as one of ours, but a different provider's model: matching
        // on the tail alone would count this as ours.
        { providerId: 'openai', modelId: 'deepseek-v4.1-flash', key: 'openai/deepseek-v4.1-flash' },
        foreign('cline-pass', 'mimo-v2.6-pro'),
      ],
    },
  })
  expect('another provider\'s models are not counted as synced', await hostModelSync(IDS), {
    ok: true,
    synced: 1,
    total: 5,
    missing: IDS.filter((id) => id !== IDS[2]),
    error: '',
  })

  /* 4a. the host's own key spelling: `${providerId}/${modelId}` with our ids */
  stubPi({ models: { list: async () => IDS.map((id) => ({ key: `cline-pass/${id}` })) } })
  expect('entries that carry only a nested key still match', await hostModelSync(IDS), {
    ok: true,
    synced: 5,
    total: 5,
    missing: [],
    error: '',
  })

  /* 4b. and an implementation that puts the bare id in `key` */
  stubPi({ models: { list: async () => IDS.map((id) => ({ key: id, providerId: 'cline-pass' })) } })
  expect('an entry whose key is the bare declared id matches', await hostModelSync(IDS), {
    ok: true,
    synced: 5,
    total: 5,
    missing: [],
    error: '',
  })

  /* 5. the host refuses the call (missing permission is the usual reason) */
  stubPi({
    models: {
      list: async () => {
        throw new Error('PERMISSION_DENIED: models.list')
      },
    },
  })
  const thrown = await hostModelSync(IDS)
  expect('a throwing models.list → ok:false, nothing synced, every id missing', thrown, {
    ok: false,
    synced: 0,
    total: 5,
    missing: IDS,
  })
  check(thrown.error.includes('PERMISSION_DENIED'), `the host's message survives: ${JSON.stringify(thrown.error)}`)
  check(thrown.error.length <= 240 && !/\n\s*at /.test(thrown.error), 'the failure is one short line, not a stack')

  stubPi({
    models: {
      list: async () => {
        throw new Error('x'.repeat(900))
      },
    },
  })
  const huge = await hostModelSync(IDS)
  check(isShape(huge) && huge.ok === false && huge.error.length <= 240, `a 900-character message is truncated (${huge.error.length} chars)`)

  /* 6. no host API at all: old host, or the permission is not granted yet */
  stubPi({})
  const bare = await hostModelSync(IDS)
  expect('no pi.models → ok:false, every id missing', bare, { ok: false, synced: 0, total: 5, missing: IDS })
  check(
    /models\.list/.test(bare.error) && /(权限|permission)/i.test(bare.error) && /重新加载/.test(bare.error),
    `the error names models.list, the permission and a reload: ${JSON.stringify(bare.error)}`,
  )

  stubPi({ models: {} })
  const noList = await hostModelSync(IDS)
  check(isShape(noList) && noList.ok === false && noList.error.length > 0, 'an empty pi.models is treated as unavailable')

  stubPi(undefined)
  const noPi = await hostModelSync(IDS)
  check(isShape(noPi) && noPi.ok === false && noPi.missing.length === IDS.length, 'a missing global pi does not throw')

  /* 7. the host answers with something that is not a list */
  stubPi({ models: { list: async () => null } })
  const nul = await hostModelSync(IDS)
  expect('a null listing → ok:false, every id missing', nul, { ok: false, synced: 0, total: 5, missing: IDS })
  check(nul.error.length > 0, `a null listing says why: ${JSON.stringify(nul.error)}`)

  stubPi({ models: { list: async () => ({ models: IDS }) } })
  const obj = await hostModelSync(IDS)
  check(isShape(obj) && obj.ok === false && obj.synced === 0, 'an object listing → ok:false, not a crash')

  /* 8. junk inside a real listing must not match or crash */
  stubPi({ models: { list: async () => [null, undefined, 'cline-pass/kimi-k3', 42, { key: `${IDS[3]}` }] } })
  expect('junk rows are skipped, the one real row still counts', await hostModelSync(IDS), {
    ok: true,
    synced: 1,
    total: 5,
    missing: IDS.filter((id) => id !== IDS[3]),
    error: '',
  })

  /* 9. no declared ids and non-arrays: never NaN */
  stubPi({ models: { list: async () => IDS.map(entry) } })
  expect('an empty id list → ok:true, total 0', await hostModelSync([]), { ok: true, synced: 0, total: 0, missing: [], error: '' })
  const missingArg = await hostModelSync(undefined)
  expect('a missing id list → ok:true, total 0', missingArg, { ok: true, synced: 0, total: 0, missing: [], error: '' })
  const notArray = await hostModelSync('cline-pass/kimi-k3')
  check(
    isShape(notArray) && Number.isFinite(notArray.total) && !/NaN/.test(JSON.stringify(notArray)),
    'a non-array id list falls back to [] instead of producing NaN',
  )
  const odd = await hostModelSync([42, null])
  check(isShape(odd) && Number.isFinite(odd.total) && odd.missing.length === 2, 'non-string ids neither throw nor change the shape')

  stubPi(undefined)
  const nothing = await hostModelSync(undefined)
  check(isShape(nothing) && numberSafe(nothing), 'no host and no ids still answers with the promised shape')

  /* restore whatever was here before this file ran */
  stubPi(realPi)

  console.log('\n' + (failures === 0 ? 'HOST SYNC OK' : `FAILURES: ${failures}`))
  if (failures !== 0) process.exitCode = 1
}
