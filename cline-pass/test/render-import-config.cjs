/**
 * Asserts the 生成配置 card wiring: render + copy fallback.
 *
 * Slices the relevant script block out of renderer/index.html, runs it against
 * a tiny fake DOM, calls the render helper with the frozen interface shape and
 * checks: path/meta/textarea filling, empty-models hint, error path, and the
 * copy button degrading when clipboard is unavailable.
 *
 *   node test/render-import-config.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html')
const PAGE = fs.readFileSync(RENDERER, 'utf8')
const scriptOpen = PAGE.indexOf('<script>', PAGE.indexOf('</head>'))
const scriptClose = PAGE.lastIndexOf('</script>')
const pageScript = PAGE.slice(PAGE.indexOf('>', scriptOpen) + 1, scriptClose)

const start = pageScript.indexOf('/* ------------------------- \u751f\u6210\u914d\u7f6e')
if (start < 0) { console.log('FAIL  generate-config block not found'); process.exitCode = 1; throw new Error('block missing') }
let end = pageScript.indexOf('/* Keep the host', start)
if (end < 0) end = pageScript.length
const chunk = pageScript.slice(start, end)

function el(tag) {
  const e = { tagName: tag, className: '', value: '', hidden: false, style: {}, dataset: {}, attributes: {}, children: [], parentNode: null, onclick: null, setAttribute(n, v){ e.attributes[n]=String(v) } }
  e._t = ''
  Object.defineProperty(e, 'textContent', { get(){ return e._t }, set(v){ e._t = String(v) } })
  e.contains = function(n){ let x=n; while(x){ if(x===e) return true; x=x.parentNode } return false }
  return e
}
const logs = []
const elements = {
  'generate-config-path': (()=>{ const n=el('div'); n.id='generate-config-path'; n.hidden=true; return n })(),
  'generate-config-meta': (()=>{ const n=el('span'); n.id='generate-config-meta'; return n })(),
  'config-json': (()=>{ const n=el('textarea'); n.id='config-json'; n.hidden=true; n.value=''; return n })(),
  'generate-config-hint': (()=>{ const n=el('div'); n.id='generate-config-hint'; return n })(),
  'copy-config': (()=>{ const n=el('button'); n.id='copy-config'; n.textContent='复制'; return n })(),
  'generate-config': (()=>{ const n=el('button'); n.id='generate-config'; n.textContent='生成配置'; return n })(),
  'write-config': (()=>{ const n=el('button'); n.id='write-config'; n.textContent='写入文件'; return n })(),
}
const state = {}
let busy = { active:false }
const doc = {
  getElementById(id){ return elements[id] || null },
  createElement(tag){ return el(tag) },
  contains(n){
    for (const k in elements) if (elements[k]===n) return true
    return false
  }
}
const clipboard = { calls: [] }
const win = { setTimeout(fn){}, clearTimeout(){} }
const log = t=>logs.push(String(t))
const run = p=>Promise.resolve(null)
const release = p=>p
const beginBusy = ()=>true, endBusy=()=>{}
const navigatorStub = { clipboard: { writeText(tx){ clipboard.calls.push(tx); return Promise.resolve() } } }

let failures=0, total=0
function check(ok, text){ total+=1; if(!ok) failures+=1; console.log((ok?'PASS  ':'FAIL  ')+text) }

const factory = new Function('state','document','window','log','run','release','beginBusy','endBusy','navigator','busy',
  'var node=function(t,c,tx){var e=document.createElement?document.createElement(t):{tagName:t,className:c||"",textContent:tx||""}; if(c) e.className=c; if(tx!==undefined) e.textContent=tx; return e};\n'+chunk+'\nreturn { renderGenerateConfig: typeof renderGenerateConfig!=="undefined"?renderGenerateConfig:null, copyGenerateConfig: typeof copyGenerateConfig!=="undefined"?copyGenerateConfig:null, renderWriteConfig: typeof renderWriteConfig!=="undefined"?renderWriteConfig:null };')
let api
try { api = factory(state, doc, win, log, run, release, beginBusy, endBusy, navigatorStub, busy) } catch(e){ console.log('FAIL  factory: '+e.message); console.log(e.stack); process.exitCode=1; throw e }

check(typeof api.renderGenerateConfig==='function', 'renderGenerateConfig exists')
check(typeof api.copyGenerateConfig==='function', 'copyGenerateConfig exists')

// ok with 2 models
logs.length=0; clipboard.calls.length=0
api.renderGenerateConfig({ ok:true, path:'C:\\Users\\x\\.pi\\agent\\models.json', json:'{"a":1}', models:[{id:'m-a',name:'A'},{id:'m-b',name:'B'}], note:'' })
check(elements['generate-config-path'].textContent.indexOf('C:\\Users\\x\\.pi\\agent\\models.json')>=0, 'ok: path shown (got "'+elements['generate-config-path'].textContent+'")')
check(elements['generate-config-path'].hidden===false, 'ok: path visible')
check(elements['generate-config-meta'].textContent.indexOf('2')>=0, 'ok: meta shows 2 models (got "'+elements['generate-config-meta'].textContent+'")')
check(elements['config-json'].value==='{"a":1}', 'ok: textarea filled (got "'+elements['config-json'].value+'")')
check(elements['config-json'].hidden===false, 'ok: textarea visible')
check(elements['generate-config-hint'].textContent.indexOf('2')>=0, 'ok: hint mentions 2')
check(logs.join(' ').indexOf('已生成配置')>=0, 'ok: log says 已生成配置')

// models: []
logs.length=0
api.renderGenerateConfig({ ok:true, path:'C:\\a\\b.json', json:'{}', models:[], note:'' })
check(elements['generate-config-meta'].textContent.indexOf('还没有勾选任何模型')>=0, 'empty models: meta says empty (got "'+elements['generate-config-meta'].textContent+'")')
check(elements['generate-config-hint'].textContent.indexOf('还没有勾选任何模型')>=0, 'empty models: hint says empty (got "'+elements['generate-config-hint'].textContent+'")')
check(elements['config-json'].value==='{}', 'empty models: textarea still has json')

// ok:false
logs.length=0
api.renderGenerateConfig({ ok:false, error:'boom' })
check(elements['generate-config-path'].textContent.indexOf('boom')>=0, 'ok:false: path shows error (got "'+elements['generate-config-path'].textContent+'")')
check(elements['generate-config-hint'].textContent.indexOf('boom')>=0, 'ok:false: hint shows error')

// copy with clipboard available
logs.length=0; clipboard.calls.length=0
api.renderGenerateConfig({ ok:true, path:'C:\\a\\b.json', json:'{"x":1}', models:[{id:'m1',name:'M1'}], note:'' })
try{ api.copyGenerateConfig(); check(true, 'copy incopy: no throw') }catch(e){ check(false, 'copy incopy threw: '+e.message) }
check(clipboard.calls.length===1 && clipboard.calls[0]==='{"x":1}', 'copy: clipboard.writeText called with json (got "'+(clipboard.calls[0]||'')+'")')
// copy when clipboard unavailable -> degraded prompt, no throw
logs.length=0
const factory2 = new Function('state','document','window','log','run','release','beginBusy','endBusy','navigator','busy',
  'var node=function(t,c,tx){var e=document.createElement?document.createElement(t):{tagName:t,className:c||"",textContent:tx||""}; if(c) e.className=c; if(tx!==undefined) e.textContent=tx; return e};\n'+chunk+'\nreturn { copyGenerateConfig: copyGenerateConfig };')
// need fresh elements for second harness (shares same objects but win still works)
const doc2 = {
  getElementById(id){ return elements[id] || null },
  createElement(tag){ return el(tag) },
  contains(n){ for(const k in elements) if(elements[k]===n) return true; return false }
}
const logs2 = logs
const api2 = factory2(state, doc2, win, log, run, release, beginBusy, endBusy, {}, busy)
logs.length=0
try{ api2.copyGenerateConfig(); check(true, 'copy no-clipboard: no throw') }catch(e){ check(false, 'copy no-clipboard threw: '+e.message) }
check(logs.join(' ').indexOf('手动全选复制')>=0 || logs.join(' ').indexOf('剪贴板不可用')>=0, 'copy no-clipboard: degraded hint (got "'+logs.join('|')+'")')


// ---- the write button: handler bound, and the three outcomes it reports ----
check(typeof elements['write-config'].onclick==='function', 'write: #write-config has a click handler')
check(typeof api.renderWriteConfig==='function', 'write: renderWriteConfig exists')
check(PAGE.indexOf('id="write-config"')>=0, 'markup: #write-config exists')

logs.length=0
api.renderWriteConfig({ ok:true, path:'C:\\Users\\x\\.pi\\agent\\models.json', bytes:1675, models:5 })
const okLog = logs.join(' ')
check(okLog.indexOf('已写入')>=0, 'write ok: log says 已写入 (got "'+okLog+'")')
check(okLog.indexOf('models.json')>=0, 'write ok: log carries the path')
check(okLog.indexOf('1675')>=0, 'write ok: log carries the byte count')
check(okLog.indexOf('5')>=0, 'write ok: log carries the model count')

logs.length=0
api.renderWriteConfig({ ok:false, error:'没有选择目录（已取消）。再点一次「写入文件」，选择 ~/.pi/agent 目录。', code:'' })
const cancelLog = logs.join(' ')
check(cancelLog.indexOf('已取消')>=0, 'write cancel: friendly cancel line (got "'+cancelLog+'")')
check(cancelLog.indexOf('写入文件失败')<0, 'write cancel: not reported as a hard failure')

logs.length=0
api.renderWriteConfig({ ok:false, error:'missing permission: fs.read' })
check(logs.join(' ').indexOf('写入文件失败：missing permission: fs.read')>=0, 'write error: raw reason surfaced (got "'+logs.join('|')+'")')

logs.length=0
api.renderWriteConfig(null)
check(logs.join(' ').indexOf('写入文件失败')>=0, 'write null result: no throw, failure line')
// markup checks (existence) — counts as checks too
check(PAGE.indexOf('id="generate-config"')>=0, 'markup: #generate-config exists')
check(PAGE.indexOf('id="copy-config"')>=0, 'markup: #copy-config exists')
check(PAGE.indexOf('id="config-json"')>=0, 'markup: #config-json exists')
check(PAGE.indexOf('id="generate-config-card"')>=0, 'markup: #generate-config-card exists')
check(PAGE.indexOf('max-height')>=0 && PAGE.indexOf('#config-json')>=0, 'css: #config-json has max-height rule')
check(PAGE.indexOf('生成配置（导入到模型配置）')>=0, 'markup: card title exists')
check(PAGE.indexOf('class="generate-steps"')>=0, 'markup: steps list exists')

// The model-id spelling is a contract the user has to be told about. The generated
// config re-spells ids (`cline-pass-local/x`) so an imported model never collides with
// one served by a provider pointed straight at Cline. Without this note a user may
// "fix" the id back to the plain spelling and then wonder why a subagent asking for it
// is answered by that other provider - or, reading it the other way, assume a renamed
// id cannot be routed back at all.
check(PAGE.indexOf('cline-pass-local/')>=0, 'markup: the imported model-id prefix is named')
check(PAGE.indexOf('两种拼写都认')>=0, 'markup: says the gateway accepts both spellings')
check(PAGE.indexOf('重命名 provider')>=0 && PAGE.indexOf('没有用')>=0, 'markup: says renaming the provider does not help')
check(PAGE.indexOf('委派 key')>=0 && PAGE.indexOf('vendorKey')>=0, 'markup: names the delegation key the ids collide on')

console.log('\n'+(failures===0?'ALL '+total+' IMPORT CONFIG CHECKS PASSED':failures+' OF '+total+' IMPORT CONFIG CHECK(S) FAILED'))
process.exitCode = failures===0?0:1
