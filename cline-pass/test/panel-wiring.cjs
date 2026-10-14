/**
 * Mechanical check of renderer/index.html after a CSS-only refactor:
 *   1. every id the script asks for exists in the markup,
 *   2. every class the script emits has a rule (or a descendant rule) in <style>,
 *   3. the <style> block's braces balance.
 *
 *   node test/panel-wiring.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'renderer', 'index.html')
const html = fs.readFileSync(FILE, 'utf8')

const styleAt = html.indexOf('<style>')
const styleEnd = html.indexOf('</style>')
const css = html.slice(styleAt, styleEnd)
const markup = html.slice(styleEnd)

const scriptOpen = html.indexOf('<script>', html.indexOf('</head>'))
const scriptClose = html.lastIndexOf('</script>')
const script = html.slice(html.indexOf('>', scriptOpen) + 1, scriptClose)

let failures = 0
const check = (ok, text) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + text)
}

/* 1. ids */
const wanted = new Set()
for (const m of script.matchAll(/getElementById\("([^"]+)"\)/g)) wanted.add(m[1])
const present = new Set()
for (const m of markup.matchAll(/id="([^"]+)"/g)) present.add(m[1])
const missing = [...wanted].filter((id) => !present.has(id) && !script.includes('style.id = "' + id + '"'))
check(missing.length === 0, 'every getElementById target exists (or is created by the script)' + (missing.length ? ' — missing: ' + missing.join(', ') : ' (' + wanted.size + ' ids)'))

/* 2. classes the script emits */
const emitted = new Set()
for (const m of script.matchAll(/node\("[a-z]+",\s*"([^"]+)"|className:\s*"([^"]+)"/g)) {
  for (const token of String(m[1] ?? m[2]).split(/\s+/)) if (/^[a-z][a-z0-9-]*$/.test(token)) emitted.add(token)
}
/* `(?![a-z0-9-])` rather than `\b`: a word boundary would let `.import-title`
   be satisfied by a rule named `.import-title-renamed`. */
const unstyled = [...emitted].filter((token) => !new RegExp('\\.' + token + '(?![a-z0-9-])').test(css))
check(unstyled.length === 0, 'every class the script emits has a style rule' + (unstyled.length ? ' — unstyled: ' + unstyled.join(', ') : ' (' + emitted.size + ' classes)'))

/* 4. braces in the style block */
const open = (css.match(/\{/g) || []).length
const close = (css.match(/\}/g) || []).length
check(open === close, 'the <style> block balances (' + open + ' { vs ' + close + ' })')

/* 5. the panel still declares the chrome contract the host reads */
check(/<meta name="pi-plugin-chrome" content="v2"\s*\/?>/.test(html), 'the v2 chrome meta is untouched')
check(/--pi-plugin-titlebar-height/.test(css + markup), 'the titlebar height variable survives')

/* 6. the tab strip, the sections and the switcher's hardcoded name list agree.
      `getElementById("tab-" + name)` throws on a name with no section, and a
      section no name mentions can never be shown - neither is visible to the
      script checks above, which only look at literal ids. */
const tabButtons = [...markup.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1])
const tabSectionList = [...markup.matchAll(/id="tab-([a-z-]+)"/g)].map((m) => m[1])
const tabSections = new Set(tabSectionList)
const listedTabs = (() => {
  const found = /\[([^\]]*)\]\.forEach\(function \(name\)/.exec(script)
  if (!found || !script.slice(found.index, found.index + 240).includes('getElementById("tab-" + name)')) return []
  return [...found[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
})()
check(tabButtons.length > 0 && tabSections.size > 0, 'the tab strip and the tab sections are both present (' + tabButtons.length + ' buttons, ' + tabSections.size + ' sections)')
check(new Set(tabSectionList).size === tabSectionList.length, 'no <section id="tab-..."> is declared twice')
check(new Set(tabButtons).size === tabButtons.length, 'no data-tab appears twice in the strip')
check(new Set(listedTabs).size === listedTabs.length, 'no tab name appears twice in the switcher list')
check(listedTabs.length > 0, "the tab switcher names its tabs explicitly (" + listedTabs.length + ' names)')
for (const name of tabButtons) {
  check(tabSections.has(name), 'tab button "' + name + '" has a <section id="tab-' + name + '">')
  check(listedTabs.includes(name), 'the switcher knows the tab "' + name + '"')
}
for (const name of tabSections) {
  check(tabButtons.includes(name), 'section "tab-' + name + '" has a button')
}
for (const name of listedTabs) {
  check(tabSections.has(name), 'the switcher toggles a section that exists: ' + name)
}
/* 7. tab ownership: 导入与参数 holds the import flow and the parameter card;
      模型与通道 holds the model list. A tab that exists but holds the wrong subtree
      still passes every check above. */
const importAt = tabButtons.indexOf('import')
check(importAt > 0 && tabButtons[importAt - 1] === 'models', 'the 导入与参数 tab follows 模型与通道')
const importRegion = markup.slice(markup.indexOf('id="tab-import"'), markup.indexOf('id="tab-history"'))
const modelsRegion = markup.slice(markup.indexOf('id="tab-models"'), markup.indexOf('id="tab-import"'))
for (const id of ['import-and-params', 'generate-config-card', 'host-ladder-card', 'model-settings']) {
  check(importRegion.includes('id="' + id + '"'), '#tab-import contains #' + id)
}
check(modelsRegion.includes('id="model-list-card"'), '#tab-models owns the model list card')
check(modelsRegion.includes('id="model-settings-list"'), '#tab-models owns the model list')
check(!importRegion.includes('id="model-settings-list"'), 'the model list is not in #tab-import')
check(!modelsRegion.includes('id="import-and-params"'), 'the merged card left #tab-models')

/* 8. 数值来源 is one setting with two owners: a select in each tab, driven by one
      list. A missing entry would leave one tab's copy stale. */
for (const id of ['catalog-source', 'catalog-source-ladder']) {
  check(markup.includes('id="' + id + '"'), 'the markup has #' + id)
}
check(/CATALOG_SOURCE_SELECTS/.test(script), 'both selects are wired through one list')
check(!/document\.getElementById\("catalog-source"\)\.onchange/.test(script), 'no select is wired on its own')

/* 9. a model card never auto-opens on load: the selected model used to expand and
      push every other card off screen. */
/* Assert on the whole assignment, not on a substring: an added `|| model.id === state.model`
   fallback would still auto-open while a substring check stayed green. */
const openLine = (/entry\.open = [^\n]*/.exec(script) || [''])[0]
check(openLine.includes('state.openModels[model.id] === true'), 'a card opens only when the user toggled it')
check(!openLine.includes('state.model'), 'a card never falls back to the selected model')


console.log('\n' + (failures === 0 ? 'PANEL WIRING OK' : failures + ' PANEL WIRING PROBLEM(S)'))
process.exit(failures === 0 ? 0 : 1)
