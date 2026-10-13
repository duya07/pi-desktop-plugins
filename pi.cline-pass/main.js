/**
 * pi.cline-pass - PI-Desktop entry.
 *
 * This is the port of the DSH plugin `dsh-cline-pass` (0.2.5-p3, MIT) to
 * PI-Desktop. The harness seam it used to own (an LLM provider route) does not
 * exist here: a PI-Desktop plugin can only *declare* a provider, and the host
 * sends the requests itself. So the ported request path (channel pin, failover,
 * account pool, idle watchdog) runs in this plugin process as a local
 * OpenAI-compatible gateway, and `manifest.json` declares a provider that points
 * at it - `http://127.0.0.1:41593/v1`.
 *
 * The plugin therefore does three things:
 *   1. keeps that gateway listening for as long as the plugin is loaded,
 *   2. exposes the DSH management surface as `cline_pass_*` agent tools,
 *   3. serves the panel, which drives the same operations by hand.
 *
 * Permissions: `provider.register` (the declared provider), `background.service`
 * (the gateway must outlive any panel), `agent.tool.register` (the tools),
 * `ui.panel` (the panel), `notify` (startup failures).
 *
 * @module pi.cline-pass
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { BUILD_TAG } = require('./src/protocol.js')
const { createConfig } = require('./src/config.js')
const { createGateway } = require('./src/gateway.js')

const COMMAND_ID = 'cline-pass.open'
const SERVICE_ID = 'gateway'
/**
 * The host aborts a panel call at 30s and an agent tool call at 110s
 * (`PLUGIN_PANEL_TIMEOUT_MS` / `PLUGIN_TOOL_TIMEOUT_MS`). Both budgets stay just
 * inside those caps, so the plugin stops the work on its own terms and can say
 * what happened instead of being killed with no result at all.
 */
const PANEL_BUDGET_MS = 25000
const TOOL_BUDGET_MS = 100000
const TOOL_NAMES = [
  'cline_pass_status',
  'cline_pass_models',
  'cline_pass_probe',
  'cline_pass_validate',
  'cline_pass_test',
  'cline_pass_pin',
  'cline_pass_accounts',
  'cline_pass_history',
  'cline_pass_usage',
  'cline_pass_quota',
]

let gateway = null
let configStore = null
let startError = ''
let instanceId = ''
let log = () => {}

/**
 * A logger for the plugin's own file, because a PI-Desktop plugin has no host
 * logger API: the panel, the tools and the gateway all report through this one
 * sink, capped so it can never grow without bound.
 *
 * Only failures are also written to stderr. The host files every stderr line as
 * a `level:"error"` entry in its own plugin log, so progress sent there makes a
 * healthy plugin look broken (measured: 10 informational lines archived as
 * errors, zero real failures).
 */
function createLogger(dataDir) {
  const file = path.join(dataDir, 'gateway.log')
  const MAX_BYTES = 512 * 1024
  return (message, detail, level) => {
    const failed = level !== undefined ? level !== 'info' : /failed|error|refused|not start|unavailable|cannot|rejected/i.test(String(message))
    const line = `${new Date().toISOString()} [${failed ? level ?? 'error' : 'info'}] ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`
    if (failed) {
      try {
        process.stderr.write(`[pi.cline-pass] ${line}`)
      } catch {
        /* a closed stderr must not break the gateway */
      }
    }
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size > MAX_BYTES) fs.writeFileSync(file, '', 'utf8')
      fs.appendFileSync(file, line, 'utf8')
    } catch {
      /* logging is never worth failing a request for */
    }
  }
}

/** Start the gateway if it is not listening yet; remember why when it fails. */
async function ensureGateway() {
  if (!gateway) throw new Error('the plugin is not loaded')
  if (gateway.status().running) return gateway
  try {
    await gateway.start()
    startError = ''
  } catch (error) {
    startError = error instanceof Error ? error.message : String(error)
    log('gateway start failed', { error: startError, port: gateway.port })
    throw new Error(startError)
  }
  return gateway
}

/** Guard every entry point: a tool call must never throw at the host. */
function liveGateway() {
  if (!gateway) throw new Error('the plugin is not loaded')
  return gateway
}

/** Describe the failure of one operation in a shape a tool result can carry. */
function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code ?? '' }
}

/* --------------------------------- tools --------------------------------- */

const TOOL_SPECS = {
  cline_pass_status: {
    description:
      'Cline Pass 本地网关状态（pi.cline-pass 插件）：端口、上游 baseUrl、账号池（含冷却与掩码后的 key 提示）、每个模型的 pin 配置与已探测到的通道、并发与超时设置、最近请求条数。只读。',
    risk: 'low',
    schema: { type: 'object', properties: {} },
  },
  cline_pass_models: {
    description:
      '列出 Cline Pass 订阅可用的模型及其上下文窗口、输出上限、思考档位支持与图片能力，并附带每个模型已探测到的上游通道、pin 与最近一次被哪个通道服务。只读。',
    risk: 'low',
    schema: {
      type: 'object',
      properties: { model: { type: 'string', description: '只看某个模型（可选，模糊匹配子串）' } },
    },
  },
  cline_pass_probe: {
    description:
      '探测一个模型：判断它走的是哪条路由管线（direct / planner）、本次被哪个上游通道服务，并从路由层错误里抓取该模型可用的完整通道列表。写操作：结果会缓存到观测状态里，供 pin 与 exclude 使用。',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id，例如 cline-pass/deepseek-v4.1-flash' },
        apiKey: { type: 'string', description: '可选：本次探测使用的 Cline API Key（不落盘；默认用账号池）' },
      },
      required: ['model'],
    },
  },
  cline_pass_validate: {
    description:
      '逐个把已发现的通道 pin 一遍并记录可用性，得到一个通道黑/白名单依据。判定标准是响应自报的 finalProvider 是否等于被 pin 的通道，而不是 HTTP 200。需要先 probe。',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id' },
        apiKey: { type: 'string', description: '可选：本次校验使用的 Cline API Key（不落盘）' },
      },
      required: ['model'],
    },
  },
  cline_pass_test: {
    description:
      '按给定的 pin/exclude 配置真实发一次请求，返回每个候选通道的尝试轨迹（状态码、耗时、是否真的被采纳）。用于验证 pin 是否生效，不会修改配置。',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id' },
        upstreams: { type: 'array', items: { type: 'string' }, description: '按顺序尝试的通道列表（可选）' },
        exclude: { type: 'array', items: { type: 'string' }, description: '排除的通道（可选）' },
        pinMode: { type: 'string', enum: ['strict', 'preferred'], description: 'strict：只允许该通道；preferred：优先但仍允许其它（默认 strict）' },
        sort: { type: 'string', enum: ['cost', 'ttft', 'tps', 'none'], description: '路由排序偏好（可选）' },
        apiKey: { type: 'string', description: '可选：本次测试使用的 Cline API Key（不落盘）' },
      },
      required: ['model'],
    },
  },
  cline_pass_pin: {
    description:
      '写入或清除某个模型的通道 pin：upstreams（按顺序的通道列表，构成 failover 链）、exclude（排除的通道，会编译成 allow-list）、pinMode（strict / preferred）、sort。写操作，立即对后续请求生效。clear=true 清除该模型的 pin。',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id' },
        upstreams: { type: 'array', items: { type: 'string' }, description: '按顺序尝试的通道' },
        exclude: { type: 'array', items: { type: 'string' }, description: '要排除的通道' },
        pinMode: { type: 'string', enum: ['strict', 'preferred'] },
        sort: { type: 'string', enum: ['cost', 'ttft', 'tps', 'none'] },
        clear: { type: 'boolean', description: 'true 时清除该模型的 pin' },
      },
      required: ['model'],
    },
  },
  cline_pass_accounts: {
    description:
      '管理 Cline Pass 账号池：list 查看（含冷却与掩码）、add 新增（需 key）、update 改名/启停/换 key、remove 删除、mode 切换 single/roundrobin 与当前账号、test 用该账号发一次最小请求、resetCooldowns 复位账号池（清冷却并复位轮转）。密钥只写在插件数据目录的 config.json 里；宿主给插件进程的是最小环境，读不到你自己的环境变量，所以没有 env 账号。',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'mode', 'test', 'resetCooldowns'] },
        name: { type: 'string', description: '账号名（add/update/remove/test 使用）' },
        displayName: { type: 'string' },
        source: { type: 'string', enum: ['inline'], description: '目前只有 inline：key 存在 config.json' },
        key: { type: 'string', description: 'inline 账号的 Cline API Key' },
        enabled: { type: 'boolean' },
        accountMode: { type: 'string', enum: ['single', 'roundrobin'] },
        activeAccount: { type: 'string', description: 'single 模式下固定使用的账号名' },
        model: { type: 'string', description: 'test 时使用的模型（可选）' },
      },
      required: ['action'],
    },
  },
  cline_pass_history: {
    description: '读取最近的 Cline Pass 请求记录：模型、命中的通道、使用的账号、状态、耗时、token 与备注。只读。',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数（默认 50）' },
        model: { type: 'string', description: '按模型子串过滤（可选）' },
      },
    },
  },
  cline_pass_usage: {
    description:
      'Cline Pass 用量账本：按时间窗汇总请求数、失败数、输入/输出 token 与上游给出的成本（按模型、按通道、按账号、按天分组），并附最近 N 条明细。数据来自每次请求最终帧的 usage，存在插件数据目录的 usage.jsonl。只读。',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计窗口天数，0 表示全部（默认 7）' },
        limit: { type: 'number', description: '附带的最近明细条数（默认 20）' },
        model: { type: 'string', description: '只看某个模型（可选，模糊匹配）' },
      },
    },
  },
  cline_pass_quota: {
    description:
      'Cline 官方额度（订阅配额）：按账号读 Cline 自己的 /users/me/plan/usage-limits，给出 5 小时 / 每周 / 每月窗口的已用与剩余百分比、三档语气与重置倒计时。只读、不消耗 token。与本地用量账本（cline_pass_usage）不同：账本只统计经过本网关的请求，官方窗口统计该账号在任何地方的消耗；host 账号的 key 只在请求内存里，读不到时会明确说明原因。',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'true 时绕过 60 秒缓存强制重读' },
      },
    },
  },
}

/** Route one tool call into the shared control surface. */
async function runTool(name, args) {
  try {
    const gw = liveGateway()
    const input = args && typeof args === 'object' ? args : {}
    switch (name) {
      case 'cline_pass_status':
        return { ok: true, status: gw.ops.status(input.apiKey ?? '') }
      case 'cline_pass_models': {
        const models = gw.ops.models()
        const needle = String(input.model ?? '').trim().toLowerCase()
        return { ok: true, models: needle ? models.filter((entry) => entry.id.toLowerCase().includes(needle)) : models }
      }
      case 'cline_pass_probe':
        return { ok: true, result: await gw.ops.probe(budgeted(input, TOOL_BUDGET_MS)) }
      case 'cline_pass_validate':
        return { ok: true, result: await gw.ops.validate(budgeted(input, TOOL_BUDGET_MS)) }
      case 'cline_pass_test':
        return { ok: true, result: await gw.ops.test(budgeted(input, TOOL_BUDGET_MS)) }
      case 'cline_pass_pin':
        return input.clear === true ? gw.ops.clearPin(input) : gw.ops.pin(input)
      case 'cline_pass_accounts':
        return gw.ops.accounts(input)
      case 'cline_pass_history':
        return { ok: true, ...gw.ops.history(input) }
      case 'cline_pass_usage':
        return gw.ops.usage(input)
      case 'cline_pass_quota':
        return await gw.ops.quota(budgeted(input, TOOL_BUDGET_MS))
      default:
        return { ok: false, error: `unknown tool: ${name}` }
    }
  } catch (error) {
    return failure(budgetError(error))
  }
}

/* -------------------------------- lifecycle ------------------------------- */

async function onLoad() {
  const dataDir = await pi.plugin.getDataPath()
  log = createLogger(dataDir)
  instanceId = `${process.pid}-${Date.now().toString(36)}`
  configStore = createConfig({ dataDir, logger: (message, detail) => log(message, detail) })
  configStore.reload()
  gateway = createGateway({ configStore, logger: (message, detail) => log(message, detail), instanceId })

  try {
    const { port } = await ensureGateway()
    log(`gateway ready on 127.0.0.1:${port}`, { build: BUILD_TAG, dataDir })
  } catch (error) {
    startError = error instanceof Error ? error.message : String(error)
    log('gateway did not start', { error: startError })
    try {
      await pi.ui.notify({ title: 'Cline Pass 网关未能启动', body: `端口 ${gateway.port} 不可用：${startError}` })
    } catch {
      /* notification is best effort */
    }
  }

  // The service keeps the plugin process alive when no panel is open, which is
  // what a provider that answers host requests needs.
  pi.services.register({
    id: SERVICE_ID,
    start: async ({ log: serviceLog }) => {
      serviceLog('cline-pass gateway service started')
      await ensureGateway().catch(() => {})
    },
    stop: () => {
      /* the gateway is owned by the plugin lifetime, not by this service */
    },
  })

  await pi.commands.register({
    id: COMMAND_ID,
    title: 'Cline Pass：打开管理面板',
    keywords: ['cline', 'cline-pass', '订阅', '通道', 'pin', 'cline_pass'],
    run: async () => {
      await pi.ui.openPanel()
    },
  })

  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    await pi.agent.registerTool({
      name,
      description: spec.description,
      risk: spec.risk,
      schema: spec.schema,
      execute: async (args) => runTool(name, args),
    })
  }
}

async function onUnload() {
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.unregisterTool(name)
    } catch {
      /* already gone */
    }
  }
  try {
    await pi.commands.unregister(COMMAND_ID)
  } catch {
    /* already gone */
  }
  try {
    await pi.services.unregister(SERVICE_ID)
  } catch {
    /* the host may have stopped it first */
  }
  if (gateway) {
    try {
      await gateway.stop()
    } catch {
      /* closing a dead server is not an error worth surfacing */
    }
  }
  gateway = null
  configStore = null
}

/**
 * The panel bridge forwards exactly the host's `skill.*` channels into a plugin
 * (`invokePanelBridge` / `PANEL_SKILL_CHANNELS` in the host), so the panel
 * speaks one of those and carries its own action name in the payload - the same
 * shape the official pi.todo panel uses.
 */
const PANEL_CHANNEL = 'skill.setEnabled'

/** Every panel action, so the renderer and this file cannot drift apart. */
const PANEL_ACTIONS = [
  'status',
  'probe',
  'validate',
  'test',
  'pin',
  'clearPin',
  'accounts',
  'history',
  'setConfig',
  'reloadConfig',
  'restartGateway',
  'setModel',
  'usage',
  'usageClear',
  'quota',
]

/**
 * Give an operation that can outlive the host's patience a deadline of its own.
 * The host stops waiting at 30s for a panel call and 110s for a tool call; work
 * that runs past that is wasted, and the caller would only see "no response".
 */
function budgeted(input, ms) {
  return { ...(input && typeof input === 'object' ? input : {}), signal: AbortSignal.timeout(ms) }
}

/** Say a spent budget in the caller's terms instead of leaking a DOMException. */
function budgetError(error) {
  if (!error || (error.name !== 'TimeoutError' && error.name !== 'AbortError')) return error
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${message} —— 已用完本次调用的时间预算（面板 25 秒、agent 工具 100 秒；宿主上限分别是 30 秒和 110 秒）。可缩小范围（先只 probe 一个模型）或分步执行，并用 cline_pass_history 看已完成的请求。`)
}

async function onPanelInvoke(channel, payload) {
  if (channel !== PANEL_CHANNEL) throw new Error(`unsupported panel channel: ${channel}`)
  const gw = liveGateway()
  const input = payload && typeof payload === 'object' ? payload : {}
  switch (String(input.action ?? '')) {
    case 'status':
      return { ok: true, status: { ...gw.ops.status(input.apiKey ?? ''), startError } }
    case 'probe':
      return { ok: true, result: await gw.ops.probe(budgeted(input, PANEL_BUDGET_MS)) }
    case 'validate':
      return { ok: true, result: await gw.ops.validate(budgeted(input, PANEL_BUDGET_MS)) }
    case 'test':
      return { ok: true, result: await gw.ops.test(budgeted(input, PANEL_BUDGET_MS)) }
    case 'pin':
      return gw.ops.pin(input)
    case 'clearPin':
      return gw.ops.clearPin(input)
    case 'accounts':
      // The panel's own action name is "accounts"; its sub-action rides along.
      return gw.ops.accounts({ ...input, action: input.accountsAction ?? input.action })
    case 'history':
      return { ok: true, ...gw.ops.history(input) }
    case 'setModel':
      return gw.ops.setModel(input)
    case 'usage':
      return gw.ops.usage(input)
    case 'usageClear':
      return gw.ops.usageClear()
    case 'quota':
      return await gw.ops.quota(budgeted(input, PANEL_BUDGET_MS))
    case 'setConfig':
      return gw.ops.setConfig(input)
    case 'reloadConfig':
      return { ok: true, config: { baseUrl: configStore.reload().baseUrl } }
    case 'restartGateway': {
      await gw.stop()
      await ensureGateway()
      return { ok: true, status: { ...gw.ops.status(input.apiKey ?? ''), startError } }
    }
    default:
      throw new Error(`unsupported panel action: ${String(input.action ?? '')}`)
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke, createLogger, TOOL_NAMES, PANEL_CHANNEL, PANEL_ACTIONS }
