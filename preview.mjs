/**
 * Client-half pre-flight + live preview.
 *
 * Loads the REAL `lib/client.js` in a VM with a small React stand-in, mounts the
 * real components, and asserts the module contract the shell depends on. Then
 * writes an HTML preview from those very components — so the picture you look at
 * is the code that will run, not a hand-drawn mock.
 *
 *   node preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, 'preview')

let failures = 0
const check = (label, condition, detail) => {
  const ok = condition === true
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * a tiny hook runtime: effects really run, so effects that load data are
 * exercised rather than skipped.
 * ------------------------------------------------------------------ */

let captured = null
let cells = []
let cursor = 0
let effects = []
let dirty = false

const setCell = (index, next) => {
  const value = typeof next === 'function' ? next(cells[index]) : next
  if (value !== cells[index]) { cells[index] = value; dirty = true }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = cursor
    cursor += 1
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
    return [cells[index], (next) => setCell(index, next)]
  },
  useEffect: (fn) => { const index = cursor; cursor += 1; effects[index] = fn },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => {
    const index = cursor
    cursor += 1
    if (!(index in cells)) cells[index] = { current: initial }
    return cells[index]
  },
}

/** Config the workspace will render. Mirrors what the Host's /config returns. */
const CONFIG = {
  model: 'x-ai/grok-imagine-image-quality',
  models: ['x-ai/grok-imagine-image-quality', 'google/gemini-2.5-flash-image'],
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
  saveDir: 'generated-images',
  promptModel: 'google/gemini-2.5-flash',
  extraJson: '',
  skills: true,
}

/** A 1×1 PNG, so the stage has real bytes to lay out. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

const RECORDS = [{
  id: 'gen-demo-1',
  createdAt: Date.now(),
  prompt: 'Product photograph on a pale oak desktop beside a window at early morning.\nSoft directional daylight rakes across the surface from camera left, long gentle shadows,\nbright airy highlights on the product edges, cool-neutral white balance with warm morning tint.',
  request: '把这张产品照片改成清晨窗边的自然光，背景换成浅色木桌面，保持产品外观不变',
  model: 'x-ai/grok-imagine-image-quality',
  params: { model: 'x-ai/grok-imagine-image-quality', count: 1, resolution: '1K', aspect_ratio: '16:9', quality: 'medium', output_format: 'png', background: 'auto', seed: 1844679 },
  seed: 1844679,
  seedRandom: true,
  outputDir: 'X:\\github\\dsh-openrouter-imagen\\generated-images',
  outputDirRelative: 'generated-images',
  cost: 0.0149,
  elapsedMs: 32000,
  images: [
    { name: 'openrouter-20261012-093014-1.png', mediaType: 'image/png', bytes: 688883, attachmentId: 'att-1', filePath: 'X:\\github\\dsh-openrouter-imagen\\generated-images\\a.png', width: 816, height: 816 },
    { name: 'openrouter-20261012-093014-2.png', mediaType: 'image/png', bytes: 661000, attachmentId: 'att-2', filePath: 'X:\\github\\dsh-openrouter-imagen\\generated-images\\b.png', width: 816, height: 816 },
  ],
}]

const fetchShim = async (url) => {
  const text = String(url)
  if (text.includes('/history')) return jsonResponse({ ok: true, records: RECORDS })
  // The key preview is a SHAPE, never the secret — same contract the Host keeps.
  if (text.includes('/config')) {
    return jsonResponse({
      ok: true,
      config: CONFIG,
      hasKey: true,
      prefix: 'sk-or-v1-',
      suffix: 'cdef',
      looksValid: true,
      options: {},
      historyLimit: 60,
    })
  }
  if (text.includes('/image')) return { ok: true, status: 200, blob: async () => ({ size: PNG.length }) }
  return jsonResponse({ ok: true })
}

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
})

const registered = []
const styles = []

const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
  document: {
    head: { appendChild: (element) => { if (element && element.id) styles.push(String(element.textContent)) } },
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { dataset: {} },
  },
  fetch: fetchShim,
  URL: { createObjectURL: () => 'blob:preview' },
  navigator: { clipboard: { writeText: async () => {} } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout,
  console,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })

check('the client module registers itself with the loader', captured !== null && captured.id === 'dsh-openrouter-imagen-v2',
  captured === null ? 'no factory captured' : `id ${captured.id}`)

const moduleExports = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})

check('the client exports apply()', typeof moduleExports.apply === 'function')
check('the client declares the slots dependency', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'))
check('the panel key is a plain string the main slot can dispatch', typeof moduleExports.PANEL_KEY === 'string' && moduleExports.PANEL_KEY.length > 0)
check('the history window is 5, as reviewed', moduleExports.HISTORY_MAX === 5)
check('the ratio list matches the host\'s supported set', moduleExports.ASPECTS.length === 12 && moduleExports.ASPECTS.includes('21:9'))
check('ratioBox draws proportional boxes', moduleExports.ratioBox('16:9').w > moduleExports.ratioBox('16:9').h)
check('ratioBox marks auto as dashed', moduleExports.ratioBox('auto').dashed === true)

/* ---- mount the components through the real apply() ---- */

moduleExports.apply({
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject: () => () => {},
  get: () => undefined,
  slots: {
    inject: (_key, factory) => { factory().next(); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
})

const entry = registered.find((r) => r.options.name === 'sidebar.panellist')
const mainView = registered.find((r) => r.options.name === 'main')

check('the sidebar entry registers into sidebar.panellist', entry !== undefined, registered.map((r) => r.options.name).join(','))
check('the workspace registers into the keyed main slot', mainView !== undefined && mainView.options.key === moduleExports.PANEL_KEY,
  JSON.stringify(mainView?.options ?? null))
check('the plugin does NOT touch the chat (no conversation.* registrations)',
  registered.every((r) => !String(r.options.name).startsWith('conversation.')),
  registered.map((r) => r.options.name).join(','))

/* ---- render the real workspace to HTML ---- */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const mountStable = async (Component, props) => {
  cells = []
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    cursor = 0
    effects = []
    dirty = false
    tree = Component(props ?? {})
    const recorded = effects.slice()
    effects = []
    if (pass === 0) recorded.forEach((fn) => { if (typeof fn === 'function') fn() })
    await tick()
    if (!dirty) return tree
  }
  return tree
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
const escapeHtml = (value) => String(value)
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')

const renderToHtml = (node) => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(renderToHtml).join('')
  if (typeof node.type === 'function') return renderToHtml(node.type({ ...node.props, children: node.children }))
  const { type, props, children } = node
  const attrs = []
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'key' || key === 'children' || key === 'ref' || typeof value === 'function' || value === undefined || value === null) continue
    if (key === 'value') { attrs.push(`value="${escapeHtml(value)}"`); continue }
    if (typeof value === 'object') continue
    // Boolean HTML attributes: React omits them when false, and `checked="false"`
    // would actually CHECK the box in a browser — so mirror React, not the
    // naive stringification.
    if (value === false) continue
    if (value === true) { attrs.push(key); continue }
    // React's SVG attribute names are camelCase (`stopColor`, `clipPath`,
    // `strokeWidth`) and React rewrites them to the hyphenated form. Passing
    // them through verbatim produced `<stop stopColor=…>`, which the browser
    // ignores — every gradient then painted BLACK, and the preview looked like
    // a broken icon when the real app was fine.
    const SVG_PROPS = {
      stopColor: 'stop-color', stopOpacity: 'stop-opacity',
      clipPath: 'clip-path', clipRule: 'clip-rule',
      strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap',
      strokeLinejoin: 'stroke-linejoin', strokeDasharray: 'stroke-dasharray',
      fillOpacity: 'fill-opacity', fillRule: 'fill-rule',
      strokeOpacity: 'stroke-opacity', textAnchor: 'text-anchor',
      gradientUnits: 'gradientUnits', patternUnits: 'patternUnits',
      maskUnits: 'maskUnits', markerWidth: 'markerWidth',
      xlinkHref: 'xlink:href', xmlnsXlink: 'xmlns:xlink',
      fontSize: 'font-size', fontFamily: 'font-family', fontWeight: 'font-weight',
    }
    const name = key === 'className' ? 'class'
      : key === 'htmlFor' ? 'for'
      : SVG_PROPS[key] ?? key
    attrs.push(`${name}="${escapeHtml(value)}"`)
  }
  const open = `<${type}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
  if (VOID.has(type)) return open
  return `${open}${(children ?? []).map(renderToHtml).join('')}</${type}>`
}

const workspaceTree = await mountStable(moduleExports.Workspace ?? mainView.component)
const workspaceHtml = renderToHtml(workspaceTree)

/* ------------------------------------------------------------------ *
 * the sidebar, as the SHELL builds it
 *
 * `PanelRow` is ONE button whose glyph column holds
 * `renderSlot('sidebar.panellist', …, { only: id })` and whose next child is
 * the registered `label`. Reproducing that wrapper here is the whole point: the
 * entry is judged by how it sits beside the shell's own rows and by what the
 * shell's button already covers, and a preview that dropped the wrapper passed
 * happily while the real sidebar was misaligned and the label unclickable.
 *
 * `PanelRow` hands the glyph `size: wide ? 16 : 18`, so 16px is the icon column
 * width every other entry uses while labels are shown.
 */
const shellRow = (label, glyph, active) =>
  `<button type="button" class="shell-row${active === true ? ' is-active' : ''}" aria-label="${escapeHtml(label)}">`
  + `<span class="shell-glyph" aria-hidden="true">${glyph}</span>`
  + `<span class="shell-title">${escapeHtml(label)}</span></button>`

/** Stand-in for the shell's own glyph (the MCP connector tiles). Geometry is
    the thing under review here; the artwork only has to be a 16px tile. */
const SHELL_GLYPH = '<svg class="shell-svg" viewBox="0 0 24 24" aria-hidden="true">'
  + '<rect x="2.5" y="2.5" width="8.5" height="8.5" rx="2.4" fill="#f2a93b"/>'
  + '<rect x="13" y="2.5" width="8.5" height="8.5" rx="2.4" fill="#4f7ff0"/>'
  + '<rect x="2.5" y="13" width="8.5" height="8.5" rx="2.4" fill="#63c37a"/>'
  + '<rect x="13" y="13" width="8.5" height="8.5" rx="2.4" fill="#9a6be8"/></svg>'

// The sidebar entry, rendered for real — this is what the doubled label showed
// up in, and only the DOM (not the source) can tell us it is gone.
const entryHtml = renderToHtml(entry.component({ ctx: { on: () => () => {}, get: () => undefined } }))

const sidebarHtml = `<div class="shell-root">`
  + `<div class="shell-group"><svg class="shell-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">`
  + `<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>插件</div>`
  + `${shellRow('MCP 连接器', SHELL_GLYPH)}`
  + `${shellRow('图像生成', entryHtml, true)}`
  + `</div>`

check('the workspace renders a root element', workspaceHtml.includes('dsh-iv-root'))
check('it renders the two-column split (left + splitter + right)',
  workspaceHtml.includes('dsh-iv-left') && workspaceHtml.includes('dsh-iv-split') && workspaceHtml.includes('dsh-iv-right'))
check('it renders the draggable parameter divider', workspaceHtml.includes('dsh-iv-hsplit'))
check('the ratio picker renders every supported ratio',
  moduleExports.ASPECTS.every((ratio) => workspaceHtml.includes(`>${ratio}<`)))
check('the ratio picker prints numeric values, not just boxes',
  workspaceHtml.includes('dsh-iv-rationum') && workspaceHtml.includes('>16:9<'))
check('the history strip renders the 5-image window', workspaceHtml.includes('dsh-iv-strip'))
check('the conversation column is present', workspaceHtml.includes('dsh-iv-convo'))
check('the confirm-before-generating switch defaults OFF',
  workspaceHtml.includes('dsh-iv-switch') && workspaceHtml.includes('type="checkbox"') && !/type="checkbox"[^>]*checked/u.test(workspaceHtml))
check('count defaults to 1', /aria-pressed="true"[^>]*>1</u.test(workspaceHtml) || workspaceHtml.includes('>1</button>'))
check('quality defaults to medium', workspaceHtml.includes('>medium</button>'))
// The approved change: no explanatory paragraph BELOW the input box. A
// placeholder INSIDE the box is not that, so this checks for the removed
// paragraph's own markup rather than the word appearing anywhere.
check('no hint paragraph sits under the input box',
  !workspaceHtml.includes('dsh-iv-field-hint') && !workspaceHtml.includes('提示词会显示在对话里'))
check('the composer action row keeps its own headroom (breathing room above 生成)',
  /\.dsh-iv-actions\{[^}]*margin-top/u.test(styles.join('\n')))

/* ---- the settings dialog ---- */

// Assertions below look at the DOM, so the stylesheet must be stripped first:
// the dialog's own CSS contains the very selectors being searched for, and a
// naive `includes` would match the stylesheet and pass no matter what rendered.
const domOf = (html) => html.replace(/<style>[\s\S]*?<\/style>/gu, '')

// Closed by default: the workspace must open on the pictures, not on a form.
check('the settings dialog is absent from the DOM until asked for',
  !domOf(workspaceHtml).includes('dsh-iv-modal'), 'the closed dialog must render nothing')
check('the header offers a 设置 button (the only way to configure a key here)',
  workspaceHtml.includes('>设置</button>'))
// With no key stored, that button is the one thing that can fix it, so it is
// styled as primary. The preview config HAS a key, so it stays secondary.
check('the 设置 button is not shouting while a key is already configured',
  !/dsh-iv-btn-primary[^>]*>设置</u.test(workspaceHtml))

// Mounted OPEN, through the real component, so what is asserted is what renders.
const mountDialog = async (overrides) => {
  const tree = await mountStable(moduleExports.SettingsDialog, {
    open: true,
    config: CONFIG,
    keyInfo: { hasKey: true, prefix: 'sk-or-v1-', suffix: 'cdef', looksValid: true },
    onClose: () => {},
    onSave: async () => ({ ok: true }),
    onForgetKey: async () => ({ ok: true }),
    ...overrides,
  })
  return domOf(renderToHtml(tree))
}

const dialogHtml = await mountDialog()

check('the open dialog renders as a modal with a role', dialogHtml.includes('data-open="1"') && dialogHtml.includes('role="dialog"'))
check('the dialog has all three tabs', ['密钥', '模型', '高级'].every((label) => dialogHtml.includes(`>${label}</button>`)))
check('the key field is masked by default', /type="password"/u.test(dialogHtml))
check('the key field says an empty box keeps the stored key',
  dialogHtml.includes('留空 = 保留已存的密钥'))
check('the stored key is previewed, never printed in full',
  dialogHtml.includes('已配置 sk-or-v1-…cdef') && !dialogHtml.includes('sk-or-v1-cdef'))
check('the dialog explains where a key comes from', dialogHtml.includes('openrouter.ai/keys'))
check('the dialog offers 校验 without saving', dialogHtml.includes('>校验</button>'))
check('the dialog offers to clear the stored key', dialogHtml.includes('>清除已存的密钥</button>'))
check('the dialog says the key is staying put while the box is empty',
  dialogHtml.includes('密钥保持不动'))

// The dialog opens on 密钥 — the tab that matters when nothing works yet — so
// the model and advanced tabs are asserted through the components that own
// them, which is also what proves the tabs are real and not decorative.
const modelTabSource = moduleExports.SettingsDialog.toString()
check('the model tab is reachable from the dialog', modelTabSource.includes("setTab('models')"))
check('the advanced tab is reachable from the dialog', modelTabSource.includes("setTab('advanced')"))

// A dialog with no key stored must SAY so, and lead with the fix.
const noKeyHtml = await mountDialog({ keyInfo: { hasKey: false, prefix: '', suffix: '', looksValid: false } })
check('with no key stored the dialog reports it plainly', noKeyHtml.includes('未配置'))
check('with no key stored the placeholder is the real key shape', noKeyHtml.includes('sk-or-v1-…'))
check('with no key stored there is nothing to clear', !noKeyHtml.includes('清除已存的密钥'))
check('with no key stored the footer says so', noKeyHtml.includes('尚未配置密钥'))

// The "a key was typed" state cannot be reached from outside the component
// (it is component state, and the box starts empty by design). So assert the
// MECHANISM: the footer and the badge both branch on the typed value, which is
// what makes the dialog able to say "this will replace your key" at all.
const dialogSource = moduleExports.SettingsDialog.toString()
check('the dialog distinguishes a typed key from the stored one',
  dialogSource.includes('将替换密钥') && dialogSource.includes('密钥保持不动'))
check('the dialog flags a typed key that is not an OpenRouter key',
  dialogSource.includes('不像 OpenRouter 密钥'))
check('a typed key is only sent when one was actually typed',
  dialogSource.includes('draftKey.trim().length > 0'))

// A 404/405 on our OWN prefix means the Host half never registered — a restart,
// not a protocol error. Reporting the bare status sent the user hunting for a
// bug in a plugin that had simply not been loaded yet.
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
check('a non-JSON answer is explained as an unmounted plugin, not a bare status',
  clientSource.includes('没有挂载') && clientSource.includes('重启 DSH'))
check('the unmounted-plugin message covers both 404 and 405',
  /status === 404 \|\| status === 405/u.test(clientSource))

// The image model used to be reachable only from settings, because the
// workspace never sent one with the request. The picker lives under the
// composer and every configured model is offered. It is a PER-CALL control, so
// it must NOT write to the stored config.
check('a model picker sits under the composer',
  domOf(workspaceHtml).includes('dsh-iv-callmodel') && domOf(workspaceHtml).includes('dsh-iv-callmodelsel'))
check('the picker offers every configured image model',
  CONFIG.models.every((id) => domOf(workspaceHtml).includes(`>${id}<`)))
check('the generate call carries the chosen model',
  clientSource.includes('model: pickModel()'), 'the request must name a model or the Host uses the stored default')
check('the picker is per-call and never writes to settings',
  !/setCallModel[\s\S]{0,120}patch\(/u.test(clientSource), 'picking a model for one call must not rewrite the default')
check('the picker can return to the stored default',
  clientSource.includes("setCallModel('')"))
// With a per-call pick in play the header must NOT keep advertising the stored
// default: a label that disagrees with the request is worse than no label.
check('the header reports the model this call will really use',
  clientSource.includes('pickModel() ||') && clientSource.includes('模型 · 本次 '),
  'the header chip must follow the per-call pick, not only the stored default')

// The save-path bug: `/generate` reached the Host with no session directory, so
// a relative `saveDir` could not be resolved and the bytes went to DSH's own
// attachment store. The client is the only side that knows the directory, so it
// has to send it.
check('the generate request carries the session directory',
  /api\('generate'[\s\S]{0,1200}cwd: sessionCwd\(\)/u.test(clientSource),
  'without cwd the Host cannot resolve saveDir and falls back to attachments')
check('the session directory is read through ctx.get, not ctx.sessions',
  clientSource.includes("ctx?.get?.('sessions')")
  // Strip line comments first: the code EXPLAINS this rule in a comment, and a
  // naive search would match the explanation instead of the code.
  && !/ctx\.sessions\b/u.test(clientSource.replace(/^\s*\/\/.*$/gmu, '')),
  'the property form throws without inject — the way this plugin once died')
check('a failure to read the session list degrades to empty, not a crash',
  /const sessionCwd = React\.useCallback\(\(\) => \{\s*try \{[\s\S]{0,900}\} catch \{\s*return ''\s*\}/u.test(clientSource))
check('the main view receives the client context (it is what exposes sessions)',
  /slots\.register\(\{ name: 'main', key: PANEL_KEY \}, \(\) => h\(Workspace, \{ ctx \}\)\)/u.test(clientSource))

// --- the sidebar row: aligned, clickable, and labelled exactly once ----------
//
// `sidebar.panellist` already draws the registered `label`, so the entry's own
// text made the sidebar read "图像生成 图像生成". Assert on the RENDERED entry:
// grepping the source would pass on a dead CSS rule.
const visibleText = (html) => html.replace(/<[^>]*>/gu, '')
check('the sidebar entry draws no text of its own',
  !visibleText(entryHtml).includes('图像生成'),
  `the shell draws \`label\`; repeating it here doubles the sidebar text (rendered: ${JSON.stringify(entryHtml)})`)
check('the sidebar entry still supplies an icon',
  entryHtml.includes('dsh-iv-entryicon') && entryHtml.includes('<svg'))
check('the sidebar registration still carries the label once',
  /slots\.register\(\{ name: 'sidebar\.panellist'[\s\S]{0,200}label: '图像生成'/u.test(clientSource),
  'dropping the text is only safe while the registration keeps the label')

// (1) LEFT ALIGNED. The shell's `PanelRow` is already the row: a flex button
// with its own padding and an 8px gap. A second, full-width button nested in
// the glyph column stretched that column and pushed the label right — the row
// stopped lining up with its neighbours. So the entry must contribute a bare
// glyph and add no geometry of its own.
check('the sidebar entry is a bare glyph, not a second button',
  entryHtml.startsWith('<span class="dsh-iv-entryicon">') && !entryHtml.includes('<button'),
  `a <button> inside the shell's <button> is invalid HTML and re-drew the row (rendered: ${JSON.stringify(entryHtml)})`)
check('the entry glyph takes no width, padding or margin of its own',
  (() => {
    const rule = /\.dsh-iv-entryicon\{([^}]*)\}/u.exec(clientSource)
    if (rule === null) return false
    return !/padding|margin|width:100%|flex:1/u.test(rule[1])
  })(),
  'any of those re-draws the row and pushes the label out of line with the others')
check('the entry glyph is exactly the shell\'s icon column (16px)',
  /\.dsh-iv-entryicon\{[^}]*width:16px/u.test(clientSource)
  && /\.dsh-iv-entryicon svg\{[^}]*width:16px/u.test(clientSource),
  'the shell asks its glyphs for 16px while labels show; a wider column offsets every label')

// (2) CLICKING THE TEXT OPENS THE PLUGIN. The shell's row button is the only
// thing that calls `layout.selectPanel(id)` — and it THROWS for an id no `main`
// entry answers to (`main panel "…" is not registered`). The id and the main key
// are the same string, so the click on the icon and the click on the words take
// the same path. These two used to differ, which is why the words did nothing.
check('the sidebar row id and the main slot key are the same string',
  entry.options.id === mainView.options.key,
  `the row clicked selects ${JSON.stringify(entry.options.id)} but only ${JSON.stringify(mainView.options.key)} is registered as a main panel, so layout.selectPanel throws and the label does nothing`)
check('both registrations derive that id from the one constant',
  /slots\.register\(\{ name: 'sidebar\.panellist', id: PANEL_KEY/u.test(clientSource)
  && /slots\.register\(\{ name: 'main', key: PANEL_KEY \}/u.test(clientSource),
  'two literals drifted apart once already; one constant cannot')

// (3) NO DUPLICATED TEXT, and nothing left behind that could re-add it.
check('the dead text/badge classes for the entry are gone',
  !clientSource.includes('dsh-iv-entrytxt') && !clientSource.includes('dsh-iv-entrybadge')
  && !/\.dsh-iv-entry\{/u.test(clientSource),
  'they styled a label this component no longer renders')
check('the shell row the entry lands in carries the label once',
  (sidebarHtml.match(/>图像生成</gu) ?? []).length === 1,
  `the rendered sidebar must read one label (rendered: ${JSON.stringify(sidebarHtml)})`)

// --- seed moved beside the model picker, and now reports what was used -------
check('the seed control no longer sits in the parameters area',
  !/dsh-iv-label' \}, '种子'/u.test(clientSource),
  'one seed control only — two would fight over the same setting')
check('the seed box sits on the composer row next to the model picker',
  /dsh-iv-callmodellabel' \}, '种子'[\s\S]{0,400}dsh-iv-seedin/u.test(clientSource))
// A seed is a number: the box is sized for the digits it holds, not for the
// row, and the 随机 button shares that same line instead of wrapping below it.
// The selector must name the ELEMENT, because `input.dsh-iv-in{width:100%}`
// outranks a bare class: writing `.dsh-iv-seedin` alone leaves the box full
// width and 随机 wraps — which is exactly what happened, and a check that only
// looked for the declaration still passed while the render was wrong.
check('the seed box is sized for a number, not the whole row',
  /input\.dsh-iv-seedin\{[^}]*width:86px/u.test(clientSource),
  'a full-width box pushes 随机 onto its own line and wastes the row')
check('the seed box wins over the shared full-width input rule',
  // Specificity is scored PER SELECTOR and the best one wins — a grouped rule
  // like `input.dsh-iv-in,select.dsh-iv-in,…` must not be counted as one long
  // selector, or a perfectly good rule looks like a loser.
  (() => {
    const score = (one) => (one.match(/\./gu) ?? []).length + (/(^|\s|,)[a-z]+/u.test(one) ? 1 : 0)
    const best = (list) => Math.max(...list.split(',').map((part) => score(part.trim())))
    const shared = /(^|\n)([^{}\n]*\.dsh-iv-in[^{}\n]*)\{[^}]*width:100%/u.exec(clientSource)
    const seed = /(^|\n)([^{}\n]*dsh-iv-seedin[^{}\n]*)\{/u.exec(clientSource)
    if (shared === null || seed === null) return false
    return best(seed[2]) >= best(shared[2])
  })(),
  'a class-only rule loses to input.dsh-iv-in and the box stays full width')
check('the seed box and 随机 share one line',
  /dsh-iv-callmodellabel' \}, '种子'[\s\S]{0,900}?\}, '随机'\)\)/u.test(clientSource),
  'both must sit inside the same row, or 随机 wraps to a line of its own')
check('the seed box caps its length at the digits a seed can have',
  /maxLength: 10/u.test(clientSource))
check('the seed this call used is written back to the box',
  /setSeedDraft\(String\(res\.seed\)\)/u.test(clientSource),
  'a drawn seed is otherwise lost the moment it scrolls by')
check('the drawn seed is persisted, so the next call can reproduce it',
  /res\.seed[\s\S]{0,200}saveSeed\(/u.test(clientSource))

// --- reference images: picker, paste and drop --------------------------------
check('the + button actually opens a file picker',
  /dsh-iv-refadd[\s\S]{0,300}fileRef\.current\?\.click\(\)/u.test(clientSource),
  'it was a placeholder with no onClick at all')
check('only image files are accepted',
  clientSource.includes("accept: 'image/*'"))
// The hidden picker must be hidden by a CLASS. An inline `style={{display:'none'}}`
// is silently dropped by this file's renderer (it skips object-valued props), so
// the raw <input type=file> shows up in the preview as a "Choose Files" control.
check('the file input is hidden by a class, not an inline style',
  clientSource.includes("className: 'dsh-iv-filein'")
  && clientSource.includes('.dsh-iv-filein{display:none}')
  && !/type: 'file'[\s\S]{0,200}style: \{/u.test(clientSource),
  'an inline display:none renders the raw file input visibly in the preview')
check('pasted images become references',
  /onPaste:[\s\S]{0,300}addRefFiles/u.test(clientSource))
check('dropped images become references',
  /onDrop:[\s\S]{0,300}addRefFiles/u.test(clientSource))
check('a pasted block of TEXT is left alone',
  /imageFilesFrom[\s\S]{0,900}startsWith\('image\/'\)/u.test(clientSource),
  'only real image files may be turned into references')
check('the reference list is capped at the API limit',
  clientSource.includes('MAX_REFS = 4'))
check('references are sent with the generate request',
  /api\('generate'[\s\S]{0,900}reference_images: refs\.map/u.test(clientSource),
  'collecting references but not sending them would look exactly like this bug')
check('references are sent with the PROMPT request as well',
  /api\('prompt'[\s\S]{0,900}reference_images: refs\.map/u.test(clientSource),
  'refine mode writes the prompt on the Host; without references there the prompt cannot mention the image')
check('the prompt request carries the per-call model and the session cwd too',
  /api\('prompt'[\s\S]{0,900}model: pickModel\(\)[\s\S]{0,200}cwd: sessionCwd\(\)/u.test(clientSource),
  'otherwise the picker under the composer and the save directory are ignored in refine mode')
// The dep array is read out of the source rather than matched as one literal.
// A regex window breaks every time a dependency is added, and the thing worth
// protecting is "every value the body reads is in the list" — not one exact
// string. `refs` is what this caught: the array was `[]`, so refine mode sent
// the first render's empty reference list forever.
check('the prompt request is rebuilt when the reference list changes',
  (() => {
    const start = clientSource.indexOf("api('prompt'")
    const open = start === -1 ? -1 : clientSource.indexOf('}, [', start)
    const deps = open === -1 ? '' : clientSource.slice(open, clientSource.indexOf(')', open))
    return ['refs', 'pickModel', 'sessionCwd', 'saveSeed'].every((name) => deps.includes(name))
  })(),
  'a stale closure would send the first render\'s (empty) reference list, or drop the seed that came back')
check('the seed that was actually used is written back to the box on BOTH generate paths',
  (clientSource.match(/setSeedDraft\(String\(res\.seed\)\)/gu) ?? []).length === 2
    && clientSource.includes('void saveSeed(String(res.seed)).catch(() => {})'),
  'the refine path generates in the same call, so its seed exists only on that one response')
check('a long prompt box scrolls instead of growing without end',
  /\.dsh-iv-promptbody\{[^}]*overflow:auto[^}]*scrollbar-width:thin/u.test(clientSource)
    && /\.dsh-iv-promptbody\{[^}]*max-height:min\(/u.test(clientSource)
    && /overscroll-behavior:contain/u.test(clientSource),
  'an overlay scrollbar has a 0px gutter on Windows: the box scrolls but shows no bar')
check('writing a prompt says how many references it is using',
  clientSource.includes('正在写提示词 · 带 ${refs.length} 张参考图'),
  'the user must be able to tell "wrote blind" from "ignored my reference"')
check('a reference can be removed again',
  /setRefs\(\(prev\) => prev\.filter/u.test(clientSource))

// Render the override state for real, rather than only grepping for the branch.
// The pick is component state with no seeding prop, so mount a copy of the
// module whose initial value is already an override; everything else is the
// shipping code path.
{
  const seededSource = clientSource.replace(
    "const [callModel, setCallModel] = React.useState('')",
    "const [callModel, setCallModel] = React.useState('google/gemini-2.5-flash-image')",
  )
  check('the per-call model state is reachable for seeding (override render is real)',
    seededSource !== clientSource)
  if (seededSource !== clientSource) {
    let seededCaptured = null
    const seededSandbox = { ...sandbox, window: { __ModuleLoader__: { load: (d) => { seededCaptured = d } } } }
    vm.createContext(seededSandbox)
    vm.runInContext(seededSource, seededSandbox, { filename: 'client.seeded.js' })
    const seededExports = seededCaptured.factory((id) => {
      if (id === 'react') return React
      throw new Error(`unexpected require(${id})`)
    })
    const seededTree = await mountStable(seededExports.Workspace)
    const seededHtml = domOf(renderToHtml(seededTree))
    const other = 'google/gemini-2.5-flash-image'
    check('with an override the header names it and says it is this call only',
      seededHtml.includes('模型 · 本次') && seededHtml.includes(other))
    check('with an override the picker shows the highlight state',
      /dsh-iv-callmodelsel[^>]*data-override="1"/u.test(seededHtml))
    check('with an override a way back to the default is offered',
      seededHtml.includes('回到默认'))
    check('the header no longer claims the override is the stored default',
      !/title="来自设置的默认模型"/u.test(seededHtml))
  }
}

mkdirSync(OUT, { recursive: true })

const TOKENS = `:root{
  --dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#6b7280;
  --dsw-alias-border-l1:#e5e5e5;--dsw-alias-border-l2:#d4d4d4;
  --dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#fcfcfc;--dsw-alias-bg-layer-2:#f4f4f5;
  --dsw-alias-brand-primary:#0b6cff;--dsw-alias-state-error-primary:#d92d20;
  --dsw-alias-state-success-primary:#12b76a;--dsw-alias-state-warn-primary:#f79009;
  --dsw-alias-state-idle-primary:#a3a3a3;
}
body{margin:0;background:#e9eaee;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.shell{display:flex;height:840px;margin:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.10)}
.side{width:238px;flex:0 0 238px;background:#f7f7f8;border-right:1px solid var(--dsw-alias-border-l1)}
.mainpane{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
/* The shell's own sidebar rules, copied from SidebarRoot.module.css so the row
   the entry lands in is measured, not approximated: same padding, same 8px
   gap, same 16px glyph column. A preview that guessed at these would have
   called a misaligned row aligned. */
.shell-root{--dsh-sidebar-inline-padding:12px;height:100%;padding:6px var(--dsh-sidebar-inline-padding);box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:14px;display:flex;flex-direction:column}
.shell-group{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.shell-row{box-sizing:border-box;border-radius:8px;min-height:36px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex;width:100%}
.shell-row:hover,.shell-row.is-active{background:var(--dsw-alias-bg-layer-2)}
.shell-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex}
.shell-title{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.shell-svg{width:16px;height:16px;display:block}
`

writeFileSync(join(OUT, 'workspace.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 工作台（真实组件渲染）</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side">${sidebarHtml}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n</body>\n</html>\n`,
  'utf8')

// A second page: the same workspace with the settings dialog open. Rendered
// from the real component, so what is reviewed is what ships.
const dialogNoKeyHtml = await mountDialog({ keyInfo: { hasKey: false, prefix: '', suffix: '', looksValid: false } })
const dialogModelsHtml = await mountDialog({ initialTab: 'models' })
const dialogAdvancedHtml = await mountDialog({ initialTab: 'advanced' })

// One list, two jobs. The default is marked ON the row, so there is no second
// dropdown above the palette saying the same thing a different way.
check('the model tab renders the palette and its size',
  dialogModelsHtml.includes('图像模型')
  && CONFIG.models.every((id) => dialogModelsHtml.includes(id))
  && dialogModelsHtml.includes(`${CONFIG.models.length}/16`))
check('the default model is marked on its own row, not by a separate dropdown',
  /dsh-iv-palrow" data-default="1"/u.test(dialogModelsHtml)
  && !/dsh-iv-field-h[\s\S]{0,400}<select/u.test(dialogModelsHtml.split('dsh-iv-pal')[0]),
  'the palette must be the only place the default is chosen')
check('every non-default row offers to become the default',
  dialogModelsHtml.includes('设为默认'))
check('the tab explains that one list does both jobs',
  dialogModelsHtml.includes('有哪些可选') && dialogModelsHtml.includes('默认用哪个'))
// Help text is written with **emphasis**. Nothing renders markdown here, so an
// unparsed marker shows up as literal asterisks on screen. Assert the rendered
// DOM, across every dialog tab, not just the one that happens to be open.
check('emphasis markers are rendered, never shown as literal asterisks',
  !/<span class="dsh-iv-fhelp">[^<]*\*\*/u.test(domOf(dialogModelsHtml))
  && !/<span class="dsh-iv-fhelp">[^<]*\*\*/u.test(domOf(dialogAdvancedHtml))
  && /<span class="dsh-iv-fhelp">[^<]*<b>/u.test(domOf(dialogModelsHtml)),
  'help text uses **...** and emph() must turn it into <b>')
check('the advanced tab names the prompt model and the save directory',
  dialogAdvancedHtml.includes('写提示词的文本模型')
  && dialogAdvancedHtml.includes('保存目录')
  && dialogAdvancedHtml.includes(CONFIG.promptModel))
check('the prompt-model help says a reference needs vision to be seen',
  dialogAdvancedHtml.includes('带视觉')
  && dialogAdvancedHtml.includes('纯文本模型也能用'),
  'a user who typed a text-only model must know references go in unseen, not silently ignored')

writeFileSync(join(OUT, 'settings.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 设置弹窗（真实组件渲染）</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side">${sidebarHtml}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n${dialogNoKeyHtml}\n</body>\n</html>\n`,
  'utf8')

writeFileSync(join(OUT, 'settings-models.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 设置 · 模型</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side">${sidebarHtml}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n${dialogModelsHtml}\n</body>\n</html>\n`,
  'utf8')

writeFileSync(join(OUT, 'settings-advanced.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 设置 · 高级</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side">${sidebarHtml}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n${dialogAdvancedHtml}\n</body>\n</html>\n`,
  'utf8')

console.log('')
console.log(`wrote ${OUT}/workspace.html`)
console.log(`wrote ${OUT}/settings.html`)
console.log(`wrote ${OUT}/settings-models.html`)
console.log(`wrote ${OUT}/settings-advanced.html`)
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
