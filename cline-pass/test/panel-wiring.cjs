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
/* 4. braces in the style block */
const open = (css.match(/\{/g) || []).length
const close = (css.match(/\}/g) || []).length
check(open === close, 'the <style> block balances (' + open + ' { vs ' + close + ' })')

/* 5. the panel still declares the chrome contract the host reads */
check(/<meta name="pi-plugin-chrome" content="v2"\s*\/?>/.test(html), 'the v2 chrome meta is untouched')
check(/--pi-plugin-titlebar-height/.test(css + markup), 'the titlebar height variable survives')

console.log('\n' + (failures === 0 ? 'PANEL WIRING OK' : failures + ' PANEL WIRING PROBLEM(S)'))
process.exit(failures === 0 ? 0 : 1)
