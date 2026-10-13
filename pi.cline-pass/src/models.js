/**
 * The model registry: which Cline Pass models this plugin registers with
 * PI-Desktop, and with which published parameters.
 *
 * Why this module exists at all: a PI-Desktop plugin provider is *owned* by the
 * plugin. The host refreshes `providers.config_json` from `manifest.json` on
 * every plugin load (`crates/host-core/src/plugins/providers.rs`) and its
 * settings UI refuses to edit a plugin-owned provider - "This provider comes
 * from the plugin ..., which supplies its endpoint and models. Enable or
 * disable it on the Plugins page." So the only surface where the user can
 * change a model's context window, output cap or which models exist at all is
 * the manifest this plugin ships. Verified on 2026-10-13 against the host
 * binary, its renderer bundle and `~/.pi-desktop/pi.sqlite` (schema v17:
 * `providers.owner_plugin_id`, model params inside `config_json.models[]` with
 * `contextWindowSource`/`maxTokensSource` set to `user` or `catalog`).
 *
 * So: settings live in the plugin's own `config.json`, and this module turns
 * them into the manifest's model list, which the host reloads. Nothing is
 * guessed - the catalog holds what Cline publishes, the settings hold what the
 * user asked for, and the manifest is the merge.
 *
 * @module pi.cline-pass/models
 */
'use strict'

const fs = require('node:fs')

const {
  MODEL_CATALOG,
  DEFAULT_REGISTERED,
  catalogEntry,
  thinkingLevelsFor,
  defaultThinkingLevel,
  PI_THINKING_LEVELS,
} = require('./catalog.js')

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

/** Every model id the catalog knows. */
function modelIds() {
  return Object.keys(MODEL_CATALOG)
}

/** The catalog plus built-in defaults, before any user override. */
function defaultsFor(id) {
  const entry = catalogEntry(id)
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
    if (typeof patch.defaultThinkingLevel === 'string') clean.defaultThinkingLevel = patch.defaultThinkingLevel
    if (Object.keys(clean).length > 0) out[id] = clean
  }
  return out
}

/**
 * The effective model list: catalog defaults merged with the user's overrides.
 *
 * `source` says where each value came from, so the panel can mark an edited
 * field instead of pretending it is published metadata.
 */
function effectiveModels(settings = {}) {
  const overrides = sanitizeSettings(settings)
  return modelIds()
    .map((id) => {
      const base = defaultsFor(id)
      const patch = overrides[id] ?? {}
      const thinkingLevels = sanitizeLevels(patch.thinkingLevels, base.thinkingLevels)
      const preferred = typeof patch.defaultThinkingLevel === 'string' && thinkingLevels.includes(patch.defaultThinkingLevel)
        ? patch.defaultThinkingLevel
        : thinkingLevels.includes(base.defaultThinkingLevel)
          ? base.defaultThinkingLevel
          : thinkingLevels[0]
      return {
        id,
        name: base.name,
        contextWindow: patch.contextWindow ?? base.contextWindow,
        maxTokens: patch.maxTokens ?? base.maxTokens,
        supportsImages: typeof patch.supportsImages === 'boolean' ? patch.supportsImages : base.supportsImages,
        thinkingLevels,
        defaultThinkingLevel: preferred,
        registered: typeof patch.registered === 'boolean' ? patch.registered : base.registered,
        published: {
          contextWindow: base.contextWindow,
          maxTokens: base.maxTokens,
          supportsImages: base.supportsImages,
          thinkingLevels: base.thinkingLevels,
        },
        lever: catalogEntry(id).thinking.lever,
        // True when the catalog itself had to fall back to a stand-in default.
        fallback: catalogEntry(id).fallback === true,
        edited: Object.keys(patch),
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

/** One manifest model entry, with the fields the host's `ModelBinding` knows. */
function manifestModel(model) {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImages: model.supportsImages,
    thinkingLevels: model.thinkingLevels,
    defaultThinkingLevel: model.defaultThinkingLevel,
  }
}

/** The manifest entries for every registered model, in catalog order. */
function registeredManifestModels(settings = {}) {
  return effectiveModels(settings)
    .filter((model) => model.registered)
    .map(manifestModel)
}

/** A short human summary of one write, for the panel and the log. */
function describeWrite(result) {
  if (result.error) return `manifest not updated: ${result.error}`
  if (!result.changed) return `manifest already declared ${result.count} model(s)`
  return `manifest now declares ${result.count} model(s)`
}

/**
 * Write the effective model list into this plugin's own `manifest.json`.
 *
 * The host reads the manifest when it loads the plugin, which is exactly what
 * happens after a development-plugin save - so this call is what makes the
 * settings take effect in the model picker. The previous manifest is kept as
 * `<manifest>.bak` so a bad edit can be undone by hand.
 *
 * @param manifestPath - absolute path to this plugin's manifest.
 * @param settings - the per-model overrides from `config.json`.
 * @param logger - `(message, detail?) => void`.
 */
function syncManifest({ manifestPath, settings = {}, logger = () => {}, backupPath = '' } = {}) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { changed: false, count: 0, error: error instanceof Error ? error.message : String(error) }
  }
  const provider = Array.isArray(doc?.contributes?.providers) ? doc.contributes.providers[0] : null
  if (!provider || !Array.isArray(provider.models)) {
    return { changed: false, count: 0, error: 'the manifest has no provider model list' }
  }
  const next = registeredManifestModels(settings)
  const current = provider.models
  if (JSON.stringify(current) === JSON.stringify(next)) {
    return { changed: false, count: next.length, path: manifestPath }
  }
  // Beside the manifest unless the caller says otherwise: the gateway keeps its
  // backup in the plugin's data directory, so a backup never rides into a package.
  const backup = backupPath || `${manifestPath}.bak`
  try {
    fs.writeFileSync(backup, fs.readFileSync(manifestPath), 'utf8')
    provider.models = next
    fs.writeFileSync(manifestPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { changed: false, count: next.length, error: error instanceof Error ? error.message : String(error), path: manifestPath }
  }
  logger('manifest model list rewritten', { count: next.length, registered: next.map((model) => model.id), backup })
  return { changed: true, count: next.length, path: manifestPath, backup }
}

module.exports = {
  SETTINGS_FIELDS,
  LIMITS,
  modelIds,
  defaultsFor,
  sanitizeLevels,
  sanitizeSettings,
  effectiveModels,
  effortsFor,
  manifestModel,
  registeredManifestModels,
  describeWrite,
  syncManifest,
}
