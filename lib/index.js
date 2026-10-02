/**
 * dsh-openrouter-imagen v2 — Host half.
 *
 * Same generation path as v1 (OpenRouter `POST /api/v1/images`, proxy-aware,
 * attachments committed as durable references), plus the two things v2's
 * workspace needs and v1 never had:
 *
 *   1. a **generation record store** — the picture existed only as an
 *      attachment and a file, so "the last five pictures" and "generate again
 *      with the same parameters" had nothing to read (`lib/store.js`);
 *   2. a **history route** — the workspace is a UI of its own and does not read
 *      settings or conversation state, so it asks this plugin directly.
 *
 * The tool is still registered and still behaves exactly as v1's: the workspace
 * is an addition, not a replacement, so a conversation can keep calling
 * `openrouter_generate_imagen_v2` with no UI involved.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GenerationStore, HISTORY_LIMIT, recordId } from './store.js'
import { imageSize } from './image-size.js'
import { bundledSkill } from './skills.js'

/** Namespace = this plugin row's id; dsh ≥ 0.1.7 keys configurable entries by it. */
const NS = 'openrouter-imagen-v2'
const API_PATH = '/openrouter-imagen-v2/api'
const API_BASE = (process.env.OPENROUTER_IMAGE_API_BASE ?? '').trim() || 'https://openrouter.ai/api/v1'
const MEDIA_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
const MAX_REFERENCES = 4
const MAX_INLINE_BYTES = 8000000
const REQUEST_TIMEOUT_MS = 600000
const DEFAULT_SAVE_DIR = 'generated-images'

/** Every ratio the API accepts. The workspace's picker renders this same list. */
export const ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21']
export const RESOLUTIONS = ['auto', '512', '1K', '2K', '4K']
export const QUALITIES = ['auto', 'low', 'medium', 'high']
export const FORMATS = ['png', 'jpeg', 'webp']
export const BACKGROUNDS = ['auto', 'transparent', 'opaque']

/**
 * How far a delivered picture may sit from the ratio that was requested before
 * the receipt says so.
 *
 * Encoders round, so an exact match cannot be demanded — 1536×864 is 16:9 to
 * the last bit and must stay quiet. But 1200×628 against a 16:9 request is a 7%
 * drift, and a caller filling a 16:9 ad slot has to be told rather than told
 * 「参数：16:9」. 2% absorbs rounding without absorbing a real substitution.
 */
export const ASPECT_TOLERANCE = 0.02

// What an AGENT may ask for — deliberately narrower than what the workbench may
// pick, because these three were fixed by decision rather than by an API limit:
//
//   one picture   a batch makes "generate, then use it" ambiguous about which
//                 file the artefact should point at
//   always PNG    the tool's result is a path the caller is about to write into
//                 an `<img src>`; a format that varies per call makes that path
//                 unpredictable and the `.jpg`/`.webp` bytes no more useful here
//   medium|high   `auto` and `low` are panel conveniences. An agent choosing
//                 quality is spending the user's money, so it picks one of the
//                 two that can actually justify itself.
//
// `aspect_ratio`, `resolution` and `background` stay the agent's to set. The
// workbench keeps its own full list — these constrain the TOOL only.
export const AGENT_QUALITIES = ['medium', 'high']
export const AGENT_FORMAT = 'png'
export const AGENT_COUNT = 1

export const Config = Schema.object({
  apiKey: Schema.string().role('secret').volatile(),
  model: Schema.string().default('google/gemini-2.5-flash-image').volatile(),
  models: Schema.array(Schema.string()).default([]).volatile(),
  /**
   * The TEXT model used by「让 AI 写提示词」. Separate from `model` because the
   * two jobs need different models: prompt composition is a text task, and
   * pointing it at an image model would fail.
   */
  promptModel: Schema.string().default('google/gemini-2.5-flash').volatile(),
  resolution: Schema.string().default('1K').volatile(),
  aspectRatio: Schema.string().default('16:9').volatile(),
  quality: Schema.string().default('medium').volatile(),
  outputFormat: Schema.string().default('png').volatile(),
  count: Schema.number().default(1).volatile(),
  background: Schema.string().default('auto').volatile(),
  seed: Schema.string().default('').volatile(),
  /** Whether the workspace asks for confirmation after the prompt is written. Off by default. */
  confirmPrompt: Schema.boolean().default(false).volatile(),
  /** Left column width, as a fraction, so the user's split survives a reload. */
  splitRatio: Schema.number().default(0.6).volatile(),
  /** Parameter block height in px. 236 is the reviewed default. */
  paramsHeight: Schema.number().default(236).volatile(),
  providerSort: Schema.string().default('').volatile(),
  extraJson: Schema.string().default('').volatile(),
  saveDir: Schema.string().default(DEFAULT_SAVE_DIR).volatile(),
  skills: Schema.boolean().default(true).volatile(),
})

const WRITABLE = [
  'apiKey', 'model', 'models', 'promptModel', 'resolution', 'aspectRatio', 'quality', 'outputFormat',
  'count', 'background', 'seed', 'confirmPrompt', 'splitRatio', 'paramsHeight',
  'providerSort', 'extraJson', 'saveDir', 'skills',
]

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function errorMessage(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

function stamp() {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Proxy resolution mirrors undici's EnvHttpProxyAgent, plus npm's config. */
function proxyFromEnv() {
  const pick = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') return null
    return /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `http://${value}`
  }
  const https = pick(process.env.https_proxy ?? process.env.HTTPS_PROXY) ?? pick(process.env.npm_config_https_proxy)
  const http = pick(process.env.http_proxy ?? process.env.HTTP_PROXY) ?? pick(process.env.npm_config_proxy)
  return { http, https }
}

const MAX_MODELS = 16
function sanitizeModels(value) {
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || id.length > 200 || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_MODELS) break
  }
  return out
}

function clampChoice(value, allowed, fallback) {
  const text = String(value ?? '').trim()
  return allowed.includes(text) ? text : fallback
}

/* ------------------------------------------------------------------ *
 * plugin
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const readConfig = () => ({
    apiKey: config.apiKey?.get?.() ?? '',
    model: config.model?.get?.() ?? '',
    promptModel: config.promptModel?.get?.() ?? '',
    models: config.models?.get?.() ?? [],
    resolution: config.resolution?.get?.() ?? '1K',
    aspectRatio: config.aspectRatio?.get?.() ?? '16:9',
    quality: config.quality?.get?.() ?? 'medium',
    outputFormat: config.outputFormat?.get?.() ?? 'png',
    count: config.count?.get?.() ?? 1,
    background: config.background?.get?.() ?? 'auto',
    seed: config.seed?.get?.() ?? '',
    confirmPrompt: config.confirmPrompt?.get?.() === true,
    splitRatio: config.splitRatio?.get?.() ?? 0.6,
    paramsHeight: config.paramsHeight?.get?.() ?? 236,
    providerSort: config.providerSort?.get?.() ?? '',
    extraJson: config.extraJson?.get?.() ?? '',
    saveDir: config.saveDir?.get?.() ?? DEFAULT_SAVE_DIR,
    skills: config.skills?.get?.() !== false,
  })

  /* ---- generation history ---- */

  const dataDir = join(homedir(), '.dsh', 'openrouter-imagen-v2')
  const store = new GenerationStore(join(dataDir, 'history.json'))
  void store.load()

  /* ---- outbound HTTP (proxy aware, owned by this fiber) ---- */

  let pool = null
  const getPool = async () => {
    if (pool !== null) return pool
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici')
    const { http, https } = proxyFromEnv()
    const dispatcher = http === null && https === null
      ? undefined
      : new EnvHttpProxyAgent({ httpProxy: http ?? undefined, httpsProxy: https ?? undefined })
    pool = { fetch: undiciFetch, dispatcher }
    return pool
  }
  ctx.effect(
    () => () => {
      const current = pool
      pool = null
      void current?.dispatcher?.close?.()
    },
    'openrouter-imagen-v2: http pool',
  )

  async function callApi(path, body, options, keyOverride) {
    const { apiKey } = readConfig()
    // A candidate key (typed into the settings dialog, not saved yet) takes
    // precedence for this one request only. It is never written anywhere.
    const effective = typeof keyOverride === 'string' && keyOverride.trim().length > 0 ? keyOverride.trim() : apiKey
    if (typeof effective !== 'string' || effective.trim().length === 0) {
      throw new Error('未配置 API Key：请先在设置里填入 OpenRouter 密钥')
    }
    const { fetch: doFetch, dispatcher } = await getPool()
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options?.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const init = {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${effective.trim()}`,
        'content-type': 'application/json',
        'http-referer': 'https://github.com/fancyui/dsh-openrouter-imagen',
        'x-title': 'DSH OpenRouter Imagen v2',
      },
      signal,
    }
    if (dispatcher !== undefined) init.dispatcher = dispatcher
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await doFetch(`${API_BASE}${path}`, init)
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`OpenRouter 返回非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    if (!response.ok) {
      const detail = parsed?.error?.message ?? JSON.stringify(parsed).slice(0, 400)
      if (response.status === 401) {
        throw new Error(`OpenRouter 401：API Key 缺失或无效（服务端原文：“${detail}”）。请确认 Key 以 sk-or-v1- 开头且未过期。`)
      }
      throw new Error(`OpenRouter HTTP ${response.status}：${detail}`)
    }
    return parsed
  }

  /* ---- body assembly ---- */

  function referenceUrls(source) {
    const urls = []
    const push = (value) => {
      if (urls.length < MAX_REFERENCES && typeof value === 'string' && value.length > 0) urls.push(value)
    }
    const structured = Array.isArray(source?.references) ? source.references : []
    for (const entry of structured) {
      if (typeof entry === 'string') { push(entry); continue }
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.url === 'string') { push(entry.url); continue }
      if (typeof entry.data === 'string' && entry.data.length > 0) {
        const mediaType = typeof entry.mediaType === 'string' && entry.mediaType.length > 0 ? entry.mediaType : 'image/png'
        push(`data:${mediaType};base64,${entry.data}`)
      }
    }
    for (const entry of (Array.isArray(source?.reference_images) ? source.reference_images : [])) push(entry)
    return urls
  }

  function drawSeed() {
    return Math.floor(Math.random() * 2147483646) + 1
  }

  /**
   * A number that is a whole positive integer, or null for everything else.
   *
   * `Number(undefined)` is NaN — not 0, and not null. And `??` does not catch
   * it, because NaN is neither null nor undefined. So a `ref` that carried no
   * width used to write NaN into the record (JSON turned it into null, erasing
   * the difference between "unknown" and "broken") and hand NaN to the
   * renderer. Anything that is not a positive integer is unknown here, and
   * unknown is null.
   */
  function positiveInt(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null
  }

  /**
   * `16:9` as a number, or null.
   *
   * Deliberately strict, because this feeds a warning: `auto`, a typo, a
   * zero-sided ratio and a three-part ratio are all "no shape was promised",
   * and warning about a shape nobody asked for is worse than staying quiet.
   */
  function aspectRatio(aspect) {
    if (typeof aspect !== 'string') return null
    const parts = aspect.split(':')
    if (parts.length !== 2) return null
    const width = Number(parts[0])
    const height = Number(parts[1])
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    if (width <= 0 || height <= 0) return null
    return width / height
  }

  /**
   * The first delivered picture whose shape is not the shape that was asked for.
   *
   * The API takes an aspect ratio as a word and returns pixels, and nothing in
   * between promises they agree. A 16:9 request came back 1536×864 — which is
   * 16:9 — and a model that ignored the ratio entirely would have been reported
   * as a clean success that names 16:9. So the comparison happens here, on the
   * decoded bytes.
   *
   * It REPORTS, and never re-rolls: the picture is already paid for, and asking
   * again on the user's dime without being asked is not this plugin's call.
   *
   * @returns {{requested: string, width: number, height: number, ratio: number}|null}
   */
  function aspectMismatch(aspect, images) {
    const wanted = aspectRatio(aspect)
    if (wanted === null) return null
    for (const image of Array.isArray(images) ? images : []) {
      const width = positiveInt(image?.width)
      const height = positiveInt(image?.height)
      if (width === null || height === null) continue
      const ratio = width / height
      if (Math.abs(ratio - wanted) / wanted > ASPECT_TOLERANCE) {
        return { requested: aspect, width, height, ratio }
      }
    }
    return null
  }

  function buildBody(input) {
    const source = input ?? {}
    const settings = readConfig()
    const prompt = String(source.prompt ?? '').trim()
    if (prompt.length === 0) throw new Error('prompt 不能为空')
    const pick = (override, fallback) => {
      const value = override === undefined || override === null || override === '' ? fallback : override
      return value === undefined || value === null ? '' : String(value)
    }
    const palette = Array.isArray(settings.models) ? settings.models : []
    // An explicit per-call model, then the configured default, then the
    // palette's first entry — same precedence v1 settled on.
    const model = pick(source.model, settings.model).trim() || String(palette[0] ?? '').trim()
    if (model.length === 0) throw new Error('未设置模型：请在图像生成工作台的「参数」里添加一个图像模型 id')

    const body = { model, prompt }
    const rawCount = source.count ?? settings.count
    const count = Number.isFinite(Number(rawCount)) ? Math.max(1, Math.min(10, Math.floor(Number(rawCount)))) : 1
    if (count > 1) body.n = count
    const resolution = clampChoice(pick(source.resolution, settings.resolution), RESOLUTIONS, 'auto')
    if (resolution !== 'auto') body.resolution = resolution
    const aspect = clampChoice(pick(source.aspect_ratio ?? source.aspectRatio, settings.aspectRatio), ASPECTS, 'auto')
    if (aspect !== 'auto') body.aspect_ratio = aspect
    const quality = clampChoice(pick(source.quality, settings.quality), QUALITIES, 'auto')
    if (quality !== 'auto') body.quality = quality
    const format = clampChoice(pick(source.output_format ?? source.outputFormat, settings.outputFormat), FORMATS, 'png')
    if (format.length > 0) body.output_format = format
    const background = clampChoice(pick(source.background, settings.background), BACKGROUNDS, 'auto')
    if (background !== 'auto') body.background = background

    // An empty seed box means "draw one", not "omit": OpenRouter only samples
    // deterministically for a seed it was given, so the plugin draws the number
    // and reports it back — a seed that was sent is at least one that can be
    // sent again.
    const seedText = pick(source.seed, settings.seed).trim()
    const seedRandom = seedText.length === 0
    let seedDrawn
    if (seedRandom) {
      seedDrawn = drawSeed()
    } else {
      const numeric = Number(seedText)
      if (!Number.isFinite(numeric)) throw new Error(`seed 必须是数字：${seedText}`)
      seedDrawn = Math.floor(numeric)
    }
    body.seed = seedDrawn
    if (String(settings.providerSort ?? '').length > 0) body.provider = { sort: settings.providerSort }

    const extra = String(settings.extraJson ?? '').trim()
    if (extra.length > 0) {
      let parsed
      try {
        parsed = JSON.parse(extra)
      } catch (error) {
        throw new Error(`附加参数不是合法 JSON：${errorMessage(error)}`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('附加参数必须是 JSON 对象')
      for (const key of ['model', 'prompt', 'input_references']) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) throw new Error(`附加参数不能覆盖 ${key}：它由工具参数或工作台决定`)
      }
      Object.assign(body, parsed)
    }

    const refs = referenceUrls(source).slice(0, MAX_REFERENCES)
    if (refs.length > 0) body.input_references = refs.map((url) => ({ type: 'image_url', image_url: { url } }))

    const seedSent = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : seedDrawn
    const params = {
      model: String(body.model ?? ''),
      count: Number.isFinite(Number(body.n)) ? Math.floor(Number(body.n)) : 1,
      resolution: body.resolution === undefined ? 'auto' : String(body.resolution),
      aspect_ratio: body.aspect_ratio === undefined ? 'auto' : String(body.aspect_ratio),
      quality: body.quality === undefined ? 'auto' : String(body.quality),
      output_format: body.output_format === undefined ? '' : String(body.output_format),
      background: body.background === undefined ? 'auto' : String(body.background),
      seed: seedSent,
      referenceCount: refs.length,
    }
    return { body, model, referenceCount: refs.length, seed: seedSent, seedRandom: seedSent === seedDrawn && seedRandom, params }
  }

  /* ---- file placement ---- */

  /**
   * The session directory for a request that arrived over HTTP.
   *
   * A tool call gets `exec.agent.session.header.cwd` for free; the workspace's
   * `/generate` does not, because a plain HTTP request carries no session
   * identity. Without a cwd a RELATIVE `saveDir` cannot be resolved, and the
   * generator silently fell through to DSH's attachment store — the picture
   * saved, just not in the configured folder.
   *
   * So the client sends its session's directory, and this decides whether to
   * believe it. Only an absolute path is accepted: a relative one would be
   * resolved against the DSH process's own working directory, which is not the
   * user's project and is not somewhere to write pictures. Anything rejected
   * degrades to the previous attachment-only behaviour rather than failing.
   */
  function sessionCwdFrom(input) {
    const raw = typeof input?.cwd === 'string' ? input.cwd.trim() : ''
    if (raw.length === 0) return undefined
    return isAbsolute(raw) ? raw : undefined
  }

  /**
   * Where this call's pictures go.
   *
   * `requested` is the tool call's `save_dir`. It is a MODEL-chosen directory, so
   * it is held to a stricter rule than the configured one: it must resolve inside
   * the session's cwd, and when it does not, the call fails loudly. Silently
   * relocating to the configured folder is what made an earlier saveDir bug so
   * hard to see — the picture existed, just not where the caller asked for it.
   * The workbench path never passes `requested` and keeps its old behaviour.
   */
  /**
    * Resolve a tool call's `save_dir` to an absolute path, or refuse it.
    *
    * Pure on purpose: it decides, it does not create. `execute` runs it BEFORE
    * the paid request so that a directory the model picked wrongly — outside the
    * session, or unresolvable without a cwd — fails at zero cost. `generate`
    * ran these checks too, but only after the picture had already been bought.
    */
  function resolveSaveDir(cwd, requested) {
    const asked = typeof requested === 'string' ? requested.trim() : ''
    if (asked.length === 0) return null
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error(`save_dir 需要会话工作目录才能解析「${asked}」，但本次会话没有 cwd；请去掉 save_dir 用工作台的保存目录`)
    }
    const wanted = isAbsolute(asked) ? asked : join(cwd, asked)
    const rel = relative(cwd, wanted)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`save_dir 必须留在会话工作目录内：${asked}。要写到别处，请在工作台的「保存目录」里改，不要用这个参数。`)
    }
    return wanted
  }

  async function projectDirectory(cwd, requested) {
    const wanted = resolveSaveDir(cwd, requested)
    if (wanted !== null) {
      try {
        await mkdir(wanted, { recursive: true })
        return wanted
      } catch (error) {
        throw new Error(`建不出 save_dir「${wanted}」：${errorMessage(error)}`)
      }
    }
    const configured = String(readConfig().saveDir ?? '').trim()
    if (configured.length === 0) return null
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const base = isAbsolute(configured) ? configured : join(cwd, configured)
    try {
      await mkdir(base, { recursive: true })
      return base
    } catch (error) {
      console.warn(`[openrouter-imagen-v2] cannot create ${base}: ${errorMessage(error)}`)
      return null
    }
  }

  /**
   * The file name an agent asked for, as a bare stem.
   *
   * `file_name` is a NAME, not a path: a stem that carries separators or `..` is
   * refused rather than normalised, because a model that wrote `public/hero.png`
   * into `file_name` has misunderstood the two parameters, and quietly turning
   * that into a name called `public_hero.png` inside the wrong directory teaches
   * it nothing. Characters no filesystem accepts are replaced — that part is
   * noise, not intent. The extension is added by the caller from the media type.
   */
  function fileStem(raw) {
    if (raw === undefined || raw === null) return null
    const text = String(raw).trim()
    if (text.length === 0) return null
    if (text.length > 80) throw new Error(`file_name 太长（${text.length} 字），最多 80 字`)
    if (/[\\/]/u.test(text) || text.includes('..') || text === '.' || text === '..') {
      throw new Error(`file_name 只是文件名主干，不接受路径：「${text}」。要指定目录请用 save_dir。`)
    }
    const cleaned = text
      .replace(/[[<>:"|?*\u0000-\u001f]/gu, '_')
      .replace(/^[.\s]+|[.\s]+$/gu, '')
    return cleaned.length === 0 ? null : cleaned
  }

  async function writeUnique(dir, name, bytes) {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = join(dir, attempt === 0 ? name : `${stem}-${attempt + 1}${ext}`)
      try {
        await writeFile(candidate, bytes, { flag: 'wx' })
        return candidate
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          console.warn(`[openrouter-imagen-v2] cannot write ${candidate}: ${errorMessage(error)}`)
          return null
        }
      }
    }
    return null
  }

  /* ---- generation ---- */

  async function generate(input, options) {
    const withDataUrl = options?.withDataUrl === true
    const { body, model, referenceCount, seed, seedRandom, params } = buildBody(input)
    const started = Date.now()
    const json = await callApi('/images', body, { signal: options?.signal })
    const rows = Array.isArray(json?.data) ? json.data : []
    if (rows.length === 0) throw new Error('OpenRouter 未返回任何图片数据')

    const attachments = ctx.get('attachments')
    const saveToProject = await projectDirectory(options?.cwd, options?.saveDir)
    // Named once per call, not per image: `hero.png`, `hero-2.png`, `hero-3.png`
    // is a list an agent can paste into a page's sources; `hero-1.png` reads like
    // a fragment of something bigger.
    const askedStem = fileStem(options?.name)
    // Drawn ONCE, outside the loop: calling `stamp()` per image gave a batch
    // three different stems AND suffixes (`openrouter-a.png`,
    // `openrouter-b-2.png`), which is neither the requested name nor a list.
    const stem = askedStem ?? `openrouter-${stamp()}`
    const workspace = typeof options?.cwd === 'string' && options.cwd.length > 0 ? options.cwd : null
    const images = []
    for (let i = 0; i < rows.length; i += 1) {
      const encoded = typeof rows[i]?.b64_json === 'string' ? rows[i].b64_json : ''
      if (encoded.length === 0) continue
      const declared = typeof rows[i]?.media_type === 'string' && rows[i].media_type.length > 0 ? rows[i].media_type : 'image/png'
      const supported = MEDIA_EXT[declared] !== undefined
      const mediaType = supported ? declared : 'image/png'
      const bytes = Buffer.from(encoded, 'base64')
      // The shape of what actually arrived, read from its own header. The receipt
      // used to report the shape that was ASKED for — a claim taken from the same
      // object the request was built out of, so it could never be wrong, and
      // therefore could never be informative either.
      const decoded = imageSize(bytes)
      // Only a MULTI-image call gets suffixes: one picture asked for by name is
      // exactly that name.
      const suffix = rows.length > 1 && i > 0 ? `-${i + 1}` : ''
      const imageName = `${stem}${suffix}${MEDIA_EXT[mediaType]}`

      let attachment = null
      let filePath = null
      if (attachments !== undefined && supported) {
        try {
          const saved = await attachments.saveImages([{ data: bytes, mediaType, name: imageName }])
          const ref = saved?.[0]
          if (ref) {
            attachment = {
              attachmentId: String(ref.attachmentId),
              mediaType: String(ref.mediaType),
              bytes: Number(ref.bytes),
              width: positiveInt(ref.width),
              height: positiveInt(ref.height),
              name: typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : imageName,
            }
          }
        } catch (error) {
          console.warn(`[openrouter-imagen-v2] saveImages failed: ${errorMessage(error)}`)
        }
      }
      if (saveToProject !== null) {
        filePath = await writeUnique(saveToProject, imageName, bytes)
      } else if (attachments !== undefined && supported) {
        try {
          const fileRef = await attachments.saveFile({ data: bytes, name: imageName })
          const located = fileRef === undefined ? undefined : attachments.fileHostPath(fileRef)
          if (typeof located === 'string' && located.length > 0) filePath = located
        } catch {
          /* a backend without verbatim file storage is not a failure of this call */
        }
      }

      // Forward slashes on purpose: this string is what goes into an `<img src>`,
      // and a Windows-style `\` in HTML is not a separator. Null when the file
      // lives outside the session (attachment store), where "relative to the
      // session" would be a lie.
      let filePathRelative = null
      if (typeof filePath === 'string' && workspace !== null) {
        const rel = relative(workspace, filePath)
        if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) filePathRelative = rel.split(sep).join('/')
      }
      const image = { name: imageName, mediaType, bytes: bytes.length, width: decoded?.width ?? positiveInt(attachment?.width), height: decoded?.height ?? positiveInt(attachment?.height), attachment, filePath, filePathRelative }
      if (withDataUrl && bytes.length <= MAX_INLINE_BYTES) image.dataUrl = `data:${mediaType};base64,${encoded}`
      images.push(image)
    }
    if (images.length === 0) throw new Error('响应中没有可解析的图片数据（b64_json 缺失）')

    const relativeDir = saveToProject === null || workspace === null ? null : relative(workspace, saveToProject)
    const elapsedMs = Date.now() - started
    const cost = typeof json?.usage?.cost === 'number' ? json.usage.cost : null

    // The record is what makes the workspace's history and "same parameters
    // again" possible. Written after the bytes are safely stored, and a failure
    // here is reported but never fails the generation.
    const record = {
      id: recordId(),
      createdAt: Date.now(),
      prompt: String(body.prompt ?? ''),
      request: String(input?.request ?? ''),
      model,
      params,
      seed,
      seedRandom,
      outputDir: saveToProject,
      outputDirRelative: relativeDir,
      cost,
      elapsedMs,
      referenceCount,
      images: images.map((image) => ({
        name: image.name,
        mediaType: image.mediaType,
        bytes: image.bytes,
        attachmentId: image.attachment?.attachmentId ?? null,
        filePath: image.filePath,
        filePathRelative: image.filePathRelative,
        width: image.width,
        height: image.height,
      })),
    }
    try {
      await store.add(record)
    } catch (error) {
      console.warn(`[openrouter-imagen-v2] cannot record generation: ${errorMessage(error)}`)
    }

    return { model, prompt: body.prompt, referenceCount, seed, seedRandom, params, images, project: saveToProject, outputDir: saveToProject, outputDirRelative: relativeDir, cost, elapsedMs, recordId: record.id }
  }

  /* ---- prompt composition ---- */

  /**
   * Compose a professional prompt from a plain-language request.
   *
   * HOW THIS WORKS, stated plainly because the difference matters:
   *
   * The reviewed design routes this through the chat model, because the thing
   * that makes a good image prompt is the *derivation* the bundled skill
   * teaches (identify the medium, ask what makes it recognisable, delete the
   * axes it does not have). The plugin cannot reach the chat model: the client's
   * `sessions` face exposes lifecycle operations, not "send a message", and the
   * Host has no service that drives another agent's turn.
   *
   * So this asks a TEXT model directly, with the skill's derivation rules as the
   * instruction, and returns its output. That is a real model call — not a
   * template — and it is why this route needs the API key. What it does NOT do
   * is reuse the conversation's context: if the user has been discussing the
   * picture with the agent, that discussion is not part of this call.
   *
   * When the request already looks like a professional prompt (it names a
   * medium and carries camera or material specifics), it is passed through
   * untouched: rewriting an already-good prompt only loses what was in it.
   */
  /**
   * How the prompt must talk about an attached reference.
   *
   * The image model receives the reference separately, as `input_references`.
   * So the prompt is NOT where the reference's appearance is re-explained — that
   * is what the image already carries, and restating it fights the image and
   * lowers fidelity. What the prompt must add is the OPERATION, phrased relative
   * to the reference, plus one clause that anchors the subject to it.
   *
   * This is the same rule the tool description gives the model
   * (lib/index.js, the tool's own `description`), kept here as a constant so the
   * two paths cannot drift apart: the workspace writes its own prompt instead of
   * calling the tool, so it needs the rule stated in its own contract.
   */
  const REFERENCE_PROMPT_RULE = [
    'Reference images are attached and travel to the image model separately, as input_references —',
    'the model already SEES them. So write a prompt that REFERENCES them, not one that repeats them:',
    '- describe what CHANGES or what the new picture is, and say the operation relative to the',
    '  reference ("replace the background with a snowy street", "re-light the same room at dusk");',
    '- anchor the subject to the reference with one clause, e.g. "keep the product appearance from',
    '  the reference unchanged" or "the same subject as the reference, now ...";',
    '- never re-describe what the reference already shows — its colours, materials, logos, terminals,',
    '  structure, pose. That is the image\'s job, and saying it again lowers fidelity.',
    '- if the user asked for a NEW picture and merely attached a reference for look or palette, keep',
    '  one short clause naming that ("in the palette and line weight of the reference").',
  ].join('\n')

  /**
   * When to reach for this tool WITHOUT being asked.
   *
   * The tool existed only for the manual workbench, and its description said so:
   * 「只在用户确实要图时调用」 and 「工作台会展示参数、种子、保存路径与费用」. A
   * model reading that has two reasons never to call it on its own — it is told to
   * wait for a picture request, and it is told the result is somebody else's job to
   * show. Building a page is exactly the case both sentences rule out.
   *
   * Kept as a constant for the same reason as REFERENCE_PROMPT_RULE: the skill
   * states this contract too, and the two must not drift.
   */
  const AGENT_PROACTIVE_RULE = [
    '**用户没有说「出图」，不等于你不能出图。** 当用户要的是一份**产物** —— 网页、落地页、幻灯片、文档、README、报告封面 ——',
    '而这张图正是缺的那一块时，主动调用本工具把图补上，然后把它用进产物里。用户不为「每一张配图」单独下达指令，',
    '你也不必为每张图单独请示。',
    '',
    '**什么时候不要调用：** 纯文字任务；产物里已经有合适的图；只是想让成品「看起来更丰满」而自作主张。',
    '**拿不准要不要出图时，先问一句** —— 每次调用都真实消耗用户自己的 OpenRouter 额度，沉默地花钱比问一句更糟。',
  ].join('\n')

  /**
   * What the model owes the user once the picture exists.
   *
   * The path is the whole point of the call.「已生成」without a path leaves the
   * user with nothing to open, and leaves an agent that was building a page with
   * a picture it cannot reference.
   */
  const AGENT_USE_THE_PATH_RULE = [
    '**结果里有 `filePath`（绝对路径）与 `filePathRelative`（相对会话目录）。** 要把图放进你写的文件里，就用相对路径：',
    '例如生成了 `public/hero.png`，就写 `<img src="public/hero.png">`。**只说「已生成」而不给路径，对使用者没有用。**',
    '用 `save_dir` 指定图该落进产物的哪个目录（相对会话目录，如 `public`），用 `file_name` 指定文件名主干',
    '（扩展名按实际媒体类型自动决定，多张时自动加 `-2`、`-3`）。',
  ].join('\n')

  /**
   * The reference-blind version of the rule, for a prompt model that cannot take
   * images. The prompt still has to reference the image — the model just cannot
   * be told what is in it, so it must not pretend to.
   */
  const REFERENCE_BLIND_RULE = [
    'Reference images are attached and travel to the image model separately, as input_references —',
    'the model already sees them, but you cannot. Therefore:',
    '- anchor the subject to the reference with one clause ("keep the product appearance from the',
    '  reference unchanged");',
    '- say the operation relative to the reference ("replace the background with a snowy street");',
    '- never re-describe what the reference shows. You cannot see it, and guessing its contents',
    '  would contradict the image.',
  ].join('\n')

  /**
   * Turn a plain-language request into one professional prompt.
   *
   * `references` is the same list the image call will send. It matters for the
   * prompt, not just the request: a prompt composed without it is a description
   * of a picture the user was not asking for, because the whole point of an
   * attached reference is an operation performed ON it.
   */
  async function composePrompt(request, context, references) {
    const refs = referenceUrls({ references: references ?? [] }).slice(0, MAX_REFERENCES)
    // An already-professional prompt is returned verbatim. The heuristic is
    // deliberately conservative: rewriting a good prompt is a real loss, while
    // sending a mediocre one through the model costs one cheap call.
    const looksProfessional = request.length > 160
      && /(?:mm|f\/\d|bokeh|depth of field|vector|gouache|watercolour|watercolor|ink-wash|palette|lighting|composition|perspective|isometric|pixel|cel[- ]shad|linework|texture)/iu.test(request)
    if (looksProfessional) return request

    const textModel = String(readConfig().promptModel ?? '').trim() || 'google/gemini-2.5-flash'
    const buildInstruction = (rule, count) => [
      'You turn a plain-language image request into ONE professional image-generation prompt.',
      '',
      'Method — derive, do not look up:',
      '1. Identify the medium the user actually named. Write in that medium\'s own vocabulary.',
      '   Do not sort it into a fixed category first.',
      '2. Ask what makes that medium recognisable (line weight? brushwork? material? colour blocks?',
      '   pixel grid? light?) and write those axes.',
      '3. Ask what it does NOT have, and delete those axes. Focal length, aperture, softbox and',
      '   colour temperature belong to photography and photoreal 3D ONLY — writing them into a',
      '   cartoon, line drawing, ink-wash or pixel-art prompt drags the picture toward a photo.',
      '   "Light" as picture content is fine in any medium; "lighting setup" is photography.',
      '4. Fill missing slots with that medium\'s professional defaults. Do not ask questions.',
      '',
      'Cover: subject and action; medium and style; composition and framing; palette and tonality;',
      'detail and texture; any in-image text (verbatim, with capitalisation). Use concrete nouns.',
      'Never write empty words like "high-end", "atmospheric", "beautiful".',
      '',
      'If the request names an aspect ratio or a size, express it in the prompt as picture language',
      '(e.g. "vertical 9:16 portrait format, tall framing").',
      'Ignore what the request leaves out about seed, quality, format and count — those are API',
      'fields, not picture content. If the user asks for a transparent background, do NOT describe',
      'a background at all.',
      ...(count > 0 ? ['', `IMPORTANT — ${count} reference image${count > 1 ? 's are' : ' is'} attached and shown below.`, rule] : []),
      '',
      'Reply with the prompt ONLY — no preamble, no quotes, no explanation, in English.',
      context === undefined || context === '' ? '' : `\nAdditional context from the user: ${String(context).slice(0, 500)}`,
      '',
      `User request: ${request}`,
    ].join('\n')

    const ask = async (withImages) => {
      const content = withImages
        ? [
          { type: 'text', text: buildInstruction(REFERENCE_PROMPT_RULE, refs.length) },
          ...refs.map((url) => ({ type: 'image_url', image_url: { url } })),
        ]
        : buildInstruction(REFERENCE_BLIND_RULE, refs.length)
      const json = await callApi('/chat/completions', {
        model: textModel,
        messages: [{ role: 'user', content }],
        temperature: 0.7,
        max_tokens: 900,
      }, {})
      const text = json?.choices?.[0]?.message?.content
      return typeof text === 'string' ? text.trim() : ''
    }

    let prompt = ''
    try {
      prompt = await ask(refs.length > 0)
    } catch (error) {
      // A prompt model without vision (a text-only id typed into the settings
      // dialog) rejects the image parts. Losing the prompt over that would be
      // worse than writing one that cannot see the reference, so retry blind.
      if (refs.length === 0) throw error
      prompt = await ask(false)
    }
    // A model that returned nothing usable must not silently produce an empty
    // generation; fall back to the user's own words, which is what "direct" mode
    // would have sent anyway.
    return prompt.length > 0 ? prompt : request
  }

  /* ---- tool ---- */

  const tool = defineTool({
    name: 'openrouter_generate_imagen_v2',
    description:
      'Generate AND edit raster images through the OpenRouter Image API (POST /api/v1/images). 出图与改图都走这里：'
      + '文生图，以及基于参考图的图生图 —— 换背景、换风格、换光线、改颜色、换姿势、去掉或添加元素、局部重绘、扩图、出多个变体。'
      + '用户贴了一张图说「改一下」时同样调用本工具，不要回答「无法修改图片」，也不要用文字描述代替出图。\n\n'
      + '你的职责是听懂需求、写出一条专业提示词；画由生图模型完成，不要复述参考图里已经拍清楚的外观。'
      + '每次调用都会用用户自己的 OpenRouter 额度真实计费，提示词与参考图会离开本机发往 OpenRouter。\n\n'
      + AGENT_PROACTIVE_RULE + '\n\n'
      + AGENT_USE_THE_PATH_RULE + '\n\n'
      + '**`prompt` 必填，其余只在有理由时填。** 可选参数分两类：'
      + '`aspect_ratio` / `resolution` 是**你自己的工程判断** —— 用户要一份产物，而这份产物里的图有确定的几何形状'
      + '（网页 hero 要 16:9、头像要 1:1、手机壁纸要 9:16），这时填；只是构图倾向（「高一点」「更空」）就写进 prompt。'
      + '`model` / `quality` / `background` / `seed` 是**用户的所有物**，只在这条对话里用户点名了才填，'
      + '留空就是正确行为、不是遗漏 —— 不要自己判断「这次适合出几张」「提高画质会更清楚」而替他改。'
      + '画幅、分辨率、背景由你决定，**每次调用固定出一张 PNG**，没有 `count` 参数；'
      + '`quality` 只能填 `medium` 或 `high`。想要多个版本就多调用几次、改提示词。',
    // `defineTool` takes a PROPERTY MAP here (not a JSON-Schema object): each
    // key is a field, `required: true` marks the mandatory one, and dsh-tools
    // compiles it into the wire schema itself.
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述。照用户说的媒介写，用那种媒介自己的词汇（线条/笔触/材质/色块/像素网格/光影），不要往固定几类里硬塞；问「它靠什么被认出来」就写什么，问「它没有什么」就把不属于它的轴删掉。焦段、光圈、柔光箱、色温只属于摄影与照片级 3D。' },
      aspect_ratio: { type: 'string', enum: [...ASPECTS], description: '画面比例。这是你的工程判断：产物里的图有确定几何时就填（网页 hero 16:9、头像 1:1、手机壁纸 9:16）；只是构图倾向就写进 prompt。留空则用工作台的「宽高比」。' },
      resolution: { type: 'string', enum: [...RESOLUTIONS], description: '出图分辨率档。产物要当大图用（横幅、封面）时填；留空则用工作台的「分辨率」。' },
      save_dir: { type: 'string', description: '保存目录，**相对会话工作目录**，例如 public、docs/img。必须留在会话目录内，写到外面一律报错而不是换个地方存。留空则用工作台的「保存目录」。' },
      file_name: { type: 'string', description: '文件名主干，不含扩展名，例如 hero、avatar、cover。扩展名固定为 .png，不要自己写。留空则用时间戳命名。' },
      model: { type: 'string', description: '覆盖本次使用的图像模型 id。用户点名了才填，省略则用工作台当前的默认模型。' },
      quality: { type: 'string', enum: [...AGENT_QUALITIES], description: '画质档，只能是 medium 或 high。用户点名了才填，省略则用工作台的「质量」。' },
      background: { type: 'string', enum: [...BACKGROUNDS], description: '背景处理。用户点名了才填，省略则用工作台的「背景」。要透明底时不要描述背景。' },
      seed: { type: 'number', description: '固定种子以复现同一张图。用户点名了才填；省略则用工作台的种子（留空则插件抽一个随机种子并回报）。' },
      reference_images: { type: 'array', items: { type: 'string' }, description: '图生图参考图：http(s) URL 或 data URL，最多 4 张。' },
      reference_files: { type: 'array', items: { type: 'string' }, description: '本机绝对路径的参考图，必须位于会话工作目录内；越界会被拒绝。' },
    },
    // `output` is mandatory for defineTool (it reads output.render directly).
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          model: { type: 'string' },
          cost: { type: 'number' },
          elapsedMs: { type: 'number' },
          referenceCount: { type: 'number' },
          outputDir: { type: 'string' },
          outputDirRelative: { type: 'string' },
          seed: { type: 'number' },
          seedRandom: { type: 'boolean' },
          params: {
            type: 'object',
            additionalProperties: true,
            properties: {
              model: { type: 'string' },
              count: { type: 'number' },
              resolution: { type: 'string' },
              aspect_ratio: { type: 'string' },
              quality: { type: 'string' },
              output_format: { type: 'string' },
              background: { type: 'string' },
              seed: { type: 'number' },
              referenceCount: { type: 'number' },
            },
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'number' },
                width: { type: 'number', description: '实际像素宽，从图片字节的头部读出；解析不了时为空' },
                height: { type: 'number', description: '实际像素高，从图片字节的头部读出；解析不了时为空' },
                filePath: { type: 'string' },
                filePathRelative: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (value?.ok !== true) return [{ type: 'text', text: `图像生成失败：${value?.error ?? '未知错误'}` }]
        const images = Array.isArray(value.images) ? value.images : []
        const parts = [`已生成 ${images.length} 张图片（模型 ${value.model}`]
        if (value.referenceCount > 0) parts.push(`，参考图 ${value.referenceCount} 张`)
        parts.push(`，耗时 ${Math.round((value.elapsedMs ?? 0) / 1000)} 秒`)
        if (typeof value.cost === 'number') parts.push(`，费用 $${value.cost.toFixed(4)}`)
        parts.push('）。')
        const sent = value.params
        if (sent !== undefined && sent !== null) {
          const bits = []
          if (typeof sent.resolution === 'string' && sent.resolution.length > 0) bits.push(sent.resolution)
          if (typeof sent.aspect_ratio === 'string' && sent.aspect_ratio.length > 0) bits.push(sent.aspect_ratio)
          if (typeof sent.quality === 'string' && sent.quality.length > 0) bits.push(sent.quality)
          if (typeof sent.background === 'string' && sent.background !== 'auto') bits.push(`背景 ${sent.background}`)
          if (typeof sent.output_format === 'string' && sent.output_format.length > 0) bits.push(sent.output_format)
          if (typeof sent.count === 'number' && sent.count > 1) bits.push(`${sent.count} 张`)
          if (bits.length > 0) parts.push(`\n参数：${bits.join(' · ')}`)
        }
        if (typeof value.seed === 'number') parts.push(`\n种子：${value.seed}${value.seedRandom === true ? '（本次随机）' : ''}`)
        if (typeof value.outputDir === 'string' && value.outputDir.length > 0) parts.push(`\n保存目录：${value.outputDir}`)
        for (const image of images) {
          if (typeof image.filePath === 'string' && image.filePath.length > 0) parts.push(`\n文件：${image.filePath}`)
          // The relative path is the string that goes INTO the artefact — an
          // `<img src>` the agent writes, not one the user has to retype. Printing
          // only the absolute path leaves the caller doing path arithmetic.
          if (typeof image.filePathRelative === 'string' && image.filePathRelative.length > 0) {
            parts.push(`\n相对会话目录：${image.filePathRelative}`)
          }
          const width = positiveInt(image?.width)
          const height = positiveInt(image?.height)
          if (width !== null && height !== null) parts.push(`\n尺寸：${width}×${height}`)
        }
        // The one thing this receipt used to be unable to say: whether the file
        // is the shape that was ordered. `参数：` names the request, and the
        // request is not the deliverable — a 16:9 request that comes back 1:1
        // is a square picture wearing a 16:9 label.
        const mismatch = aspectMismatch(sent?.aspect_ratio, images)
        if (mismatch !== null) {
          parts.push(`\n注意：请求画幅 ${mismatch.requested}，实际交付 ${mismatch.width}×${mismatch.height}（${mismatch.ratio.toFixed(2)}:1）比例不符，投放前需自行裁剪或重出。`)
        }
        const blocks = [{ type: 'text', text: parts.join('') }]
        // The image blocks are what make the picture visible in the
        // conversation; without them the card can only show text.
        for (const image of images) {
          if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const allowed = new Set(['prompt', 'aspect_ratio', 'resolution', 'background', 'quality', 'save_dir', 'file_name', 'model', 'seed', 'reference_images', 'reference_files'])
      const unknown = Object.keys(args ?? {}).filter((key) => !allowed.has(key))
      if (unknown.length > 0) throw new Error(`未支持的参数：${unknown.join(', ')}`)
      if (typeof args?.prompt !== 'string' || args.prompt.trim().length === 0) throw new Error('prompt 必填')

      // Local reference files are read here and refused if they escape the
      // session workspace: dsh-fs-local resolves any absolute path and the file
      // sandbox guards writes, not reads, so this check is the only thing
      // between a model-chosen path and a third-party upload.
      const cwd = exec?.agent?.session?.header?.cwd
      const references = []
      for (const entry of Array.isArray(args.reference_images) ? args.reference_images : []) {
        if (typeof entry === 'string' && entry.length > 0) references.push({ url: entry })
      }
      for (const entry of Array.isArray(args.reference_files) ? args.reference_files : []) {
        if (typeof entry !== 'string' || entry.length === 0) continue
        if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('本机参考图需要会话工作目录；改用 reference_images 传 URL 或 data URL')
        const resolved = isAbsolute(entry) ? entry : join(cwd, entry)
        const rel = relative(cwd, resolved)
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`参考图必须在会话工作目录内：${entry}。请先复制进项目，或改用 reference_images 的 URL。`)
        }
        let bytes
        try {
          bytes = await readFile(resolved)
        } catch (error) {
          throw new Error(`读不到参考图 ${entry}：${errorMessage(error)}`)
        }
        const lower = resolved.toLowerCase()
        const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
          : lower.endsWith('.webp') ? 'image/webp'
            : lower.endsWith('.gif') ? 'image/gif' : 'image/png'
        references.push({ mediaType, data: bytes.toString('base64') })
      }

      const signal = exec?.signal === undefined
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : AbortSignal.any([exec.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])

      // Both of these can be refused for a reason the caller can fix, so they
      // are checked HERE, before the request that costs money. `generate` runs
      // the same rules, but by then the picture has already been bought.
      const askedSaveDir = typeof args.save_dir === 'string' && args.save_dir.trim().length > 0 ? args.save_dir.trim() : undefined
      const askedName = typeof args.file_name === 'string' ? args.file_name : undefined
      if (askedSaveDir !== undefined) resolveSaveDir(cwd, askedSaveDir)
      if (askedName !== undefined) fileStem(askedName)

      const result = await generate({
        ...args,
        references,
        // Pinned by decision, not by an API limit: one picture, always PNG.
        // Passed as per-call values because `buildBody` lets the caller's word
        // beat the panel's — the workbench keeps whatever it was set to.
        count: AGENT_COUNT,
        output_format: AGENT_FORMAT,
      }, {
        cwd,
        signal,
        // The two parameters that make「生图然后用」one step instead of three:
        // the picture lands in the artefact's own directory, under a name the
        // caller can reference, instead of a timestamped file in a shared folder.
        saveDir: askedSaveDir,
        name: askedName,
      })
      // The STRUCTURED value, not content blocks: `output.render` above turns
      // this into the text + image blocks the conversation shows.
      return {
        ok: true,
        model: result.model,
        prompt: result.prompt,
        referenceCount: result.referenceCount,
        seed: result.seed,
        seedRandom: result.seedRandom,
        params: result.params,
        cost: result.cost,
        elapsedMs: result.elapsedMs,
        outputDir: result.outputDir ?? undefined,
        outputDirRelative: result.outputDirRelative ?? undefined,
        images: result.images.map((image) => ({
          name: image.name,
          mediaType: image.mediaType,
          bytes: image.bytes,
          filePath: image.filePath ?? undefined,
          filePathRelative: image.filePathRelative ?? undefined,
          attachment: image.attachment,
        })),
      }
    },
  })

  ctx.effect(() => ctx.tools.register(tool), 'openrouter-imagen-v2: tool')

  /* ---- same-origin JSON route for the workspace ---- */

  /**
   * The key's *shape*, never the key.
   *
   * A settings dialog has to answer "is a key configured, and does it look like
   * the right kind of credential" without ever handing the secret back to the
   * page. So this reports only the prefix and the last four characters — enough
   * to recognise which key is in place, useless to anyone who reads it.
   */
  const keyPreview = () => {
    const { apiKey } = readConfig()
    const value = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (value.length === 0) return { hasKey: false, prefix: '', suffix: '', looksValid: false }
    return {
      hasKey: true,
      prefix: value.slice(0, 9),
      suffix: value.length > 13 ? value.slice(-4) : '',
      looksValid: value.startsWith('sk-or-v1-') && value.length >= 40,
    }
  }

  const publicConfig = () => {
    const settings = readConfig()
    return {
      config: {
        model: settings.model,
        models: settings.models,
        promptModel: settings.promptModel,
        resolution: settings.resolution,
        aspectRatio: settings.aspectRatio,
        quality: settings.quality,
        outputFormat: settings.outputFormat,
        count: settings.count,
        background: settings.background,
        seed: settings.seed,
        confirmPrompt: settings.confirmPrompt,
        splitRatio: settings.splitRatio,
        paramsHeight: settings.paramsHeight,
        providerSort: settings.providerSort,
        extraJson: settings.extraJson,
        saveDir: settings.saveDir,
        skills: settings.skills,
      },
      ...keyPreview(),
      options: { aspects: ASPECTS, resolutions: RESOLUTIONS, qualities: QUALITIES, formats: FORMATS, backgrounds: BACKGROUNDS },
      historyLimit: HISTORY_LIMIT,
    }
  }

  const sendJson = (res, status, payload) => {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  const readJsonBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('请求体不是合法 JSON')
    }
  }

  async function handleApi(req, res) {
    // Same trust gate the product's own routes use: a mismatched Host/Origin is
    // 403 and a missing browser auth cookie is 401. `/generate` spends the
    // stored key, so this is its only door.
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, error: rejection === 401 ? '未通过浏览器鉴权，请从 DSH 窗口访问' : '该来源不被信任' })
        return
      }
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.slice(API_PATH.length).replace(/^\/+/, '')
    const method = req.method ?? 'GET'
    try {
      if (action === 'config' && method === 'GET') {
        sendJson(res, 200, { ok: true, ...publicConfig() })
        return
      }
      if (action === 'config' && method === 'POST') {
        const patch = await readJsonBody(req)
        const next = {}
        for (const key of WRITABLE) {
          if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
          if (key === 'apiKey' && String(patch.apiKey ?? '').trim().length === 0) continue
          if (key === 'count' || key === 'splitRatio' || key === 'paramsHeight') next[key] = Number(patch[key])
          else if (key === 'skills' || key === 'confirmPrompt') next[key] = patch[key] === true || patch[key] === 'true'
          else if (key === 'models') next[key] = sanitizeModels(patch[key])
          else next[key] = patch[key]
        }
        // Reject an obviously wrong key at SAVE time rather than at generation
        // time: a key that cannot be right is worth one clear message now, not a
        // 401 after a prompt has been written. Shape only — never a network
        // call, so saving stays instant and works offline.
        if (Object.prototype.hasOwnProperty.call(next, 'apiKey')) {
          const value = String(next.apiKey).trim()
          if (!value.startsWith('sk-or-v1-')) {
            throw new Error('这看起来不是 OpenRouter 密钥：它应该以 sk-or-v1- 开头。请从 openrouter.ai/keys 复制完整密钥。')
          }
          if (value.length < 40) {
            throw new Error(`密钥看起来不完整（只有 ${value.length} 个字符，OpenRouter 密钥通常更长）。请确认复制时没有截断。`)
          }
          next.apiKey = value
        }
        if (Object.keys(next).length > 0) {
          const settings = ctx.get('settings')
          if (settings === undefined || typeof settings.update !== 'function') {
            throw new Error('设置服务不可用：当前 DSH 运行时未挂载可写的配置编辑器')
          }
          await settings.update(NS, next)
        }
        sendJson(res, 200, { ok: true, ...publicConfig() })
        return
      }
      /**
       * Clear the stored key.
       *
       * Separate from POST /config on purpose: that route IGNORES a blank
       * apiKey so an accidental empty form cannot erase a working secret, which
       * also means it cannot express "remove it". Forgetting a key has to be an
       * explicit act, so it gets its own verb.
       */
      if (action === 'config/key' && method === 'DELETE') {
        const settings = ctx.get('settings')
        if (settings === undefined || typeof settings.update !== 'function') {
          throw new Error('设置服务不可用：当前 DSH 运行时未挂载可写的配置编辑器')
        }
        await settings.update(NS, { apiKey: '' })
        sendJson(res, 200, { ok: true, ...publicConfig() })
        return
      }
      if (action === 'history' && method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? '')
        sendJson(res, 200, { ok: true, records: store.list(Number.isFinite(limit) ? limit : HISTORY_LIMIT) })
        return
      }
      // Serve one generated file's BYTES to the workspace.
      //
      // The workspace cannot use the chat's attachment loader (that one is
      // authorized per conversation message, and this UI has no message), so it
      // asks this plugin for the picture by record id + name. Only paths that
      // this plugin itself recorded are served — the id is looked up in the
      // store and the name must match a file of that record, so the route can
      // never be turned into a general file reader.
      if (action === 'image' && method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const name = url.searchParams.get('name') ?? ''
        const record = store.find(id)
        if (record === null) {
          sendJson(res, 404, { ok: false, error: '没有这条生成记录' })
          return
        }
        const image = (record.images ?? []).find((row) => row.name === name)
        if (image === undefined || typeof image.filePath !== 'string' || image.filePath.length === 0) {
          sendJson(res, 404, { ok: false, error: '这条记录没有可读的文件路径' })
          return
        }
        let bytes
        try {
          bytes = await readFile(image.filePath)
        } catch (error) {
          sendJson(res, 404, { ok: false, error: `读不到文件：${errorMessage(error)}` })
          return
        }
        res.writeHead(200, {
          'content-type': image.mediaType ?? 'image/png',
          'cache-control': 'private, max-age=3600',
          'content-length': bytes.length,
        })
        res.end(bytes)
        return
      }
      /**
       * Turn a plain-language request into a professional prompt.
       *
       * The reviewed design routes this through the chat model (the plugin's
       * own skill is what teaches prompt construction). The client cannot post
       * into a conversation — its `sessions` face exposes lifecycle, not message
       * send — so this is the leg the Host owns. It runs the generation model's
       * own prompt-composition contract in-process: the request is sent to a
       * text model with the bundled skill's derivation rules, and the returned
       * prompt is handed back for review.
       *
       * References, the per-call model and the session cwd all travel WITH this
       * call, not only with `/generate`. They used to arrive here and be
       * dropped, which meant an attached reference never reached the prompt
       * model, and — because the same call generates when the confirm switch is
       * off — was never sent to the image API either.
       */
      if (action === 'prompt' && method === 'POST') {
        const input = await readJsonBody(req)
        const request = String(input?.request ?? '').trim()
        if (request.length === 0) throw new Error('要求不能为空')
        // One normaliser for both legs, so the prompt model and the image model
        // are always shown the same references in the same order.
        const references = referenceUrls(input).slice(0, MAX_REFERENCES)
        const model = String(input?.model ?? '').trim()
        const cwd = sessionCwdFrom(input)
        const prompt = await composePrompt(request, input?.context, references)
        if (input?.generate === true) {
          const result = await generate(
            { prompt, request, model, references },
            { withDataUrl: true, cwd },
          )
          sendJson(res, 200, {
            ok: true,
            generated: true,
            prompt,
            model: result.model,
            referenceCount: result.referenceCount,
            seed: result.seed,
            seedRandom: result.seedRandom,
            params: result.params,
            elapsedMs: result.elapsedMs,
            cost: result.cost,
            images: result.images.map((image) => ({
              name: image.name,
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              filePath: image.filePath,
              filePathRelative: image.filePathRelative,
              dataUrl: image.dataUrl ?? null,
            })),
          })
          return
        }
        sendJson(res, 200, { ok: true, generated: false, prompt })
        return
      }
      if (action === 'history' && method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (typeof id === 'string' && id.length > 0) await store.remove(id)
        else await store.clear()
        sendJson(res, 200, { ok: true, records: store.list(HISTORY_LIMIT) })
        return
      }
      if (action === 'models' && method === 'GET') {
        // A key typed into the dialog is not saved yet, so the catalogue must be
        // fetchable with a CANDIDATE key. It is used for this one request and
        // never stored — that is what makes「测试」safe to press before saving.
        const candidate = String(url.searchParams.get('key') ?? '').trim()
        const json = await callApi('/images/models', undefined, {}, candidate.length > 0 ? candidate : undefined)
        const models = (Array.isArray(json?.data) ? json.data : [])
          .filter((row) => typeof row?.id === 'string' && row.id.length > 0)
          .map((row) => ({ id: row.id, name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        sendJson(res, 200, { ok: true, models, count: models.length })
        return
      }
      if (action === 'test' && method === 'GET') {
        const candidate = String(url.searchParams.get('key') ?? '').trim()
        const json = await callApi('/key', undefined, {}, candidate.length > 0 ? candidate : undefined)
        const data = json?.data ?? {}
        const parts = []
        if (typeof data.label === 'string' && data.label.length > 0) parts.push(`标签：${data.label}`)
        if (data.is_free_tier === true) parts.push('免费额度账户')
        if (typeof data.usage === 'number') parts.push(`已用：$${data.usage.toFixed(4)}`)
        if (typeof data.limit === 'number') parts.push(`额度上限：$${data.limit.toFixed(2)}`)
        else if (data.limit === null) parts.push('额度上限：未设置（按量付费）')
        if (typeof data.limit_remaining === 'number') parts.push(`剩余：$${data.limit_remaining.toFixed(4)}`)
        sendJson(res, 200, { ok: true, report: parts.length > 0 ? parts.join('　·　') : JSON.stringify(data).slice(0, 300) })
        return
      }
      if (action === 'generate' && method === 'POST') {
        const input = await readJsonBody(req)
        // The workspace sends the session's own directory, because a plain HTTP
        // request carries no session identity (only a tool call gets
        // `exec.agent.session.header.cwd`). Without it a relative `saveDir`
        // cannot be resolved and the file lands in DSH's attachment store
        // instead of the configured folder. See `sessionCwdFrom`.
        const cwd = sessionCwdFrom(input)
        const result = await generate(input, { withDataUrl: true, cwd })
        sendJson(res, 200, {
          ok: true,
          recordId: result.recordId,
          model: result.model,
          prompt: result.prompt,
          seed: result.seed,
          seedRandom: result.seedRandom,
          params: result.params,
          outputDir: result.outputDir,
          outputDirRelative: result.outputDirRelative,
          cost: result.cost,
          elapsedMs: result.elapsedMs,
          images: result.images.map((image) => ({
            name: image.name,
            mediaType: image.mediaType,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
            attachmentId: image.attachment?.attachmentId ?? null,
            filePath: image.filePath,
            filePathRelative: image.filePathRelative,
            dataUrl: image.dataUrl ?? null,
          })),
        })
        return
      }
      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${action}` })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: errorMessage(error) })
    }
  }

  const registerRoute = (service) => {
    if (service === undefined) return
    ctx.effect(() => service.register({ kind: 'prefix', path: API_PATH, handler: handleApi }), 'openrouter-imagen-v2: api route')
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) registerRoute(webServer)
  else ctx.inject(['webServer'], (webCtx) => registerRoute(webCtx.get('webServer')))

  /* ---- bundled skill ---- */

  // A skill that cannot register must not take the paid tool down with it: the
  // image capability is the point, the skill is a convenience. This mirrors the
  // reasoning in lib/skills.js, which already tolerates a missing SKILL.md — the
  // same tolerance has to apply to the registration itself, or a skill-service
  // signature change becomes "the whole plugin failed to activate".
  if (readConfig().skills !== false) {
    try {
      ctx.plugin(bundledSkill)
    } catch (error) {
      console.warn(`[openrouter-imagen-v2] bundled skill not registered: ${errorMessage(error)}`)
    }
  }

  /* ---- test seams ---- */

  ctx.provide('openrouterImagenV2', {
    NS,
    API_PATH,
    generate,
    buildBody,
    sessionCwdFrom,
    // The two decisions a tool call makes about WHERE a picture lands. Both are
    // reachable only after the API call, so a smoke test cannot get to them
    // without a network round trip — hence exported, to be tested directly.
    projectDirectory,
    resolveSaveDir,
    fileStem,
    // Deciding what a delivered picture ACTUALLY is needs real bytes, which a
    // smoke test has none of — hence exported, to be tested directly.
    imageSize,
    aspectRatio,
    aspectMismatch,
    positiveInt,
    store,
    publicConfig,
    keyPreview,
    storeFile: store.file,
  })
}

export const name = 'openrouter-imagen-v2'

/**
 * `tools` is REQUIRED, and it must be declared here rather than read lazily.
 *
 * Cordis gates the *property* form (`ctx.tools`) behind `inject`: without this
 * line, `ctx.tools.register(...)` throws `cannot get property "tools" without
 * inject` while `apply` runs, which marks the whole fiber `failed` — the route
 * never registers and every request falls through to the SPA fallback (404 on
 * GET, 405 on any other method). That failure is silent at the call site and
 * only visible in the boot diagnostic, so it is worth stating why this line
 * exists rather than leaving it to be rediscovered.
 *
 * Only `tools` is listed. Everything else this plugin touches — `webServer`,
 * `connection`, `settings`, `attachments` — is read through `ctx.get(...)`,
 * which returns `undefined` instead of throwing, so a surface missing one of
 * them loses that feature rather than the whole plugin. `tools` cannot work
 * that way: it is what the plugin IS, so waiting for it is correct.
 */
export const inject = ['tools']

export { GenerationStore }
