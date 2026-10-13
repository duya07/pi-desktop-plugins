/**
 * Asserts the model-parameter card actually works, without a browser.
 *
 * The card is a plain ES5 script inside `renderer/index.html`, so this harness
 * slices that block out of the live file, runs it against a tiny fake DOM and
 * checks what a user would notice:
 *
 *   - the 默认档位 dropdown has options at all. It used to come out blank and
 *     `disabled` because the card read its level checkboxes through a root-node
 *     lookup before the card was attached to the document; the candidates now
 *     come from the card's own `.levels` container, so a detached card still
 *     fills the select;
 *   - the 上下文窗口 / 最大输出 preset chips write their value into the number
 *     box and highlight themselves, and a hand-typed value no preset matches
 *     leaves every chip unhighlighted;
 *   - 显示名（别名）starts on the model name and never submits an empty name;
 *   - the 宿主专有能力 block is read-only: every checkbox disabled, no
 *     data-field, nothing to submit;
 *   - a save carries exactly the fields that were edited (never the untouched
 *     thinkingLevels / maxTokens / supportsImages / registered), the alias
 *     travels as `patch.name`, and 思考档位 without `off` is refused locally.
 *
 *   node test/render-model-card.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html')
const PAGE = fs.readFileSync(RENDERER, 'utf8')

/* ---------- slice the model-parameter block out of the panel script ---------- */
const scriptOpen = PAGE.indexOf('<script>', PAGE.indexOf('</head>'))
const scriptClose = PAGE.lastIndexOf('</script>')
const pageScript = PAGE.slice(PAGE.indexOf('>', scriptOpen) + 1, scriptClose)
// Anchor on the label only: the banner's wording is decoration, the block's
// position between this banner and the next one is what this test needs.
const start = pageScript.search(/\/\* -+ 模型参数/)
if (start < 0) throw new Error('model-parameter block not found in the panel script')
const tail = pageScript.slice(start)
const end = tail.search(/\/\* -+ 用量 -+ \*\//)
if (end < 0) throw new Error('the block after the model-parameter one was not found')
const chunk = tail.slice(0, end)

/* ---------- a fake DOM, just enough for this card ---------- */
function dataKey(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}
function attrOf(node, name) {
  if (name.slice(0, 5) === 'data-') return node.dataset ? node.dataset[dataKey(name)] : undefined
  return node[name]
}
/* tag / #id / .class / [attr] / [attr="value"], in any combination - no descendants. */
const SELECTOR = /^(?:([a-z0-9]+))?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/
function matches(node, selector) {
  const m = SELECTOR.exec(selector)
  if (!m || node.nodeType !== 1) return false
  if (m[1] && node.tagName !== m[1]) return false
  if (m[2] && node.id !== m[2]) return false
  if (m[3] && (' ' + node.className + ' ').indexOf(' ' + m[3] + ' ') < 0) return false
  if (m[4]) {
    const value = attrOf(node, m[4])
    if (m[5] === undefined) {
      if (value === undefined || value === null) return false
    } else if (String(value) !== m[5]) return false
  }
  return true
}
function el(tag) {
  const name = String(tag).toLowerCase()
  let own = ''
  const e = {
    tagName: name,
    nodeType: 1,
    id: '',
    className: '',
    title: '',
    type: '',
    value: '',
    checked: false,
    disabled: false,
    placeholder: '',
    maxLength: 0,
    min: '',
    max: '',
    open: false,
    selected: false,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    listeners: {},
    onclick: null,
    onchange: null,
    addEventListener(type, handler) { (e.listeners[type] = e.listeners[type] || []).push(handler) },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = e
      e.children.push(child)
      return child
    },
    removeChild(child) {
      const at = e.children.indexOf(child)
      if (at >= 0) e.children.splice(at, 1)
      if (child.parentNode === e) child.parentNode = null
      return child
    },
    replaceChild(next, old) {
      const at = e.children.indexOf(old)
      if (at < 0) return e.appendChild(next)
      if (next.parentNode) next.parentNode.removeChild(next)
      e.children[at] = next
      next.parentNode = e
      old.parentNode = null
      return old
    },
    querySelector(selector) {
      const found = e.querySelectorAll(selector)
      return found.length > 0 ? found[0] : null
    },
    querySelectorAll(selector) {
      const found = []
      walk(e, (node) => { if (node !== e && matches(node, selector)) found.push(node) })
      return found
    },
    closest(selector) {
      let node = e
      while (node) {
        if (matches(node, selector)) return node
        node = node.parentNode
      }
      return null
    },
    contains(other) {
      let node = other
      while (node) {
        if (node === e) return true
        node = node.parentNode
      }
      return false
    },
    setAttribute(attribute, value) { e.attributes[attribute] = String(value) },
    focus() {},
    scrollIntoView() {},
    get firstChild() { return e.children.length > 0 ? e.children[0] : null },
  }
  Object.defineProperty(e, 'textContent', {
    get() { return own },
    set(value) {
      own = String(value)
      e.children.forEach((child) => { child.parentNode = null })
      e.children = []
    },
  })
  /* A select behaves like the browser's: its value is the selected option's
     value, and the first option counts as selected until something else is.
     Setting a value no option has leaves the select empty - that is what makes
     "the dropdown is blank" detectable. */
  if (name === 'select') {
    Object.defineProperty(e, 'value', {
      get() {
        const options = e.children.filter((child) => child.tagName === 'option')
        const picked = options.filter((option) => option.selected)[0]
        if (picked) return picked.value
        if (e.stale === true) return ''
        return options.length > 0 ? options[0].value : ''
      },
      set(next) {
        const wanted = String(next)
        let hit = false
        e.children.forEach((child) => {
          if (child.tagName !== 'option') return
          child.selected = child.value === wanted
          if (child.selected) hit = true
        })
        e.stale = !hit
      },
    })
    const append = e.appendChild
    e.appendChild = function (child) {
      if (child && child.tagName === 'option') e.stale = false
      return append.call(e, child)
    }
  }
  return e
}
function flat(node) {
  let out = node.textContent || ''
  ;(node.children || []).forEach((child) => { out += ' ' + flat(child) })
  return out.replace(/\s+/g, ' ').trim()
}
function walk(node, visit) {
  visit(node)
  ;(node.children || []).forEach((child) => walk(child, visit))
}
function collect(root, predicate) {
  const found = []
  walk(root, (node) => { if (predicate(node)) found.push(node) })
  return found
}

const elements = {}
const roots = []
const doc = {
  activeElement: null,
  createElement: (tag) => el(tag),
  createTextNode: (value) => ({ nodeType: 3, textContent: String(value), children: [] }),
  getElementById: (id) => elements[id] || null,
  querySelector: (selector) => doc.querySelectorAll(selector)[0] || null,
  querySelectorAll: (selector) => {
    const found = []
    roots.forEach((root) => walk(root, (node) => { if (matches(node, selector)) found.push(node) }))
    return found
  },
  contains: (node) => {
    let cursor = node
    while (cursor) {
      if (roots.indexOf(cursor) >= 0) return true
      cursor = cursor.parentNode
    }
    return false
  },
}

/* ---------- the dependencies that live outside the sliced block ---------- */
const logs = []
const sent = []
const busyLabels = []
const timers = []
const state = { status: null, model: '', openModels: {} }
const log = (text) => { logs.push(String(text)) }
const run = (payload) => { sent.push(payload); return Promise.resolve(null) }
const release = (promise) => promise
const beginBusy = (label) => { busyLabels.push(label); return true }
const endBusy = () => {}
const renderStatus = () => {}
/* flashField schedules its own cleanup: recording the callback instead of
   running it keeps the hint on screen for the assertion. */
const win = {
  setTimeout: (handler) => { timers.push(handler); return timers.length },
  setInterval: () => 0,
  clearInterval: () => {},
}

const factory = new Function('state', 'document', 'window', 'log', 'run', 'release', 'beginBusy', 'endBusy', 'renderStatus',
  chunk + '\nreturn { modelSettingsCard: modelSettingsCard, renderModelSettings: renderModelSettings, formValues: formValues, formProblem: formProblem, patchKeys: patchKeys, saveModel: saveModel, restoreModel: restoreModel, checkedLevels: checkedLevels, syncPresetHighlight: syncPresetHighlight, sameLevels: sameLevels, flashField: flashField, LEVELS: LEVELS, CW_PRESETS: CW_PRESETS, MAX_PRESETS: MAX_PRESETS, LIMITS: LIMITS };')
const api = factory(state, doc, win, log, run, release, beginBusy, endBusy, renderStatus)

/* ---------- assertion plumbing, and the little interactions a user performs ---------- */
let failures = 0
let total = 0
function check(ok, text) {
  total += 1
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + text)
}
function click(node) {
  if (!node) throw new Error('click() got nothing')
  if (typeof node.onclick !== 'function') throw new Error('click() on a control with no onclick: ' + node.tagName + ' .' + node.className)
  node.onclick.call(node)
  return node
}
function fire(node, type) {
  ;(node.listeners[type] || []).slice().forEach((handler) => handler.call(node, {}))
  return node
}
function toggle(box, on) {
  box.checked = on
  if (typeof box.onchange === 'function') box.onchange()
  fire(box, 'change')
  return box
}
const ON = /(^|\s)on(\s|$)/
function fieldOf(card, name) { return card.querySelector('[data-field="' + name + '"]') }
function chipsOf(card, name) {
  const input = fieldOf(card, name)
  return input && input.parentNode ? input.parentNode.querySelector('.preset-chips') : null
}
function chipButtons(chips) { return chips ? collect(chips, (n) => n.tagName === 'button') : [] }
function chipLabels(chips) { return chipButtons(chips).map((b) => b.textContent).join('|') }
function onChips(chips) {
  return chipButtons(chips).filter((b) => ON.test(b.className)).map((b) => b.textContent).join('|')
}
function buttonNamed(card, text) { return collect(card, (n) => n.tagName === 'button' && n.textContent === text)[0] }
function lastLog() { return logs.length > 0 ? logs[logs.length - 1] : '(no log line)' }

/* ---------- the model the panel would send for a thinking-capable model ---------- */
function fixture(over) {
  return Object.assign({
    id: 'claude-sonnet-4.5',
    name: 'Sonnet 4.5',
    registered: true,
    contextWindow: 128000,
    maxTokens: 8000,
    supportsImages: true,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    defaultThinkingLevel: 'low',
    lever: 'levels',
    published: { contextWindow: 200000, maxTokens: 64000, supportsImages: true, thinkingLevels: ['off', 'low'] },
    edited: [],
  }, over)
}

/* 1. 默认档位: the dropdown is usable, and it is filled from the card's own
      levels container - this whole card is detached, so a root-node lookup
      would come back with zero candidates and leave the select blank. */
const card1 = api.modelSettingsCard(fixture())
const def1 = fieldOf(card1, 'defaultThinkingLevel')
const options1 = () => def1.children.filter((n) => n.tagName === 'option').map((n) => n.value)
check(def1 !== null && def1.tagName === 'select', 'the card builds a 默认档位 <select>')
check(card1.parentNode === null, 'this card was never appended to a document (the state the blank-dropdown bug came from)')
check(options1().length === 5, 'the dropdown holds 5 options - the 4 checked levels plus omit - not 0 (got ' + options1().join('/') + ')')
check(options1().join('|') === 'off|low|high|max|omit', 'the options are off / low / high / max / omit')
check(def1.disabled === false, 'the select is enabled (an empty candidate list is what used to disable it)')
check(def1.value === 'low', 'the current pick is the model default low (got "' + def1.value + '")')
const omitOption = def1.children.filter((n) => n.tagName === 'option' && n.value === 'omit')[0]
check(omitOption !== undefined && omitOption.textContent === 'omit（不发送思考字段）', 'omit is labelled 不发送思考字段, not offered as a real level')
const cardOff = api.modelSettingsCard(fixture({ id: 'off-only', thinkingLevels: ['off'], defaultThinkingLevel: 'off' }))
const defOff = fieldOf(cardOff, 'defaultThinkingLevel')
const offOptions = defOff.children.filter((n) => n.tagName === 'option').map((n) => n.value)
check(offOptions.join('|') === 'off' && defOff.disabled === false, 'a model with only off gets the single option off and no omit (got ' + offOptions.join('/') + ')')

/* 2. 上下文窗口 preset chips */
const chipCard = api.modelSettingsCard(fixture())
const cw = fieldOf(chipCard, 'contextWindow')
const cwChips = chipsOf(chipCard, 'contextWindow')
check(cw !== null && cw.type === 'number' && cw.value === '128000', 'the 上下文窗口 number box starts on the model window (got "' + (cw && cw.value) + '")')
check(chipLabels(cwChips) === '128k|256k|312k|500k|1M', 'the window presets are 128k / 256k / 312k / 500k / 1M (got ' + chipLabels(cwChips) + ')')
check(cwChips !== null && cwChips.parentNode === cw.parentNode, 'the chips and the number box sit in the same control')
check(onChips(cwChips) === '128k', 'the chip matching the model window is highlighted when the card opens (got ' + onChips(cwChips) + ')')
click(chipButtons(cwChips)[3])
check(cw.value === '500000', 'clicking 500k writes 500000 into the box (got "' + cw.value + '")')
check(onChips(cwChips) === '500k', 'and 500k is the chip left highlighted (got ' + onChips(cwChips) + ')')
cw.value = '12345'
fire(cw, 'input')
check(onChips(cwChips) === '', 'a hand-typed 12345 leaves every chip unhighlighted (got ' + onChips(cwChips) + ')')

/* 3. 最大输出 preset chips */
const maxCard = api.modelSettingsCard(fixture())
const max = fieldOf(maxCard, 'maxTokens')
const maxChips = chipsOf(maxCard, 'maxTokens')
check(max !== null && max.type === 'number' && max.value === '8000', 'the 最大输出 number box starts on the model cap (got "' + (max && max.value) + '")')
check(chipLabels(maxChips) === '4k|8k|16k|32k|128k', 'the output presets are 4k / 8k / 16k / 32k / 128k (got ' + chipLabels(maxChips) + ')')
check(onChips(maxChips) === '8k', 'the chip matching the model cap is highlighted when the card opens (got ' + onChips(maxChips) + ')')
click(chipButtons(maxChips)[4])
check(max.value === '128000', 'clicking 128k writes 128000 into the box (got "' + max.value + '")')
check(onChips(maxChips) === '128k', 'and 128k is the chip left highlighted (got ' + onChips(maxChips) + ')')

/* 4. 显示名（别名）: on the card, filled with the model name, never silently emptied */
const aliasCard = api.modelSettingsCard(fixture())
const alias = fieldOf(aliasCard, 'alias')
const aliasSave = buttonNamed(aliasCard, '保存模型参数')
check(alias !== null && alias.type === 'text', 'the card carries a text field for the alias')
check(alias !== null && alias.value === 'Sonnet 4.5', 'its initial value is the model name (got "' + (alias && alias.value) + '")')
check(flat(aliasCard).indexOf('显示名（别名）') >= 0, 'the field is labelled 显示名（别名）')
check(aliasSave !== undefined, 'the card offers a 保存模型参数 button')
let mark = sent.length
alias.value = ''
click(aliasSave)
check(sent.length === mark, 'clearing the name and saving sends no request (got ' + (sent.length - mark) + ')')
const aliasHint = collect(aliasCard, (n) => n.className === 'flash-hint')[0]
check(aliasHint !== undefined && aliasHint.textContent.indexOf('显示名') >= 0 && aliasHint.textContent.indexOf('Sonnet 4.5') >= 0,
  'the user is told why, with the kept name: "' + (aliasHint ? aliasHint.textContent : '(no hint)') + '"')
check(lastLog().indexOf('没有提交') >= 0, 'and the log says nothing was submitted: "' + lastLog() + '"')
const longCard = api.modelSettingsCard(fixture())
fieldOf(longCard, 'alias').value = 'x'.repeat(61)
mark = sent.length
click(buttonNamed(longCard, '保存模型参数'))
check(sent.length === mark && lastLog().indexOf('显示名最多 60 字符') >= 0,
  'a 61-character name is refused in the card instead of being cut off later: "' + lastLog() + '"')

/* 5. 宿主专有能力: listed, read-only, with no submit path */
const hostCard = api.modelSettingsCard(fixture())
const hostBox = collect(hostCard, (n) => n.className === 'host-only')[0]
check(hostBox !== undefined, 'the card has a 宿主专有能力 block')
const hostItems = collect(hostCard, (n) => n.className === 'host-only-item')
check(hostItems.length === 5, 'it lists five host-only capabilities (got ' + hostItems.length + ')')
const hostText = hostItems.map((n) => flat(n)).join(' | ')
check(['思考协议', 'PDF', '可供 AI 自动调度', '原生联网搜索', '设为生图模型'].every((word) => hostText.indexOf(word) >= 0),
  'the five rows are 思考协议 / PDF / 可供 AI 自动调度 / 原生联网搜索 / 设为生图模型')
const hostBoxes = collect(hostBox, (n) => n.tagName === 'input')
check(hostBoxes.length === 5 && hostBoxes.every((box) => box.type === 'checkbox' && box.disabled === true),
  'every control in that block is a disabled checkbox (read-only)')
check(hostBoxes.every((box) => box.dataset.field === undefined), 'and none of them carries a data-field, so the block has no submit path at all')

/* 6. the save patch carries exactly the edited fields */
const patchCard = api.modelSettingsCard(fixture())
const patchAlias = fieldOf(patchCard, 'alias')
const patchChips = chipsOf(patchCard, 'contextWindow')
const patchSave = buttonNamed(patchCard, '保存模型参数')
mark = sent.length
click(patchSave)
check(sent.length === mark, 'a save with nothing edited sends no request')
check(lastLog().indexOf('没有改动') >= 0, 'and says so: "' + lastLog() + '"')
patchAlias.value = '新名字'
click(chipButtons(patchChips)[3])
click(patchSave)
const patch = sent[sent.length - 1]
check(sent.length === mark + 1 && patch !== undefined, 'editing 别名 + 上下文窗口 and saving sends exactly one request (got ' + (sent.length - mark) + ')')
check(patch !== undefined && Object.keys(patch).sort().join('|') === 'action|contextWindow|model|name',
  'the patch holds only those two edits plus the routing keys (got ' + (patch ? Object.keys(patch).sort().join('|') : '(none)') + ')')
check(patch !== undefined && patch.name === '新名字' && patch.alias === undefined, 'the alias travels as patch.name, not as patch.alias')
check(patch !== undefined && patch.contextWindow === 500000 && patch.maxTokens === undefined && patch.thinkingLevels === undefined
  && patch.supportsImages === undefined && patch.registered === undefined && patch.defaultThinkingLevel === undefined,
  'the untouched fields stay out of the patch')
check(patch !== undefined && patch.supportsDocuments === undefined && patch.nativeWebSearch === undefined
  && patch.availableForSubagents === undefined && patch.imageGen === undefined,
  'the host-only capabilities never reach the patch')
check(patch !== undefined && patch.action === 'setModel' && patch.model === 'claude-sonnet-4.5', 'action + model route the patch to this one model')

/* 7. 思考档位 rules, and the dropdown following the ticks */
const ruleCard = api.modelSettingsCard(fixture())
const ruleDef = fieldOf(ruleCard, 'defaultThinkingLevel')
const ruleOptions = () => ruleDef.children.filter((n) => n.tagName === 'option').map((n) => n.value)
const levelBoxes = collect(ruleCard, (n) => n.tagName === 'input' && n.dataset.level !== undefined)
check(levelBoxes.length === 7 && levelBoxes.filter((box) => box.checked).length === 4,
  'the 思考档位 row offers all seven host levels and ticks the four the model has (got ' + levelBoxes.filter((box) => box.checked).length + ' ticked)')
check(ruleOptions().join('|') === 'off|low|high|max|omit', 'before any toggle the candidates are the four ticked levels + omit')
toggle(levelBoxes.filter((box) => box.dataset.level === 'high')[0], false)
check(ruleOptions().join('|') === 'off|low|max|omit', 'unticking high drops it from the 默认档位 candidates (got ' + ruleOptions().join('|') + ')')
check(ruleDef.value === 'low', 'and the current pick survives that rebuild (got "' + ruleDef.value + '")')
toggle(levelBoxes.filter((box) => box.dataset.level === 'high')[0], true)
toggle(levelBoxes.filter((box) => box.dataset.level === 'off')[0], false)
check(ruleOptions().indexOf('off') < 0, 'unticking off removes it from the candidates too (got ' + ruleOptions().join('|') + ')')
mark = sent.length
click(buttonNamed(ruleCard, '保存模型参数'))
check(sent.length === mark, 'saving a model whose levels lost off is refused: no request is sent (got ' + (sent.length - mark) + ')')
check(lastLog().indexOf('off') >= 0, 'the refusal names off: "' + lastLog() + '"')
toggle(levelBoxes.filter((box) => box.dataset.level === 'off')[0], true)
check(ruleOptions().length === 5 && ruleDef.value === 'low', 're-ticking off brings the candidate back (5 options) with low still picked')
const rangeCard = api.modelSettingsCard(fixture())
fieldOf(rangeCard, 'contextWindow').value = '10'
mark = sent.length
click(buttonNamed(rangeCard, '保存模型参数'))
check(sent.length === mark && lastLog().indexOf('上下文窗口要填') >= 0, 'a window below the host minimum is refused in the card: "' + lastLog() + '"')

/* 8. regression guard: where the candidates come from */
check(/var candidates = checkedLevels\(levels\);/.test(chunk), 'the candidates are read from the card\'s own .levels container (var candidates = checkedLevels(levels))')
check(chunk.indexOf('checkedLevels(entry)') < 0, 'the old root-node lookup checkedLevels(entry) is gone from the model-card block')

/* 9. the list-level wiring: cards are built, kept, and rebuilt only when they change */
const listHost = el('div')
listHost.id = 'model-settings-list'
elements['model-settings-list'] = listHost
roots.push(listHost)
state.status = { models: [fixture(), fixture({ id: 'gpt-5', name: 'GPT-5' })] }
state.model = 'claude-sonnet-4.5'
const cardNodes = () => collect(listHost, (n) => n.tagName === 'details' && /(^|\s)model-entry(\s|$)/.test(n.className))
api.renderModelSettings(true)
check(cardNodes().length === 2, 'the list builds one card per model (got ' + cardNodes().length + ')')
const firstCard = cardNodes()[0]
const firstDef = fieldOf(firstCard, 'defaultThinkingLevel')
check(firstCard.parentNode === listHost && firstDef.children.length === 5, 'the card is attached to the list and its 默认档位 dropdown is filled')
api.renderModelSettings()
check(cardNodes()[0] === firstCard, 'a plain refresh keeps the same card node, so half-typed values survive')
state.status = { models: [fixture({ name: '改过名' }), fixture({ id: 'gpt-5', name: 'GPT-5' })] }
api.renderModelSettings()
check(cardNodes()[0] !== firstCard && fieldOf(cardNodes()[0], 'alias').value === '改过名',
  'a model whose fields changed is rebuilt from the new status (alias now "' + fieldOf(cardNodes()[0], 'alias').value + '")')

/* 10. the helpers the card leans on */
check(api.patchKeys({ action: 'setModel', model: 'm', name: 'n', contextWindow: 1 }).join('|') === 'name|contextWindow', 'patchKeys strips only action/model, leaving the edited fields')
check(api.sameLevels(['off', 'max'], ['max', 'off']) === true && api.sameLevels(['off'], ['off', 'low']) === false, 'sameLevels ignores order but not membership')
const restoreCard = api.modelSettingsCard(fixture())
mark = sent.length
click(buttonNamed(restoreCard, '恢复官方值'))
const restorePatch = sent[sent.length - 1]
check(sent.length === mark + 1 && restorePatch.contextWindow === 200000 && restorePatch.maxTokens === 64000 && restorePatch.supportsImages === true,
  '恢复官方值 sends the published window / output / images')
check(restorePatch.thinkingLevels.join('|') === 'off|low' && restorePatch.name === undefined && restorePatch.registered === undefined
  && restorePatch.defaultThinkingLevel === undefined,
  'and only those: the alias, the registration flag and the default pick stay untouched')

console.log('\n' + (failures === 0 ? 'ALL ' + total + ' MODEL CARD CHECKS PASSED' : failures + ' OF ' + total + ' MODEL CARD CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)
