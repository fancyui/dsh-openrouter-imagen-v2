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
check('the tool description carries the "only fill prompt" discipline', tools[0]?.description?.includes('默认只填'))
check('the tool description forbids the decisions the model must not make', tools[0]?.description?.includes('这次适合出几张'))
check('the tool exposes no aspect_ratio/resolution parameters (the panel owns them)',
  tools[0]?.parameters?.properties?.aspect_ratio === undefined && tools[0]?.parameters?.properties?.resolution === undefined)
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

let rejectedEscape = ''
try { await callTool({ prompt: 'x', reference_files: ['C:/Windows/System32/drivers/etc/hosts'] }) } catch (error) { rejectedEscape = String(error.message) }
check('a reference file outside the session workspace is refused', rejectedEscape.includes('工作目录内'), rejectedEscape)

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
