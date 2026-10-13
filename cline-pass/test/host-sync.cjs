/**
 * host-sync - the plugin's only in-contract view of what the *host* really has.
 *
 * The plugin no longer declares a model: the user imports the config the panel
 * generates (`src/models.js`), and the host owns that row. Its model picker
 * reads the row, so when the row is stale - the observed case was an imported
 * provider whose secret went missing, or one the user disabled - every model of
 * it disappears from the picker while the gateway keeps answering requests, and
 * nothing the plugin can see from its own side changes. So the panel asks the
 * host directly with `pi.models.list()` (permission name: `models.list`) and
 * reports how many of the ids the generated config carries the host really
 * answers with.
 *
 * The last checks read `main.js` as text, the way `test/panel-wiring.cjs`
 * already does, to prove the panel's `status` branch really carries the result
 * and the `cline_pass_status` tool result was left alone.
 *
 * The second half covers the panel's 写入文件 action, which writes the generated
 * config to the one file it is allowed to reach: `models.json` inside a
 * directory the user picks. `globalThis.pi` is a stub there too, so the checks
 * can see exactly which path was handed to `pi.fs.writeText` and what happened
 * when the user cancels the directory picker.
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

/*
 * `main.js` destructures `importConfigPayload` when it loads, so the one way a
 * test can drive "the user ticked nothing" without loading the whole plugin
 * (data directory, real listening socket) is to wrap that export before
 * `main.js` is required. The wrapper is inert unless a check turns it on.
 */
const registry = require(path.join(__dirname, '..', 'src', 'models.js'))
const realImportConfigPayload = registry.importConfigPayload
let nothingTicked = false
registry.importConfigPayload = (settings) => {
  const payload = realImportConfigPayload(settings)
  if (nothingTicked) payload.providers[registry.IMPORT_PROVIDER_ID].models = []
  return payload
}

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
/*
 * The ids the panel feeds in are the ones the *generated config* carries: this
 * plugin no longer declares a model to the host (a plugin-declared model loses
 * `availableForSubagents` on the host's sync, so it could not be dispatched to a
 * subagent), and the user imports `importConfigPayload()` instead. So the set the
 * host-sync row reports on is that payload's model list.
 */
const IDS = registry.importConfigPayload().providers[registry.IMPORT_PROVIDER_ID].models.map((model) => model.id)

/* --------------------------- static wiring checks -------------------------- */

check(IDS.length === 5, `the generated config carries the 5 default models (found ${IDS.length})`)
check(manifest.contributes?.providers === undefined, 'the manifest declares no provider row at all')
check(manifest.permissions.includes('provider.register') === false, 'no provider declaration, so no provider.register permission')
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

/* -------------------- 写入 models.json：接线检查 --------------------------- */

/*
 * 面板的「写入文件」把生成好的导入配置写到 `%USERPROFILE%\.pi\agent\models.json`。
 * 那是插件数据目录之外的路径，唯一可达的机制是 `root: "userSelected"`
 * （`pi.fs.requestDirectory()` 让用户自己选目录，句柄只存在内存里、随进程结束失效）。
 * 宿主把 `fs.requestDirectory` 挂在 `fs.read` 权限下，写文件又要 `fs.write`，声明缺一条
 * 宿主就直接拒绝这次调用，所以这几条一起断言。
 */
check(main.PANEL_ACTIONS.includes('writeConfig'), "PANEL_ACTIONS carries the 'writeConfig' action")
check(/case 'writeConfig':/.test(panelBody), "onPanelInvoke has a 'writeConfig' branch (wiring check on main.js source)")
check(
  manifest.permissions.includes('fs.read'),
  'manifest.json declares fs.read — the host asserts it for fs.requestDirectory (plugin-runtime.ts)',
)
check(manifest.permissions.includes('fs.write'), 'manifest.json declares the fs.write permission (the high-risk one the user approves on reload)')
check(manifest.fs?.write?.root === 'userSelected', 'manifest.json sets fs.write.root to userSelected — the only way to reach ~/.pi')
check(manifest.fs?.read === undefined, 'manifest.json declares no fs.read rule, so no readable path is granted')
check(!/\bunlink|rmSync|rmdir|fs\.rm\b/.test(source), 'main.js never deletes a file (the panel only writes, wiring check)')

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
   * the shape main.js may rely on - and the registered ones are exactly the ids
   * the *generated config* carries, which is what the panel now reports on. */
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
    `the registered models are exactly the ${IDS.length} ids the generated config carries`,
  )
  // The panel feeds `generatedModelIds()`, which is built from that same payload:
  // the host-sync row can therefore never report on a different set of ids.
  check(
    /hostModelSync\(generatedModelIds\(\)\)/.test(statusBody),
    "the 'status' branch asks the host about the ids of the generated config (wiring check)",
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

  /* ------------------ 写入 models.json：唯一被授权的写目标 ------------------ */

  /*
   * 面板的「写入文件」是省掉复制粘贴的那一步：它只写 `models.json` 这一个文件名，
   * 落在用户通过 `pi.fs.requestDirectory()` 亲自选的目录里。下面用一个记录型 stub
   * 代替宿主，断言：写下的永远是 `models.json`、内容就是面板生成的那份配置、
   * 取消与任何异常都变成 `{ok:false,...}` 而不是抛给宿主。
   */
  const selectedDir = path.join('C:', 'Users', 'someone', '.pi', 'agent')
  const calls = { picked: 0, written: [] }
  let writeFails = ''
  const fsHost = (pick) => ({
    fs: {
      requestDirectory: async () => {
        calls.picked += 1
        if (pick instanceof Error) throw pick
        return pick
      },
      writeText: async (file, content) => {
        if (writeFails) throw new Error(writeFails)
        calls.written.push({ file, content })
      },
    },
  })
  /** Never let a throw escape: an unhandled rejection would hide every later check. */
  const writeConfig = async () => {
    try {
      return await main.onPanelInvoke(main.PANEL_CHANNEL, { action: 'writeConfig' })
    } catch (error) {
      return { threw: error instanceof Error ? error.message : String(error) }
    }
  }
  const noThrow = (result, label) => check(!('threw' in result), `${label} 不抛错${'threw' in result ? `（抛了：${result.threw}）` : ''}`)

  /* 0. 一个模型都没勾选：直接拒绝，不覆盖用户已经放好的 models.json */
  stubPi(fsHost(null))
  nothingTicked = true
  const unticked = await writeConfig()
  nothingTicked = false
  noThrow(unticked, '没有勾选模型')
  check(unticked.ok === false, `0 个模型 → ok:false（收到 ${JSON.stringify(unticked)}）`)
  check(
    /没有勾选任何模型/.test(String(unticked.error)) && /不覆盖/.test(String(unticked.error)),
    `拒绝的理由说清了：${JSON.stringify(unticked.error)}`,
  )
  check(calls.picked === 0 && calls.written.length === 0, '0 个模型时既不弹目录选择器也不写文件')
  /* 1. 用户取消目录选择：不写任何东西，也不抛 */
  stubPi(fsHost(null))
  const cancelled = await writeConfig()
  noThrow(cancelled, '取消目录选择')
  check(cancelled.ok === false, `取消 → ok:false（收到 ${JSON.stringify(cancelled)}）`)
  check(
    typeof cancelled.error === 'string' && /取消/.test(cancelled.error) && /\.pi/.test(cancelled.error),
    `取消时给出可操作的话：${JSON.stringify(cancelled.error)}`,
  )
  check(calls.picked === 1 && calls.written.length === 0, '取消后没有写下任何文件')

  /* 2. 目录选择器本身报错：同样只变成一条错误 */
  stubPi(fsHost(new Error('EACCES: dialog failed')))
  const pickerFailed = await writeConfig()
  noThrow(pickerFailed, '目录选择器报错')
  check(pickerFailed.ok === false && /dialog failed/.test(String(pickerFailed.error)), `目录选择失败的原因被带回来：${JSON.stringify(pickerFailed.error)}`)
  check(calls.written.length === 0, '目录没选成时也没有写任何文件')

  /* 3. 正常路径：只写一个 models.json，落在用户选的目录里，内容是面板生成的那份 */
  stubPi(fsHost({ path: selectedDir, name: 'agent' }))
  calls.picked = 0
  const written = await writeConfig()
  noThrow(written, '写入')
  check(written.ok === true, `写入成功 → ok:true（收到 ${JSON.stringify(written)}）`)
  check(calls.picked === 1, '第一次写入会弹一次目录选择器')
  check(calls.written.length === 1, `只写了一个文件（${calls.written.length}）`)
  const first = calls.written[0] ?? { file: '', content: '' }
  // `pi.fs.writeText(pathFromRoot, content)` resolves against the rule's root, so
  // the argument must be the bare file name: a path with a directory component
  // would be a second, unchecked place the reachable set could come from.
  check(first.file === 'models.json', `交给 fs.writeText 的就是字面量 models.json（${JSON.stringify(first.file)}）`)
  check(!first.file.includes('/') && !first.file.includes('\\'), '写下的路径不含任何目录成分')
  check(written.path === path.join(selectedDir, 'models.json'), `返回的 path 是用户所选目录下的 models.json（${written.path}）`)
  check(calls.written.every((item) => item.file === 'models.json'), '整个测试里除了 models.json 没有写过任何别的路径')
  let parsed = null
  try {
    parsed = JSON.parse(first.content)
  } catch {
    /* 报在下面的断言里 */
  }
  const writtenIds = parsed?.providers?.[registry.IMPORT_PROVIDER_ID]?.models?.map((model) => model.id) ?? []
  check(JSON.stringify(writtenIds) === JSON.stringify(IDS), `写下的内容可解析，且携带的模型与生成配置一致（${writtenIds.length}/${IDS.length}）`)
  check(written.models === IDS.length, `返回值里的模型数一致（${written.models} vs ${IDS.length}）`)
  check(written.bytes === Buffer.byteLength(first.content, 'utf8'), `bytes 是真实字节数（${written.bytes}）`)

  /* 4. 第二次点击复用进程内记住的目录：不再弹选择器 */
  const again = await writeConfig()
  noThrow(again, '第二次写入')
  check(again.ok === true && calls.picked === 1, `第二次不再弹目录选择器（picked=${calls.picked}）`)
  check(calls.written.length === 2 && path.basename(calls.written[1].file) === 'models.json', '第二次仍然只写 models.json')

  /* 5. 写失败（宿主拒绝、磁盘满、路径被占）：错误原样回来，不抛 */
  writeFails = 'EPERM: operation not permitted, open models.json'
  const refused = await writeConfig()
  writeFails = ''
  noThrow(refused, '写入失败')
  check(refused.ok === false && /EPERM/.test(String(refused.error)), `宿主的写入错误原样带回：${JSON.stringify(refused.error)}`)

  /* 6. 没有 fs API（旧宿主，或 fs.write 权限还没批准）：说清楚要声明什么、要重新加载 */
  stubPi({})
  const noFs = await writeConfig()
  noThrow(noFs, '宿主没有 fs API')
  check(
    noFs.ok === false && /fs\.write/.test(String(noFs.error)) && /重新加载/.test(String(noFs.error)),
    `缺 fs API 时点名 fs.write 与重新加载：${JSON.stringify(noFs.error)}`,
  )
  stubPi(undefined)
  const noHost = await writeConfig()
  noThrow(noHost, '没有宿主 pi')
  check(noHost.ok === false && String(noHost.error).length > 0, '没有 globalThis.pi 时同样只回一条错误')
  check(calls.written.length === 2, '以上失败路径一个文件都没写')

  /* restore whatever was here before this file ran */
  stubPi(realPi)

  console.log('\n' + (failures === 0 ? 'HOST SYNC OK' : `FAILURES: ${failures}`))
  if (failures !== 0) process.exitCode = 1
}
