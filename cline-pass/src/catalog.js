/**
 * Published model metadata for the Cline Pass subscription models.
 *
 * The numbers are not guesses and not preferences: they are what models.dev
 * publishes for the same slugs - the same source PI-Desktop itself reads
 * (`resources/models.dev/api.json`, provider key `cline-pass`). `tools/sync-catalog.mjs`
 * is how this table gets refreshed from it: window from `limit.context`, output
 * cap from `limit.output`, image support from `modalities.input`, and the ladder
 * from `reasoning_options`. Last synced 2026-10-13. `test/gateway.test.mjs` pins
 * the shape, and the panel can override any of it per model.
 *
 * Why the numbers matter: the host sizes its prompt budget against the declared
 * context window, so an overstated window silently overflows the model and an
 * understated one truncates history for no reason. The same table is what
 * `/v1/models` reports to anyone pointing a plain OpenAI client at the gateway.
 *
 * Thinking control is per model and follows the upstream catalog rather than
 * one blanket list:
 *   - `effort`: the model accepts a discrete effort. Only the published levels
 *     exist, so a level the host offers but the model does not is clamped to the
 *     nearest published one (see {@link reasoningEffortFor}).
 *   - `toggle`: the upstream exposes an on/off switch, not levels. The gateway
 *     sends no effort field at all for these and lets the model do what it does
 *     by default - inventing an effort string the model never published is how a
 *     request starts failing for reasons the panel cannot explain.
 *   - `none`: no thinking control in the catalog at all.
 *
 * An entry models.dev does not publish keeps its hand-written numbers and is
 * flagged `fallback: true`, which the panel surfaces as "兜底默认值，别当真实能力".
 * Nothing is flagged today: the last stand-in (`cline-pass/qwen3.8-max`) turned
 * out to be published after all, so the flag went away with the refresh.
 *
 * @module cline-pass/catalog
 */
'use strict'

/** Selectable reasoning efforts, in the vocabulary Cline Pass accepts. */
const REASONING_EFFORTS = [
  { id: 'none', name: 'None', description: 'No extra thinking; fastest and cheapest.' },
  { id: 'minimal', name: 'Minimal', description: 'A bare minimum of reasoning.' },
  { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive work.' },
  { id: 'medium', name: 'Medium', description: 'A balanced amount of reasoning.' },
  { id: 'high', name: 'High', description: 'More thorough reasoning for multi-step work.' },
  { id: 'xhigh', name: 'Extra high', description: 'For difficult work that rewards more thinking.' },
  { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
]

/**
 * The thinking levels PI-Desktop itself knows, in display order.
 *
 * The two vocabularies differ in exactly one entry: the harness says `off`
 * where Cline Pass says `none`. Everything the host sends is translated back
 * into the upstream vocabulary by {@link reasoningEffortFor} before it leaves
 * the gateway, which is why the host-side list can stay in the host's own
 * spelling.
 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The level PI-Desktop pre-selects for a freshly picked model. */
const PI_DEFAULT_THINKING_LEVEL = 'low'

/** Effort levels in order of intensity; index distance is the clamp metric. */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Translate one host thinking level into the effort value Cline Pass accepts.
 *
 * @param level - the level the host sent (`off`..`max`), or undefined.
 * @param allowed - the model's published efforts, when the caller knows them.
 *   A level the model does not publish is clamped to the nearest one that is;
 *   ties resolve downward, because a smaller effort is the cheaper mistake.
 * @returns the upstream effort string, or null when no field should be sent.
 */
function reasoningEffortFor(level, allowed) {
  if (level === undefined || level === null || level === '') return null
  const value = String(level).trim().toLowerCase()
  if (value === 'off' || value === 'omit') return null
  const list = Array.isArray(allowed) ? allowed.filter((entry) => EFFORT_ORDER.includes(entry)) : []
  if (list.length === 0) return null
  if (list.includes(value)) return value
  const known = EFFORT_ORDER.includes(value) ? value : 'none'
  if (known === 'none') return null
  const target = EFFORT_ORDER.indexOf(known)
  let best = list[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of list) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Published metadata for the shipped Cline Pass models.
 *
 * `name` mirrors the provider's own display name where it publishes one, and
 * falls back to the model id when the catalog has no separate label.
 * `thinking.levels` lists the published efforts in PI spelling; it is empty for
 * `toggle` and `none`, whose host-side list is just `off`.
 */
const MODEL_CATALOG = {
  'cline-pass/deepseek-v4.1-flash': {
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['low', 'high', 'max'] },
  },
  'cline-pass/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxTokens: 384000,
    supportsImages: false,
    thinking: { lever: 'effort', levels: ['high', 'max'] },
  },
  'cline-pass/glm-5.3': {
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    supportsImages: false,
    thinking: { lever: 'effort', levels: ['low', 'high', 'max'] },
  },
  'cline-pass/glm-5.3-flash': {
    name: 'cline-pass/glm-5.3-flash',
    contextWindow: 1000000,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['low', 'high', 'max'] },
  },
  'cline-pass/kimi-k3': {
    name: 'Kimi K3',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['low', 'high', 'max'] },
  },
  'cline-pass/muse-spark-1.3-contributor': {
    name: 'Muse Spark 1.3 Contributor',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  },
  'cline-pass/minimax-m3': {
    name: 'MiniMax-M3',
    contextWindow: 1048576,
    maxTokens: 512000,
    supportsImages: true,
    thinking: { lever: 'toggle', levels: [] },
  },
  'cline-pass/mimo-v2.5': {
    name: 'MiMo-V2.5',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'toggle', levels: [] },
  },
  'cline-pass/mimo-v2.5-pro': {
    name: 'MiMo-V2.5-Pro',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: false,
    thinking: { lever: 'toggle', levels: [] },
  },
  'cline-pass/mimo-v2.6-flash': {
    name: 'MiMo-V2.6-Flash',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['low', 'medium', 'high', 'xhigh'] },
  },
  'cline-pass/mimo-v2.6-pro': {
    name: 'MiMo-V2.6-Pro',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['low', 'medium', 'high', 'xhigh'] },
  },
  'cline-pass/qwen3.7-max': {
    name: 'Qwen3.7 Max',
    contextWindow: 1000000,
    maxTokens: 65536,
    supportsImages: false,
    thinking: { lever: 'toggle', levels: [] },
  },
  'cline-pass/qwen3.7-plus': {
    name: 'Qwen3.7 Plus',
    contextWindow: 1000000,
    maxTokens: 64000,
    supportsImages: true,
    thinking: { lever: 'toggle', levels: [] },
  },
  'cline-pass/qwen3.8-max': {
    name: 'Qwen3.8 Max',
    contextWindow: 1000000,
    maxTokens: 131072,
    supportsImages: true,
    thinking: { lever: 'effort', levels: ['low', 'medium', 'xhigh'] },
  },
}

/**
 * The models the generated import config carries by default.
 *
 * The panel's model tab decides what ends up in that config, and the user hands
 * the config to PI-Desktop's "从其他工具导入" to create a provider of their own -
 * which is the only kind of provider that can be edited in Settings and offered
 * to subagents. The authoritative table above still holds every Cline Pass model,
 * so nothing is lost by leaving one out.
 */
const DEFAULT_REGISTERED = [
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/glm-5.3',
  'cline-pass/kimi-k3',
  'cline-pass/minimax-m3',
]

/** Published entry for one model id, or undefined when the catalog lacks it. */
function catalogEntry(model) {
  return MODEL_CATALOG[model]
}

/** The effort levels one model publishes, or `[]` when it takes no effort. */
function effortLevelsFor(entry) {
  return Array.isArray(entry?.thinking?.levels) ? entry.thinking.levels.slice() : []
}

/**
 * The host-side thinking levels for one model: always `off` first, then every
 * level the model actually publishes.
 */
function thinkingLevelsFor(entry) {
  return [PI_THINKING_LEVELS[0], ...effortLevelsFor(entry)]
}

/** The level the host pre-selects for one model (its first published effort). */
function defaultThinkingLevel(entry) {
  const levels = effortLevelsFor(entry)
  return levels.length > 0 ? levels[0] : PI_THINKING_LEVELS[0]
}
/**
 * The `/v1/models` payload the gateway serves.
 *
 * The plugin declares no models to the host any more, so this endpoint is what
 * keeps the gateway discoverable for anyone pointing a plain OpenAI client (or a
 * second harness) at it. `registered` now means "written into the generated
 * import config", which is exactly what the panel's checkbox toggles.
 */
function modelsEndpointPayload(effective) {
  const rows = Array.isArray(effective)
    ? effective.map((model) => ({ id: model.id, entry: catalogEntry(model.id), registered: model.registered !== false }))
    : Object.entries(MODEL_CATALOG).map(([id, entry]) => ({ id, entry, registered: DEFAULT_REGISTERED.includes(id) }))
  return {
    object: 'list',
    data: rows
      .filter((row) => row.entry)
      .map(({ id, entry, registered }) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'cline-pass',
        name: entry.name,
        context_window: entry.contextWindow,
        max_tokens: entry.maxTokens,
        capabilities: entry.supportsImages ? ['text', 'image'] : ['text'],
        thinking: entry.thinking.lever,
        registered,
      })),
  }
}

module.exports = {
  REASONING_EFFORTS,
  EFFORT_ORDER,
  PI_THINKING_LEVELS,
  PI_DEFAULT_THINKING_LEVEL,
  reasoningEffortFor,
  MODEL_CATALOG,
  DEFAULT_REGISTERED,
  catalogEntry,
  effortLevelsFor,
  thinkingLevelsFor,
  defaultThinkingLevel,
  modelsEndpointPayload,
}
