/**
 * Host-half smoke test — no network, no money.
 *
 * Runs the real `lib/index.js` against a stub Context and asserts the contracts
 * the workspace depends on:
 *
 *   - the plugin loads and registers its tool;
 *   - the API route answers `config` / `history` and REJECTS writes it should;
 *   - the generation record store round-trips through disk, because the history
 *     strip is only useful if it survives a restart;
 *   - `/image` serves only files this plugin itself recorded (it must not become
 *     a general file reader);
 *   - the trusted-origin gate is actually consulted.
 *
 *   node smoke.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GenerationStore, recordId } from './lib/store.js'
import { skillInternals } from './lib/skills.js'

let failures = 0
const check = (label, condition, detail) => {
  const ok = condition === true
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * 1. the generation record store
 * ------------------------------------------------------------------ */

const dir = await mkdtemp(join(tmpdir(), 'oiv2-'))
try {
  const file = join(dir, 'history.json')
  const store = new GenerationStore(file)
  await store.load()
  check('a missing history file starts empty instead of throwing', store.list().length === 0)

  const record = {
    id: recordId(),
    createdAt: Date.now(),
    prompt: 'a test prompt',
    request: '测试',
    model: 'test/model',
    params: { aspect_ratio: '16:9' },
    seed: 42,
    seedRandom: false,
    outputDir: dir,
    outputDirRelative: 'generated-images',
    cost: 0.01,
    elapsedMs: 1200,
    images: [{ name: 'a.png', mediaType: 'image/png', bytes: 10, attachmentId: 'att-1', filePath: join(dir, 'a.png'), width: 8, height: 8 }],
  }
  await store.add(record)

  // Round-trip through a SECOND instance: the point of persisting is that a
  // restart still sees the picture.
  const reopened = new GenerationStore(file)
  await reopened.load()
  check('a record survives a reload from disk', reopened.list().length === 1 && reopened.list()[0].id === record.id)
  check('find() resolves a stored id', reopened.find(record.id)?.prompt === 'a test prompt')
  check('find() returns null for an unknown id', reopened.find('nope') === null)

  // Newest first.
  const second = { ...record, id: recordId(Date.now() + 5, 0.5), createdAt: Date.now() + 5 }
  await store.add(second)
  check('list() returns newest first', store.list()[0].id === second.id)
  check('remove() deletes one record', (await store.remove(second.id)) === true)
  check('remove() reports a miss for an unknown id', (await store.remove('nope')) === false)

  // The cap holds, and eviction drops the OLDEST — the strip only ever reads
  // the newest few, so that is the right end to lose.
  await store.add({ ...record, id: 'gen-keeper' })
  for (let i = 0; i < 70; i += 1) await store.add({ ...record, id: recordId(Date.now() + 10 + i, i / 100) })
  check('the store is capped and does not grow without bound', store.list(999).length <= 60, `got ${store.list(999).length}`)
  check('eviction drops the oldest, keeping the recent ones', store.find('gen-keeper') === null)

  await store.clear()
  check('clear() empties the store', store.list().length === 0)

  // A corrupt file must degrade to empty, not throw: a bad history is not worth
  // taking the plugin down for.
  await writeFile(file, '{ this is not json', 'utf8')
  const broken = new GenerationStore(file)
  await broken.load()
  check('a corrupt history file degrades to empty', broken.list().length === 0)
} finally {
  await rm(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 2. the bundled skill
 * ------------------------------------------------------------------ */

const loaded = skillInternals.loadSkill()
check('the bundled SKILL.md is readable and has frontmatter', loaded !== null && loaded.description.length > 0)
check('the skill description fits dsh-tool-skill\'s catalog budget', loaded !== null && loaded.description.length <= skillInternals.DESCRIPTION_MAX,
  loaded === null ? '' : `length ${loaded.description.length}`)
check('the description names both intents (生成 and 修改)', loaded !== null
  && /生成|绘制/u.test(loaded.description) && /改|修改|编辑/u.test(loaded.description))
check('the description says the style list is open-ended', loaded !== null && /任何其他风格/u.test(loaded.description))
check('the skill body teaches derivation, not a lookup table', loaded !== null
  && /靠什么被认出来/u.test(loaded.body) && /它没有什么/u.test(loaded.body) && !/先定画风/u.test(loaded.body))
check('the skill body keeps the photography-gear rule', loaded !== null && /焦段、光圈、柔光箱、色温/u.test(loaded.body))
check('the skill description routes the「build something that needs a picture」case',
  loaded !== null && /网页|落地页|幻灯片|README/u.test(loaded.description))

/* ------------------------------------------------------------------ *
 * 3. the real host plugin against a stub context
 * ------------------------------------------------------------------ */

const stubConfig = (defaults) => {
  const values = { ...defaults }
  return {
    apiKey: { get: () => values.apiKey },
    model: { get: () => values.model },
    models: { get: () => values.models },
    promptModel: { get: () => values.promptModel },
    resolution: { get: () => values.resolution },
    aspectRatio: { get: () => values.aspectRatio },
    quality: { get: () => values.quality },
    outputFormat: { get: () => values.outputFormat },
    count: { get: () => values.count },
    background: { get: () => values.background },
    seed: { get: () => values.seed },
    confirmPrompt: { get: () => values.confirmPrompt },
    splitRatio: { get: () => values.splitRatio },
    paramsHeight: { get: () => values.paramsHeight },
    providerSort: { get: () => values.providerSort },
    extraJson: { get: () => values.extraJson },
    saveDir: { get: () => values.saveDir },
    skills: { get: () => false },
  }
}

const settingsWrites = []
const effects = []
const provided = {}
let gateCalls = 0
const routes = []
const tools = []
/** Names the plugin handed to `attachments.saveFile` — the no-cwd fallback. */
const attachmentWrites = []

/**
 * A Context that enforces Cordis's real `inject` gate.
 *
 * The reason this matters: reading a service as a PROPERTY (`ctx.tools`) throws
 * unless that name was declared in the plugin's `inject` — while reading it with
 * `ctx.get('tools')` returns undefined. A stub that hands out `tools` eagerly
 * makes the difference invisible, and the difference is fatal: the throw happens
 * inside `apply`, which marks the fiber `failed`, so the route never registers
 * and every request falls through to the SPA fallback.
 *
 * So this stub reproduces the gate. `ctx.get` stays permissive (that is its real
 * contract); the property form is what gets guarded.
 */
const makeCtx = (declared) => {
  const services = {
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => { gateCalls += 1; return undefined } },
    settings: { update: async (ns, patch) => { settingsWrites.push({ ns, patch }) } },
    // Records where the plugin would fall back to when it has no session
    // directory. The save-path bug was exactly this fallback firing when it
    // should not have, so the stub has to be able to observe it.
    attachments: {
      saveImages: async (rows) => rows.map((row, i) => ({
        attachmentId: `att-stub-${i}`, mediaType: row.mediaType, bytes: row.data.length, width: 8, height: 8, name: row.name,
      })),
      saveFile: async (row) => { attachmentWrites.push(row.name); return { id: `file-${row.name}` } },
      fileHostPath: (ref) => join(tmpdir(), 'oiv2-attachments', String(ref.id ?? 'x')),
    },
  }
  const guard = (key) => {
    if (!declared.includes(key)) {
      throw new Error(`cannot get property "${key}" without inject`)
    }
    return services[key]
  }
  const target = {
    effect: (fn) => { effects.push(fn()); return () => {} },
    plugin: () => {},
    provide: (key, value) => { provided[key] = value },
    get: (key) => (key === 'webServer' || key === 'connection' || key === 'settings' ? services[key] : undefined),
    inject: (names, cb) => { cb({ get: (key) => services[key] }) },
  }
  // Only the declared service names become readable properties.
  for (const key of declared) target[key] = services[key]
  // Anything else throws, like the real context does.
  return new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop === 'string' && !(prop in obj)) return guard(prop)
      return obj[prop]
    },
  })
}

const host = await import('./lib/index.js')
// `inject` is the plugin's own declaration; the stub honours exactly it.
const ctx = makeCtx(Array.isArray(host.inject) ? host.inject : [])
host.apply(ctx, stubConfig({
  model: 'test/image-model',
  models: [],
  promptModel: 'test/text-model',
  resolution: '1K',
  aspectRatio: '16:9',
  quality: 'medium',
  outputFormat: 'png',
  count: 1,
  background: 'auto',
  seed: '',
  confirmPrompt: false,
  splitRatio: 0.6,
  paramsHeight: 236,
  providerSort: '',
  extraJson: '',
  saveDir: 'generated-images',
  // A REALISTIC length: the key-shape checks below (prefix, suffix preview,
  // looksValid) only mean something against a key of the size OpenRouter issues.
  apiKey: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',
}))

check('the plugin registers its tool', tools.length === 1 && tools[0].name === 'openrouter_generate_imagen_v2',
  tools.map((t) => t.name).join(','))
check('the tool description says the agent may call it WITHOUT being asked', tools[0]?.description?.includes('用户没有说「出图」，不等于你不能出图'))
check('the tool description still refuses the decisions the model must not make', tools[0]?.description?.includes('这次适合出几张'))
check('the tool description tells the agent to USE the path, not just report the call', tools[0]?.description?.includes('只说「已生成」而不给路径，对使用者没有用'))
check('the tool description spends the proactive call rule on its own paragraph', tools[0]?.description?.includes('拿不准要不要出图时，先问一句'))
check('the tool exposes aspect_ratio/resolution as request fields the agent may fill', tools[0]?.parameters?.properties?.aspect_ratio?.enum?.includes('16:9') === true
  && tools[0]?.parameters?.properties?.resolution?.enum?.includes('2K') === true)
check('the tool exposes save_dir and file_name, the two that make「生图然后用」one step', typeof tools[0]?.parameters?.properties?.save_dir?.description === 'string'
  && typeof tools[0]?.parameters?.properties?.file_name?.description === 'string')
check('prompt stays the only required field', JSON.stringify(tools[0]?.parameters?.required) === '["prompt"]',
  JSON.stringify(tools[0]?.parameters?.required))

// What an agent may ask for is a decision, not an API limit: one picture, always
// PNG, quality medium|high. Aspect/resolution/background stay the agent's.
const toolProps = tools[0]?.parameters?.properties ?? {}
check('quality offers exactly medium and high', JSON.stringify(toolProps.quality?.enum) === JSON.stringify(['medium', 'high']),
  JSON.stringify(toolProps.quality?.enum))
check('count is not offered at all — one picture per call', toolProps.count === undefined,
  `count is still a field: ${JSON.stringify(toolProps.count)}`)
check('aspect_ratio, resolution and background stay the agent to set',
  Array.isArray(toolProps.aspect_ratio?.enum) && Array.isArray(toolProps.resolution?.enum) && Array.isArray(toolProps.background?.enum))
check('the tool description says one PNG per call and names no count parameter',
  String(tools[0]?.description ?? '').includes('固定出一张 PNG')
  && String(tools[0]?.description ?? '').includes('没有 `count` 参数'),
  'the description must state the pinned format/count so the model stops offering them')

/**
 * The skill body and the tool description are two hand-written copies of ONE
 * contract. Nothing but a check stops them drifting, and the drift is invisible:
 * the routing text sends the agent one way while the tool description tells it
 * another, and both read as authoritative.
 */
{
  const contract = [
    ['用户没有说「出图」，不等于你不能出图', 'the proactive rule itself'],
    ['拿不准要不要出图时，先问一句', 'the cost caveat'],
    ['只说「已生成」而不给路径，对使用者没有用', 'the obligation to hand back a path'],
  ]
  const toolDescription = String(tools[0]?.description ?? '')
  for (const [phrase, what] of contract) {
    check(`the skill body and the tool description say the same thing about ${what}`,
      loaded?.body?.includes(phrase) === true && toolDescription.includes(phrase),
      'one of the two copies is missing this sentence')
  }
}
check('the API route registered a prefix mount', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/openrouter-imagen-v2/api',
  JSON.stringify(routes[0] ?? null))
check('the plugin publishes a test seam', provided.openrouterImagenV2 !== undefined)

/* ---- call the route the way the workspace does ---- */

const callRoute = async (method, path, body) => {
  const url = `/openrouter-imagen-v2/api${path}`
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  let status = 0
  let payload = ''
  const headers = {}
  const res = {
    writeHead: (code, h) => { status = code; Object.assign(headers, h ?? {}) },
    end: (chunk) => { payload = chunk === undefined ? '' : String(chunk) },
  }
  await routes[0].handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(payload) } catch { /* a binary body (the image route) */ }
  return { status, headers, payload, parsed }
}

const configRes = await callRoute('GET', '/config')
check('GET /config passes the trusted-origin gate', gateCalls > 0)
check('GET /config reports the settings the workspace renders',
  configRes.parsed?.ok === true && configRes.parsed.config.aspectRatio === '16:9' && configRes.parsed.config.quality === 'medium')
check('GET /config never returns the API key', JSON.stringify(configRes.parsed ?? {}).includes('sk-or-v1-0123456789') === false)
check('GET /config reports whether a key exists', configRes.parsed?.hasKey === true)
check('GET /config publishes the ratio list the picker renders',
  Array.isArray(configRes.parsed?.options?.aspects) && configRes.parsed.options.aspects.includes('21:9'))

const histRes = await callRoute('GET', '/history')
check('GET /history answers with a records array', histRes.parsed?.ok === true && Array.isArray(histRes.parsed.records))

// A blank apiKey must NOT be written (it would erase the stored secret).
const blankKey = await callRoute('POST', '/config', { apiKey: '' })
check('POST /config ignores a blank apiKey', blankKey.parsed?.ok === true)
check('a blank apiKey reaches the settings service not at all',
  settingsWrites.every((write) => write.patch.apiKey === undefined), JSON.stringify(settingsWrites))

/* ---- the settings dialog's contract ---- */

// The dialog has to recognise which key is stored WITHOUT being handed the key.
// So the preview is a shape, not the secret: prefix + last four.
check('GET /config previews the stored key instead of returning it',
  configRes.parsed?.prefix === 'sk-or-v1-' && configRes.parsed?.suffix === 'cdef',
  JSON.stringify({ prefix: configRes.parsed?.prefix, suffix: configRes.parsed?.suffix }))
check('the key preview does not contain the whole key',
  String(configRes.parsed?.prefix ?? '').length + String(configRes.parsed?.suffix ?? '').length < 'sk-or-v1-test'.length + 8)
check('GET /config reports a well-formed key as valid', configRes.parsed?.looksValid === true)
check('GET /config exposes the prompt model the dialog edits', typeof configRes.parsed?.config?.promptModel === 'string')

// A key that cannot possibly be right is refused at SAVE time. Waiting until a
// generation 401s would waste the prompt-composition call that precedes it.
const badPrefix = await callRoute('POST', '/config', { apiKey: 'not-a-key' })
check('POST /config refuses a key that is not an OpenRouter key',
  badPrefix.parsed?.ok === false && String(badPrefix.parsed?.error ?? '').includes('sk-or-v1-'),
  String(badPrefix.parsed?.error ?? ''))
check('a refused key is not written anywhere', settingsWrites.every((write) => write.patch.apiKey === undefined))

const truncated = await callRoute('POST', '/config', { apiKey: 'sk-or-v1-short' })
check('POST /config refuses a truncated key',
  truncated.parsed?.ok === false && String(truncated.parsed?.error ?? '').includes('不完整'),
  String(truncated.parsed?.error ?? ''))

const goodKey = await callRoute('POST', '/config', { apiKey: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef' })
check('POST /config accepts a well-formed key', goodKey.parsed?.ok === true, String(goodKey.parsed?.error ?? ''))
check('an accepted key is written to the settings service',
  settingsWrites.some((write) => typeof write.patch.apiKey === 'string' && write.patch.apiKey.startsWith('sk-or-v1-')))

// Forgetting a key is explicit: the POST route cannot express "remove it"
// (blanks are ignored), so DELETE exists for exactly that.
const beforeForget = settingsWrites.length
const forgot = await callRoute('DELETE', '/config/key')
check('DELETE /config/key clears the stored key', forgot.parsed?.ok === true
  && settingsWrites.slice(beforeForget).some((write) => write.patch.apiKey === ''))

// The dialog edits the text model and the palette through the same route.
const advanced = await callRoute('POST', '/config', { promptModel: 'vendor/text-model', models: ['a/one', 'b/two'] })
check('POST /config writes the prompt model the dialog edits',
  settingsWrites.some((write) => write.patch.promptModel === 'vendor/text-model'))
check('POST /config sanitizes the model palette',
  settingsWrites.some((write) => Array.isArray(write.patch.models) && write.patch.models.length === 2))

// The catalogue and the key test must accept a CANDIDATE key, because the whole
// point is to check a key BEFORE committing it to settings.
const candidateModels = await callRoute('GET', '/models?key=sk-or-v1-candidate')
check('GET /models accepts a candidate key without saving it',
  candidateModels.parsed?.ok === false || candidateModels.parsed?.ok === true,
  'the route must answer rather than crash')
check('a candidate key is never written to settings',
  settingsWrites.every((write) => String(write.patch.apiKey ?? '') !== 'sk-or-v1-candidate'))

const unknown = await callRoute('GET', '/nope')
check('an unknown action 404s', unknown.status === 404 && unknown.parsed?.ok === false)

// The image route must refuse anything not in the store: this is what keeps it
// from being a general file reader.
const escape = await callRoute('GET', '/image?id=../../etc&name=passwd')
check('GET /image refuses an unknown record id', escape.status === 404, `status ${escape.status}`)

const unknownRecord = await callRoute('GET', `/image?id=${recordId()}&name=whatever.png`)
check('GET /image refuses a record id that was never stored', unknownRecord.status === 404)

// A recorded id whose file is missing must also be a clean 404.
const store = provided.openrouterImagenV2.store
await store.add({
  id: 'gen-test-image', createdAt: Date.now(), prompt: 'p', request: '', model: 'm',
  params: {}, seed: 1, seedRandom: false, outputDir: null, outputDirRelative: null,
  cost: null, elapsedMs: null,
  images: [{ name: 'gone.png', mediaType: 'image/png', bytes: 0, attachmentId: null, filePath: join(tmpdir(), 'definitely-missing-oiv2.png'), width: null, height: null }],
})
const missing = await callRoute('GET', '/image?id=gen-test-image&name=gone.png')
check('GET /image 404s when the recorded file is gone', missing.status === 404)
const wrongName = await callRoute('GET', '/image?id=gen-test-image&name=other.png')
check('GET /image refuses a name that is not part of that record', wrongName.status === 404)
await store.clear()

/* ---- generation input validation (no network reached) ---- */

const tool = tools[0]
const callTool = async (args) => tool.execute(args, { agent: { session: { header: { cwd: dir } } } })

let rejectedUnknown = ''
try { await callTool({ prompt: 'x', nope: 1 }) } catch (error) { rejectedUnknown = String(error.message) }
check('the tool rejects undeclared parameters', rejectedUnknown.includes('未支持的参数'), rejectedUnknown)

let rejectedEmpty = ''
try { await callTool({ prompt: '   ' }) } catch (error) { rejectedEmpty = String(error.message) }
check('the tool rejects an empty prompt', rejectedEmpty.includes('prompt 必填'), rejectedEmpty)

// The wire schema is compiled from the property map, so a typo'd ratio is
// rejected with the valid list rather than silently falling back to the panel's
// value — which would look like the agent's own choice succeeded.
let rejectedRatio = ''
try { await callTool({ prompt: 'x', aspect_ratio: '16/9' }) } catch (error) { rejectedRatio = String(error.message) }
check('a typo in aspect_ratio is rejected with the valid list, before any request', rejectedRatio.includes('16:9'), rejectedRatio)

let rejectedResolution = ''
try { await callTool({ prompt: 'x', resolution: '2k' }) } catch (error) { rejectedResolution = String(error.message) }
check('resolution is case-sensitive, as the API is', rejectedResolution.includes('2K'), rejectedResolution)

let rejectedEscape = ''
try { await callTool({ prompt: 'x', reference_files: ['C:/Windows/System32/drivers/etc/hosts'] }) } catch (error) { rejectedEscape = String(error.message) }
check('a reference file outside the session workspace is refused', rejectedEscape.includes('工作目录内'), rejectedEscape)

/* ---- save_dir and file_name: where an agent's picture lands, and what it is called ---- */

/**
 * Both decisions are exported and tested directly, so they can be exercised
 * without a request. `execute` ALSO runs them before it spends anything — the
 * tool-level assertions below prove that, by refusing inputs that would
 * otherwise only fail once the picture had been bought.
 *
 * The behaviour they pin is the one that makes「做网页时自动生图然后用」a single
 * step instead of three: the file must land inside the artefact's own directory,
 * under the name the page will reference, and a path outside the project must be
 * an ERROR rather than a quiet relocation — the old saveDir bug was exactly a
 * picture that saved to somewhere nobody asked for.
 */
{
  const seam = provided.openrouterImagenV2
  const project = join(tmpdir(), 'dsh-imagen-agent-project')

  const chosen = await seam.projectDirectory(project, 'public')
  check('save_dir resolves against the session directory', chosen === join(project, 'public'), chosen)

  const root = await seam.projectDirectory(project, '.')
  check('save_dir may be the session directory itself', root === project, root)

  const absoluteInside = await seam.projectDirectory(project, join(project, 'docs', 'img'))
  check('an absolute save_dir inside the session is accepted', absoluteInside === join(project, 'docs', 'img'), absoluteInside)

  let escaped = ''
  try { await seam.projectDirectory(project, '../outside') } catch (error) { escaped = String(error.message) }
  check('a save_dir that escapes the session is refused, not relocated', escaped.includes('必须留在会话工作目录内'), escaped)

  let escapedAbsolute = ''
  try { await seam.projectDirectory(project, join(tmpdir(), 'somewhere-else')) } catch (error) { escapedAbsolute = String(error.message) }
  check('an absolute save_dir outside the session is refused too', escapedAbsolute.includes('必须留在会话工作目录内'), escapedAbsolute)

  let withoutCwd = ''
  try { await seam.projectDirectory(undefined, 'public') } catch (error) { withoutCwd = String(error.message) }
  check('save_dir without a session directory is refused rather than guessed', withoutCwd.includes('save_dir 需要会话工作目录'), withoutCwd)

  // No save_dir is the workbench's business: it must still fall back to the
  // configured folder, unchanged by any of this.
  const configured = await seam.projectDirectory(project)
  check('no save_dir still lands in the configured folder', configured === join(project, 'generated-images'), configured)

  check('file_name is kept as a bare stem', seam.fileStem('hero') === 'hero')
  check('file_name with characters no filesystem accepts is cleaned, not refused',
    seam.fileStem('hero:cover?') === 'hero_cover_', seam.fileStem('hero:cover?'))
  check('an empty or absent file_name means「use the default name」',
    seam.fileStem(undefined) === null && seam.fileStem('   ') === null)
  let stemIsPath = ''
  try { seam.fileStem('public/hero') } catch (error) { stemIsPath = String(error.message) }
  check('a file_name that carries a path is refused, not flattened into a name', stemIsPath.includes('不接受路径'), stemIsPath)
  let stemEscapes = ''
  try { seam.fileStem('../hero') } catch (error) { stemEscapes = String(error.message) }
  check('a file_name that climbs out is refused', stemEscapes.includes('不接受路径'), stemEscapes)

  // The naming has to reach the write, not just the decision.
  const hostSource = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check('the generated name is the stem plus the real media extension',
    /\$\{stem\}\$\{suffix\}\$\{MEDIA_EXT\[mediaType\]\}/u.test(hostSource),
    'file_name must not decide the extension — the media type does')
  check('only a multi-image call gets name suffixes',
    /rows\.length > 1 && i > 0 \? `-\$\{i \+ 1\}` : ''/u.test(hostSource),
    'a single picture asked for by name is exactly that name')
  check('the tool hands save_dir and file_name to generate()',
    /saveDir: askedSaveDir[\s\S]{0,80}name: askedName/u.test(hostSource),
    'without the pass-through the two parameters reach the API and change nothing')
  check('each image carries the session-relative path the caller writes into its artefact',
    /filePathRelative = rel\.split\(sep\)\.join\('\/'\)/u.test(hostSource)
    && /相对会话目录：/u.test(hostSource),
    'the absolute path alone leaves the caller doing path arithmetic')
}

/* ---- what the result actually SAYS ---- */

/**
 * The assertion this file was missing.
 *
 * `render` printed the absolute path and the session-relative path on the SAME
 * line, and the only thing covering it checked that the string「相对会话目录：」
 * occurs in the SOURCE. The string was there — welded onto the wrong thing — so
 * `npm run all` stayed green while the single most useful value in the result
 * was unreadable line by line.
 *
 * So call the real `render`, with its real two-argument shape, and read lines.
 */
{
  check('the tool exposes the renderer that builds the result text', typeof tool?.output?.render === 'function')

  const renderOne = (images) => {
    if (typeof tool?.output?.render !== 'function') return ''
    const blocks = tool.output.render({}, {
      ok: true,
      model: 'test/model',
      seed: 42,
      seedRandom: false,
      params: { resolution: '2K', aspect_ratio: '16:9', quality: 'high', output_format: 'png', count: 1 },
      cost: 0.0097,
      elapsedMs: 19000,
      outputDir: join(dir, 'generated-images'),
      images,
    })
    const block = (Array.isArray(blocks) ? blocks : []).find((entry) => entry?.type === 'text')
    if (Array.isArray(block?.text)) return block.text.join('')
    return String(block?.text ?? '')
  }

  const absolute = join(dir, 'generated-images', 'hero.png')
  const single = renderOne([{ filePath: absolute, filePathRelative: 'generated-images/hero.png' }])
  check('the absolute path prints on a line of its own', single.split('\n').includes(`文件：${absolute}`), single)
  check('the session-relative path prints on a line of its own',
    single.split('\n').includes('相对会话目录：generated-images/hero.png'), single)
  check('the two paths are never welded onto one line', !/文件：[^\n]*相对会话目录：/u.test(single), single)

  // The shape that actually shipped broken: only the LAST image welded, because
  // every earlier one was rescued by the next `文件：` line bringing its own \n.
  const batch = renderOne([
    { filePath: join(dir, 'generated-images', 'hero.png'), filePathRelative: 'generated-images/hero.png' },
    { filePath: join(dir, 'generated-images', 'hero-2.png'), filePathRelative: 'generated-images/hero-2.png' },
  ])
  check('in a two-image result BOTH relative paths get their own line',
    !/文件：[^\n]*相对会话目录：/u.test(batch)
    && batch.split('\n').filter((line) => line.startsWith('相对会话目录：')).length === 2,
    batch)
}

/* ---- what a delivered picture ACTUALLY is ---- */

/**
 * The receipt used to be an echo of the request.
 *
 * `render` printed the resolution tier and the aspect ratio out of the outbound
 * body, so 「参数：2K · 16:9」 described what was ASKED for — read from the same
 * object the request was built out of, so it could not be wrong and could not be
 * informative. A 2K 16:9 call came back 1536×864 and the receipt still said 2K;
 * finding that out needed a shell and a PNG header reader.
 *
 * So the shape is now read from the delivered bytes, printed, and compared with
 * the shape that was ordered. Both halves are needed: a number nobody shows is
 * a number nobody acts on, and a comparison nobody reports is a comparison
 * nobody runs.
 */
{
  const seam = provided.openrouterImagenV2
  const sizeOf = typeof seam?.imageSize === 'function' ? seam.imageSize : () => null
  const mismatchOf = typeof seam?.aspectMismatch === 'function' ? seam.aspectMismatch : () => null
  const positive = typeof seam?.positiveInt === 'function' ? seam.positiveInt : () => 'the seam does not export it'

  const be32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
  const be16 = (value) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b }

  /** The 24 leading bytes of a PNG. Everything after IHDR is image data. */
  const png = (width, height) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    be32(13),
    Buffer.from('IHDR', 'latin1'),
    be32(width),
    be32(height),
    Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
  ])

  const jpegSegment = (marker, payload) =>
    Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload])

  /** A JPEG whose SOF sits BEHIND an APP0 and a DHT — the offset is not fixed,
   *  and DHT (0xC4) is the segment a lazy parser mistakes for a frame. */
  const jpeg = (width, height, sof = 0xc0) => Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.alloc(16)),
    jpegSegment(0xc4, Buffer.alloc(24)),
    jpegSegment(sof, Buffer.concat([Buffer.from([0x08]), be16(height), be16(width), Buffer.from([0x03, 0x01, 0x11, 0x00])])),
  ])

  const gif = (width, height) => {
    const b = Buffer.alloc(13)
    b.write('GIF89a', 0, 'latin1')
    b.writeUInt16LE(width, 6)
    b.writeUInt16LE(height, 8)
    return b
  }

  const deep = (actual, width, height) => actual?.width === width && actual?.height === height
  const shown = (value) => JSON.stringify(value ?? null)

  check('the plugin reads a PNG\'s dimensions out of its own header',
    deep(sizeOf(png(1536, 864)), 1536, 864), shown(sizeOf(png(1536, 864))))
  check('it reads them from a plain Uint8Array as well as a Buffer',
    deep(sizeOf(new Uint8Array(png(1536, 864))), 1536, 864))
  check('it walks JPEG segments to the frame, skipping the ones that only look like one',
    deep(sizeOf(jpeg(1200, 628)), 1200, 628) && deep(sizeOf(jpeg(800, 600, 0xc2)), 800, 600),
    `${shown(sizeOf(jpeg(1200, 628)))} / ${shown(sizeOf(jpeg(800, 600, 0xc2)))}`)
  check('it reads a GIF screen descriptor', deep(sizeOf(gif(640, 480)), 640, 480), shown(sizeOf(gif(640, 480))))

  // WebP has three container variants with bit-packed 14-bit fields. A wrong
  // number is worse than no number, so this must be UNKNOWN, not a guess.
  const webp = Buffer.concat([
    Buffer.from('RIFF'), be32(20), Buffer.from('WEBPVP8 '), be32(16), Buffer.from([0x00, 0x00, 0x00]),
  ])
  check('an unreadable container reports UNKNOWN instead of guessing', sizeOf(webp) === null, shown(sizeOf(webp)))
  check('garbage, an empty buffer and a truncated header all report UNKNOWN without throwing',
    sizeOf(Buffer.from([0x00, 0x01, 0x02, 0x03])) === null
    && sizeOf(Buffer.alloc(0)) === null
    && sizeOf(png(1536, 864).subarray(0, 20)) === null
    && sizeOf('not bytes at all') === null)
  check('a header claiming 0×0 is refused rather than written into a record',
    sizeOf(png(0, 0)) === null, shown(sizeOf(png(0, 0))))

  /* ---- the comparison that turns the number into a warning ---- */

  const asked = (aspect, images) => mismatchOf(aspect, images)

  check('a delivered 16:9 picture does not warn against a 16:9 request',
    asked('16:9', [{ width: 1536, height: 864 }]) === null)
  check('a real substitution is caught — 1200×628 is 1.91, not 1.78',
    asked('16:9', [{ width: 1200, height: 628 }]) !== null,
    shown(asked('16:9', [{ width: 1200, height: 628 }])))
  check('a square delivered against a 16:9 request is caught',
    asked('16:9', [{ width: 1024, height: 1024 }]) !== null)
  check('`auto` promised no shape, so nothing can contradict it',
    asked('auto', [{ width: 1024, height: 1024 }]) === null)
  check('a typo is not a promise either',
    asked('wide', [{ width: 1024, height: 1024 }]) === null
    && asked(undefined, [{ width: 1, height: 9 }]) === null
    && asked('16:9', []) === null)
  check('an UNKNOWN size is silence, not a false alarm',
    asked('16:9', [{ width: null, height: null }]) === null
    && asked('16:9', [{ width: 1536, height: null }]) === null)
  // Either side of the 2% line: 1.5% of drift is rounding, 2.5% is a different
  // picture. A tolerance test that only tries the extremes proves nothing.
  check('1.5% of drift stays quiet while 2.5% is reported',
    asked('16:9', [{ width: 1513, height: 864 }]) === null
    && asked('16:9', [{ width: 1574, height: 864 }]) !== null)

  /* ---- the receipt itself ---- */

  const renderText = (images) => {
    if (typeof tool?.output?.render !== 'function') return ''
    const blocks = tool.output.render({}, {
      ok: true,
      model: 'test/model',
      seed: 42,
      seedRandom: false,
      params: { resolution: '2K', aspect_ratio: '16:9', quality: 'high', output_format: 'png', count: 1 },
      cost: 0.0097,
      elapsedMs: 19000,
      outputDir: join(dir, 'generated-images'),
      images,
    })
    const block = (Array.isArray(blocks) ? blocks : []).find((entry) => entry?.type === 'text')
    if (Array.isArray(block?.text)) return block.text.join('')
    return String(block?.text ?? '')
  }

  const at = join(dir, 'generated-images', 'hero.png')
  const named = { filePath: at, filePathRelative: 'generated-images/hero.png' }

  const sized = renderText([{ ...named, width: 1536, height: 864 }])
  check('the receipt states the DELIVERED size', sized.split('\n').includes('尺寸：1536×864'), sized)
  check('the requested tier and the delivered pixels are both on the receipt, so they can be compared by eye',
    /参数：2K · 16:9 · high · png/u.test(sized) && /尺寸：1536×864/u.test(sized), sized)

  const substituted = renderText([{ ...named, width: 1200, height: 628 }])
  check('a shape that is not the one ordered is called out in words',
    /注意：请求画幅 16:9，实际交付 1200×628/u.test(substituted), substituted)
  check('a matching shape gets no warning', !renderText([{ ...named, width: 1536, height: 864 }]).includes('注意：'))

  const unknown = renderText([named])
  check('an UNKNOWN size prints no size line, and no placeholder either',
    !unknown.includes('尺寸：') && !unknown.includes('undefined') && !unknown.includes('null'), unknown)
  check('a NaN dimension never reaches the receipt', !renderText([{ ...named, width: NaN, height: NaN }]).includes('NaN'))

  /* ---- the NaN that got here in the first place ---- */

  check('a width the attachment store did not provide stays null instead of becoming NaN',
    positive(undefined) === null && positive(null) === null && positive(NaN) === null && positive(0) === null,
    `${String(positive(undefined))} / ${String(positive(NaN))} / ${String(positive(0))}`)
  check('a width that IS there passes through untouched',
    positive(1536) === 1536 && positive('864') === 864)

  // `positiveInt` existing is not the fix; the CALL SITE using it is. That line
  // only runs against a live attachment store, which this file has no way to
  // fake, so the wiring is asserted from the source — the same escape hatch the
  // neighbouring blocks use for what they cannot run.
  const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check('the attachment width is read null-safely at the call site, not with a bare Number()',
    /width: positiveInt\(ref\.width\)/u.test(source) && !/width: Number\(ref\.width\)/u.test(source))
  check('the decoded size reaches the record and the routes, not the attachment\'s copy',
    /const decoded = imageSize\(bytes\)/u.test(source)
    && /width: image\.width/u.test(source)
    && !/width: image\.attachment\?\.width/u.test(source))
}

/* ---- refusals that must cost nothing ---- */

/**
 * This file has no API key and no network. A call that reached `callApi` would
 * fail with a key or config error instead — so getting the REFUSAL message back
 * is itself the proof that no request was sent. Both of these used to be
 * refused inside `generate`, i.e. after the picture had been bought.
 */
{
  let badStem = ''
  try { await callTool({ prompt: 'x', file_name: '../hero' }) } catch (error) { badStem = String(error.message) }
  check('a file_name that climbs out is refused BEFORE any paid request',
    badStem.includes('不接受路径'), badStem)

  let badDir = ''
  try { await callTool({ prompt: 'x', save_dir: '../outside' }) } catch (error) { badDir = String(error.message) }
  check('a save_dir that escapes the session is refused BEFORE any paid request',
    badDir.includes('必须留在会话工作目录内'), badDir)

  let countArg = ''
  try { await callTool({ prompt: 'x', count: 3 }) } catch (error) { countArg = String(error.message) }
  check('count is refused as an undeclared parameter', countArg.includes('未支持的参数') && countArg.includes('count'), countArg)
}

/* ---- what the tool pins, and what the workbench keeps ---- */

/**
 * One picture, always PNG — pinned as PER-CALL values, because `buildBody` lets
 * the caller's word beat the stored one. That precedence is the whole mechanism,
 * so it is tested against a panel configured for something else; and the panel
 * must still get what it asked for, or this "fix" would have quietly changed the
 * workbench too.
 */
{
  const pinProvided = {}
  const pinCtx = {
    effect: (fn) => { fn(); return () => {} },
    plugin: () => {},
    provide: (key, value) => { pinProvided[key] = value },
    get: (key) => (key === 'webServer' ? { register: () => () => {} } : undefined),
    inject: (names, cb) => cb({ get: () => undefined }),
    tools: { register: () => () => {} },
  }
  const pinHost = await import('./lib/index.js')
  pinHost.apply(pinCtx, stubConfig({
    model: 'test/image-model', models: [], promptModel: 'test/text', apiKey: 'sk-or-v1-test',
    resolution: 'auto', aspectRatio: 'auto', quality: 'auto', outputFormat: 'jpeg',
    count: 4, background: 'auto', seed: '', confirmPrompt: false, splitRatio: 0.6,
    paramsHeight: 236, providerSort: '', extraJson: '', saveDir: 'generated-images',
  }))

  const pinned = pinProvided.openrouterImagenV2.buildBody({ prompt: 'x', count: 1, output_format: 'png' })
  check('a per-call count of 1 beats a panel asking for four',
    pinned.body.n === undefined && pinned.params.count === 1, JSON.stringify(pinned.body.n))
  check('a per-call PNG beats the panel format', pinned.body.output_format === 'png', pinned.body.output_format)

  const panelSide = pinProvided.openrouterImagenV2.buildBody({ prompt: 'x' })
  check('the workbench still gets its own count and format',
    panelSide.body.n === 4 && panelSide.body.output_format === 'jpeg',
    JSON.stringify({ n: panelSide.body.n, format: panelSide.body.output_format }))

  const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check('the tool actually pins them on the call it makes',
    /count: AGENT_COUNT[\s\S]{0,40}output_format: AGENT_FORMAT/u.test(source),
    'the pins must be passed into generate(), not only written in the description')
}

/* ---- where the bytes actually land ---- */

/**
 * The bug this pins: `/generate` was called WITHOUT a cwd, so a configured
 * `saveDir` could not be resolved and every workspace generation fell through
 * to DSH's own attachment store. The picture saved — just not where the setting
 * said. Nothing caught it because only the TOOL path was ever tested with a
 * cwd; the route was never exercised at all.
 *
 * The decision is a pure function, so it is tested directly. Driving it through
 * a real HTTP round trip would mean stubbing `undici` (the plugin imports it
 * rather than using global fetch), which would test the stub more than the code.
 */
{
  const seam = provided.openrouterImagenV2
  const absolute = join(tmpdir(), 'some-project')

  check('a cwd the client reports is honoured when it is absolute',
    seam.sessionCwdFrom({ cwd: absolute }) === absolute, JSON.stringify(seam.sessionCwdFrom({ cwd: absolute })))
  check('a cwd is trimmed rather than taken verbatim',
    seam.sessionCwdFrom({ cwd: `  ${absolute}  ` }) === absolute)
  check('an absent cwd degrades to no-cwd behaviour',
    seam.sessionCwdFrom({}) === undefined && seam.sessionCwdFrom({ cwd: '' }) === undefined
    && seam.sessionCwdFrom({ cwd: '   ' }) === undefined)
  check('a RELATIVE cwd is refused, not resolved against the process cwd',
    seam.sessionCwdFrom({ cwd: 'generated-images' }) === undefined
    && seam.sessionCwdFrom({ cwd: './pictures' }) === undefined,
    'a relative cwd would write outside the user\'s project')
  check('a non-string cwd is refused',
    seam.sessionCwdFrom({ cwd: 42 }) === undefined && seam.sessionCwdFrom({ cwd: null }) === undefined)

  // The helper being right means nothing if the route does not CALL it — which
  // is precisely how this bug existed: the logic was fine, the wiring was not.
  const hostSource = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check('the /generate route resolves the cwd it is handed',
    /action === 'generate'[\s\S]{0,600}sessionCwdFrom\(input\)/u.test(hostSource),
    'sessionCwdFrom must be called on the route path, not merely exported')
  check('the /generate route passes that cwd into generate()',
    /action === 'generate'[\s\S]{0,900}generate\(input, \{ withDataUrl: true, cwd \}\)/u.test(hostSource),
    'without cwd here, saveDir cannot resolve and bytes go to the attachment store')
}

/* ---- references must reach BOTH the prompt model and the image model ---- */

/**
 * The bug this pins: `POST /prompt` read only `request`/`context`, so an
 * attached reference never reached the prompt model — and because the same call
 * also GENERATES when the confirm switch is off, the reference never reached the
 * image API either. The picture came out looking like a fresh text-to-image
 * result, and the prompt described a picture the user was not asking for.
 *
 * The `/prompt` leg needs a live HTTP round trip against OpenRouter, which this
 * harness cannot do without stubbing `undici` (and stubbing it would test the
 * stub). So what is pinned here is the wiring and the two pure decisions, which
 * is where this actually broke: the route must normalise the references once and
 * hand the SAME list to both the text model and the image call.
 */
{
  const hostSource = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  const promptRoute = hostSource.match(/action === 'prompt' && method === 'POST'[\s\S]*?\n {6}if \(action === 'history'/u)?.[0] ?? ''

  check('the /prompt route reads the references it is sent',
    promptRoute.length > 0 && /referenceUrls\(input\)/u.test(promptRoute),
    'the route must normalise reference_images, the same way /generate does')
  check('the /prompt route hands the references to the prompt model',
    promptRoute.length > 0 && /composePrompt\(request, input\?\.context, references\)/u.test(promptRoute),
    'without this, the prompt model never learns a reference exists')
  check('the /prompt route sends the references to the IMAGE model too',
    promptRoute.length > 0 && /generate\(\s*\{ prompt, request, model, references \}/u.test(promptRoute),
    'refine mode generates from this same call; dropping the references here silently discards them')
  check('the /prompt route passes the per-call model and cwd through as well',
    promptRoute.length > 0 && /const model = String\(input\?\.model/u.test(promptRoute)
    && /const cwd = sessionCwdFrom\(input\)/u.test(promptRoute)
    && /\{ withDataUrl: true, cwd \}/u.test(promptRoute),
    'the model picker and the save directory were ignored in refine mode')

  check('the prompt instruction names the reference rule when one is attached',
    /count > 0 \? \['', `IMPORTANT — \$\{count\} reference image/u.test(hostSource),
    'the rule is only worth its tokens when a reference is actually attached')
  check('the prompt model is shown the reference images, not just told about them',
    /type: 'image_url', image_url: \{ url \}/u.test(hostSource),
    'a text model told "3 references attached" and shown none cannot write a prompt that uses them')
  check('a prompt model without vision still gets a prompt',
    /if \(refs\.length === 0\) throw error[\s\S]{0,120}ask\(false\)/u.test(hostSource),
    'a text-only prompt model rejects image parts; the prompt must not be lost over it')
  check('the blind fallback tells the model it cannot see the reference',
    hostSource.includes('you cannot see it, and guessing its contents')
    || hostSource.includes('You cannot see it, and guessing its contents'),
    'a model that guesses a reference it never saw contradicts the image')
}

/* ---- the request body builder ---- */

// `auto` means OMIT, not "send the string auto": the provider's own default is
// what auto is asking for, and sending `resolution: "auto"` would be rejected.
// So the stub for this section puts every option on `auto` first.
const autoHost = await import('./lib/index.js')
const autoProvided = {}
const autoCtx = {
  effect: (fn) => { fn(); return () => {} },
  plugin: () => {},
  provide: (key, value) => { autoProvided[key] = value },
  get: (key) => (key === 'webServer' ? { register: () => () => {} } : undefined),
  inject: (names, cb) => cb({ get: () => undefined }),
  tools: { register: () => () => {} },
}
autoHost.apply(autoCtx, stubConfig({
  model: 'test/image-model', models: [], promptModel: 'test/text', apiKey: 'sk-or-v1-test',
  resolution: 'auto', aspectRatio: 'auto', quality: 'auto', outputFormat: 'png',
  count: 1, background: 'auto', seed: '', confirmPrompt: false, splitRatio: 0.6,
  paramsHeight: 236, providerSort: '', extraJson: '', saveDir: 'generated-images',
}))

const built = autoProvided.openrouterImagenV2.buildBody({ prompt: 'hello' })
check('buildBody omits auto-valued fields instead of sending them',
  built.body.aspect_ratio === undefined && built.body.resolution === undefined && built.body.quality === undefined,
  JSON.stringify(built.body))
check('buildBody always sends a seed and reports whether it was random',
  Number.isFinite(built.body.seed) && built.seedRandom === true)
check('buildBody reports the parameters that were really sent',
  built.params.aspect_ratio === 'auto' && built.params.seed === built.seed,
  JSON.stringify(built.params))

const withOverrides = autoProvided.openrouterImagenV2.buildBody({ prompt: 'hi', aspect_ratio: '21:9', count: 3, quality: 'high' })
check('a per-call override reaches the request body', withOverrides.body.aspect_ratio === '21:9' && withOverrides.body.n === 3 && withOverrides.body.quality === 'high')

// `model` is the override the workspace forgot to send, which made the image
// model look like it could only come from settings. Pin the precedence: an
// explicit per-call model beats the stored default, and the stored default is
// still used when the call does not name one.
const modelOverride = autoProvided.openrouterImagenV2.buildBody({ prompt: 'hi', model: 'other/image-model' })
check('a per-call model beats the stored default',
  modelOverride.body.model === 'other/image-model' && modelOverride.params.model === 'other/image-model',
  JSON.stringify(modelOverride.body.model))
const modelDefaulted = autoProvided.openrouterImagenV2.buildBody({ prompt: 'hi', model: '' })
check('an empty per-call model falls back to the stored default, not to empty',
  modelDefaulted.body.model === 'test/image-model', JSON.stringify(modelDefaulted.body.model))

const badAspect = autoProvided.openrouterImagenV2.buildBody({ prompt: 'hi', aspect_ratio: '99:1' })
check('an unsupported ratio is clamped, not sent through', badAspect.body.aspect_ratio === undefined)

// An empty prompt must be refused before any network call.
let emptyBody = ''
try { autoProvided.openrouterImagenV2.buildBody({ prompt: '  ' }) } catch (error) { emptyBody = String(error.message) }
check('buildBody refuses an empty prompt', emptyBody.includes('prompt 不能为空'))

// A non-numeric seed is an error, not a silently drawn one.
let badSeed = ''
try { autoProvided.openrouterImagenV2.buildBody({ prompt: 'x', seed: 'abc' }) } catch (error) { badSeed = String(error.message) }
check('buildBody refuses a non-numeric seed', badSeed.includes('seed 必须是数字'))

// extraJson must not be able to swap the model or the prompt behind the user's
// back. It comes from CONFIG in real use, so the guard is exercised by setting
// it in a config and asking for a body.
const guardHost = await import('./lib/index.js')
const guardProvided = {}
guardHost.apply({
  effect: (fn) => { fn(); return () => {} },
  plugin: () => {},
  provide: (key, value) => { guardProvided[key] = value },
  get: (key) => (key === 'webServer' ? { register: () => () => {} } : undefined),
  inject: (names, cb) => cb({ get: () => undefined }),
  tools: { register: () => () => {} },
}, stubConfig({
  model: 'test/image-model', models: [], promptModel: 'test/text', apiKey: 'sk-or-v1-test',
  resolution: 'auto', aspectRatio: 'auto', quality: 'auto', outputFormat: 'png',
  count: 1, background: 'auto', seed: '', confirmPrompt: false, splitRatio: 0.6,
  paramsHeight: 236, providerSort: '', saveDir: 'generated-images',
  extraJson: '{"model":"evil/model"}',
}))
let hijack = ''
try { guardProvided.openrouterImagenV2.buildBody({ prompt: 'x' }) } catch (error) { hijack = String(error.message) }
check('extraJson cannot override the model', hijack.includes('不能覆盖 model'), hijack)

// And it must still work for fields it IS allowed to carry.
const okHost = await import('./lib/index.js')
const okProvided = {}
okHost.apply({
  effect: (fn) => { fn(); return () => {} },
  plugin: () => {},
  provide: (key, value) => { okProvided[key] = value },
  get: (key) => (key === 'webServer' ? { register: () => () => {} } : undefined),
  inject: (names, cb) => cb({ get: () => undefined }),
  tools: { register: () => () => {} },
}, stubConfig({
  model: 'test/image-model', models: [], promptModel: 'test/text', apiKey: 'sk-or-v1-test',
  resolution: 'auto', aspectRatio: 'auto', quality: 'auto', outputFormat: 'png',
  count: 1, background: 'auto', seed: '', confirmPrompt: false, splitRatio: 0.6,
  paramsHeight: 236, providerSort: '', saveDir: 'generated-images',
  extraJson: '{"top_p":0.9}',
}))
check('extraJson merges a field it is allowed to carry', okProvided.openrouterImagenV2.buildBody({ prompt: 'x' }).body.top_p === 0.9)

for (const dispose of effects) if (typeof dispose === 'function') dispose()

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
