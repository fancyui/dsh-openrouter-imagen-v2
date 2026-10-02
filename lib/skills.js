/**
 * The skill this package bundles, registered as a CHILD plugin.
 *
 * `skills` is deliberately absent from the main plugin's `inject`: the skill
 * registry is optional infrastructure, and naming it there would park the whole
 * plugin — the paid tool included — on any surface that has no skill service.
 * This child waits for the service on its own; the tool registers either way.
 *
 * The file is read once at apply time, and a read failure is a warning rather
 * than a throw: a package that shipped without `skills/` loses one skill, not
 * its entire image capability.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Rank below every filesystem provider, so a user's own skill of the same name wins instead of colliding. */
const BUNDLED_SKILL_RANK = 600
const SKILL_NAME = 'openrouter-imagen-v2'
/** The catalog description is hard-capped by dsh-tool-skill (default 500, tail-truncated). */
const DESCRIPTION_MAX = 500

/** Strip the YAML frontmatter and return `{ description, body }`. */
function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text)
  if (match === null) return { description: '', body: text.trim() }
  const header = match[1]
  const line = header.split(/\r?\n/u).find((row) => /^description\s*:/u.test(row)) ?? ''
  let description = line.replace(/^description\s*:\s*/u, '').trim()
  if ((description.startsWith('"') && description.endsWith('"')) || (description.startsWith("'") && description.endsWith("'"))) {
    description = description.slice(1, -1)
  }
  return { description, body: text.slice(match[0].length).trim() }
}

function loadSkill() {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, '..', 'skills', SKILL_NAME, 'SKILL.md')
  try {
    const parsed = parseSkill(readFileSync(file, 'utf8'))
    return { ...parsed, file }
  } catch (error) {
    console.warn(`[openrouter-imagen-v2] cannot read bundled skill at ${file}: ${error?.message ?? error}`)
    return null
  }
}

export function bundledSkill(ctx) {
  ctx.inject(['skills'], (scope) => {
    const skills = scope.get('skills')
    if (skills === undefined || typeof skills.registerProvider !== 'function') return
    const loaded = loadSkill()
    if (loaded === null) return

    const description = loaded.description.slice(0, DESCRIPTION_MAX - 3) + (loaded.description.length > DESCRIPTION_MAX - 3 ? '...' : '')

    scope.effect(
      () => skills.registerProvider({
        id: SKILL_NAME,
        rank: BUNDLED_SKILL_RANK,
        async list() {
          return [{
            name: SKILL_NAME,
            description,
            // The skill directory travels with the entry so a relative path
            // mentioned in SKILL.md resolves against it.
            root: dirname(loaded.file),
            async read() {
              return loaded.body
            },
          }]
        },
      }),
      'openrouter-imagen-v2: bundled skill',
    )
  })
}

export const skillInternals = { parseSkill, loadSkill, BUNDLED_SKILL_RANK, SKILL_NAME, DESCRIPTION_MAX }
