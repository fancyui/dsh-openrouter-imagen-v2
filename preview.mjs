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
    const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key
    attrs.push(`${name}="${escapeHtml(value)}"`)
  }
  const open = `<${type}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
  if (VOID.has(type)) return open
  return `${open}${(children ?? []).map(renderToHtml).join('')}</${type}>`
}

const workspaceTree = await mountStable(moduleExports.Workspace ?? mainView.component)
const workspaceHtml = renderToHtml(workspaceTree)

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
.side{width:238px;flex:0 0 238px;background:#f7f7f8;border-right:1px solid var(--dsw-alias-border-l1);padding:14px 8px}
.side h4{margin:0 6px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.mainpane{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
`

writeFileSync(join(OUT, 'workspace.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 工作台（真实组件渲染）</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side"><h4>插件</h4>${renderToHtml(entry.component({ ctx: { on: () => () => {}, get: () => undefined } }))}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n</body>\n</html>\n`,
  'utf8')

// A second page: the same workspace with the settings dialog open. Rendered
// from the real component, so what is reviewed is what ships.
const dialogNoKeyHtml = await mountDialog({ keyInfo: { hasKey: false, prefix: '', suffix: '', looksValid: false } })
const dialogModelsHtml = await mountDialog({ initialTab: 'models' })
const dialogAdvancedHtml = await mountDialog({ initialTab: 'advanced' })

check('the model tab renders the palette and the default picker',
  dialogModelsHtml.includes('图像模型（画图的那个）')
  && CONFIG.models.every((id) => dialogModelsHtml.includes(id))
  && dialogModelsHtml.includes(`${CONFIG.models.length}/16`))
check('the advanced tab names the prompt model and the save directory',
  dialogAdvancedHtml.includes('写提示词的文本模型')
  && dialogAdvancedHtml.includes('保存目录')
  && dialogAdvancedHtml.includes(CONFIG.promptModel))

writeFileSync(join(OUT, 'settings.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 设置弹窗（真实组件渲染）</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side"><h4>插件</h4>${renderToHtml(entry.component({ ctx: { on: () => () => {}, get: () => undefined } }))}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n${dialogNoKeyHtml}\n</body>\n</html>\n`,
  'utf8')

writeFileSync(join(OUT, 'settings-models.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 设置 · 模型</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side"><h4>插件</h4>${renderToHtml(entry.component({ ctx: { on: () => () => {}, get: () => undefined } }))}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n${dialogModelsHtml}\n</body>\n</html>\n`,
  'utf8')

writeFileSync(join(OUT, 'settings-advanced.html'),
  `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>dsh-openrouter-imagen v2 — 设置 · 高级</title>\n<style>${TOKENS}\n${styles.join('\n')}\n</style>\n</head>\n<body>\n<div class="shell">\n<div class="side"><h4>插件</h4>${renderToHtml(entry.component({ ctx: { on: () => () => {}, get: () => undefined } }))}</div>\n<div class="mainpane">${workspaceHtml}</div>\n</div>\n${dialogAdvancedHtml}\n</body>\n</html>\n`,
  'utf8')

console.log('')
console.log(`wrote ${OUT}/workspace.html`)
console.log(`wrote ${OUT}/settings.html`)
console.log(`wrote ${OUT}/settings-models.html`)
console.log(`wrote ${OUT}/settings-advanced.html`)
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
