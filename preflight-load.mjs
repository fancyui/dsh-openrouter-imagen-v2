/**
 * Load the plugin the way the HOST does, against the real installed packages.
 *
 * `smoke.mjs` runs the host half with a stub Context, which proves the logic but
 * not that the module resolves its imports the way the running app will. This
 * script closes that gap: it imports the package BY BARE NAME from the profile's
 * `node_modules` (exactly as the linked-root interception does), so a missing
 * `undici`, a bad peer name, or a broken export shows up here rather than as a
 * silent 404 after a restart.
 *
 *   node preflight-load.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let failures = 0
const check = (label, condition, detail) => {
  const ok = condition === true
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`)
}

const PROFILE = process.env.DSH_PROFILE_DIR ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')
const require = createRequire(pathToFileURL(join(PROFILE, 'noop.js')))

/** Resolve a bare name from the PROFILE, which is what the app's loader does. */
function resolveFromProfile(name) {
  try {
    return require.resolve(name)
  } catch (error) {
    return { error: String(error.message) }
  }
}

const mainPath = resolveFromProfile('dsh-openrouter-imagen-v2')
check('the package resolves by bare name from the profile', typeof mainPath === 'string', typeof mainPath === 'string' ? '' : mainPath.error)

const clientPath = resolveFromProfile('dsh-openrouter-imagen-v2/client')
check('the client entry resolves (exports["./client"])', typeof clientPath === 'string', typeof clientPath === 'string' ? '' : clientPath.error)

const patchPath = resolveFromProfile('dsh-openrouter-imagen-v2/cordis.patch.yml')
check('the bundle patch resolves (exports["./cordis.patch.yml"])', typeof patchPath === 'string', typeof patchPath === 'string' ? '' : patchPath.error)

// The one that actually bit v1: `undici` is NOT intercepted by the host (it is
// not in peerDependencies), so it must resolve from inside the package.
const undiciFromPlugin = (() => {
  try {
    return createRequire(pathToFileURL(join(PROFILE, 'node_modules', 'dsh-openrouter-imagen-v2', 'lib', 'index.js'))).resolve('undici')
  } catch (error) {
    return { error: String(error.message) }
  }
})()
check('undici resolves from inside the package (the v1 failure mode)', typeof undiciFromPlugin === 'string',
  typeof undiciFromPlugin === 'string' ? '' : undiciFromPlugin.error)

if (typeof mainPath === 'string') {
  const host = await import(pathToFileURL(mainPath).href)
  check('the host module exports apply()', typeof host.apply === 'function')
  check('the host module exports the Config schema', host.Config !== undefined)
  check('the host module exports the generation store', typeof host.GenerationStore === 'function')
  check('the host declares its supported ratios', Array.isArray(host.ASPECTS) && host.ASPECTS.length === 12)

  /**
   * `tools` MUST be injected; nothing else may be.
   *
   * Cordis gates the property form (`ctx.tools`) behind `inject`. Omitting it
   * throws inside `apply`, the fiber goes `failed`, the route never registers,
   * and every request lands on the SPA fallback — 404 on GET, 405 otherwise.
   * That is exactly the bug this check now exists to prevent, and an earlier
   * version of this file asserted the OPPOSITE (inject must be empty), which is
   * how it slipped through.
   *
   * The other services are read with `ctx.get(...)`, which returns undefined
   * rather than throwing, so they must NOT be listed: naming one would park the
   * whole row — the paid tool included — on a surface that lacks it.
   */
  const injected = Array.isArray(host.inject) ? host.inject : []
  check('the host injects "tools" (ctx.tools throws without it)',
    injected.includes('tools'), JSON.stringify(injected))
  check('the host injects nothing else (other services are read via ctx.get)',
    injected.length === 1 && injected[0] === 'tools', JSON.stringify(injected))
}

// The client half is loaded by the browser's module system, but its SYNTAX and
// its top-level shape are checkable here.
if (typeof clientPath === 'string') {
  const source = await import('node:fs').then((fs) => fs.readFileSync(clientPath, 'utf8'))
  check('the client registers itself with window.__ModuleLoader__', source.includes('__ModuleLoader__.load'))
  check('the client module id is unique to v2', source.includes("id: 'dsh-openrouter-imagen-v2'"))
  check('the client does not require any host-only package', !/require\(['"](?!react)/u.test(source))
  // A non-JSON answer on our OWN prefix means the Host half never mounted. That
  // message is the difference between a five-second fix (restart) and a long
  // detour, so it is a contract worth pinning.
  check('the client explains an unmounted plugin instead of reporting a bare status',
    source.includes('没有挂载') && source.includes('重启 DSH'))
}

/**
 * A note on the one failure this file cannot see.
 *
 * `fiberPhase: failed` lives in the running process, not on disk. It is worth
 * naming anyway because it is the usual cause of "404 on my own route": a plugin
 * row mounts ONCE, at boot. Installing afterwards leaves the route absent — and
 * if the row was first read while the package was still being written, the fiber
 * stays failed for the life of that process even after the files are correct.
 */
console.log('')
console.log('note: plugin rows mount at DSH startup. If /openrouter-imagen-v2/api/* answers')
console.log('      404 to GET or 405 to POST, the running app predates (or failed to load)')
console.log('      this plugin: restart DSH, then reload the page.')

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)