/**
 * The model registry: which Cline Pass models this plugin knows, with which
 * parameters - and the PI-Desktop config the user imports to get them into the
 * model picker.
 *
 * Why this module builds the config instead of feeding `manifest.json`: a
 * PI-Desktop plugin provider is *owned* by the plugin. The host refreshes
 * `providers.config_json` from the manifest on every plugin load and its settings
 * UI refuses to edit a plugin-owned provider ("This provider comes from the
 * plugin ..., which supplies its endpoint and models."), and - measured on 0.20.1
 * - the sync drops `availableForSubagents` from a plugin provider's rows. So a
 * model that arrives through the manifest can never be ticked for automatic AI
 * dispatch, i.e. it is unusable for subagents, and the user has no settings-page
 * entry to fix that.
 *
 * The way out is the one the host itself offers: 模型配置 → 从其他工具导入. The
 * panel hands the user the JSON in {@link importConfigPayload}; the host parses
 * it with its `pi`-source reader (`bindingFromPiModel`) and creates a provider
 * the *user* owns - editable, and tickable for subagents. That is now the only
 * provider this plugin produces: `contributes.providers` is gone from the
 * manifest (and `provider.register` with it), so the settings page no longer
 * carries an empty plugin row next to the imported one.
 *
 * Nothing is guessed: the catalog holds what Cline publishes, the settings hold
 * what the user asked for, and the generated config is the merge.
 *
 * @module cline-pass/models
 */

'use strict'

const {
  MODEL_CATALOG,
  DEFAULT_REGISTERED,
  catalogEntry,
  thinkingLevelsFor,
  defaultThinkingLevel,
  PI_THINKING_LEVELS,
} = require('./catalog.js')
const { GATEWAY_BASE_URL } = require('./protocol.js')

/** The per-model keys the panel may override. */
const SETTINGS_FIELDS = ['registered', 'contextWindow', 'maxTokens', 'supportsImages', 'thinkingLevels', 'defaultThinkingLevel']

/**
 * Bounds for the two numeric parameters.
 *
 * Not arbitrary: the host sizes its prompt budget from `contextWindow`, so a
 * zero or negative window would make every session unusable, and a window no
 * model could have would let a prompt silently overflow. The upper bound is a
 * sanity ceiling, not a claim about any model.
 */
const LIMITS = {
  contextWindow: { min: 1000, max: 100000000 },
  maxTokens: { min: 1, max: 100000000 },
}

/* ------------------------------ the generated config ------------------------------ */

/**
 * The provider key, label and wire protocol of the generated config.
 *
 * The id is deliberately *not* the plugin's own name: this block is what creates
 * a provider, and the plugin no longer declares one (nothing would collide).
 *
 * `api` is pinned to `chat_completions`: the gateway speaks the OpenAI dialect,
 * and the host's `pi` reader accepts `api | apiStyle | type` but only this value
 * means "OpenAI compatible". The model ids are re-spelled by {@link importModelId}
 * so an imported model never collides with one the user already gets from a
 * provider pointed straight at Cline.
 */
const IMPORT_PROVIDER_ID = 'cline-pass-local'
const IMPORT_PROVIDER_NAME = 'Cline Pass（本地网关）'
const IMPORT_PROVIDER_API = 'chat_completions'

/*
 * The model ids in the generated config are *not* the catalog's own spelling.
 *
 * The host's delegation catalog keys a model as `<vendorKey>/<modelId>`, and every
 * provider the user creates is `custom` - so an imported model whose id matches one
 * already served by a provider pointed at `api.cline.bot` collides on that key, and
 * a subagent asking for it can be answered by the *other* provider (measured: the
 * request never reached this gateway at all). A provider's display name never appears
 * in that key, so renaming the provider changes nothing; the id is the lever, and it
 * is the one thing this plugin controls. The gateway maps the prefix back
 * (`normalizeModelId`), and the plain spelling keeps working for configs generated
 * before this.
 */
const IMPORT_MODEL_PREFIX = 'cline-pass-local/'

/** The catalog id as the generated config spells it: `cline-pass/x` -> `cline-pass-local/x`. */
function importModelId(id) {
  return `${IMPORT_MODEL_PREFIX}${String(id ?? '').replace(/^cline-pass\//, '')}`
}

/**
 * The catalog id behind a generated-config id, or `null` when the id carries no
 * import prefix. Pure string work: the caller decides whether the result is a model.
 */
function unimportModelId(id) {
  const text = String(id ?? '')
  if (!text.startsWith(IMPORT_MODEL_PREFIX)) return null
  return `cline-pass/${text.slice(IMPORT_MODEL_PREFIX.length)}`
}

/*
 * Where the generated config points: `GATEWAY_BASE_URL` from `protocol.js`, which
 * is also the port the gateway binds. It used to be read back from the manifest's
 * provider block, which no longer exists - the one constant is now the only place
 * the address is written, so the JSON a user imports cannot point at a port the
 * gateway does not listen on.
 */

/**
 * The placeholder key the imported provider carries.
 *
 * It must be non-empty: an imported provider without a secret is filtered out of
 * the host's model picker entirely, while this exact value is the gateway's own
 * "the host has no key" marker - so it keeps the provider usable *and* makes the
 * gateway fall through to the plugin's account pool.
 *
 * Read lazily on purpose: `src/config.js` requires this module, so a top-level
 * `require('./config.js')` here would see its half-built exports.
 */
function hostPlaceholderKey() {
  try {
    return require('./config.js').HOST_NO_AUTH_KEY
  } catch {
    return 'pi-desktop-no-auth'
  }
}

/** Every model id the catalog knows. */
function modelIds() {
  return Object.keys(MODEL_CATALOG)
}

/** The catalog plus built-in defaults, before any user override. */
function defaultsFor(id, source) {
  const entry = catalogEntry(id, source)
  if (!entry) return null
  return {
    id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    supportsImages: entry.supportsImages === true,
    thinkingLevels: thinkingLevelsFor(entry),
    defaultThinkingLevel: defaultThinkingLevel(entry),
    registered: DEFAULT_REGISTERED.includes(id),
  }
}

/** Coerce one level list into something the host accepts and we can honour. */
function sanitizeLevels(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const allowed = value.map((level) => String(level)).filter((level) => PI_THINKING_LEVELS.includes(level))
  const unique = [...new Set(allowed)]
  if (unique.length === 0) return fallback
  // `off` is the host's "no thinking" and must always stay selectable; without
  // it a session could never turn thinking off for this model.
  if (!unique.includes('off')) unique.unshift('off')
  return unique
}

/** Keep only the overrides that are well formed; everything else is dropped. */
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, patch] of Object.entries(raw)) {
    if (!catalogEntry(id) || !patch || typeof patch !== 'object') continue
    const clean = {}
    if (typeof patch.registered === 'boolean') clean.registered = patch.registered
    for (const key of ['contextWindow', 'maxTokens']) {
      const value = Number(patch[key])
      if (Number.isFinite(value) && value >= LIMITS[key].min && value <= LIMITS[key].max) clean[key] = Math.floor(value)
    }
    if (typeof patch.supportsImages === 'boolean') clean.supportsImages = patch.supportsImages
    if (Array.isArray(patch.thinkingLevels)) clean.thinkingLevels = sanitizeLevels(patch.thinkingLevels, undefined)
    // `omit` is the host's own marker for "send no thinking field at all": its
    // model editor offers it as a default level whenever the model has any level
    // besides `off`, so it has to survive this filter like any other level.
    if (typeof patch.defaultThinkingLevel === 'string' && patch.defaultThinkingLevel.trim().length > 0) {
      clean.defaultThinkingLevel = patch.defaultThinkingLevel.trim() === 'omit' ? 'omit' : patch.defaultThinkingLevel
    }
    // The host rewrites a model's `name` into its own `alias` column (and caps it
    // at 60 characters), so this is the one user-facing label it really keeps.
    if (typeof patch.name === 'string' && patch.name.trim().length > 0) clean.name = patch.name.trim().slice(0, 60)
    if (Object.keys(clean).length > 0) out[id] = clean
  }
  return out
}

/**
 * The effective model list, in the order that decides every number: the host's
 * own row first, then the panel's fallback, then the published set.
 *
 * `hostModels` is `hostladder.readHostModels()` - the parameters of the row the
 * user imported. Where the host has a value it wins, because that row is what the
 * settings page edits and what the model picker shows; the panel's own numbers
 * only cover a model the host has no row for, which is what a fresh import needs.
 * `source` picks which published set the remaining defaults come from
 * (`catalog.js` `CATALOG_SOURCES`), so one model can be read as models.dev or as
 * Cline's own catalog.
 *
 * `published`, `edited` and `origin` say where each value came from, so the panel
 * can mark a field the host owns instead of offering an edit that would do
 * nothing.
 */
function effectiveModels(settings = {}, source, hostModels) {
  const overrides = sanitizeSettings(settings)
  const hostOf = (id) => (hostModels instanceof Map ? hostModels.get(id) : undefined)
  return modelIds()
    .map((id) => {
      const base = defaultsFor(id, source)
      const patch = overrides[id] ?? {}
      const host = hostOf(id)
      // The host owns these numbers once its row exists: that row is what the
      // settings page edits and what the picker shows, so a panel value must not
      // silently disagree with it. The panel's own numbers are the fallback for a
      // model the host has no row for - which is what a fresh import needs.
      const hostWindow = host?.contextWindow ?? undefined
      const hostMax = host?.maxTokens ?? undefined
      const hostImages = typeof host?.supportsImages === 'boolean' ? host.supportsImages : undefined
      const hostLevels = Array.isArray(host?.thinkingLevels) && host.thinkingLevels.length > 0 ? host.thinkingLevels : undefined
      const thinkingLevels = hostLevels
        ? sanitizeLevels(hostLevels, base.thinkingLevels)
        : sanitizeLevels(patch.thinkingLevels, base.thinkingLevels)
      // `omit` survives even though it is not one of the ticking levels: it is
      // the host's own spelling for "no thinking field by default", which is what
      // `off` means on the wire. Its model editor offers both, so we mirror it
      // instead of silently rewriting the user's choice back to a level.
      const preferred =
        host?.defaultThinkingLevel && (thinkingLevels.includes(host.defaultThinkingLevel) || host.defaultThinkingLevel === 'omit')
          ? host.defaultThinkingLevel
          : patch.defaultThinkingLevel === 'omit'
            ? 'omit'
            : typeof patch.defaultThinkingLevel === 'string' && thinkingLevels.includes(patch.defaultThinkingLevel)
              ? patch.defaultThinkingLevel
              : thinkingLevels.includes(base.defaultThinkingLevel)
                ? base.defaultThinkingLevel
                : thinkingLevels[0]
      return {
        id,
        name: patch.name ?? base.name,
        contextWindow: hostWindow ?? patch.contextWindow ?? base.contextWindow,
        maxTokens: hostMax ?? patch.maxTokens ?? base.maxTokens,
        supportsImages: hostImages ?? (typeof patch.supportsImages === 'boolean' ? patch.supportsImages : base.supportsImages),
        thinkingLevels,
        defaultThinkingLevel: preferred,
        registered: typeof patch.registered === 'boolean' ? patch.registered : base.registered,
        published: {
          name: base.name,
          contextWindow: base.contextWindow,
          maxTokens: base.maxTokens,
          supportsImages: base.supportsImages,
          thinkingLevels: base.thinkingLevels,
        },
        lever: catalogEntry(id, source).thinking.lever,
        // True when the catalog itself had to fall back to a stand-in default.
        fallback: catalogEntry(id, source).fallback === true,
        edited: Object.keys(patch),
        // Where each effective value came from, so the panel can mark a field the
        // host owns instead of offering an edit that would have no effect.
        origin: {
          contextWindow: hostWindow !== undefined ? 'host' : patch.contextWindow !== undefined ? 'panel' : 'catalog',
          maxTokens: hostMax !== undefined ? 'host' : patch.maxTokens !== undefined ? 'panel' : 'catalog',
          supportsImages: hostImages !== undefined ? 'host' : typeof patch.supportsImages === 'boolean' ? 'panel' : 'catalog',
          thinkingLevels: hostLevels ? 'host' : Array.isArray(patch.thinkingLevels) ? 'panel' : 'catalog',
          defaultThinkingLevel: host?.defaultThinkingLevel ? 'host' : typeof patch.defaultThinkingLevel === 'string' ? 'panel' : 'catalog',
        },
        // The host's own block, so the comparison card can show it next to the
        // catalog's suggestion without a second read.
        host: host ?? null,
      }
    })
}

/**
 * The effort levels one model accepts, read back from its effective host-side
 * level list - so an override in the panel is what the request path honours.
 */
function effortsFor(model) {
  return (model?.thinkingLevels ?? []).filter((level) => level !== 'off')
}

/**
 * The models the generated config carries: the ones the user ticked, in catalog
 * order.
 *
 * `registered` (the panel's checkbox, `config.json`'s `modelSettings[].registered`)
 * means exactly "this one goes into the JSON the user imports" - it no longer
 * feeds any host-facing file.
 */
function registeredModels(settings = {}, source) {
  return effectiveModels(settings, source).filter((model) => model.registered)
}

/**
 * The `%USERPROFILE%\.pi\agent\models.json` body for the ticked models.
 *
 * The shape is the host's `pi` source, field by field. Its reader
 * (`parsePiModelConfig` -> `bindingFromPiModel`) takes exactly:
 *   - provider: `name`, `baseUrl`, `api`, `apiKey`, `headers`, and at least one
 *     model - a provider without a model is dropped by the parser;
 *   - model: `id` (the only spelling that reader accepts), `limit.context` /
 *     `limit.output` (or `contextWindow` / `maxTokens`), `contextWindowSource` /
 *     `maxTokensSource`, `reasoning` for "offer thinking levels", `input` for
 *     image support, and `nativeWebSearch`.
 * Everything else is silently ignored - notably a model's `name`, and the whole
 * `thinkingLevels` / `defaultThinkingLevel` / `thinkingProtocol` /
 * `availableForSubagents` group, which only the host's own sync payload accepts.
 * `name` is still emitted because it costs nothing and a host that reads it would
 * then have the label; on 0.20.1 the label reaches the host through the gateway's
 * `/v1/models` instead (`src/catalog.js`).
 * `reasoning: true` is the whole ladder lever: the host answers it with its own
 * `off/low/medium/high` plus a `medium` default, so the `max` level this catalog
 * knows cannot survive the import - which is why the panel says so in as many
 * words instead of promising it.
 * Explicit `limit` values are kept as the user's own numbers, so the host's
 * models.dev backfill does not overwrite them.
 *
 * Pure computation: this never touches the filesystem, so the panel can call it
 * as often as it likes and the user decides when (and whether) to save it.
 *
 * @param settings - the per-model overrides from `config.json`.
 * @returns the config object, ready for `JSON.stringify(payload, null, 2)`.
 */
function importConfigPayload(settings = {}, source) {
  return {
    providers: {
      [IMPORT_PROVIDER_ID]: {
        name: IMPORT_PROVIDER_NAME,
        baseUrl: GATEWAY_BASE_URL,
        api: IMPORT_PROVIDER_API,
        apiKey: hostPlaceholderKey(),
        models: registeredModels(settings, source).map((model) => ({
          id: importModelId(model.id),
          name: model.name,
          limit: { context: model.contextWindow, output: model.maxTokens },
          // The host's own ladder for an imported model is its generic one; the
          // catalog's tuned ladder stays this plugin's own reading of the model.
          reasoning: model.thinkingLevels.length > 1,
          input: model.supportsImages ? ['text', 'image'] : ['text'],
        })),
      },
    },
  }
}

/** How many models the generated config would carry, as a sentence. */
function describeImportConfig(payload) {
  const models = payload?.providers?.[IMPORT_PROVIDER_ID]?.models
  const count = Array.isArray(models) ? models.length : 0
  return count === 0 ? '生成配置里现在没有模型' : `生成配置里现在有 ${count} 个模型`
}

module.exports = {
  SETTINGS_FIELDS,
  LIMITS,
  IMPORT_PROVIDER_ID,
  IMPORT_MODEL_PREFIX,
  importModelId,
  unimportModelId,
  modelIds,
  defaultsFor,
  sanitizeLevels,
  sanitizeSettings,
  effectiveModels,
  effortsFor,
  importConfigPayload,
  describeImportConfig,
}
